#!/usr/bin/env npx tsx
/**
 * Wild Apricot Files Crawler & Analyzer
 *
 * Discovers and analyzes files in WA's /resources/ directory structure.
 * Since WA doesn't provide a files API, this uses multiple discovery strategies:
 *
 * 1. Known folders from admin UI screenshots
 * 2. Crawling public pages for resource links
 * 3. Probing common folder naming patterns
 * 4. Following discovered links recursively
 *
 * Usage:
 *   npx tsx scripts/wa-files-crawler.ts --site sbnewcomers.org
 *   npx tsx scripts/wa-files-crawler.ts --site sbnewcomers.org --download
 *   npx tsx scripts/wa-files-crawler.ts --site sbnewcomers.org --cookies cookies.txt
 *
 * Cookie Authentication:
 *   Export cookies from your browser using an extension like "Get cookies.txt LOCALLY"
 *   or "EditThisCookie", then pass the file path with --cookies
 *
 * Copyright © 2025 ClubCalendar
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Configuration
// ============================================================================

interface Config {
  site: string;
  baseUrl: string;
  outputFile: string;
  downloadDir: string;
  shouldDownload: boolean;
  maxPages: number;
  maxDepth: number;
  timeout: number;
  verbose: boolean;
  cookiesFile: string;
  cookies: string; // Parsed cookie header string
}

// ============================================================================
// Cookie Parsing (Netscape format)
// ============================================================================

interface ParsedCookie {
  domain: string;
  path: string;
  secure: boolean;
  expiry: number;
  name: string;
  value: string;
}

/**
 * Parse Netscape cookies.txt format
 * Format: domain \t tailmatch \t path \t secure \t expiry \t name \t value
 */
function parseCookiesFile(filePath: string, targetDomain: string): string {
  if (!fs.existsSync(filePath)) {
    console.error(`ERROR: Cookies file not found: ${filePath}`);
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const cookies: ParsedCookie[] = [];

  for (const line of lines) {
    // Skip comments and empty lines
    if (line.startsWith('#') || line.trim() === '') continue;

    const parts = line.split('\t');
    if (parts.length < 7) continue;

    const [domain, , cookiePath, secure, expiry, name, value] = parts;

    // Check if cookie applies to target domain
    const domainMatch = domain.startsWith('.')
      ? targetDomain.endsWith(domain) || targetDomain === domain.slice(1)
      : targetDomain === domain;

    if (domainMatch) {
      cookies.push({
        domain,
        path: cookiePath,
        secure: secure.toLowerCase() === 'true',
        expiry: parseInt(expiry, 10),
        name: name.trim(),
        value: value.trim(),
      });
    }
  }

  // Build cookie header string
  const cookieHeader = cookies
    .map(c => `${c.name}=${c.value}`)
    .join('; ');

  return cookieHeader;
}

/**
 * Also support JSON cookie format (from EditThisCookie export)
 */
function parseJsonCookiesFile(filePath: string, targetDomain: string): string {
  const content = fs.readFileSync(filePath, 'utf-8');

  try {
    const cookies = JSON.parse(content);

    if (!Array.isArray(cookies)) {
      return '';
    }

    const matchingCookies = cookies.filter((c: any) => {
      const domain = c.domain || '';
      return domain.startsWith('.')
        ? targetDomain.endsWith(domain) || targetDomain === domain.slice(1)
        : targetDomain === domain || targetDomain.endsWith(domain);
    });

    return matchingCookies
      .map((c: any) => `${c.name}=${c.value}`)
      .join('; ');
  } catch {
    return '';
  }
}

/**
 * Load cookies from file (auto-detect format)
 */
function loadCookies(filePath: string, targetDomain: string): string {
  const content = fs.readFileSync(filePath, 'utf-8').trim();

  // Try JSON first
  if (content.startsWith('[')) {
    const cookies = parseJsonCookiesFile(filePath, targetDomain);
    if (cookies) return cookies;
  }

  // Fall back to Netscape format
  return parseCookiesFile(filePath, targetDomain);
}

// Known folders from WA admin screenshots
const KNOWN_FOLDERS = [
  'Documents',
  'Documents/Board Agendas and Minutes',
  'Documents/Board Agendas and Minutes/2023 Agendas',
  'Documents/Board Agendas and Minutes/2024 Agendas',
  'Documents/Board Agendas and Minutes/2024 Minutes',
  'Documents/Board Agendas and Minutes/2025 Minutes',
  'Documents/Board Agendas and Minutes/Agenda Archives',
  'Documents/Board Agendas and Minutes/Minutes Archives',
  'Documents/Club History',
  'Documents/Committee Information',
  'Documents/Directories',
  'Documents/eNews',
  'Documents/Equipment and Tools',
  'Documents/Financials',
  'Documents/Governing Documents',
  'Documents/Inventory',
  'Documents/Job Descriptions',
  'Documents/Member Information',
  'Documents/President\'s Party Contracts',
  'Documents/Terms and Conditions',
  'Documents/Training Guides',
  'Documents/Webmaster_Resources',
  'EmailTemplates',
  'Misfiled',
  'Pictures',
  'Site',
  'SiteAlbums',
  'stylesheets',
  'Theme',
  'Theme_Overrides',
  'Web_page_Images_and_Pictures',
];

// Common folder names to probe for discovery
const PROBE_FOLDERS = [
  'images', 'img', 'imgs', 'photos', 'photo',
  'files', 'uploads', 'media', 'assets',
  'docs', 'documents', 'pdfs', 'pdf',
  'newsletters', 'news', 'announcements',
  'events', 'calendar', 'activities',
  'members', 'membership', 'profiles',
  'forms', 'templates', 'downloads',
  'archive', 'archives', 'old', 'backup',
  'logos', 'branding', 'brand',
  'videos', 'video', 'audio',
  'flyers', 'posters', 'banners',
  'reports', 'minutes', 'agendas',
  '2020', '2021', '2022', '2023', '2024', '2025', '2026',
];

// File extensions to look for
const FILE_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp',
  '.mp3', '.mp4', '.wav', '.mov', '.avi',
  '.zip', '.txt', '.rtf', '.csv', '.json', '.xml',
  '.html', '.htm', '.css', '.js',
];

