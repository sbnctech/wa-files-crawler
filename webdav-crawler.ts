#!/usr/bin/env npx tsx
/**
 * WA WebDAV Crawler - Complete file download via WebDAV
 * Recursively lists and downloads all files from WA resources
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createHash } from 'crypto';

const USERNAME = 'technology@sbnewcomers.org';
const PASSWORD = process.env.WA_PASSWORD || process.argv[2];
const BASE_URL = 'https://sbnewcomers.org/resources';
const DOWNLOAD_DIR = './downloads-webdav';

interface FileInfo {
  href: string;
  name: string;
  size: number;
  isFolder: boolean;
  lastModified: string;
}

interface CrawlStats {
  totalFolders: number;
  totalFiles: number;
  totalSize: number;
  downloaded: number;
  skipped: number;
  errors: string[];
}

const stats: CrawlStats = {
  totalFolders: 0,
  totalFiles: 0,
  totalSize: 0,
  downloaded: 0,
  skipped: 0,
  errors: []
};

// Digest auth helper
function createDigestAuth(realm: string, nonce: string, uri: string, method: string): string {
  const ha1 = createHash('md5').update(`${USERNAME}:${realm}:${PASSWORD}`).digest('hex');
  const ha2 = createHash('md5').update(`${method}:${uri}`).digest('hex');
  const nc = '00000001';
  const cnonce = Math.random().toString(36).substring(2, 10);
  const response = createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`).digest('hex');

  return `Digest username="${USERNAME}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
}

async function propfind(folderPath: string): Promise<FileInfo[]> {
  const url = new URL(folderPath ? `${BASE_URL}/${folderPath}/` : `${BASE_URL}/`);

  return new Promise((resolve, reject) => {
    // First request to get nonce
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'PROPFIND',
      headers: {
        'Content-Type': 'application/xml',
        'Depth': '1'
      }
    };

    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/></d:prop></d:propfind>';

    const req = https.request(options, (res) => {
      if (res.statusCode === 401) {
        // Get digest challenge
        const wwwAuth = res.headers['www-authenticate'] || '';
        const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
        const nonceMatch = wwwAuth.match(/nonce="([^"]+)"/);

        if (realmMatch && nonceMatch) {
          // Retry with auth
          const authHeader = createDigestAuth(realmMatch[1], nonceMatch[1], url.pathname, 'PROPFIND');
          options.headers['Authorization'] = authHeader;

          const authReq = https.request(options, (authRes) => {
            let data = '';
            authRes.on('data', chunk => data += chunk);
            authRes.on('end', () => {
              if (authRes.statusCode === 207) {
                resolve(parseMultistatus(data, folderPath));
              } else {
                reject(new Error(`HTTP ${authRes.statusCode}`));
              }
            });
          });
          authReq.write(body);
          authReq.end();
        }
      } else {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(parseMultistatus(data, folderPath)));
      }
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseMultistatus(xml: string, currentPath: string): FileInfo[] {
  const items: FileInfo[] = [];
  const responses = xml.split('<d:response>').slice(1);

  for (const response of responses) {
    const hrefMatch = response.match(/<d:href>([^<]+)<\/d:href>/);
    const nameMatch = response.match(/<d:displayname>([^<]*)<\/d:displayname>/);
    const sizeMatch = response.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/);
    const isFolder = response.includes('<d:collection');
    const lastModMatch = response.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/);

    if (hrefMatch) {
      const href = decodeURIComponent(hrefMatch[1]);
      const name = nameMatch ? nameMatch[1] : path.basename(href);

      // Skip the current folder itself
      const hrefPath = href.replace(/^https:\/\/[^/]+\/resources\/?/, '').replace(/\/$/, '');
      if (hrefPath === currentPath || (!hrefPath && !currentPath)) continue;

      items.push({
        href,
        name,
        size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
        isFolder,
        lastModified: lastModMatch ? lastModMatch[1] : ''
      });
    }
  }

  return items;
}

async function downloadFile(fileUrl: string, destPath: string): Promise<boolean> {
  const url = new URL(fileUrl);

  // Ensure directory exists
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'GET',
      headers: {}
    };

    // Helper to handle response with redirect following
    const handleResponse = (res: any, isAuth: boolean = false): void => {
      // Handle redirect (307, 302, 301)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location);
        const redirectOptions: https.RequestOptions = {
          hostname: redirectUrl.hostname,
          port: 443,
          path: redirectUrl.pathname + (redirectUrl.search || ''),
          method: 'GET',
          headers: {}
        };

        const redirectReq = https.request(redirectOptions, (redirectRes) => {
          if (redirectRes.statusCode === 200) {
            const file = fs.createWriteStream(destPath);
            redirectRes.pipe(file);
            file.on('finish', () => {
              file.close();
              resolve(true);
            });
            file.on('error', () => resolve(false));
          } else {
            resolve(false);
          }
        });
        redirectReq.on('error', () => resolve(false));
        redirectReq.end();
        return;
      }

      if (res.statusCode === 401 && !isAuth) {
        const wwwAuth = res.headers['www-authenticate'] || '';
        const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
        const nonceMatch = wwwAuth.match(/nonce="([^"]+)"/);

        if (realmMatch && nonceMatch) {
          const authHeader = createDigestAuth(realmMatch[1], nonceMatch[1], url.pathname, 'GET');
          const authOptions: https.RequestOptions = {
            hostname: url.hostname,
            port: 443,
            path: url.pathname,
            method: 'GET',
            headers: { 'Authorization': authHeader }
          };

          const authReq = https.request(authOptions, (authRes) => {
            handleResponse(authRes, true);
          });
          authReq.on('error', () => resolve(false));
          authReq.end();
        } else {
          resolve(false);
        }
      } else if (res.statusCode === 200) {
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve(true);
        });
        file.on('error', () => resolve(false));
      } else {
        resolve(false);
      }
    };

    const req = https.request(options, (res) => handleResponse(res));
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function crawlFolder(folderPath: string, depth: number = 0): Promise<void> {
  const indent = '  '.repeat(depth);
  console.log(`${indent}📁 ${folderPath || '(root)'}`);

  try {
    const items = await propfind(folderPath);

    for (const item of items) {
      if (item.isFolder) {
        stats.totalFolders++;
        const subPath = item.href.replace(/^https:\/\/[^/]+\/resources\//, '').replace(/\/$/, '');
        await crawlFolder(subPath, depth + 1);
      } else {
        stats.totalFiles++;
        stats.totalSize += item.size;

        const relativePath = item.href.replace(/^https:\/\/[^/]+\/resources\//, '');
        const destPath = path.join(DOWNLOAD_DIR, decodeURIComponent(relativePath));

        // Skip if already exists with same size
        if (fs.existsSync(destPath)) {
          const existingSize = fs.statSync(destPath).size;
          if (existingSize === item.size) {
            stats.skipped++;
            continue;
          }
        }

        process.stdout.write(`${indent}  📄 ${item.name} (${formatSize(item.size)})... `);

        if (await downloadFile(item.href, destPath)) {
          stats.downloaded++;
          console.log('✅');
        } else {
          stats.errors.push(relativePath);
          console.log('❌');
        }
      }
    }
  } catch (e) {
    console.log(`${indent}  ⚠️ Error: ${e}`);
    stats.errors.push(`${folderPath}: ${e}`);
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

async function main() {
  if (!PASSWORD) {
    console.log('Usage: npx tsx webdav-crawler.ts <password>');
    console.log('   Or: WA_PASSWORD=xxx npx tsx webdav-crawler.ts');
    process.exit(1);
  }

  console.log('🚀 WA WebDAV Crawler');
  console.log(`   Target: ${BASE_URL}`);
  console.log(`   Download to: ${DOWNLOAD_DIR}\n`);

  // Create download directory
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  const startTime = Date.now();

  await crawlFolder('');

  const elapsed = (Date.now() - startTime) / 1000;

  console.log('\n' + '='.repeat(60));
  console.log('📊 Summary:');
  console.log(`   Folders: ${stats.totalFolders}`);
  console.log(`   Files: ${stats.totalFiles} (${formatSize(stats.totalSize)})`);
  console.log(`   Downloaded: ${stats.downloaded}`);
  console.log(`   Skipped (existing): ${stats.skipped}`);
  console.log(`   Errors: ${stats.errors.length}`);
  console.log(`   Time: ${elapsed.toFixed(1)}s`);

  if (stats.errors.length > 0) {
    console.log('\n❌ Errors:');
    stats.errors.slice(0, 20).forEach(e => console.log(`   - ${e}`));
    if (stats.errors.length > 20) console.log(`   ... and ${stats.errors.length - 20} more`);
  }

  // Save stats
  fs.writeFileSync('webdav-crawl-stats.json', JSON.stringify({
    ...stats,
    crawledAt: new Date().toISOString(),
    elapsedSeconds: elapsed
  }, null, 2));
}

main().catch(console.error);
