#!/usr/bin/env bash
#
# Tests for the deploy scripts, run in CI by the secret-free validation job.
#
# These exist because a pull request never runs the deploy job, so the scripts
# that create, update and delete DNS records and register an Azure custom domain
# would otherwise first execute against production. `curl`, `az` and `dig` are
# replaced with stubs on PATH; nothing here touches a network or a cloud
# account.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
STUB="$(mktemp -d)"
trap 'rm -rf "$STUB"' EXIT

pass=0; fail=0

# The stubs read these to decide what to return, so each case is a few env vars.
cat > "$STUB/curl" <<'STUBEOF'
#!/usr/bin/env python3
import sys, os, json
a = ' '.join(sys.argv)
def out(o): print(json.dumps(o))
if os.environ.get('STUB_CURL_EXIT'):
    sys.exit(int(os.environ['STUB_CURL_EXIT']))
if os.environ.get('STUB_CF_RAW'):
    print(os.environ['STUB_CF_RAW']); sys.exit(0)
if '-X DELETE' in a and os.environ.get('STUB_DELETE_LOG'):
    open(os.environ['STUB_DELETE_LOG'], 'a').write(a.split('dns_records/')[-1].split()[0] + "\n")
if os.environ.get('STUB_CF_ZONE_FAIL'):
    out({"success": False, "errors": [{"code": 9109, "message": "Invalid access token"}]}); sys.exit(0)
if '-X DELETE' in a:
    out({"success": True}); sys.exit(0)
if 'dns_records' in a and ('-X POST' in a or '-X PUT' in a):
    if os.environ.get('STUB_CF_WRITE_FAIL'):
        out({"success": False, "errors": [{"code": 10000, "message": "no DNS edit"}]}); sys.exit(0)
    out({"success": True, "result": {"id": "r1",
        "proxied": os.environ.get('STUB_CF_PROXIED', 'true') == 'true'}}); sys.exit(0)
if 'dns_records' in a:
    if 'asverify' in a:
        if os.environ.get('STUB_ASVERIFY_EXISTS'):
            out({"success": True, "result": [{"id": "av1"}, {"id": "av2"}]})
        else:
            out({"success": True, "result": []})
        sys.exit(0)
    kind = os.environ.get('STUB_APEX', 'cname')
    if kind == 'cname':
        out({"success": True, "result": [{"id": "c1", "type": "CNAME", "name": "kyryll.com"}]})
    elif kind == 'a':
        out({"success": True, "result": [
            {"id": "a1", "type": "A", "name": "kyryll.com"},
            {"id": "a2", "type": "A", "name": "kyryll.com"}]})
    else:
        out({"success": True, "result": []})
    sys.exit(0)
out({"success": True, "result": {"name": os.environ.get('STUB_ZONE_NAME', 'kyryll.com')}})
STUBEOF

cat > "$STUB/az" <<'STUBEOF'
#!/usr/bin/env bash
if [[ "$*" == *"customDomain.name"* && "$*" == *"storage account show"* ]]; then
  echo "${STUB_CURRENT_DOMAIN:-}"; exit 0
fi
if [[ "$*" == *"storage account list"* ]]; then
  echo "${STUB_DOMAIN_HOLDER:-}"; exit 0
fi
if [[ "$*" == *"storage account update"* ]]; then
  [ -n "${STUB_AZURE_VERIFY_FAIL:-}" ] && exit 1
  echo "registered"; exit 0
fi
exit 0
STUBEOF

cat > "$STUB/dig" <<'STUBEOF'
#!/usr/bin/env bash
echo "${STUB_DIG:-asverify.acct.blob.core.windows.net.}"
STUBEOF

