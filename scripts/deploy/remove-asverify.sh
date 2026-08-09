#!/usr/bin/env bash
# Removes the asverify record. Runs whether or not verification succeeded — the
# record has done its job either way and is clutter afterwards.
set -euo pipefail
. "$(dirname "$0")/common.sh"

: "${ASVERIFY_NAME:?required}"

cf -G "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
  --data-urlencode "type=CNAME" --data-urlencode "name=$ASVERIFY_NAME" \
  | jq -r '.result[]?.id' 2>/dev/null \
  | while IFS= read -r id; do
      [ -n "$id" ] || continue
      cf -X DELETE "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records/$id" >/dev/null
      echo "Removed $ASVERIFY_NAME"
    done
exit 0
