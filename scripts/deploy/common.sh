# Shared helpers for the deploy scripts.
#
# These live in files rather than inline in the workflow so they can be run
# against stubbed `curl`, `az` and `dig` by scripts/deploy/test/run.sh. Roughly
# two hundred lines that create, update and delete DNS records had no test at
# all, and a pull request never runs the deploy job — so their first execution
# would have been against production.

CF_API="https://api.cloudflare.com/client/v4"

# A Cloudflare API call that always exits 0 and always emits something cf_ok
# can evaluate.
#
# This matters more than it looks. Every caller assigns the result with
# `response=$(cf ...)`, and under `set -e` a command substitution that exits
# non-zero aborts the script — so a DNS blip that made curl exit 7 took the
# whole step down. For the fallback scripts, whose stated contract is that they
# never fail the deploy, that was the contract being broken by the transport
# layer rather than by any of the logic written to uphold it. And because these
# steps run before the upload and the Worker deploy, a failed step skips those
# too: an optional extra could abort the deployment it was supposed to be
# incidental to.
#
# A transport failure is reported as a normal unsuccessful API response, so the
# existing warn-and-continue paths handle it without any caller changing.
cf() {
  local body status=0
  body=$(curl -sS "$@" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" 2>&1) || status=$?

  if [ "$status" -ne 0 ]; then
    # A fixed shape, never interpolating curl's stderr into JSON.
    printf '{"success":false,"errors":[{"code":0,"message":"curl exited %s"}]}' "$status"
    return 0
  fi

  printf '%s' "$body"
  return 0
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
