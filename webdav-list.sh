#!/bin/bash
# WebDAV directory listing for WA resources
# Usage: ./webdav-list.sh <password> [folder]

if [ -z "$1" ]; then
  echo "Usage: $0 <password> [folder]"
  echo "Example: $0 mypassword"
  echo "Example: $0 mypassword Pictures"
  exit 1
fi

PASSWORD="$1"
FOLDER="${2:-}"
USERNAME="technology@sbnewcomers.org"
BASE_URL="https://sbnewcomers.org/resources"

if [ -n "$FOLDER" ]; then
  URL="$BASE_URL/$FOLDER/"
else
  URL="$BASE_URL/"
fi

echo "Testing WebDAV on: $URL"
echo ""

curl -s -X PROPFIND \
  --digest \
  -u "$USERNAME:$PASSWORD" \
  -H "Depth: 1" \
  -H "Content-Type: application/xml" \
  -d '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/><d:getlastmodified/></d:prop></d:propfind>' \
  "$URL" 2>&1