chmod +x "$STUB"/*
export PATH="$STUB:$PATH"

# Keep the retry loops from making the suite slow.
export ASVERIFY_DNS_ATTEMPTS=1 ASVERIFY_DNS_SLEEP=0
export ASVERIFY_AZURE_ATTEMPTS=1 ASVERIFY_AZURE_SLEEP=0

check() {
  local name="$1" want="$2"; shift 2
  local output; output=$("$@" 2>&1); local got=$?
  if [ "$got" = "$want" ]; then
    printf '  ok    %-58s exit=%s\n' "$name" "$got"; pass=$((pass + 1))
  else
    printf '  FAIL  %-58s exit=%s want=%s\n' "$name" "$got" "$want"
    printf '%s\n' "$output" | sed 's/^/          /'; fail=$((fail + 1))
  fi
}

expect_output() {
  local name="$1" pattern="$2"; shift 2
  local output; output=$("$@" 2>&1)
  if printf '%s' "$output" | grep -q -- "$pattern"; then
    printf '  ok    %s\n' "$name"; pass=$((pass + 1))
  else
    printf '  FAIL  %s (missing: %s)\n' "$name" "$pattern"
    printf '%s\n' "$output" | sed 's/^/          /'; fail=$((fail + 1))
  fi
}

export CLOUDFLARE_ZONE_ID=z CLOUDFLARE_API_TOKEN=t
export AZURE_STORAGE_ACCOUNT=acct AZURE_RESOURCE_GROUP=rg
export STORAGE_BLOB_HOST=acct.blob.core.windows.net
export STORAGE_WEB_HOST=acct.z8.web.core.windows.net
export WRANGLER_TOML="$ROOT/worker/wrangler.toml"
unset GITHUB_ENV

D="$ROOT/scripts/deploy"

echo "resolve-zone.sh"
check "the expected zone is accepted"                0 env STUB_ZONE_NAME=kyryll.com  "$D/resolve-zone.sh"
# The whole point of the check: a token with access to several zones plus a
# mistyped secret must not be able to redirect someone else's domain here.
check "a different zone is refused"                  1 env STUB_ZONE_NAME=example.com "$D/resolve-zone.sh"
check "an empty zone name is refused"                1 env STUB_ZONE_NAME=            "$D/resolve-zone.sh"
check "an unreadable zone is refused"                1 env STUB_CF_ZONE_FAIL=1        "$D/resolve-zone.sh"
check "a non-JSON body does not crash the check"     1 env STUB_CF_RAW='<html>1020</html>' "$D/resolve-zone.sh"

echo "register-custom-domain.sh  (never fatal: the site does not depend on it)"
export ZONE_NAME=kyryll.com
check "registers when unset"                         0 env STUB_CURRENT_DOMAIN=            "$D/register-custom-domain.sh"
check "skips when already registered here"           0 env STUB_CURRENT_DOMAIN=kyryll.com  "$D/register-custom-domain.sh"
check "warns, not fails, when held by another account" 0 env STUB_DOMAIN_HOLDER=kyryllsite "$D/register-custom-domain.sh"
expect_output "and names the account and the fix" "already registered on storage account 'kyryllsite'" \
  env STUB_DOMAIN_HOLDER=kyryllsite "$D/register-custom-domain.sh"
check "warns, not fails, when DNS write is denied"   0 env STUB_CF_WRITE_FAIL=1           "$D/register-custom-domain.sh"
check "warns, not fails, when Azure will not verify" 0 env STUB_AZURE_VERIFY_FAIL=1       "$D/register-custom-domain.sh"

echo "point-apex.sh"
check "updates an existing CNAME"                    0 env STUB_APEX=cname "$D/point-apex.sh"
check "creates one when the apex is empty"           0 env STUB_APEX=none  "$D/point-apex.sh"
# Non-destructive: this record is what makes the Worker route fire.
check "refuses to touch A/AAAA records"              0 env STUB_APEX=a     "$D/point-apex.sh"
expect_output "and says so" "Not touching them" env STUB_APEX=a "$D/point-apex.sh"
check "fails if the record ends up unproxied"        1 env STUB_APEX=cname STUB_CF_PROXIED=false "$D/point-apex.sh"
check "fails if the DNS write is denied"             1 env STUB_APEX=cname STUB_CF_WRITE_FAIL=1  "$D/point-apex.sh"
# The record is repointed either way, but a fallback that is not actually
# functional must say so rather than be discovered during an incident.
expect_output "reports the fallback live when the domain is registered" "Fallback is live" \
  env STUB_APEX=cname STUB_CURRENT_DOMAIN=kyryll.com "$D/point-apex.sh"
expect_output "warns when the domain is not registered on this account" "NOT a working fallback" \
  env STUB_APEX=cname STUB_CURRENT_DOMAIN= "$D/point-apex.sh"

echo "remove-asverify.sh"
export ASVERIFY_NAME=asverify.kyryll.com
check "no record to remove is fine"                  0 "$D/remove-asverify.sh"

# The previous version of this asserted only an exit code against an empty
# record list, so it never issued a DELETE at all.
DELETE_LOG="$STUB/deletes"; : > "$DELETE_LOG"
check "deletes every matching record"                0 \
  env STUB_ASVERIFY_EXISTS=1 STUB_DELETE_LOG="$DELETE_LOG" "$D/remove-asverify.sh"
if [ "$(wc -l < "$DELETE_LOG" | tr -d ' ')" = "2" ]; then
  printf '  ok    %s\n' "and issued a DELETE for each"; pass=$((pass + 1))
else
  printf '  FAIL  %s (deletes: %s)\n' "and issued a DELETE for each" "$(cat "$DELETE_LOG")"; fail=$((fail + 1))
fi

echo "transport failures must never abort the deploy"
# These steps run before the upload and the Worker deploy, so a non-zero exit
# skips them. `response=$(cf ...)` aborts under set -e when curl exits non-zero,
# and pipefail did the same for a non-JSON body.
check "register survives curl exiting non-zero"      0 env STUB_CURL_EXIT=7 "$D/register-custom-domain.sh"
check "remove survives curl exiting non-zero"        0 env STUB_CURL_EXIT=7 "$D/remove-asverify.sh"
check "remove survives a non-JSON body"              0 env STUB_CF_RAW='<html>502</html>' "$D/remove-asverify.sh"
check "register survives a non-JSON body"            0 env STUB_CF_RAW='<html>502</html>' "$D/register-custom-domain.sh"
# The apex step is deliberately the opposite: it is not optional.
check "point-apex still fails loudly on a bad body"  1 env STUB_CF_RAW='<html>502</html>' "$D/point-apex.sh"
check "point-apex still fails on curl exiting"       1 env STUB_CURL_EXIT=7 "$D/point-apex.sh"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