// ============================================================================
// Types
// ============================================================================

interface DiscoveredFile {
  url: string;
  path: string;
  name: string;
  extension: string;
  size?: number;
  lastModified?: string;
  contentType?: string;
  discoveredFrom: string;
  status: 'found' | 'downloaded' | 'failed' | 'forbidden';
  error?: string;
}

interface DiscoveredFolder {
  path: string;
  url: string;
  discoveredFrom: string;
  accessible: boolean;
  fileCount: number;
}

interface CrawlReport {
  site: string;
  crawledAt: string;
  duration: number;
  authenticated: boolean;
  cookiesFile?: string;
  folders: {
    known: DiscoveredFolder[];
    discovered: DiscoveredFolder[];
    probed: DiscoveredFolder[];
  };
  files: DiscoveredFile[];
  statistics: {
    totalFolders: number;
    accessibleFolders: number;
    totalFiles: number;
    totalSize: number;
    byExtension: Record<string, { count: number; size: number }>;
    byYear: Record<string, number>;
    oldestFile?: { url: string; date: string };
    newestFile?: { url: string; date: string };
  };
  errors: string[];
}

// ============================================================================
// HTTP Utilities
// ============================================================================

// Global config reference for cookies (set during init)
let globalConfig: Config | null = null;

async function fetchWithTimeout(
  url: string,
  timeout: number,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  // Build headers with cookies if available
  const headers: Record<string, string> = {
    'User-Agent': 'ClubCalendar-Crawler/1.0 (Resource Discovery)',
    ...(options.headers as Record<string, string> || {}),
  };

  if (globalConfig?.cookies) {
    headers['Cookie'] = globalConfig.cookies;
  }

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers,
      // Don't follow redirects to login page
      redirect: 'manual',
    });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function headFile(url: string, timeout: number): Promise<{
  exists: boolean;
  size?: number;
  lastModified?: string;
  contentType?: string;
  status: number;
}> {
  try {
    const response = await fetchWithTimeout(url, timeout, { method: 'HEAD' });

    return {
      exists: response.ok,
      size: parseInt(response.headers.get('content-length') || '0', 10) || undefined,
      lastModified: response.headers.get('last-modified') || undefined,
      contentType: response.headers.get('content-type') || undefined,
      status: response.status,
    };
  } catch (error) {
    return { exists: false, status: 0 };
  }
}

