#!/usr/bin/env bash
# Removes the asverify record. Runs whether or not verification succeeded — the
# record has done its job either way and is clutter afterwards.
set -euo pipefail
. "$(dirname "$0")/common.sh"

: "${ASVERIFY_NAME:?required}"

# Not a pipeline. With `pipefail`, a non-JSON body — a Cloudflare challenge or
# an HTML 502 — made jq exit 5 and took the step with it, and this step runs
# before the upload and the Worker deploy, so everything after it was skipped.
# Tidying up a temporary DNS record is not worth a failed deployment.
records=$(cf -G "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
  --data-urlencode "type=CNAME" --data-urlencode "name=$ASVERIFY_NAME")

if ! cf_ok "$records"; then
  echo "::warning::Could not list DNS records to remove $ASVERIFY_NAME. It is harmless; remove it by hand if you like."
  exit 0
fi

ids=$(printf '%s' "$records" | jq -r '.result[]?.id' 2>/dev/null || true)

for id in $ids; do
  [ -n "$id" ] || continue
  deleted=$(cf -X DELETE "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records/$id")
  if cf_ok "$deleted"; then
    echo "Removed $ASVERIFY_NAME"
  else
    echo "::warning::Could not remove $ASVERIFY_NAME ($id). It is harmless; remove it by hand if you like."
  fi
done

exit 0
