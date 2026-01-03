#!/usr/bin/env npx tsx
/**
 * WA Files Analyzer
 *
 * Analyzes downloaded WA files and generates cleanup recommendations.
 *
 * Features:
 * - Duplicate file detection (by content hash)
 * - Old/dated file identification
 * - Large file reporting
 * - Storage breakdown by folder
 * - Cleanup recommendations
 * - Detection of files linked from WA pages
 *
 * Usage: npx tsx analyze-files.ts [options]
 *   --source <dir>     Source directory (default: ./downloads-webdav)
 *   --report <file>    Output report file (default: ./analysis-report.md)
 *   --crawl-links      Crawl WA site to detect linked files
 *   --site <url>       WA site URL (default: https://sbnewcomers.org)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// ============================================================================
// CONFIGURATION
// ============================================================================

interface Config {
  sourceDir: string;
  reportFile: string;
  crawlLinks: boolean;
  siteUrl: string;
  resourcesUrl: string;
}

function parseArgs(): Config {
  const args = process.argv.slice(2);
  const config: Config = {
    sourceDir: './downloads-webdav',
    reportFile: './analysis-report.md',
    crawlLinks: false,
    siteUrl: 'https://sbnewcomers.org',
    resourcesUrl: 'https://sbnewcomers.org/resources',
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--source':
        config.sourceDir = args[++i];
        break;
      case '--report':
        config.reportFile = args[++i];
        break;
      case '--crawl-links':
        config.crawlLinks = true;
        break;
      case '--site':
        config.siteUrl = args[++i];
        config.resourcesUrl = `${config.siteUrl}/resources`;
        break;
    }
  }

  return config;
}

// ============================================================================
// FILE ANALYSIS
// ============================================================================

interface FileInfo {
  path: string;
  relativePath: string;
  name: string;
  folder: string;
  size: number;
  extension: string;
  hash?: string;
  mtime: Date;
  yearInName?: number;
}

interface DuplicateGroup {
  hash: string;
  size: number;
  files: FileInfo[];
  wastedBytes: number;
}

interface AnalysisResult {
  totalFiles: number;
  totalSize: number;
  files: FileInfo[];
  duplicates: DuplicateGroup[];
  oldFiles: FileInfo[];
  largeFiles: FileInfo[];
  videoFiles: FileInfo[];
  folderStats: Map<string, { count: number; size: number }>;
  extensionStats: Map<string, { count: number; size: number }>;
  linkedFiles: Set<string>;
  unlinkedFiles: FileInfo[];
}

function scanDirectory(dir: string, baseDir: string): FileInfo[] {
  const files: FileInfo[] = [];

  if (!fs.existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relativePath = path.relative(baseDir, fullPath);

    if (entry.isDirectory()) {
      files.push(...scanDirectory(fullPath, baseDir));
    } else if (entry.isFile()) {
      const stats = fs.statSync(fullPath);
      const ext = path.extname(entry.name).toLowerCase();
      const folder = path.dirname(relativePath);

      // Extract year from filename
      const yearMatch = entry.name.match(/\b(20\d{2})\b/);
      const yearInName = yearMatch ? parseInt(yearMatch[1]) : undefined;

      files.push({
        path: fullPath,
        relativePath,
        name: entry.name,
        folder: folder === '.' ? '' : folder,
        size: stats.size,
        extension: ext,
        mtime: stats.mtime,
        yearInName,
      });
    }
  }

  return files;
}

function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(content).digest('hex');
}

function findDuplicates(files: FileInfo[]): DuplicateGroup[] {
  console.log('Computing file hashes for duplicate detection...');

  // Group by size first (optimization)
  const sizeGroups = new Map<number, FileInfo[]>();
  for (const file of files) {
    const group = sizeGroups.get(file.size) || [];
    group.push(file);
    sizeGroups.set(file.size, group);
  }

  // Only compute hashes for files with same size
  const hashGroups = new Map<string, FileInfo[]>();
  let hashCount = 0;

  for (const [size, group] of sizeGroups) {
    if (group.length > 1) {
      for (const file of group) {
        try {
          file.hash = computeFileHash(file.path);
          hashCount++;
          if (hashCount % 100 === 0) {
            process.stdout.write(`\rHashed ${hashCount} files...`);
          }
          const hashGroup = hashGroups.get(file.hash) || [];
          hashGroup.push(file);
          hashGroups.set(file.hash, hashGroup);
        } catch (e) {
          // Skip files that can't be read
        }
      }
    }
  }
  console.log(`\rHashed ${hashCount} files for duplicate detection.`);

  // Find actual duplicates
  const duplicates: DuplicateGroup[] = [];
  for (const [hash, group] of hashGroups) {
    if (group.length > 1) {
      duplicates.push({
        hash,
        size: group[0].size,
        files: group,
        wastedBytes: group[0].size * (group.length - 1),
      });
    }
  }

  return duplicates.sort((a, b) => b.wastedBytes - a.wastedBytes);
}

function findOldFiles(files: FileInfo[], cutoffYear: number = 2022): FileInfo[] {
  return files.filter(f => f.yearInName && f.yearInName <= cutoffYear)
    .sort((a, b) => (a.yearInName || 0) - (b.yearInName || 0));
}

function findLargeFiles(files: FileInfo[], minSize: number = 5 * 1024 * 1024): FileInfo[] {
  return files.filter(f => f.size >= minSize)
    .sort((a, b) => b.size - a.size);
}

function findVideoFiles(files: FileInfo[]): FileInfo[] {
  const videoExtensions = ['.mp4', '.mov', '.avi', '.wmv', '.mkv', '.webm', '.m4v'];
  return files.filter(f => videoExtensions.includes(f.extension))
    .sort((a, b) => b.size - a.size);
}

function computeFolderStats(files: FileInfo[]): Map<string, { count: number; size: number }> {
  const stats = new Map<string, { count: number; size: number }>();

  for (const file of files) {
    const folder = file.folder || '(root)';
    const current = stats.get(folder) || { count: 0, size: 0 };
    current.count++;
    current.size += file.size;
    stats.set(folder, current);
  }

  return stats;
}

function computeExtensionStats(files: FileInfo[]): Map<string, { count: number; size: number }> {
  const stats = new Map<string, { count: number; size: number }>();

  for (const file of files) {
    const ext = file.extension || '(none)';
    const current = stats.get(ext) || { count: 0, size: 0 };
    current.count++;
    current.size += file.size;
    stats.set(ext, current);
  }

  return stats;
}

// ============================================================================
// LINKED FILE DETECTION
// ============================================================================

async function crawlForLinkedFiles(siteUrl: string, resourcesUrl: string): Promise<Set<string>> {
  console.log('Crawling site to detect linked files...');
  const linkedFiles = new Set<string>();

  // Common pages to check
  const pagesToCheck = [
    '/',
    '/page-18060', // Common WA page pattern
    '/about',
    '/events',
    '/membership',
    '/resources',
    '/contact',
  ];

  // Also check sitemap if available
  try {
    const sitemapUrl = `${siteUrl}/sitemap.xml`;
    const response = await fetch(sitemapUrl);
    if (response.ok) {
      const sitemap = await response.text();
      const urlMatches = sitemap.matchAll(/<loc>([^<]+)<\/loc>/g);
      for (const match of urlMatches) {
        const url = new URL(match[1]);
        if (url.origin === siteUrl) {
          pagesToCheck.push(url.pathname);
        }
      }
    }
  } catch (e) {
    console.log('Sitemap not available, using default pages');
  }

  // Dedupe pages
  const uniquePages = [...new Set(pagesToCheck)];
  console.log(`Checking ${uniquePages.length} pages for file references...`);

  for (const pagePath of uniquePages.slice(0, 50)) { // Limit to 50 pages
    try {
      const pageUrl = `${siteUrl}${pagePath}`;
      const response = await fetch(pageUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WAFilesAnalyzer/1.0)',
        },
      });

      if (response.ok) {
        const html = await response.text();

        // Find all references to /resources/
        const resourceMatches = html.matchAll(/["']([^"']*\/resources\/[^"']+)["']/g);
        for (const match of resourceMatches) {
          let resourcePath = match[1];
          // Normalize path
          if (resourcePath.startsWith('/')) {
            resourcePath = resourcePath.replace('/resources/', '');
          } else if (resourcePath.startsWith(resourcesUrl)) {
            resourcePath = resourcePath.replace(resourcesUrl + '/', '');
          }
          // URL decode
          try {
            resourcePath = decodeURIComponent(resourcePath);
            linkedFiles.add(resourcePath);
          } catch (e) {
            linkedFiles.add(resourcePath);
          }
        }
      }
    } catch (e) {
      // Skip pages that fail
    }
  }

  console.log(`Found ${linkedFiles.size} file references in site pages.`);
  return linkedFiles;
}

// ============================================================================
// REPORT GENERATION
// ============================================================================

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function generateReport(result: AnalysisResult, config: Config): string {
  const lines: string[] = [];

  lines.push('# Wild Apricot File Storage Analysis Report');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString().split('T')[0]}`);
  lines.push(`**Source:** ${config.sourceDir}`);
  lines.push(`**Total Files:** ${result.totalFiles.toLocaleString()}`);
  lines.push(`**Total Size:** ${formatBytes(result.totalSize)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  // Executive Summary
  lines.push('## Executive Summary');
  lines.push('');

  const duplicateWaste = result.duplicates.reduce((sum, d) => sum + d.wastedBytes, 0);
  const videoSize = result.videoFiles.reduce((sum, f) => sum + f.size, 0);
  const oldFileSize = result.oldFiles.reduce((sum, f) => sum + f.size, 0);

  lines.push('| Category | Files | Size | Potential Savings |');
  lines.push('|----------|-------|------|-------------------|');
  lines.push(`| Duplicate files | ${result.duplicates.reduce((sum, d) => sum + d.files.length - 1, 0)} | - | ${formatBytes(duplicateWaste)} |`);
  lines.push(`| Video files | ${result.videoFiles.length} | ${formatBytes(videoSize)} | Move to YouTube |`);
  lines.push(`| Old files (pre-2023) | ${result.oldFiles.length} | ${formatBytes(oldFileSize)} | Archive/delete |`);
  lines.push(`| Large files (>5MB) | ${result.largeFiles.length} | ${formatBytes(result.largeFiles.reduce((sum, f) => sum + f.size, 0))} | Optimize |`);
  if (result.unlinkedFiles.length > 0) {
    const unlinkedSize = result.unlinkedFiles.reduce((sum, f) => sum + f.size, 0);
    lines.push(`| Unlinked files | ${result.unlinkedFiles.length} | ${formatBytes(unlinkedSize)} | Safe to delete |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Storage Breakdown
  lines.push('## Storage Breakdown by Folder');
  lines.push('');
  lines.push('| Folder | Files | Size | % of Total |');
  lines.push('|--------|-------|------|------------|');

  const sortedFolders = [...result.folderStats.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 20);

  for (const [folder, stats] of sortedFolders) {
    const pct = ((stats.size / result.totalSize) * 100).toFixed(1);
    lines.push(`| ${folder} | ${stats.count} | ${formatBytes(stats.size)} | ${pct}% |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // File Types
  lines.push('## Storage by File Type');
  lines.push('');
  lines.push('| Extension | Files | Size | % of Total |');
  lines.push('|-----------|-------|------|------------|');

  const sortedExtensions = [...result.extensionStats.entries()]
    .sort((a, b) => b[1].size - a[1].size)
    .slice(0, 15);

  for (const [ext, stats] of sortedExtensions) {
    const pct = ((stats.size / result.totalSize) * 100).toFixed(1);
    lines.push(`| ${ext} | ${stats.count} | ${formatBytes(stats.size)} | ${pct}% |`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Cleanup Recommendations
  lines.push('## Cleanup Recommendations');
  lines.push('');

  lines.push('### 1. Move Videos to External Hosting');
  lines.push('');
  lines.push('Video files consume significant storage and can be hosted free on YouTube (unlisted) or Vimeo.');
  lines.push('');
  if (result.videoFiles.length > 0) {
    lines.push('| File | Size | Recommendation |');
    lines.push('|------|------|----------------|');
    for (const video of result.videoFiles.slice(0, 10)) {
      lines.push(`| ${video.relativePath} | ${formatBytes(video.size)} | Upload to YouTube, replace with link |`);
    }
  } else {
    lines.push('No video files found.');
  }
  lines.push('');

  lines.push('### 2. Remove Duplicate Files');
  lines.push('');
  lines.push(`Found ${result.duplicates.length} groups of duplicate files wasting ${formatBytes(duplicateWaste)}.`);
  lines.push('');
  if (result.duplicates.length > 0) {
    lines.push('Top duplicates:');
    lines.push('');
    lines.push('| File | Copies | Wasted Space |');
    lines.push('|------|--------|--------------|');
    for (const dup of result.duplicates.slice(0, 10)) {
      lines.push(`| ${dup.files[0].name} | ${dup.files.length} | ${formatBytes(dup.wastedBytes)} |`);
    }
  }
  lines.push('');

  lines.push('### 3. Archive Old Files');
  lines.push('');
  lines.push('Files with years 2022 or earlier in the filename may be obsolete.');
  lines.push('');
  const oldByYear = new Map<number, { count: number; size: number }>();
  for (const file of result.oldFiles) {
    if (file.yearInName) {
      const current = oldByYear.get(file.yearInName) || { count: 0, size: 0 };
      current.count++;
      current.size += file.size;
      oldByYear.set(file.yearInName, current);
    }
  }
  lines.push('| Year | Files | Size | Recommendation |');
  lines.push('|------|-------|------|----------------|');
  for (const [year, stats] of [...oldByYear.entries()].sort((a, b) => a[0] - b[0])) {
    const rec = year < 2020 ? 'Delete' : 'Review';
    lines.push(`| ${year} | ${stats.count} | ${formatBytes(stats.size)} | ${rec} |`);
  }
  lines.push('');

  lines.push('### 4. Optimize Large Files');
  lines.push('');
  lines.push('Files over 5 MB that may benefit from compression or optimization:');
  lines.push('');
  lines.push('| File | Size | Type | Suggestion |');
  lines.push('|------|------|------|------------|');
  for (const file of result.largeFiles.slice(0, 15)) {
    let suggestion = 'Review';
    if (file.extension === '.docx' || file.extension === '.doc') {
      suggestion = 'May have embedded images - export as PDF';
    } else if (file.extension === '.pdf') {
      suggestion = 'Compress with PDF optimizer';
    } else if (['.jpg', '.jpeg', '.png'].includes(file.extension)) {
      suggestion = 'Resize/compress image';
    }
    lines.push(`| ${file.name} | ${formatBytes(file.size)} | ${file.extension} | ${suggestion} |`);
  }
  lines.push('');

  // Linked Files Analysis
  if (result.linkedFiles.size > 0) {
    lines.push('### 5. Unlinked Files (Safe to Delete)');
    lines.push('');
    lines.push('**WARNING:** These files were not found referenced in any scanned website pages.');
    lines.push('They may still be used by:');
    lines.push('');
    lines.push('- Email templates');
    lines.push('- Event descriptions');
    lines.push('- Member-only pages not scanned');
    lines.push('- External links');
    lines.push('');
    lines.push('**Verify before deleting!**');
    lines.push('');

    if (result.unlinkedFiles.length > 0) {
      lines.push('| File | Size | Folder |');
      lines.push('|------|------|--------|');
      for (const file of result.unlinkedFiles.slice(0, 30)) {
        lines.push(`| ${file.name} | ${formatBytes(file.size)} | ${file.folder} |`);
      }
      if (result.unlinkedFiles.length > 30) {
        lines.push(`| ... and ${result.unlinkedFiles.length - 30} more | | |`);
      }
    }
  } else {
    lines.push('### 5. Linked File Detection');
    lines.push('');
    lines.push('Run with `--crawl-links` to detect which files are referenced from website pages.');
    lines.push('This helps identify orphaned files that are safe to delete.');
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  // Alternative Storage Recommendations
  lines.push('## Alternative Storage Options');
  lines.push('');
  lines.push('Consider moving content to these services to reduce WA storage usage:');
  lines.push('');
  lines.push('| Content Type | Recommended Service | Benefits |');
  lines.push('|--------------|---------------------|----------|');
  lines.push('| Videos | YouTube (unlisted) | Free, unlimited, streaming |');
  lines.push('| Training docs | Google Drive | Free 15GB, easy sharing |');
  lines.push('| Photo albums | Google Photos | Free backup, albums |');
  lines.push('| Historical archives | Dropbox/Drive | Long-term storage |');
  lines.push('| Large PDFs | Google Drive | Direct link embedding |');
  lines.push('');
  lines.push('**Implementation approach:**');
  lines.push('');
  lines.push('1. Upload file to external service');
  lines.push('2. Get shareable/embed link');
  lines.push('3. Update WA page to use external link');
  lines.push('4. Delete file from WA after verification');
  lines.push('');
  lines.push('---');
  lines.push('');

  // Important Warning
  lines.push('## Important: Detecting Linked Files');
  lines.push('');
  lines.push('Before deleting any file, verify it is not linked from:');
  lines.push('');
  lines.push('- **Website pages** - Check page editor for file references');
  lines.push('- **Email templates** - WA email templates may reference /resources/ files');
  lines.push('- **Event descriptions** - Events often embed images from file storage');
  lines.push('- **Gadgets/widgets** - Custom HTML gadgets may reference files');
  lines.push('- **External sites** - Other sites may link to your public files');
  lines.push('');
  lines.push('**To detect linked files:**');
  lines.push('');
  lines.push('```bash');
  lines.push('# Run analysis with link detection');
  lines.push('npx tsx analyze-files.ts --crawl-links');
  lines.push('```');
  lines.push('');
  lines.push('This scans public website pages for file references. However, it cannot detect:');
  lines.push('');
  lines.push('- Member-only page references (requires authentication)');
  lines.push('- Email template references');
  lines.push('- Event description references');
  lines.push('');
  lines.push('For complete safety, search WA admin for the filename before deleting.');
  lines.push('');

  return lines.join('\n');
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  const config = parseArgs();

  console.log('WA Files Analyzer');
  console.log('=================');
  console.log(`Source: ${config.sourceDir}`);
  console.log(`Report: ${config.reportFile}`);
  console.log('');

  // Scan files
  console.log('Scanning files...');
  const files = scanDirectory(config.sourceDir, config.sourceDir);
  console.log(`Found ${files.length} files.`);

  if (files.length === 0) {
    console.error('No files found. Check source directory.');
    process.exit(1);
  }

  // Analyze
  const result: AnalysisResult = {
    totalFiles: files.length,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    files,
    duplicates: findDuplicates(files),
    oldFiles: findOldFiles(files),
    largeFiles: findLargeFiles(files),
    videoFiles: findVideoFiles(files),
    folderStats: computeFolderStats(files),
    extensionStats: computeExtensionStats(files),
    linkedFiles: new Set(),
    unlinkedFiles: [],
  };

  // Crawl for linked files if requested
  if (config.crawlLinks) {
    result.linkedFiles = await crawlForLinkedFiles(config.siteUrl, config.resourcesUrl);

    // Find unlinked files
    result.unlinkedFiles = files.filter(f => {
      // Check if file path matches any linked file
      const relativePath = f.relativePath.replace(/\\/g, '/');
      for (const linked of result.linkedFiles) {
        if (relativePath.includes(linked) || linked.includes(f.name)) {
          return false;
        }
      }
      return true;
    });
  }

  // Generate report
  console.log('Generating report...');
  const report = generateReport(result, config);
  fs.writeFileSync(config.reportFile, report);

  console.log('');
  console.log('=================');
  console.log('Analysis Complete');
  console.log('=================');
  console.log(`Total files: ${result.totalFiles}`);
  console.log(`Total size: ${formatBytes(result.totalSize)}`);
  console.log(`Duplicates: ${result.duplicates.length} groups`);
  console.log(`Old files: ${result.oldFiles.length}`);
  console.log(`Large files: ${result.largeFiles.length}`);
  console.log(`Video files: ${result.videoFiles.length}`);
  if (config.crawlLinks) {
    console.log(`Linked files: ${result.linkedFiles.size}`);
    console.log(`Unlinked files: ${result.unlinkedFiles.length}`);
  }
  console.log('');
  console.log(`Report saved to: ${config.reportFile}`);
}

main().catch(console.error);
