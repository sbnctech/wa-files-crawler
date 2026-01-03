#!/bin/bash
#
# WA Files Backup using curl
# More reliable than Node.js https for WA's WebDAV server
#
# Usage: ./backup-curl.sh
#

set -e

# Configuration
BACKUP_HOME="${BACKUP_HOME:-/home/sbnewcom/wa-backup}"
BACKUP_DIR="${BACKUP_DIR:-$BACKUP_HOME/files}"
LOG_FILE="${LOG_FILE:-$BACKUP_HOME/logs/backup-$(date +%Y-%m-%d).log}"
WA_USER="technology@sbnewcomers.org"
WA_PASSWORD="${WA_PASSWORD:-$(cat $BACKUP_HOME/.wa-password 2>/dev/null)}"
BASE_URL="https://sbnewcomers.org/resources"

# Ensure directories exist
mkdir -p "$BACKUP_DIR"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date -Iseconds)] $1" | tee -a "$LOG_FILE"
}

# Function to list directory via WebDAV PROPFIND
list_dir() {
    local dir_path="$1"
    local url="$BASE_URL/$dir_path"

    curl -s -X PROPFIND \
        -u "$WA_USER:$WA_PASSWORD" \
        --digest \
        -H "Depth: 1" \
        -H "Content-Type: application/xml" \
        -d '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/></d:prop></d:propfind>' \
        "$url/" 2>/dev/null
}

# Function to download a file
download_file() {
    local file_path="$1"
    local dest_path="$BACKUP_DIR/$file_path"
    local url="$BASE_URL/$file_path"

    # Create destination directory
    mkdir -p "$(dirname "$dest_path")"

    # Download with authentication
    curl -s -o "$dest_path" \
        -u "$WA_USER:$WA_PASSWORD" \
        --digest \
        -L \
        "$url" 2>/dev/null

    if [ -f "$dest_path" ] && [ -s "$dest_path" ]; then
        return 0
    else
        return 1
    fi
}

# Parse PROPFIND response and extract items
parse_propfind() {
    local xml="$1"
    local current_path="$2"

    # Extract hrefs using grep and sed
    echo "$xml" | grep -o '<d:href>[^<]*</d:href>' | sed 's/<d:href>//g; s/<\/d:href>//g' | \
    while read href; do
        # URL decode
        decoded=$(printf '%b' "${href//%/\\x}")
        # Remove base URL
        relative="${decoded#https://sbnewcomers.org/resources/}"
        relative="${relative%/}"

        # Skip current directory
        if [ "$relative" = "$current_path" ] || [ -z "$relative" ]; then
            continue
        fi

        # Check if it's a folder (ends with /)
        if echo "$href" | grep -q '/$'; then
            echo "DIR:$relative"
        else
            echo "FILE:$relative"
        fi
    done
}

# Recursive sync function
sync_dir() {
    local dir_path="$1"
    local depth="$2"
    local indent=$(printf '%*s' $((depth * 2)) '')

    log "${indent}Scanning: ${dir_path:-/}"

    local response=$(list_dir "$dir_path")

    if [ -z "$response" ]; then
        log "${indent}  ERROR: Failed to list $dir_path"
        return
    fi

    # Parse response
    echo "$response" | grep -o '<d:response>.*</d:response>' | while read -r item; do
        local href=$(echo "$item" | grep -o '<d:href>[^<]*</d:href>' | head -1 | sed 's/<d:href>//; s/<\/d:href>//')
        local is_folder=$(echo "$item" | grep -c '<d:collection')

        # URL decode
        local decoded=$(printf '%b' "${href//%/\\x}")
        local relative="${decoded#https://sbnewcomers.org/resources/}"
        relative="${relative%/}"

        # Skip current directory
        if [ "$relative" = "$dir_path" ] || [ -z "$relative" ]; then
            continue
        fi

        if [ "$is_folder" -gt 0 ]; then
            # Recurse into subdirectory
            sync_dir "$relative" $((depth + 1))
        else
            # Download file if not exists or different size
            local dest_path="$BACKUP_DIR/$relative"
            local should_download=1

            if [ -f "$dest_path" ]; then
                # Get remote size from response
                local remote_size=$(echo "$item" | grep -o '<d:getcontentlength>[0-9]*</d:getcontentlength>' | sed 's/<[^>]*>//g')
                local local_size=$(stat -f%z "$dest_path" 2>/dev/null || stat -c%s "$dest_path" 2>/dev/null)

                if [ "$remote_size" = "$local_size" ]; then
                    should_download=0
                fi
            fi

            if [ "$should_download" -eq 1 ]; then
                log "${indent}  Downloading: $(basename "$relative")"
                if download_file "$relative"; then
                    ((DOWNLOADED++)) || true
                else
                    log "${indent}    FAILED"
                    ((ERRORS++)) || true
                fi
            else
                ((SKIPPED++)) || true
            fi
        fi
    done
}

# Main
log "=== WA Files Backup Started ==="
log "Destination: $BACKUP_DIR"

if [ -z "$WA_PASSWORD" ]; then
    log "ERROR: WA_PASSWORD not set and .wa-password not found"
    exit 1
fi

# Test connection
log "Testing connection..."
test_response=$(list_dir "")
if [ -z "$test_response" ]; then
    log "ERROR: Cannot connect to WebDAV server"
    exit 1
fi
log "Connection OK"

# Initialize counters
DOWNLOADED=0
SKIPPED=0
ERRORS=0

START_TIME=$(date +%s)

# Sync main directories
for dir in Documents Pictures; do
    sync_dir "$dir" 0
done

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

log "=== Backup Complete ==="
log "Duration: ${DURATION}s"
log "Downloaded: $DOWNLOADED"
log "Skipped: $SKIPPED"
log "Errors: $ERRORS"

# Cleanup old logs (keep 30 days)
find "$BACKUP_HOME/logs" -name "backup-*.log" -mtime +30 -delete 2>/dev/null || true

exit 0
