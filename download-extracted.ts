#!/usr/bin/env npx tsx
/**
 * Download files from extracted-files.json using direct URLs
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';

interface FileEntry {
  folder: string;
  name: string;
  size: string;
}

// Load cookies from Netscape format
function loadCookieString(cookieFile: string): string {
  const content = fs.readFileSync(cookieFile, 'utf-8');
  const cookies: string[] = [];

  for (const line of content.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length >= 7) {
      cookies.push(`${parts[5]}=${parts[6]}`);
    }
  }
  return cookies.join('; ');
}

async function downloadFile(url: string, destPath: string, cookieString: string): Promise<boolean> {
  return new Promise((resolve) => {
    const options = {
      headers: {
        'Cookie': cookieString,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    };

    https.get(url, options, (response) => {
      if (response.statusCode === 200) {
        const file = fs.createWriteStream(destPath);
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(true);
        });
        file.on('error', () => resolve(false));
      } else if (response.statusCode === 302 || response.statusCode === 301) {
        // Follow redirect
        const redirectUrl = response.headers.location;
        if (redirectUrl) {
          https.get(redirectUrl, options, (res2) => {
            if (res2.statusCode === 200) {
              const file = fs.createWriteStream(destPath);
              res2.pipe(file);
              file.on('finish', () => {
                file.close();
                resolve(true);
              });
              file.on('error', () => resolve(false));
            } else {
              resolve(false);
            }
          }).on('error', () => resolve(false));
        } else {
          resolve(false);
        }
      } else {
        resolve(false);
      }
    }).on('error', () => resolve(false));
  });
}

async function main() {
  const extractedFile = 'extracted-files.json';
  const cookieFile = 'cookies.txt';
  const downloadDir = 'downloads';

  if (!fs.existsSync(extractedFile)) {
    console.error('extracted-files.json not found');
    process.exit(1);
  }

  if (!fs.existsSync(cookieFile)) {
    console.error('cookies.txt not found');
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(extractedFile, 'utf-8'));
  const files: FileEntry[] = data.files;
  const cookieString = loadCookieString(cookieFile);

  console.log(`📥 Downloading ${files.length} files...`);

  let success = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const file of files) {
    const folder = file.folder || '';
    const filename = file.name;

    // Build URL
    const urlPath = folder ? `${folder}/${filename}` : filename;
    const url = `https://sbnewcomers.org/resources/${encodeURIComponent(urlPath).replace(/%2F/g, '/')}`;

    // Build destination path
    const destFolder = path.join(downloadDir, folder.replace(/ /g, '%20'));
    const destPath = path.join(destFolder, filename.replace(/ /g, '%20'));

    // Skip if already exists
    if (fs.existsSync(destPath)) {
      console.log(`  ⏭️  Skip (exists): ${urlPath}`);
      success++;
      continue;
    }

    // Create directory
    fs.mkdirSync(destFolder, { recursive: true });

    // Download
    process.stdout.write(`  📥 ${urlPath}... `);
    const ok = await downloadFile(url, destPath, cookieString);

    if (ok) {
      console.log('✅');
      success++;
    } else {
      console.log('❌');
      failed++;
      failures.push(urlPath);
    }

    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`\n📊 Results: ${success} success, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n❌ Failed files:');
    failures.forEach(f => console.log(`   - ${f}`));
  }
}

main().catch(console.error);
