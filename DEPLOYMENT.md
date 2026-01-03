# WA Files Backup - Mail Server Deployment

**Purpose:** Nightly incremental backup of Wild Apricot file storage to mail.sbnewcomers.org

## Overview

This backup system:

- Runs nightly at 2 AM via cron
- Downloads only new or modified files (incremental)
- Maintains a manifest of all synced files
- Keeps 30 days of logs
- Provides protection against WA data loss (which has happened before)

## Prerequisites

- SSH access to mail.sbnewcomers.org
- Node.js 18+ installed on server
- WA WebDAV password (technology@sbnewcomers.org account)

## Installation Steps

### 1. Create Backup Directory

```bash
ssh sbnewcom@mail.sbnewcomers.org

mkdir -p /home/sbnewcom/wa-backup
mkdir -p /home/sbnewcom/wa-backup/logs
mkdir -p /home/sbnewcom/wa-backup/files
```

### 2. Upload Backup Scripts

From your local machine:

```bash
cd /Users/edf/wa-files-crawler

scp backup-incremental.ts sbnewcom@mail.sbnewcomers.org:/home/sbnewcom/wa-backup/
scp cron-backup.sh sbnewcom@mail.sbnewcomers.org:/home/sbnewcom/wa-backup/
scp package.json sbnewcom@mail.sbnewcomers.org:/home/sbnewcom/wa-backup/
```

### 3. Install Dependencies

```bash
ssh sbnewcom@mail.sbnewcomers.org

cd /home/sbnewcom/wa-backup
npm install
```

### 4. Create Password File

Store the WebDAV password securely:

```bash
# Create password file (replace YOUR_PASSWORD with actual password)
echo "YOUR_PASSWORD" > /home/sbnewcom/wa-backup/.wa-password
chmod 600 /home/sbnewcom/wa-backup/.wa-password
```

### 5. Make Scripts Executable

```bash
chmod +x /home/sbnewcom/wa-backup/cron-backup.sh
```

### 6. Test Manual Run

```bash
cd /home/sbnewcom/wa-backup
WA_PASSWORD=$(cat .wa-password) npx tsx backup-incremental.ts --dry-run
```

If dry-run looks good, run actual backup:

```bash
WA_PASSWORD=$(cat .wa-password) npx tsx backup-incremental.ts
```

### 7. Set Up Cron Job

```bash
crontab -e
```

Add this line for nightly backup at 2 AM:

```
0 2 * * * /home/sbnewcom/wa-backup/cron-backup.sh
```

Save and exit.

### 8. Verify Cron Installation

```bash
crontab -l
```

Should show:
```
0 2 * * * /home/sbnewcom/wa-backup/cron-backup.sh
```

## File Locations

| Path | Purpose |
|------|---------|
| `/home/sbnewcom/wa-backup/` | Backup home directory |
| `/home/sbnewcom/wa-backup/files/` | Downloaded WA files |
| `/home/sbnewcom/wa-backup/logs/` | Daily backup logs |
| `/home/sbnewcom/wa-backup/backup-manifest.json` | File tracking manifest |
| `/home/sbnewcom/wa-backup/.wa-password` | WebDAV password (secure) |

## Manual Operations

### Run Incremental Backup

```bash
cd /home/sbnewcom/wa-backup
./cron-backup.sh
```

### Run Full Backup (Re-download Everything)

```bash
cd /home/sbnewcom/wa-backup
WA_PASSWORD=$(cat .wa-password) npx tsx backup-incremental.ts --full
```

### Check Backup Status

```bash
# View latest log
tail -50 /home/sbnewcom/wa-backup/logs/backup-$(date +%Y-%m-%d).log

# Check manifest
cat /home/sbnewcom/wa-backup/backup-manifest.json | jq '.totalFiles, .totalSize, .lastIncrementalSync'

# Check disk usage
du -sh /home/sbnewcom/wa-backup/files/
```

### Dry Run (Preview Changes)

```bash
cd /home/sbnewcom/wa-backup
WA_PASSWORD=$(cat .wa-password) npx tsx backup-incremental.ts --dry-run
```

## Monitoring

### Check Recent Backups

```bash
ls -la /home/sbnewcom/wa-backup/logs/
```

### View Backup Report

```bash
cat /home/sbnewcom/wa-backup/backup-report-$(date +%Y-%m-%d).md
```

### Check for Errors

```bash
grep -i error /home/sbnewcom/wa-backup/logs/backup-*.log | tail -20
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Password file not found" | Create `/home/sbnewcom/wa-backup/.wa-password` |
| "Authentication failed" | Verify password is correct |
| "Connection refused" | Check if WA is accessible |
| Cron not running | Check `crontab -l` and `/var/log/syslog` |
| Disk full | Clean up old backups or increase storage |

## Restore Files

If WA loses files, restore from backup:

```bash
# List available files
ls /home/sbnewcom/wa-backup/files/

# Copy specific file to download locally
scp sbnewcom@mail.sbnewcomers.org:/home/sbnewcom/wa-backup/files/Documents/SomeFile.pdf ./
```

## Security Notes

- Password file has restricted permissions (600)
- Backup runs as sbnewcom user
- Files are stored on mail server, not accessible from web
- WebDAV uses HTTPS with digest authentication

## Disk Space

Estimated storage requirements:

- Current WA storage: ~2.5 GB
- Expected growth: ~500 MB/year
- Recommend: 5 GB allocated for backups

Check available space:

```bash
df -h /home/sbnewcom/
```
