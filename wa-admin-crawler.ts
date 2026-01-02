#!/usr/bin/env npx tsx
/**
 * WA Admin File Crawler using Playwright
 * Navigates through the WA admin menu to access file manager
 */

import { chromium, Page, Frame } from 'playwright';
import * as fs from 'fs';

interface FileEntry {
  folder: string;
  name: string;
  size: string;
  type: string;
}

interface CrawlResult {
  crawledAt: string;
  totalFiles: number;
  files: FileEntry[];
  foldersVisited: string[];
  errors: string[];
}

// Load cookies
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

async function waitForFileManager(page: Page): Promise<Frame | null> {
  // Wait for the content iframe to be populated
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    const frame = page.frame('contentarea');
    if (frame) {
      const content = await frame.content();
      // Check if the file manager is loaded (look for typical elements)
      if (content.includes('filemanager') || content.includes('resourceTable') ||
          content.includes('Views') || content.includes('Folders')) {
        return frame;
      }
    }
  }
  return null;
}

async function extractFilesFromFrame(frame: Frame, currentFolder: string): Promise<{files: FileEntry[], subfolders: string[]}> {
  const files: FileEntry[] = [];
  const subfolders: string[] = [];

  try {
    // The WA file manager has a table with columns: Name, Size, Type, Date Modified, Access permissions
    // Look for the data rows (not header)
    const rows = await frame.locator('.fileRow, .resourceRow, table.resources tr, #resourceTable tr').all();

    if (rows.length === 0) {
      // Try alternative selector - look for any table with file-like content
      const allRows = await frame.locator('table tr').all();
      for (const row of allRows) {
        const rowText = await row.textContent() || '';
        // Skip header rows
        if (rowText.includes('Name') && rowText.includes('Size') && rowText.includes('Type')) continue;

        const cells = await row.locator('td').all();
        if (cells.length >= 3) {
          const nameEl = cells[0];
          const name = (await nameEl.textContent() || '').trim();
          const size = (await cells[1].textContent() || '').trim();
          const type = (await cells[2].textContent() || '').trim();

          if (!name) continue;

          if (type === 'Folder') {
            subfolders.push(currentFolder ? `${currentFolder}/${name}` : name);
          } else if (type.startsWith('File') || /^\d/.test(size)) {
            files.push({ folder: currentFolder, name, size, type });
          }
        }
      }
    }
  } catch (e) {
    console.log(`   Error extracting: ${e}`);
  }

  return { files, subfolders };
}

async function clickOnFolder(frame: Frame, folderName: string): Promise<boolean> {
  try {
    // Find and click on the folder in the tree or list
    const folderLink = frame.locator(`text="${folderName}"`).first();
    if (await folderLink.count() > 0) {
      await folderLink.dblclick();
      await frame.waitForTimeout(1500);
      return true;
    }
  } catch (e) {
    console.log(`   Couldn't click folder ${folderName}: ${e}`);
  }
  return false;
}

async function main() {
  const cookieFile = 'cookies.txt';
  const outputFile = 'wa-admin-files.json';

  console.log('🚀 WA Admin File Crawler');
  console.log('   Using menu navigation approach\n');

  const browser = await chromium.launch({ headless: false, slowMo: 100 });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  const cookies = loadCookies(cookieFile);
  await context.addCookies(cookies);

  const page = await context.newPage();
  const result: CrawlResult = {
    crawledAt: new Date().toISOString(),
    totalFiles: 0,
    files: [],
    foldersVisited: [],
    errors: []
  };

  // Step 1: Go to admin dashboard
  console.log('📂 Opening WA Admin Dashboard...');
  await page.goto('https://sbnewcomers.org/admin/', { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  // Step 2: Click on "Website" menu then "Files"
  console.log('🔍 Looking for Files menu...');

  // Take screenshot for debugging
  await page.screenshot({ path: 'wa-step1-dashboard.png' });

  // Try to find and click "Files" link - it might be under Website menu
  try {
    // First try clicking Website menu if it exists
    const websiteMenu = page.locator('text="Website"').first();
    if (await websiteMenu.count() > 0) {
      await websiteMenu.click();
      await page.waitForTimeout(1000);
    }

    // Now click on Files
    const filesLink = page.locator('a:has-text("Files"), [data-testid="files-link"], text="Files"').first();
    if (await filesLink.count() > 0) {
      console.log('   Found Files link, clicking...');
      await filesLink.click();
      await page.waitForTimeout(3000);
    } else {
      console.log('   Files link not found, trying direct navigation...');
      // Try clicking in the sidebar
      await page.click('text=/files/i', { timeout: 5000 }).catch(() => {});
    }
  } catch (e) {
    console.log(`   Navigation error: ${e}`);
  }

  await page.screenshot({ path: 'wa-step2-afterclick.png' });

  // Step 3: Wait for file manager to load
  console.log('⏳ Waiting for file manager...');
  const frame = await waitForFileManager(page);

  if (frame) {
    console.log('✅ File manager loaded!');

    // Save the frame content for debugging
    const frameContent = await frame.content();
    fs.writeFileSync('wa-filemanager-frame.html', frameContent);

    // Extract files from root
    const { files, subfolders } = await extractFilesFromFrame(frame, '');
    console.log(`   Root: ${files.length} files, ${subfolders.length} folders`);
    result.files.push(...files);
    result.foldersVisited.push('(root)');

    // Process subfolders recursively (limited depth for now)
    const queue = [...subfolders];
    while (queue.length > 0 && result.foldersVisited.length < 50) {
      const folder = queue.shift()!;
      console.log(`📁 ${folder}`);

      if (await clickOnFolder(frame, folder.split('/').pop()!)) {
        const { files: subFiles, subfolders: subSubs } = await extractFilesFromFrame(frame, folder);
        console.log(`   ${subFiles.length} files, ${subSubs.length} subfolders`);
        result.files.push(...subFiles);
        result.foldersVisited.push(folder);
        queue.push(...subSubs);
      }

      // Save intermediate results
      result.totalFiles = result.files.length;
      fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
    }
  } else {
    console.log('❌ File manager did not load');
    // Save page state for debugging
    const pageContent = await page.content();
    fs.writeFileSync('wa-debug-page.html', pageContent);
    result.errors.push('File manager did not load');
  }

  // Final save
  result.totalFiles = result.files.length;
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Done! ${result.totalFiles} files found`);
  console.log(`   Folders visited: ${result.foldersVisited.length}`);
  console.log(`   Saved to: ${outputFile}`);

  console.log('\n📸 Debug screenshots saved. Browser staying open for 2 min...');
  await page.waitForTimeout(120000);

  await browser.close();
}

main().catch(console.error);
