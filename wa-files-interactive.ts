#!/usr/bin/env npx tsx
/**
 * WA Files Interactive Crawler
 * Opens WA Files admin in non-headless mode and extracts file listings
 * by properly navigating the React/SPA interface
 */

import { chromium, Page, Frame, ElementHandle } from 'playwright';
import * as fs from 'fs';

interface FileEntry {
  folder: string;
  name: string;
  size: string;
  type: string;
  url?: string;
}

interface CrawlResult {
  crawledAt: string;
  totalFolders: number;
  totalFiles: number;
  files: FileEntry[];
  errors: string[];
}

function loadCookies(cookieFile: string) {
  const content = fs.readFileSync(cookieFile, 'utf-8');
  const cookies: Array<{name: string, value: string, domain: string, path: string, secure: boolean}> = [];
  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length >= 7) {
      cookies.push({
        name: parts[5],
        value: parts[6].trim(),
        domain: parts[0].replace(/^\./, ''),
        path: parts[2],
        secure: parts[3] === 'TRUE'
      });
    }
  }
  return cookies;
}

async function waitForFileManagerReady(page: Page): Promise<boolean> {
  console.log('   Waiting for file manager to load...');

  // Wait for any loading indicators to disappear
  await page.waitForTimeout(3000);

  // Try to find the file manager elements
  for (let i = 0; i < 30; i++) {
    // Look for folder tree or file list
    const folderTree = await page.locator('.folder-tree, .file-tree, [class*="folder"], [class*="FileManager"]').count();
    const fileList = await page.locator('.file-list, .resource-list, table tr, [class*="file-row"]').count();

    if (folderTree > 0 || fileList > 0) {
      console.log(`   Found ${folderTree} folder elements, ${fileList} file elements`);
      return true;
    }

    // Check for iframe content
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const content = await frame.content();
        if (content.includes('resourceTable') || content.includes('file-manager') ||
            content.includes('Folder') || content.includes('fileName')) {
          console.log(`   Found file manager content in frame: ${frame.name() || frame.url()}`);
          return true;
        }
      } catch (e) {
        // Frame might be detached
      }
    }

    await page.waitForTimeout(1000);
  }

  return false;
}

async function extractFilesFromPage(page: Page, currentFolder: string): Promise<{files: FileEntry[], subfolders: string[]}> {
  const files: FileEntry[] = [];
  const subfolders: string[] = [];

  // Get all frames
  const frames = page.frames();

  for (const frame of frames) {
    try {
      const content = await frame.content();

      // Look for table rows with file data
      const rows = await frame.locator('table tbody tr, .file-row, .resource-row').all();

      for (const row of rows) {
        try {
          const cells = await row.locator('td').all();
          if (cells.length >= 2) {
            const nameText = await cells[0].textContent() || '';
            const sizeText = cells.length > 1 ? await cells[1].textContent() || '' : '';
            const typeText = cells.length > 2 ? await cells[2].textContent() || '' : '';

            const name = nameText.trim();
            if (!name || name === 'Name') continue;

            if (typeText.toLowerCase().includes('folder')) {
              subfolders.push(currentFolder ? `${currentFolder}/${name}` : name);
            } else if (name) {
              files.push({
                folder: currentFolder,
                name,
                size: sizeText.trim(),
                type: typeText.trim()
              });
            }
          }
        } catch (e) {
          // Skip problematic rows
        }
      }
    } catch (e) {
      // Frame might be inaccessible
    }
  }

  return { files, subfolders };
}

async function main() {
  const cookieFile = 'cookies.txt';
  const outputFile = 'wa-files-interactive.json';

  console.log('WA Files Interactive Crawler');
  console.log('   This opens a browser for you to navigate to the Files section');
  console.log('   The script will then extract file listings\n');

  const browser = await chromium.launch({
    headless: false,
    slowMo: 100,
    args: ['--start-maximized']
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    ignoreHTTPSErrors: true
  });

  const cookies = loadCookies(cookieFile);
  console.log(`   Loaded ${cookies.length} cookies`);
  await context.addCookies(cookies);

  const page = await context.newPage();
  const result: CrawlResult = {
    crawledAt: new Date().toISOString(),
    totalFolders: 0,
    totalFiles: 0,
    files: [],
    errors: []
  };

  // Go directly to files admin
  console.log('\nOpening WA Files Admin...');
  await page.goto('https://sbnewcomers.org/admin/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  console.log('\n=== INSTRUCTIONS ===');
  console.log('1. In the browser, click "Website" in the left menu');
  console.log('2. Then click "Files" to open the file manager');
  console.log('3. Navigate to each folder you want to catalog');
  console.log('4. Press Enter in this terminal when ready to extract files from current view');
  console.log('5. Type "done" and press Enter when finished\n');

  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const prompt = (question: string): Promise<string> => {
    return new Promise(resolve => rl.question(question, resolve));
  };

  let folderCount = 0;

  while (true) {
    const input = await prompt('\nPress Enter to extract files (or type folder name, or "done" to finish): ');

    if (input.toLowerCase() === 'done') {
      break;
    }

    const currentFolder = input.trim() || `folder_${folderCount}`;
    folderCount++;

    console.log(`Extracting files from: ${currentFolder || '(current view)'}...`);

    // Take screenshot for debugging
    await page.screenshot({ path: `wa-extract-${folderCount}.png` });

    // Try to extract from the page
    const { files, subfolders } = await extractFilesFromPage(page, currentFolder);

    console.log(`   Found ${files.length} files, ${subfolders.length} subfolders`);

    if (files.length > 0) {
      result.files.push(...files);
      console.log('   Files:');
      files.slice(0, 10).forEach(f => console.log(`     - ${f.name} (${f.size})`));
      if (files.length > 10) console.log(`     ... and ${files.length - 10} more`);
    }

    if (subfolders.length > 0) {
      console.log('   Subfolders:', subfolders.join(', '));
    }

    // Save intermediate results
    result.totalFolders = folderCount;
    result.totalFiles = result.files.length;
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
  }

  rl.close();

  // Final save
  result.totalFolders = folderCount;
  result.totalFiles = result.files.length;
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));

  console.log('\n' + '='.repeat(50));
  console.log(`Total files found: ${result.files.length}`);
  console.log(`Total folders visited: ${folderCount}`);
  console.log(`Saved to: ${outputFile}`);

  console.log('\nClosing browser in 5 seconds...');
  await page.waitForTimeout(5000);
  await browser.close();
}

main().catch(console.error);
