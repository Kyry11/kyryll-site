#!/usr/bin/env bash
#
# Resolves the Cloudflare zone name for CLOUDFLARE_ZONE_ID and refuses to
# continue unless it is the zone this repository is for.
#
# The equality check is the point. Everything downstream — registering a custom
# domain in Azure, rewriting an apex DNS record — mutates whatever zone this
# returns. A token with access to several zones plus a mistyped secret would
# otherwise be enough to point somebody else's domain at this storage account.
# The expected name is read from wrangler.toml, which is where the Worker's own
# route binding already declares it, so there is one source of truth.
set -euo pipefail
. "$(dirname "$0")/common.sh"

: "${CLOUDFLARE_ZONE_ID:?required}"
: "${CLOUDFLARE_API_TOKEN:?required}"
WRANGLER_TOML="${WRANGLER_TOML:-worker/wrangler.toml}"

expected=$(sed -n 's/^ *zone_name *= *"\([^"]*\)".*/\1/p' "$WRANGLER_TOML" | head -n1)
if [ -z "$expected" ]; then
  echo "::error::No zone_name found in $WRANGLER_TOML."
  exit 1
fi

response=$(cf "$CF_API/zones/$CLOUDFLARE_ZONE_ID")
if ! cf_ok "$response"; then
  echo "::error::Could not read the Cloudflare zone. The token needs Zone > Zone > Read."
  cf_report "$response"
  exit 1
fi

zone_name=$(printf '%s' "$response" | jq -r '.result.name // empty')
if [ "$zone_name" != "$expected" ]; then
  echo "::error::CLOUDFLARE_ZONE_ID resolves to '$zone_name' but wrangler.toml expects '$expected'. Refusing to touch another zone."
  exit 1
fi

echo "Zone: $zone_name"
[ -n "${GITHUB_ENV:-}" ] && echo "ZONE_NAME=$zone_name" >> "$GITHUB_ENV"
exit 0
