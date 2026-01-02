#!/usr/bin/env npx tsx
/**
 * WA Files Auto Crawler
 * Automatically navigates WA Files admin and extracts file listings
 * by clicking through the folder tree
 */

import { chromium, Page, Frame, Locator } from 'playwright';
import * as fs from 'fs';

interface FileEntry {
  folder: string;
  name: string;
  size: string;
  type: string;
}

interface CrawlResult {
  crawledAt: string;
  totalFolders: number;
  totalFiles: number;
  files: FileEntry[];
  foldersVisited: string[];
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

async function getContentFrame(page: Page): Promise<Frame | null> {
  // Wait for the content area frame
  for (let i = 0; i < 20; i++) {
    const frame = page.frame('contentarea');
    if (frame) {
      return frame;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function extractFilesFromTable(frame: Frame, currentFolder: string): Promise<{files: FileEntry[], subfolders: string[]}> {
  const files: FileEntry[] = [];
  const subfolders: string[] = [];

  try {
    // Wait for table to load
    await frame.waitForTimeout(1500);

    // Try different table selectors
    const tableSelectors = [
      '#resourceTable tbody tr',
      'table.resourceList tbody tr',
      '.file-list tr',
      'table tr:has(td)',
      '.dataTables_wrapper tbody tr'
    ];

    for (const selector of tableSelectors) {
      const rows = await frame.locator(selector).all();
      if (rows.length > 0) {
        console.log(`   Found ${rows.length} rows with selector: ${selector}`);

        for (const row of rows) {
          try {
            const cells = await row.locator('td').all();
            if (cells.length < 2) continue;

            // Get text from first few cells
            const nameText = (await cells[0].textContent() || '').trim();
            const sizeOrType = cells.length > 1 ? (await cells[1].textContent() || '').trim() : '';
            const typeOrDate = cells.length > 2 ? (await cells[2].textContent() || '').trim() : '';

            // Skip empty or header rows
            if (!nameText || nameText === 'Name' || nameText.includes('Loading')) continue;

            // Determine if it's a folder or file
            const isFolder = typeOrDate.toLowerCase().includes('folder') ||
                             sizeOrType.toLowerCase().includes('folder') ||
                             (await row.locator('[class*="folder"]').count()) > 0;

            if (isFolder) {
              const folderPath = currentFolder ? `${currentFolder}/${nameText}` : nameText;
              subfolders.push(folderPath);
              console.log(`     📁 ${nameText}`);
            } else {
              files.push({
                folder: currentFolder,
                name: nameText,
                size: sizeOrType,
                type: typeOrDate
              });
              console.log(`     📄 ${nameText} (${sizeOrType})`);
            }
          } catch (e) {
            // Skip problematic rows
          }
        }
        break;
      }
    }
  } catch (e) {
    console.log(`   Error extracting: ${e}`);
  }

  return { files, subfolders };
}

async function clickFolder(frame: Frame, folderName: string): Promise<boolean> {
  try {
    // Try clicking on folder in tree or list
    // First try getByText
    const textElement = frame.getByText(folderName, { exact: true }).first();
    if (await textElement.count() > 0) {
      await textElement.dblclick();
      await frame.waitForTimeout(2000);
      return true;
    }

    // Try other selectors
    const selectors = [
      `a:has-text("${folderName}")`,
      `span:has-text("${folderName}")`,
      `td:has-text("${folderName}")`
    ];

    for (const selector of selectors) {
      const element = frame.locator(selector).first();
      if (await element.count() > 0) {
        await element.dblclick();
        await frame.waitForTimeout(2000);
        return true;
      }
    }
  } catch (e) {
    console.log(`   Click error: ${e}`);
  }
  return false;
}

async function navigateUp(frame: Frame): Promise<boolean> {
  try {
    // Look for parent folder or back button
    const upButton = frame.locator('[title="Parent folder"], .upButton, a:has-text("..")').first();
    if (await upButton.count() > 0) {
      await upButton.click();
      await frame.waitForTimeout(1500);
      return true;
    }
    // Try getByText for ".."
    const dotDot = frame.getByText('..', { exact: true }).first();
    if (await dotDot.count() > 0) {
      await dotDot.click();
      await frame.waitForTimeout(1500);
      return true;
    }
  } catch (e) {
    // Ignore
  }
  return false;
}

async function main() {
  const cookieFile = 'cookies.txt';
  const outputFile = 'wa-auto-crawl.json';
  const knownFoldersFile = 'known-folders.json';

  console.log('🚀 WA Auto Crawler');
  console.log('   Automatically navigating file manager\n');

  // Load known folders to visit
  let foldersToVisit: string[] = [];
  if (fs.existsSync(knownFoldersFile)) {
    const known = JSON.parse(fs.readFileSync(knownFoldersFile, 'utf-8'));
    foldersToVisit = known.folders
      .filter((f: any) => !f.restricted && !f.empty)
      .map((f: any) => f.path)
      .slice(0, 50); // Limit for testing
    console.log(`   Loaded ${foldersToVisit.length} folders to visit`);
  }

  const browser = await chromium.launch({
    headless: false,
    slowMo: 50
  });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 }
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
    foldersVisited: [],
    errors: []
  };

  try {
    // Go to admin dashboard
    console.log('\n📂 Opening WA Admin...');
    await page.goto('https://sbnewcomers.org/admin/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Click on Website menu
    console.log('   Clicking Website menu...');
    const websiteMenu = page.getByText('Website').first();
    if (await websiteMenu.count() > 0) {
      await websiteMenu.click();
      await page.waitForTimeout(1000);
    }

    // Click on Files
    console.log('   Clicking Files...');
    const filesLink = page.locator('a:has-text("Files")').first();
    if (await filesLink.count() > 0) {
      await filesLink.click();
      await page.waitForTimeout(5000);
    } else {
      // Try text selector
      const filesText = page.getByText('Files').first();
      if (await filesText.count() > 0) {
        await filesText.click();
        await page.waitForTimeout(5000);
      }
    }

    // Save screenshot
    await page.screenshot({ path: 'wa-files-admin.png' });

    // Get the content frame
    const frame = await getContentFrame(page);
    if (!frame) {
      console.log('❌ Could not find content frame');
      result.errors.push('Content frame not found');

      // Save page content for debugging
      fs.writeFileSync('wa-debug-page.html', await page.content());
      console.log('   Saved debug page to wa-debug-page.html');
    } else {
      console.log('✅ Found content frame');

      // Save frame content for debugging
      fs.writeFileSync('wa-frame-content.html', await frame.content());
      console.log('   Saved frame content to wa-frame-content.html');

      // Extract from root
      console.log('\n📁 Extracting root folder...');
      const { files: rootFiles, subfolders } = await extractFilesFromTable(frame, '');
      result.files.push(...rootFiles);
      result.foldersVisited.push('(root)');

      console.log(`   Root: ${rootFiles.length} files, ${subfolders.length} subfolders`);

      // Process each known folder
      if (foldersToVisit.length > 0) {
        console.log('\n📁 Processing known folders...');

        for (const folderPath of foldersToVisit) {
          if (result.foldersVisited.includes(folderPath)) continue;

          console.log(`\n📁 ${folderPath}`);

          // Navigate to folder by clicking through path
          const parts = folderPath.split('/');
          let success = true;

          for (const part of parts) {
            if (!await clickFolder(frame, part)) {
              console.log(`   ⚠️ Couldn't navigate to ${part}`);
              success = false;
              break;
            }
          }

          if (success) {
            const { files: folderFiles, subfolders: newFolders } = await extractFilesFromTable(frame, folderPath);
            result.files.push(...folderFiles);
            result.foldersVisited.push(folderPath);
            console.log(`   ${folderFiles.length} files found`);
          }

          // Save intermediate results
          result.totalFolders = result.foldersVisited.length;
          result.totalFiles = result.files.length;
          fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));

          // Navigate back to root for next folder
          while (await navigateUp(frame)) {
            await frame.waitForTimeout(500);
          }

          // Stop if we have enough
          if (result.files.length > 500) {
            console.log('\n   Stopping after 500 files');
            break;
          }
        }
      }
    }
  } catch (e) {
    console.log(`Error: ${e}`);
    result.errors.push(String(e));
  }

  // Final save
  result.totalFolders = result.foldersVisited.length;
  result.totalFiles = result.files.length;
  fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Done! ${result.files.length} files found`);
  console.log(`   Folders visited: ${result.foldersVisited.length}`);
  console.log(`   Saved to: ${outputFile}`);

  console.log('\n   Browser staying open for 60 seconds for inspection...');
  await page.waitForTimeout(60000);

  await browser.close();
}

main().catch(console.error);
