# WA Files Crawler

A tool to discover and catalog files stored in Wild Apricot's `/resources/` directory.

## Problem

Wild Apricot does not provide an API to list files in the Files/Resources section. This tool discovers files by:

1. Checking known folder paths for accessibility
2. Crawling website pages to find embedded resource URLs
3. Probing for common folder names
4. Optionally downloading discovered files

## Features

- **Cookie-based authentication** for access to member-only content
- **Page crawling** to discover resource URLs embedded in content
- **Folder probing** to find undocumented directories
- **Detailed reporting** with file sizes, dates, and folder structure
- **Download mode** to retrieve all discovered files
- **Rate limiting** to avoid overwhelming the server

## Usage

```bash
# Basic crawl (public content only)
npx tsx wa-files-crawler.ts example.wildapricot.org

# Authenticated crawl with cookies
npx tsx wa-files-crawler.ts example.wildapricot.org --cookies cookies.txt

# Download all discovered files
npx tsx wa-files-crawler.ts example.wildapricot.org --cookies cookies.txt --download

# Specify output directory for downloads
npx tsx wa-files-crawler.ts example.wildapricot.org --download --output ./wa-files
```

## Cookie File Format

The tool accepts cookies in Netscape format (standard `cookies.txt`):

```
# Netscape HTTP Cookie File
.example.org    TRUE    /    FALSE    0    cookie_name    cookie_value
```

You can export cookies from your browser using extensions like "EditThisCookie" or by copying from browser dev tools.

### Key WA Cookies

The following cookies are typically needed for authenticated access:

- `waae268` / `waae268_legacy` - WA authentication token
- `csae268` / `csae268_legacy` - Session identifier
- `roae268` / `roae268_legacy` - Role (e.g., "Admin", "Member")

## Output

The crawler generates a JSON report (`wa-files-report-{domain}.json`) containing:

```json
{
  "site": "example.org",
  "crawledAt": "2026-01-01T12:00:00.000Z",
  "duration": 120,
  "authenticated": true,
  "folders": {
    "known": [...],
    "discovered": [...]
  },
  "files": [...],
  "statistics": {
    "totalFiles": 239,
    "totalSize": 124069071,
    "byExtension": {...},
    "byYear": {...}
  }
}
```

## Why This Exists

Wild Apricot's Files section can accumulate gigabytes of content over years. Without an API to list files, organizations have no easy way to:

- Audit what files exist
- Find orphaned/unused files
- Plan migrations to other platforms
- Backup file storage

This tool provides visibility into WA file storage that WA itself doesn't offer.

## Limitations

- **No directory listing**: WA folders don't return file listings. Files are only discovered when linked from pages.
- **Orphaned files**: Files not linked from any page won't be discovered.
- **Rate limiting**: WA may rate-limit aggressive crawling. The tool includes delays to mitigate this.
- **Cookie expiration**: Session cookies expire. Re-export cookies if authentication fails.

## Example Output

```
=== WA FILES CRAWLER ===
Site: sbnewcomers.org
Authenticated: Yes

Phase 1: Checking known folders...
✗ Documents - No directory listing
✗ Pictures - No directory listing
...

Phase 2: Crawling pages for resource URLs...
✓ Found 156 files from page content

Phase 3: Probing for additional folders...
✓ Discovered: Financials, Board Minutes, Training Guides

=== SUMMARY ===
Total files: 239
Total size: 118.3 MB
By type: 134 PDF, 46 JPG, 38 JPEG, 16 DOCX...
```

## License

MIT
