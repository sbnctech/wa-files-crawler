#!/usr/bin/env npx tsx
/**
 * WA Files Incremental Backup
 *
 * Performs incremental backups of WA file storage via WebDAV.
 * Only downloads new or modified files since last sync.
 *
 * Features:
 * - Tracks last sync time and file modifications
 * - Maintains manifest of all synced files
 * - Supports dry-run mode to preview changes
 * - Logs all activity for audit trail
 * - Sends email notification on completion (optional)
 *
 * Usage:
 *   WA_PASSWORD=xxx npx tsx backup-incremental.ts
 *   WA_PASSWORD=xxx npx tsx backup-incremental.ts --dry-run
 *   WA_PASSWORD=xxx npx tsx backup-incremental.ts --full   # Force full sync
 *
 * Environment variables:
 *   WA_PASSWORD       - WebDAV password (required)
 *   BACKUP_DIR        - Backup destination (default: ./backups)
 *   MANIFEST_FILE     - Manifest location (default: ./backup-manifest.json)
 *   NOTIFY_EMAIL      - Email for notifications (optional)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createHash } from 'crypto';

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  username: 'technology@sbnewcomers.org',
  password: process.env.WA_PASSWORD || '',
  baseUrl: 'https://sbnewcomers.org/resources',
  backupDir: process.env.BACKUP_DIR || './backups',
  manifestFile: process.env.MANIFEST_FILE || './backup-manifest.json',
  logFile: process.env.LOG_FILE || './backup.log',
  notifyEmail: process.env.NOTIFY_EMAIL || '',
  dryRun: process.argv.includes('--dry-run'),
  fullSync: process.argv.includes('--full'),
};

// ============================================================================
// TYPES
// ============================================================================

interface FileInfo {
  href: string;
  name: string;
  relativePath: string;
  size: number;
  isFolder: boolean;
  lastModified: string;
  lastModifiedTime: number;
}

interface ManifestEntry {
  relativePath: string;
  size: number;
  lastModified: string;
  lastModifiedTime: number;
  syncedAt: string;
  hash?: string;
}

interface Manifest {
  lastFullSync: string;
  lastIncrementalSync: string;
  totalFiles: number;
  totalSize: number;
  files: Record<string, ManifestEntry>;
}

interface SyncStats {
  started: string;
  foldersScanned: number;
  filesFound: number;
  filesNew: number;
  filesModified: number;
  filesUnchanged: number;
  filesDownloaded: number;
  bytesDownloaded: number;
  errors: string[];
  duration: number;
}

// ============================================================================
// LOGGING
// ============================================================================

function log(message: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO'): void {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}`;
  console.log(logLine);

  // Append to log file
  fs.appendFileSync(CONFIG.logFile, logLine + '\n');
}

// ============================================================================
// DIGEST AUTHENTICATION
// ============================================================================

function createDigestAuth(realm: string, nonce: string, uri: string, method: string): string {
  const ha1 = createHash('md5').update(`${CONFIG.username}:${realm}:${CONFIG.password}`).digest('hex');
  const ha2 = createHash('md5').update(`${method}:${uri}`).digest('hex');
  const nc = '00000001';
  const cnonce = Math.random().toString(36).substring(2, 10);
  const response = createHash('md5').update(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`).digest('hex');

  return `Digest username="${CONFIG.username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=auth, nc=${nc}, cnonce="${cnonce}", response="${response}"`;
}

// ============================================================================
// WEBDAV OPERATIONS
// ============================================================================

async function propfind(folderPath: string): Promise<FileInfo[]> {
  const url = new URL(folderPath ? `${CONFIG.baseUrl}/${folderPath}/` : `${CONFIG.baseUrl}/`);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname,
      method: 'PROPFIND',
      headers: {
        'Content-Type': 'application/xml',
        'Depth': '1'
      } as Record<string, string>
    };

    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/></d:prop></d:propfind>';

    const req = https.request(options, (res) => {
      if (res.statusCode === 401) {
        const wwwAuth = res.headers['www-authenticate'] || '';
        const realmMatch = wwwAuth.match(/realm="([^"]+)"/);
        const nonceMatch = wwwAuth.match(/nonce="([^"]+)"/);

        if (realmMatch && nonceMatch) {
          options.headers['Authorization'] = createDigestAuth(realmMatch[1], nonceMatch[1], url.pathname, 'PROPFIND');

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
      const relativePath = href.replace(/^https:\/\/[^/]+\/resources\//, '').replace(/\/$/, '');

      // Skip the current folder itself
      if (relativePath === currentPath || (!relativePath && !currentPath)) continue;

      const lastModified = lastModMatch ? lastModMatch[1] : '';
      const lastModifiedTime = lastModified ? new Date(lastModified).getTime() : 0;

      items.push({
        href,
        name,
        relativePath: decodeURIComponent(relativePath),
        size: sizeMatch ? parseInt(sizeMatch[1]) : 0,
        isFolder,
        lastModified,
        lastModifiedTime,
      });
    }
  }

  return items;
}

async function downloadFile(fileUrl: string, destPath: string): Promise<boolean> {
  if (CONFIG.dryRun) {
    return true;
  }

  const url = new URL(fileUrl);
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

    const handleResponse = (res: any, isAuth: boolean = false): void => {
      // Handle redirect
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
            file.on('finish', () => { file.close(); resolve(true); });
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

          const authReq = https.request(authOptions, (authRes) => handleResponse(authRes, true));
          authReq.on('error', () => resolve(false));
          authReq.end();
        } else {
          resolve(false);
        }
      } else if (res.statusCode === 200) {
        const file = fs.createWriteStream(destPath);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(true); });
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

// ============================================================================
// MANIFEST MANAGEMENT
// ============================================================================

function loadManifest(): Manifest {
  if (fs.existsSync(CONFIG.manifestFile)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG.manifestFile, 'utf-8'));
    } catch (e) {
      log(`Failed to load manifest, starting fresh: ${e}`, 'WARN');
    }
  }

  return {
    lastFullSync: '',
    lastIncrementalSync: '',
    totalFiles: 0,
    totalSize: 0,
    files: {},
  };
}

function saveManifest(manifest: Manifest): void {
  if (!CONFIG.dryRun) {
    fs.writeFileSync(CONFIG.manifestFile, JSON.stringify(manifest, null, 2));
  }
}

// ============================================================================
// SYNC LOGIC
// ============================================================================

function needsSync(file: FileInfo, manifest: Manifest): 'new' | 'modified' | 'unchanged' {
  const existing = manifest.files[file.relativePath];

  if (!existing) {
    return 'new';
  }

  // Check if modified (by date or size)
  if (file.lastModifiedTime > existing.lastModifiedTime || file.size !== existing.size) {
    return 'modified';
  }

  return 'unchanged';
}

async function scanFolder(
  folderPath: string,
  manifest: Manifest,
  stats: SyncStats,
  filesToSync: FileInfo[]
): Promise<void> {
  stats.foldersScanned++;

  try {
    const items = await propfind(folderPath);

    for (const item of items) {
      if (item.isFolder) {
        await scanFolder(item.relativePath, manifest, stats, filesToSync);
      } else {
        stats.filesFound++;
        const syncStatus = CONFIG.fullSync ? 'new' : needsSync(item, manifest);

        switch (syncStatus) {
          case 'new':
            stats.filesNew++;
            filesToSync.push(item);
            break;
          case 'modified':
            stats.filesModified++;
            filesToSync.push(item);
            break;
          case 'unchanged':
            stats.filesUnchanged++;
            break;
        }
      }
    }
  } catch (e) {
    const error = `Failed to scan folder ${folderPath}: ${e}`;
    log(error, 'ERROR');
    stats.errors.push(error);
  }
}

async function syncFiles(
  filesToSync: FileInfo[],
  manifest: Manifest,
  stats: SyncStats
): Promise<void> {
  const total = filesToSync.length;
  let current = 0;

  for (const file of filesToSync) {
    current++;
    const destPath = path.join(CONFIG.backupDir, file.relativePath);
    const prefix = CONFIG.dryRun ? '[DRY-RUN] ' : '';

    process.stdout.write(`\r${prefix}Syncing ${current}/${total}: ${file.name.substring(0, 40)}...`);

    if (await downloadFile(file.href, destPath)) {
      stats.filesDownloaded++;
      stats.bytesDownloaded += file.size;

      // Update manifest
      manifest.files[file.relativePath] = {
        relativePath: file.relativePath,
        size: file.size,
        lastModified: file.lastModified,
        lastModifiedTime: file.lastModifiedTime,
        syncedAt: new Date().toISOString(),
      };
    } else {
      const error = `Failed to download: ${file.relativePath}`;
      log(error, 'ERROR');
      stats.errors.push(error);
    }
  }

  if (total > 0) {
    console.log(''); // New line after progress
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function generateReport(stats: SyncStats, manifest: Manifest): string {
  const lines: string[] = [];

  lines.push('# WA Files Backup Report');
  lines.push('');
  lines.push(`**Date:** ${stats.started}`);
  lines.push(`**Duration:** ${stats.duration.toFixed(1)} seconds`);
  lines.push(`**Mode:** ${CONFIG.dryRun ? 'Dry Run' : CONFIG.fullSync ? 'Full Sync' : 'Incremental'}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Folders scanned: ${stats.foldersScanned}`);
  lines.push(`- Files found: ${stats.filesFound}`);
  lines.push(`- New files: ${stats.filesNew}`);
  lines.push(`- Modified files: ${stats.filesModified}`);
  lines.push(`- Unchanged files: ${stats.filesUnchanged}`);
  lines.push(`- Files downloaded: ${stats.filesDownloaded}`);
  lines.push(`- Bytes downloaded: ${formatBytes(stats.bytesDownloaded)}`);
  lines.push('');
  lines.push('## Manifest');
  lines.push('');
  lines.push(`- Total files tracked: ${manifest.totalFiles}`);
  lines.push(`- Total size: ${formatBytes(manifest.totalSize)}`);
  lines.push(`- Last full sync: ${manifest.lastFullSync || 'Never'}`);
  lines.push(`- Last incremental sync: ${manifest.lastIncrementalSync || 'Never'}`);

  if (stats.errors.length > 0) {
    lines.push('');
    lines.push('## Errors');
    lines.push('');
    for (const error of stats.errors) {
      lines.push(`- ${error}`);
    }
  }

  return lines.join('\n');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  if (!CONFIG.password) {
    console.log('WA Files Incremental Backup');
    console.log('===========================');
    console.log('');
    console.log('Usage: WA_PASSWORD=xxx npx tsx backup-incremental.ts [options]');
    console.log('');
    console.log('Options:');
    console.log('  --dry-run    Preview changes without downloading');
    console.log('  --full       Force full sync (ignore manifest)');
    console.log('');
    console.log('Environment:');
    console.log('  WA_PASSWORD       WebDAV password (required)');
    console.log('  BACKUP_DIR        Backup destination (default: ./backups)');
    console.log('  MANIFEST_FILE     Manifest location (default: ./backup-manifest.json)');
    console.log('  LOG_FILE          Log file location (default: ./backup.log)');
    process.exit(1);
  }

  const startTime = Date.now();
  const stats: SyncStats = {
    started: new Date().toISOString(),
    foldersScanned: 0,
    filesFound: 0,
    filesNew: 0,
    filesModified: 0,
    filesUnchanged: 0,
    filesDownloaded: 0,
    bytesDownloaded: 0,
    errors: [],
    duration: 0,
  };

  log(`=== Backup Started ===`);
  log(`Mode: ${CONFIG.dryRun ? 'Dry Run' : CONFIG.fullSync ? 'Full Sync' : 'Incremental'}`);
  log(`Destination: ${CONFIG.backupDir}`);

  // Create backup directory
  if (!fs.existsSync(CONFIG.backupDir)) {
    fs.mkdirSync(CONFIG.backupDir, { recursive: true });
  }

  // Load manifest
  const manifest = loadManifest();
  log(`Manifest loaded: ${Object.keys(manifest.files).length} files tracked`);

  // Scan for changes
  log('Scanning for changes...');
  const filesToSync: FileInfo[] = [];
  await scanFolder('', manifest, stats, filesToSync);

  log(`Scan complete: ${stats.filesNew} new, ${stats.filesModified} modified, ${stats.filesUnchanged} unchanged`);

  // Sync files
  if (filesToSync.length > 0) {
    log(`Syncing ${filesToSync.length} files...`);
    await syncFiles(filesToSync, manifest, stats);
  } else {
    log('No files to sync');
  }

  // Update manifest
  manifest.totalFiles = Object.keys(manifest.files).length;
  manifest.totalSize = Object.values(manifest.files).reduce((sum, f) => sum + f.size, 0);
  if (CONFIG.fullSync) {
    manifest.lastFullSync = new Date().toISOString();
  } else {
    manifest.lastIncrementalSync = new Date().toISOString();
  }
  saveManifest(manifest);

  stats.duration = (Date.now() - startTime) / 1000;

  // Generate report
  const report = generateReport(stats, manifest);
  const reportFile = `./backup-report-${new Date().toISOString().split('T')[0]}.md`;
  if (!CONFIG.dryRun) {
    fs.writeFileSync(reportFile, report);
  }

  // Print summary
  console.log('');
  console.log('='.repeat(60));
  console.log('Backup Complete');
  console.log('='.repeat(60));
  console.log(`  Duration: ${stats.duration.toFixed(1)}s`);
  console.log(`  Files scanned: ${stats.filesFound}`);
  console.log(`  Files synced: ${stats.filesDownloaded}`);
  console.log(`  Data transferred: ${formatBytes(stats.bytesDownloaded)}`);
  console.log(`  Errors: ${stats.errors.length}`);
  if (!CONFIG.dryRun) {
    console.log(`  Report: ${reportFile}`);
  }
  console.log('');

  log(`=== Backup Complete: ${stats.filesDownloaded} files, ${formatBytes(stats.bytesDownloaded)} ===`);

  // Exit with error if there were failures
  if (stats.errors.length > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  log(`Fatal error: ${e}`, 'ERROR');
  process.exit(1);
});
