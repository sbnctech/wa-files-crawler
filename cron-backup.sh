#!/bin/bash
#
# WA Files Nightly Backup - Cron Wrapper
#
# This script runs the incremental backup and handles logging/notifications.
# Designed to be run from cron on mail.sbnewcomers.org.
#
# Installation:
#   1. Copy this script to /home/sbnewcom/wa-backup/cron-backup.sh
#   2. chmod +x /home/sbnewcom/wa-backup/cron-backup.sh
#   3. Add to crontab: crontab -e
#      0 2 * * * /home/sbnewcom/wa-backup/cron-backup.sh
#
# This runs nightly at 2 AM.
#

set -e

# Configuration
BACKUP_HOME="/home/sbnewcom/wa-backup"
LOG_DIR="$BACKUP_HOME/logs"
BACKUP_DIR="$BACKUP_HOME/files"
MANIFEST_FILE="$BACKUP_HOME/backup-manifest.json"

# Ensure we're in the right directory
cd "$BACKUP_HOME"

# Create directories if needed
mkdir -p "$LOG_DIR"
mkdir -p "$BACKUP_DIR"

# Date for log file
DATE=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/backup-$DATE.log"

# Load password from secure file
if [ -f "$BACKUP_HOME/.wa-password" ]; then
    export WA_PASSWORD=$(cat "$BACKUP_HOME/.wa-password")
else
    echo "ERROR: Password file not found at $BACKUP_HOME/.wa-password" >> "$LOG_FILE"
    exit 1
fi

# Export environment
export BACKUP_DIR
export MANIFEST_FILE
export LOG_FILE

# Run backup
echo "=== WA Files Backup Started: $(date) ===" >> "$LOG_FILE"

if npx tsx backup-incremental.ts >> "$LOG_FILE" 2>&1; then
    echo "=== Backup completed successfully: $(date) ===" >> "$LOG_FILE"
    EXIT_CODE=0
else
    echo "=== Backup FAILED: $(date) ===" >> "$LOG_FILE"
    EXIT_CODE=1
fi

# Cleanup old logs (keep 30 days)
find "$LOG_DIR" -name "backup-*.log" -mtime +30 -delete 2>/dev/null || true

# Cleanup old reports (keep 30 days)
find "$BACKUP_HOME" -name "backup-report-*.md" -mtime +30 -delete 2>/dev/null || true

# Optional: Send notification email on failure
if [ $EXIT_CODE -ne 0 ] && [ -n "$NOTIFY_EMAIL" ]; then
    mail -s "WA Backup FAILED - $DATE" "$NOTIFY_EMAIL" < "$LOG_FILE"
fi

exit $EXIT_CODE
