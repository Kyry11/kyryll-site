# Shared helpers for the deploy scripts.
#
# These live in files rather than inline in the workflow so they can be run
# against stubbed `curl`, `az` and `dig` by scripts/deploy/test/run.sh. Roughly
# two hundred lines that create, update and delete DNS records had no test at
# all, and a pull request never runs the deploy job — so their first execution
# would have been against production.

CF_API="https://api.cloudflare.com/client/v4"

cf() {
  curl -sS "$@" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"
}

# True when a Cloudflare API response reports success. Tolerates a non-JSON
# body — a challenge page or an HTML 502 — which `jq -e` alone exits 5 on.
cf_ok() {
  printf '%s' "$1" | jq -e '.success == true' >/dev/null 2>&1
}

cf_report() {
  printf '%s' "$1" | jq -c '{success, errors}' 2>/dev/null \
    || printf '%s\n' "$1" | head -c 500
}
