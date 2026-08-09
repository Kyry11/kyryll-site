#!/usr/bin/env bash
#
# Points the apex record at the current storage account, proxied.
#
# Deliberately non-destructive. This record is what makes the Worker route fire
# at all, so a step that could delete it is a step that can take the site down.
# It updates a CNAME it finds, creates one where the apex is empty, and reports
# and stops if it finds A/AAAA records.
set -euo pipefail
. "$(dirname "$0")/common.sh"

: "${ZONE_NAME:?required}"
: "${STORAGE_WEB_HOST:?required}"

records=$(cf -G "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records" --data-urlencode "name=$ZONE_NAME")
if ! cf_ok "$records"; then
  echo "::error::Could not list DNS records. The token needs Zone > DNS > Edit."
  cf_report "$records"
  exit 1
fi

cname_id=$(printf '%s' "$records" | jq -r '.result[]? | select(.type=="CNAME") | .id' | head -n1)
address_count=$(printf '%s' "$records" | jq -r '[.result[]? | select(.type=="A" or .type=="AAAA")] | length')

payload=$(jq -n --arg name "$ZONE_NAME" --arg content "$STORAGE_WEB_HOST" \
  '{type:"CNAME", name:$name, content:$content, ttl:1, proxied:true}')

if [ -n "$cname_id" ]; then
  response=$(cf -X PUT "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records/$cname_id" \
    -H "Content-Type: application/json" --data "$payload")
elif [ "$address_count" -eq 0 ]; then
  response=$(cf -X POST "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
    -H "Content-Type: application/json" --data "$payload")
else
  echo "::warning::$ZONE_NAME has $address_count A/AAAA record(s) and no CNAME. Not touching them — replace them with a proxied CNAME to $STORAGE_WEB_HOST by hand to enable the fallback."
  exit 0
fi

if ! cf_ok "$response"; then
  echo "::error::Could not update the apex record. The token needs Zone > DNS > Edit."
  cf_report "$response"
  exit 1
fi

proxied=$(printf '%s' "$response" | jq -r '.result.proxied')
echo "$ZONE_NAME -> $STORAGE_WEB_HOST (proxied: $proxied)"
if [ "$proxied" != "true" ]; then
  echo "::error::The apex record is not proxied. The Worker route only fires for a proxied hostname; the site is down until this is fixed."
  exit 1
fi
exit 0
