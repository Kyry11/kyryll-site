#!/usr/bin/env bash
#
# Registers the custom domain on the storage account, so that Azure answers to
# `Host: <domain>` and the proxied apex record works as a fallback when the
# Worker is disabled.
#
# Verification uses the indirect `asverify` method: Azure looks for
# asverify.<domain> pointing at asverify.<blob host>, and never requires the
# apex record itself to point anywhere. That is what makes this outage-free, and
# why a zone apex is not the obstacle it first appears — the record Azure
# inspects is a subdomain either way. Apex custom domains on Azure Storage are
# not theoretical: this subscription already has several.
#
# Nothing here is required for the site to work. The Worker fetches storage by
# its own hostname. So every failure below warns and exits 0 rather than
# failing the deploy: losing the fallback is not a reason to stop shipping, and
# a hard failure here would block the Worker deploy that follows.
set -euo pipefail
. "$(dirname "$0")/common.sh"

: "${ZONE_NAME:?required}"
: "${AZURE_STORAGE_ACCOUNT:?required}"
: "${AZURE_RESOURCE_GROUP:?required}"
: "${STORAGE_BLOB_HOST:?required}"

current=$(az storage account show \
  --name "$AZURE_STORAGE_ACCOUNT" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query "customDomain.name" -o tsv 2>/dev/null || true)
current=$(printf '%s' "$current" | tr '[:upper:]' '[:lower:]' | sed 's/\.$//')

if [ "$current" = "$ZONE_NAME" ]; then
  echo "Custom domain already registered on $AZURE_STORAGE_ACCOUNT."
  exit 0
fi

# A custom domain belongs to exactly one storage account at a time. If it is
# still held by a previous account, Azure refuses — and the message it gives is
# not obviously about that, so name it here.
holder=$(az storage account list \
  --query "[?customDomain.name=='$ZONE_NAME' && name!='$AZURE_STORAGE_ACCOUNT'].name" \
  -o tsv 2>/dev/null | head -n1 || true)
if [ -n "$holder" ]; then
  echo "::warning::$ZONE_NAME is already registered on storage account '$holder'. Azure allows one account per custom domain, so it must be cleared there first: az storage account update --name $holder --custom-domain \"\". Skipping; the site is unaffected and only the Worker-disabled fallback is."
  exit 0
fi

ASVERIFY_NAME="asverify.$ZONE_NAME"
ASVERIFY_TARGET="asverify.$STORAGE_BLOB_HOST"
[ -n "${GITHUB_ENV:-}" ] && echo "ASVERIFY_NAME=$ASVERIFY_NAME" >> "$GITHUB_ENV"

# DNS-only. A proxied record resolves to Cloudflare and Azure would not see the
# CNAME it is looking for.
existing=$(cf -G "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
  --data-urlencode "type=CNAME" --data-urlencode "name=$ASVERIFY_NAME")
record_id=$(printf '%s' "$existing" | jq -r '.result[0].id // empty' 2>/dev/null || true)
payload=$(jq -n --arg name "$ASVERIFY_NAME" --arg content "$ASVERIFY_TARGET" \
  '{type:"CNAME", name:$name, content:$content, ttl:120, proxied:false}')

if [ -n "$record_id" ]; then
  response=$(cf -X PUT "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records/$record_id" \
    -H "Content-Type: application/json" --data "$payload")
else
  response=$(cf -X POST "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
    -H "Content-Type: application/json" --data "$payload")
fi

if ! cf_ok "$response"; then
  echo "::warning::Could not create $ASVERIFY_NAME; the token may need Zone > DNS > Edit. Skipping the fallback registration."
  cf_report "$response"
  exit 0
fi

echo "Waiting for $ASVERIFY_NAME to resolve..."
for attempt in $(seq 1 "${ASVERIFY_DNS_ATTEMPTS:-18}"); do
  seen=$(dig +short CNAME "$ASVERIFY_NAME" @1.1.1.1 2>/dev/null | sed 's/\.$//' | head -n1 || true)
  [ "$seen" = "$ASVERIFY_TARGET" ] && break
  echo "  attempt $attempt: '$seen'"
  sleep "${ASVERIFY_DNS_SLEEP:-10}"
done

# Azure re-checks DNS itself and can lag the resolver.
for attempt in $(seq 1 "${ASVERIFY_AZURE_ATTEMPTS:-6}"); do
  if az storage account update \
    --name "$AZURE_STORAGE_ACCOUNT" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --custom-domain "$ZONE_NAME" \
    --use-subdomain true \
    --only-show-errors; then
    echo "Custom domain registered."
    exit 0
  fi
  echo "Not verified yet (attempt $attempt)"
  sleep "${ASVERIFY_AZURE_SLEEP:-20}"
done

echo "::warning::Azure would not verify $ZONE_NAME via $ASVERIFY_NAME. The site is unaffected; only the Worker-disabled fallback is."
exit 0