async function fetchPage(url: string, timeout: number): Promise<string | null> {
  try {
    const response = await fetchWithTimeout(url, timeout);
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

// ============================================================================
// URL Extraction
// ============================================================================

function extractResourceUrls(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();

  // Pattern for /resources/ paths
  const resourcePattern = /(?:href|src)=["']([^"']*\/resources\/[^"']+)["']/gi;
  let match;

  while ((match = resourcePattern.exec(html)) !== null) {
    let url = match[1];

    // Make absolute
    if (url.startsWith('/')) {
      url = `${baseUrl}${url}`;
    } else if (!url.startsWith('http')) {
      url = `${baseUrl}/${url}`;
    }

    // Clean up
    url = url.split('#')[0].split('?')[0];

    if (url.includes('/resources/')) {
      urls.add(url);
    }
  }

  // Also look for CDN URLs
  const cdnPattern = /https?:\/\/cdn\.wildapricot\.org\/[^\s"'<>]+/gi;
  while ((match = cdnPattern.exec(html)) !== null) {
    urls.add(match[0].replace(/["'<>]+$/, ''));
  }

  return Array.from(urls);
}

function extractPageLinks(html: string, baseUrl: string): string[] {
  const urls = new Set<string>();
  const linkPattern = /href=["']([^"']+)["']/gi;
  let match;

  while ((match = linkPattern.exec(html)) !== null) {
    let url = match[1];

    // Skip non-page links
    if (url.startsWith('#') || url.startsWith('javascript:') ||
        url.startsWith('mailto:') || url.startsWith('tel:')) {
      continue;
    }

    // Make absolute
    if (url.startsWith('/')) {
      url = `${baseUrl}${url}`;
    } else if (!url.startsWith('http')) {
      continue; // Skip relative URLs for simplicity
    }

    // Only include same-site URLs
    if (url.startsWith(baseUrl)) {
      urls.add(url.split('#')[0].split('?')[0]);
    }
  }

  return Array.from(urls);
}

// ============================================================================
// Discovery Functions
// ============================================================================

async function probeFolder(
  baseUrl: string,
  folderPath: string,
  timeout: number
): Promise<{ accessible: boolean; files: string[] }> {
  const folderUrl = `${baseUrl}/resources/${folderPath}`;

  // Try to access folder (WA might return directory listing or 403)
  const response = await fetchPage(folderUrl, timeout);

  if (!response) {
    return { accessible: false, files: [] };
  }

  // Look for file links in response
  const files = extractResourceUrls(response, baseUrl);

  return { accessible: true, files };
}

async function probeFile(
  url: string,
  timeout: number
): Promise<DiscoveredFile | null> {
  const info = await headFile(url, timeout);

  if (!info.exists) {
    return null;
  }

  const urlPath = new URL(url).pathname;
  const name = decodeURIComponent(urlPath.split('/').pop() || '');
  const extension = path.extname(name).toLowerCase();

  return {
    url,
    path: urlPath,
    name,
    extension,
    size: info.size,
    lastModified: info.lastModified,
    contentType: info.contentType,
    discoveredFrom: 'probe',
    status: 'found',
  };
}

async function discoverFromKnownFolders(
  config: Config,
  report: CrawlReport
): Promise<void> {
  console.log('\n📁 Checking known folders...');

  for (const folder of KNOWN_FOLDERS) {
    const folderUrl = `${config.baseUrl}/resources/${folder}`;

    if (config.verbose) {
      process.stdout.write(`  Checking ${folder}... `);
    }

    const result = await probeFolder(config.baseUrl, folder, config.timeout);

    const folderInfo: DiscoveredFolder = {
      path: folder,
      url: folderUrl,
      discoveredFrom: 'known',
      accessible: result.accessible,
      fileCount: result.files.length,
    };

    report.folders.known.push(folderInfo);

    if (config.verbose) {
      console.log(result.accessible ? `✓ (${result.files.length} files)` : '✗');
    }

    // Add discovered files
    for (const fileUrl of result.files) {
      const fileInfo = await probeFile(fileUrl, config.timeout);
      if (fileInfo) {
        fileInfo.discoveredFrom = `folder:${folder}`;
        report.files.push(fileInfo);
      }
    }
  }
}

// Member-only pages to crawl when authenticated
const MEMBER_PAGES = [
  '/members',
  '/member-resources',
  '/member-directory',
  '/my-profile',
  '/my-events',
  '/board',
  '/board-resources',
  '/documents',
  '/newsletters',
  '/committee-resources',
  '/admin-resources',
  '/forms',
  '/policies',
  '/bylaws',
  '/minutes',
  '/agendas',
  '/financials',
  '/reports',
  '/training',
  '/handbook',
  '/directory',
];

async function discoverFromPageCrawl(
  config: Config,
  report: CrawlReport
): Promise<void> {
  console.log('\n🔍 Crawling site pages for resources...');

  const visited = new Set<string>();
  const toVisit = [config.baseUrl];

  // Add member pages if authenticated
  if (config.cookies) {
    console.log('  (Including member-only pages due to authentication)');
    for (const page of MEMBER_PAGES) {
      toVisit.push(`${config.baseUrl}${page}`);
    }
  }

  const resourceUrls = new Set<string>();
  let pageCount = 0;

  while (toVisit.length > 0 && pageCount < config.maxPages) {
    const url = toVisit.shift()!;

    if (visited.has(url)) continue;
    visited.add(url);

    if (config.verbose) {
      process.stdout.write(`  [${++pageCount}/${config.maxPages}] ${url.slice(0, 60)}... `);
    }

    const html = await fetchPage(url, config.timeout);

    if (!html) {
      if (config.verbose) console.log('✗');
      continue;
    }

    // Extract resource URLs
    const resources = extractResourceUrls(html, config.baseUrl);
    resources.forEach(r => resourceUrls.add(r));

    if (config.verbose) {
      console.log(`✓ (${resources.length} resources)`);
    }

    // Add page links to visit queue (limited depth)
    if (pageCount < config.maxPages) {
      const links = extractPageLinks(html, config.baseUrl);
      for (const link of links) {
        if (!visited.has(link) && !toVisit.includes(link)) {
          toVisit.push(link);
        }
      }
    }
  }

  console.log(`  Found ${resourceUrls.size} unique resource URLs from ${pageCount} pages`);

  // Probe each discovered URL
  console.log('  Probing discovered resources...');
  let probed = 0;

  for (const url of resourceUrls) {
    // Skip if already found
    if (report.files.some(f => f.url === url)) continue;

    const fileInfo = await probeFile(url, config.timeout);
    if (fileInfo) {
      fileInfo.discoveredFrom = 'page-crawl';
      report.files.push(fileInfo);
      probed++;
    }

    if (config.verbose && probed % 10 === 0) {
      process.stdout.write(`\r  Probed ${probed} resources...`);
    }
  }

  if (config.verbose) console.log(`\r  Probed ${probed} resources ✓`);

  // Extract discovered folders from URLs
  const discoveredFolders = new Set<string>();
  for (const file of report.files) {
    const pathParts = file.path.split('/resources/')[1]?.split('/') || [];
    if (pathParts.length > 1) {
      // Get folder path (everything except filename)
      const folderPath = pathParts.slice(0, -1).join('/');
      discoveredFolders.add(folderPath);
    }
  }

  for (const folder of discoveredFolders) {
    if (!report.folders.known.some(f => f.path === folder)) {
      report.folders.discovered.push({
        path: folder,
        url: `${config.baseUrl}/resources/${folder}`,
        discoveredFrom: 'page-crawl',
        accessible: true,
        fileCount: report.files.filter(f => f.path.includes(`/resources/${folder}/`)).length,
      });
    }
  }
}

async function discoverFromProbing(
  config: Config,
  report: CrawlReport
): Promise<void> {
  console.log('\n🔎 Probing for additional folders...');

  const existingFolders = new Set([
    ...report.folders.known.map(f => f.path.toLowerCase()),
    ...report.folders.discovered.map(f => f.path.toLowerCase()),
  ]);

  let found = 0;

  for (const folder of PROBE_FOLDERS) {
    if (existingFolders.has(folder.toLowerCase())) continue;

    if (config.verbose) {
      process.stdout.write(`  Probing ${folder}... `);
    }

    const result = await probeFolder(config.baseUrl, folder, config.timeout);

    if (result.accessible) {
      found++;
      report.folders.probed.push({
        path: folder,
        url: `${config.baseUrl}/resources/${folder}`,
        discoveredFrom: 'probe',
        accessible: true,
        fileCount: result.files.length,
      });

      if (config.verbose) console.log(`✓ FOUND! (${result.files.length} files)`);

      // Add discovered files
      for (const fileUrl of result.files) {
        if (!report.files.some(f => f.url === fileUrl)) {
          const fileInfo = await probeFile(fileUrl, config.timeout);
          if (fileInfo) {
            fileInfo.discoveredFrom = `probed:${folder}`;
            report.files.push(fileInfo);
          }
        }
      }
    } else if (config.verbose) {
      console.log('✗');
    }
  }

  console.log(`  Discovered ${found} additional folders through probing`);
}

// ============================================================================
// Download Function
// ============================================================================

async function downloadFiles(
  config: Config,
  report: CrawlReport
): Promise<void> {
  console.log('\n📥 Downloading files...');

  // Create download directory
  if (!fs.existsSync(config.downloadDir)) {
    fs.mkdirSync(config.downloadDir, { recursive: true });
  }

  let downloaded = 0;
  let failed = 0;

  for (const file of report.files) {
    if (file.status !== 'found') continue;

    try {
      const response = await fetchWithTimeout(file.url, config.timeout * 2);

      if (!response.ok) {
        file.status = 'failed';
        file.error = `HTTP ${response.status}`;
        failed++;
        continue;
      }

      const buffer = await response.arrayBuffer();

      // Create folder structure
      const relativePath = file.path.replace(/^\/resources\//, '');
      const localPath = path.join(config.downloadDir, relativePath);
      const localDir = path.dirname(localPath);

      if (!fs.existsSync(localDir)) {
        fs.mkdirSync(localDir, { recursive: true });
      }

      fs.writeFileSync(localPath, Buffer.from(buffer));

      file.status = 'downloaded';
      file.size = buffer.byteLength;
      downloaded++;

      if (config.verbose) {
        console.log(`  ✓ ${relativePath} (${formatBytes(buffer.byteLength)})`);
      }
    } catch (error) {
      file.status = 'failed';
      file.error = error instanceof Error ? error.message : String(error);
      failed++;
    }
  }

  console.log(`  Downloaded: ${downloaded}, Failed: ${failed}`);
}

// ============================================================================
// Statistics
// ============================================================================

function calculateStatistics(report: CrawlReport): void {
  const stats = report.statistics;

  stats.totalFolders =
    report.folders.known.length +
    report.folders.discovered.length +
    report.folders.probed.length;

  stats.accessibleFolders = [
    ...report.folders.known,
    ...report.folders.discovered,
    ...report.folders.probed,
  ].filter(f => f.accessible).length;

  stats.totalFiles = report.files.length;
  stats.totalSize = report.files.reduce((sum, f) => sum + (f.size || 0), 0);

  // By extension
  stats.byExtension = {};
  for (const file of report.files) {
    const ext = file.extension || 'unknown';
    if (!stats.byExtension[ext]) {
      stats.byExtension[ext] = { count: 0, size: 0 };
    }
    stats.byExtension[ext].count++;
    stats.byExtension[ext].size += file.size || 0;
  }

  // By year (from lastModified)
  stats.byYear = {};
  for (const file of report.files) {
    if (file.lastModified) {
      try {
        const year = new Date(file.lastModified).getFullYear().toString();
        stats.byYear[year] = (stats.byYear[year] || 0) + 1;
      } catch {
        // Skip invalid dates
      }
    }
  }

  // Oldest/newest
  const filesWithDates = report.files.filter(f => f.lastModified);
  if (filesWithDates.length > 0) {
    filesWithDates.sort((a, b) =>
      new Date(a.lastModified!).getTime() - new Date(b.lastModified!).getTime()
    );

    stats.oldestFile = {
      url: filesWithDates[0].url,
      date: filesWithDates[0].lastModified!,
    };

    stats.newestFile = {
      url: filesWithDates[filesWithDates.length - 1].url,
      date: filesWithDates[filesWithDates.length - 1].lastModified!,
    };
  }
}

// ============================================================================
// Reporting
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function printReport(report: CrawlReport): void {
  console.log('\n' + '='.repeat(60));
  console.log('  WA FILES ANALYSIS REPORT');
  console.log('='.repeat(60));

  console.log(`\nSite: ${report.site}`);
  console.log(`Crawled: ${report.crawledAt}`);
  console.log(`Duration: ${report.duration}s`);
  console.log(`Authenticated: ${report.authenticated ? 'Yes' : 'No'}`);

  // Folders summary
  console.log('\n📁 FOLDERS');
  console.log('-'.repeat(40));
  console.log(`  Known folders checked: ${report.folders.known.length}`);
  console.log(`  Accessible: ${report.folders.known.filter(f => f.accessible).length}`);
  console.log(`  Discovered from pages: ${report.folders.discovered.length}`);
  console.log(`  Found by probing: ${report.folders.probed.length}`);

  // Files summary
  console.log('\n📄 FILES');
  console.log('-'.repeat(40));
  console.log(`  Total files: ${report.statistics.totalFiles}`);
  console.log(`  Total size: ${formatBytes(report.statistics.totalSize)}`);

  // By extension
  console.log('\n  By Extension:');
  const extensions = Object.entries(report.statistics.byExtension)
    .sort((a, b) => b[1].count - a[1].count);

  for (const [ext, data] of extensions.slice(0, 10)) {
    console.log(`    ${ext.padEnd(8)} ${String(data.count).padStart(4)} files  ${formatBytes(data.size).padStart(10)}`);
  }
  if (extensions.length > 10) {
    console.log(`    ... and ${extensions.length - 10} more types`);
  }

  // By year
  if (Object.keys(report.statistics.byYear).length > 0) {
    console.log('\n  By Year:');
    const years = Object.entries(report.statistics.byYear)
      .sort((a, b) => a[0].localeCompare(b[0]));

    for (const [year, count] of years) {
      console.log(`    ${year}: ${count} files`);
    }
  }

  // Date range
  if (report.statistics.oldestFile) {
    console.log('\n  Date Range:');
    console.log(`    Oldest: ${report.statistics.oldestFile.date}`);
    console.log(`            ${report.statistics.oldestFile.url.slice(0, 50)}...`);
  }
  if (report.statistics.newestFile) {
    console.log(`    Newest: ${report.statistics.newestFile.date}`);
    console.log(`            ${report.statistics.newestFile.url.slice(0, 50)}...`);
  }

  // Discovered folders (new/unknown)
  if (report.folders.discovered.length > 0 || report.folders.probed.length > 0) {
    console.log('\n🆕 NEWLY DISCOVERED FOLDERS');
    console.log('-'.repeat(40));

    for (const folder of [...report.folders.discovered, ...report.folders.probed]) {
      console.log(`  ${folder.path} (${folder.fileCount} files) [${folder.discoveredFrom}]`);
    }
  }

  // Errors
  if (report.errors.length > 0) {
    console.log('\n⚠️  ERRORS');
    console.log('-'.repeat(40));
    for (const error of report.errors.slice(0, 10)) {
      console.log(`  ${error}`);
    }
    if (report.errors.length > 10) {
      console.log(`  ... and ${report.errors.length - 10} more errors`);
    }
  }

  console.log('\n' + '='.repeat(60));
}

// ============================================================================
// CLI
// ============================================================================

function parseArgs(): Config {
  const args = process.argv.slice(2);

  const config: Config = {
    site: '',
    baseUrl: '',
    outputFile: '',
    downloadDir: './wa-files-download',
    shouldDownload: false,
    maxPages: 50,
    maxDepth: 3,
    timeout: 10000,
    verbose: true,
    cookiesFile: '',
    cookies: '',
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--site' && args[i + 1]) {
      config.site = args[++i];
    } else if (arg === '--output' && args[i + 1]) {
      config.outputFile = args[++i];
    } else if (arg === '--download-dir' && args[i + 1]) {
      config.downloadDir = args[++i];
    } else if (arg === '--download') {
      config.shouldDownload = true;
    } else if (arg === '--max-pages' && args[i + 1]) {
      config.maxPages = parseInt(args[++i], 10);
    } else if (arg === '--cookies' && args[i + 1]) {
      config.cookiesFile = args[++i];
    } else if (arg === '--quiet') {
      config.verbose = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
WA Files Crawler - Discover and analyze Wild Apricot file storage

USAGE:
  npx tsx scripts/wa-files-crawler.ts --site <domain> [OPTIONS]

OPTIONS:
  --site <domain>       WA site domain (e.g., sbnewcomers.org) [required]
  --cookies <file>      Cookies file for authentication (Netscape or JSON format)
  --output <file>       Save JSON report to file
  --download            Download all discovered files
  --download-dir <dir>  Download directory (default: ./wa-files-download)
  --max-pages <n>       Max pages to crawl (default: 50)
  --quiet               Reduce output verbosity
  --help                Show this help

COOKIE AUTHENTICATION:
  To access member-only content, export cookies from your browser:

  1. Install a browser extension:
     - Chrome: "Get cookies.txt LOCALLY" or "EditThisCookie"
     - Firefox: "cookies.txt" or "Cookie Quick Manager"
     - Safari: Use developer tools (see below)

  2. Log in to sbnewcomers.org as admin

  3. Export cookies to a file (cookies.txt or cookies.json)

  4. Run with: --cookies cookies.txt

  Safari (manual export):
    In Web Inspector > Storage > Cookies, you can copy values.
    Or use: document.cookie in the console (limited).

EXAMPLES:
  # Analyze public files
  npx tsx scripts/wa-files-crawler.ts --site sbnewcomers.org

  # Analyze with authentication (member/admin content)
  npx tsx scripts/wa-files-crawler.ts --site sbnewcomers.org --cookies cookies.txt

  # Download all discovered files
  npx tsx scripts/wa-files-crawler.ts --site sbnewcomers.org --cookies cookies.txt --download
`);
      process.exit(0);
    }
  }

  if (!config.site) {
    console.error('ERROR: --site is required');
    console.error('Run with --help for usage');
    process.exit(1);
  }

  // Normalize site URL
  config.site = config.site.replace(/^https?:\/\//, '').replace(/\/$/, '');
  config.baseUrl = `https://${config.site}`;

  if (!config.outputFile) {
    config.outputFile = `wa-files-report-${config.site.replace(/\./g, '-')}.json`;
  }

  // Load cookies if specified
  if (config.cookiesFile) {
    config.cookies = loadCookies(config.cookiesFile, config.site);
    if (!config.cookies) {
      console.error(`WARNING: No cookies found for domain ${config.site} in ${config.cookiesFile}`);
    }
  }

  return config;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const config = parseArgs();
  globalConfig = config; // Set global for HTTP functions
  const startTime = Date.now();

  console.log('');
  console.log('🔍 WA Files Crawler');
  console.log('='.repeat(60));
  console.log(`Site: ${config.site}`);
  console.log(`Base URL: ${config.baseUrl}`);

  if (config.cookies) {
    console.log(`🔐 Authentication: Using cookies from ${config.cookiesFile}`);
    console.log(`   Cookie length: ${config.cookies.length} chars`);
  } else {
    console.log(`🔓 Authentication: None (public access only)`);
  }
  console.log('');

  const report: CrawlReport = {
    site: config.site,
    crawledAt: new Date().toISOString(),
    duration: 0,
    authenticated: !!config.cookies,
    cookiesFile: config.cookiesFile || undefined,
    folders: {
      known: [],
      discovered: [],
      probed: [],
    },
    files: [],
    statistics: {
      totalFolders: 0,
      accessibleFolders: 0,
      totalFiles: 0,
      totalSize: 0,
      byExtension: {},
      byYear: {},
    },
    errors: [],
  };

  try {
    // Phase 1: Check known folders
    await discoverFromKnownFolders(config, report);

    // Phase 2: Crawl pages for resources
    await discoverFromPageCrawl(config, report);

    // Phase 3: Probe for additional folders
    await discoverFromProbing(config, report);

    // Phase 4: Download if requested
    if (config.shouldDownload) {
      await downloadFiles(config, report);
    }

    // Calculate statistics
    calculateStatistics(report);

    report.duration = Math.round((Date.now() - startTime) / 1000);

    // Print report
    printReport(report);

    // Save JSON report
    fs.writeFileSync(config.outputFile, JSON.stringify(report, null, 2));
    console.log(`\n📊 Report saved to: ${config.outputFile}`);

  } catch (error) {
    console.error('\n❌ Crawl failed:', error);
    report.errors.push(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
