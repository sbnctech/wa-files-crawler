#!/bin/bash
# Test WebDAV access to WA resources

# Read cookies and format for curl
COOKIE_STRING=""
while IFS=$'\t' read -r domain flag path secure expiry name value; do
  [[ "$domain" =~ ^# ]] && continue
  [[ -z "$name" ]] && continue
  COOKIE_STRING="${COOKIE_STRING}${name}=${value}; "
done < cookies.txt

echo "Testing WebDAV PROPFIND on /resources/"
echo ""

curl -v -X PROPFIND \
  -H "Cookie: $COOKIE_STRING" \
  -H "Depth: 1" \
  -H "Content-Type: application/xml" \
  -d '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:resourcetype/></d:prop></d:propfind>' \
  "https://sbnewcomers.org/resources/" 2>&1
