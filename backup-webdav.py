#!/usr/bin/env python3
"""
WA Files Backup - Python WebDAV Version

Reliable incremental backup using webdavclient3.

Usage:
    pip install webdavclient3
    WA_PASSWORD=xxx python3 backup-webdav.py
"""

import os
import sys
import json
import logging
from datetime import datetime
from pathlib import Path
from webdav3.client import Client

# Configuration
WA_USER = "technology@sbnewcomers.org"
WA_PASSWORD = os.environ.get("WA_PASSWORD", "")
BASE_URL = "https://sbnewcomers.org"
WEBDAV_PATH = "/resources"

BACKUP_HOME = os.environ.get("BACKUP_HOME", "/home/sbnewcom/wa-backup")
BACKUP_DIR = os.environ.get("BACKUP_DIR", f"{BACKUP_HOME}/files")
MANIFEST_FILE = os.environ.get("MANIFEST_FILE", f"{BACKUP_HOME}/manifest.json")
LOG_DIR = f"{BACKUP_HOME}/logs"

# Setup logging
os.makedirs(LOG_DIR, exist_ok=True)
log_file = f"{LOG_DIR}/backup-{datetime.now().strftime('%Y-%m-%d')}.log"
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s: %(message)s',
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

# Stats
stats = {
    "started": datetime.now().isoformat(),
    "files_found": 0,
    "files_downloaded": 0,
    "files_skipped": 0,
    "bytes_downloaded": 0,
    "errors": []
}

def load_manifest():
    """Load the backup manifest."""
    if os.path.exists(MANIFEST_FILE):
        try:
            with open(MANIFEST_FILE, 'r') as f:
                return json.load(f)
        except:
            pass
    return {"files": {}, "last_backup": None}

def save_manifest(manifest):
    """Save the backup manifest."""
    manifest["last_backup"] = datetime.now().isoformat()
    with open(MANIFEST_FILE, 'w') as f:
        json.dump(manifest, f, indent=2)

def should_download(client, remote_path, local_path, manifest):
    """Check if file should be downloaded."""
    if not os.path.exists(local_path):
        return True, "new"

    # Check manifest for size
    if remote_path in manifest.get("files", {}):
        cached_size = manifest["files"][remote_path].get("size", 0)
        local_size = os.path.getsize(local_path)
        if cached_size == local_size:
            return False, "unchanged"

    return True, "modified"

def sync_directory(client, remote_dir, local_base, manifest, depth=0):
    """Recursively sync a directory."""
    indent = "  " * depth
    logger.info(f"{indent}Scanning: {remote_dir}")

    try:
        items = client.list(remote_dir, get_info=True)
    except Exception as e:
        logger.error(f"{indent}Failed to list {remote_dir}: {e}")
        stats["errors"].append(f"List failed: {remote_dir}")
        return

    for item in items:
        name = item.get("name", "")
        if not name or name == remote_dir.rstrip('/').split('/')[-1]:
            continue

        remote_path = f"{remote_dir.rstrip('/')}/{name}"
        local_path = os.path.join(local_base, remote_path.lstrip('/'))
        is_dir = item.get("isdir", False)

        if is_dir:
            os.makedirs(local_path, exist_ok=True)
            sync_directory(client, remote_path, local_base, manifest, depth + 1)
        else:
            stats["files_found"] += 1
            size = item.get("size", 0)

            should_dl, reason = should_download(client, remote_path, local_path, manifest)

            if should_dl:
                try:
                    os.makedirs(os.path.dirname(local_path), exist_ok=True)
                    logger.info(f"{indent}  Downloading ({reason}): {name}")
                    client.download_sync(remote_path=remote_path, local_path=local_path)
                    stats["files_downloaded"] += 1
                    stats["bytes_downloaded"] += size

                    # Update manifest
                    manifest["files"][remote_path] = {
                        "size": size,
                        "downloaded": datetime.now().isoformat()
                    }
                except Exception as e:
                    logger.error(f"{indent}  Failed to download {name}: {e}")
                    stats["errors"].append(f"Download failed: {remote_path}")
            else:
                stats["files_skipped"] += 1

def main():
    if not WA_PASSWORD:
        print("Usage: WA_PASSWORD=xxx python3 backup-webdav.py")
        sys.exit(1)

    logger.info("=== WA Files Backup Started ===")
    logger.info(f"Destination: {BACKUP_DIR}")

    # Create backup directory
    os.makedirs(BACKUP_DIR, exist_ok=True)

    # Configure WebDAV client
    options = {
        'webdav_hostname': BASE_URL,
        'webdav_login': WA_USER,
        'webdav_password': WA_PASSWORD,
        'webdav_root': WEBDAV_PATH
    }

    client = Client(options)

    # Test connection
    logger.info("Testing connection...")
    try:
        client.list("/")
        logger.info("Connection OK")
    except Exception as e:
        logger.error(f"Connection failed: {e}")
        sys.exit(1)

    # Load manifest
    manifest = load_manifest()
    logger.info(f"Manifest loaded: {len(manifest.get('files', {}))} files tracked")

    # Sync directories
    for directory in ["Documents", "Pictures"]:
        sync_directory(client, f"/{directory}", BACKUP_DIR, manifest)

    # Save manifest
    save_manifest(manifest)

    # Summary
    duration = (datetime.now() - datetime.fromisoformat(stats["started"])).total_seconds()

    logger.info("=== Backup Complete ===")
    logger.info(f"Duration: {duration:.1f}s")
    logger.info(f"Files found: {stats['files_found']}")
    logger.info(f"Downloaded: {stats['files_downloaded']}")
    logger.info(f"Skipped: {stats['files_skipped']}")
    logger.info(f"Errors: {len(stats['errors'])}")

    if stats["errors"]:
        sys.exit(1)

if __name__ == "__main__":
    main()
