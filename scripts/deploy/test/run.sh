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
if ('-X POST' in a or '-X PUT' in a) and os.environ.get('STUB_DNS_LOG'):
    body = ''
    if '--data' in sys.argv:
        body = sys.argv[sys.argv.index('--data') + 1]
    open(os.environ['STUB_DNS_LOG'], 'a').write(body + "\n")
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
    if 'kyryll.com' in a and ('type=TXT' in a or 'type%3DTXT' in a):
        recs = []
        if os.environ.get('STUB_HAS_SPF'):
            recs.append({"id": "spf1", "type": "TXT", "content": "v=spf1 include:_spf.google.com -all"})
        if os.environ.get('STUB_HAS_DMARC'):
            recs.append({"id": "dm1", "type": "TXT", "content": "v=DMARC1; p=none; rua=mailto:me@kyryll.com"})
        out({"success": True, "result": recs}); sys.exit(0)
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
if [[ "$*" == *"provider show"* ]]; then
  echo "${STUB_PROVIDER_STATE:-Registered}"; exit 0
fi
if [[ "$*" == *"communication email domain show"* && "$*" != *AzureManagedDomain* ]]; then
  [ -n "${STUB_CUSTOM_DOMAIN_MISSING:-}" ] && exit 1
  # Azure returns the full name here, as the portal dialog shows.
  STUB_DOMAIN_FQDN="${CONTACT_SENDER_DOMAIN:-kyryll.com}"
  states='{"Domain":{"status":"Verified"},"SPF":{"status":"Verified"},"DKIM":{"status":"Verified"},"DKIM2":{"status":"Verified"},"DMARC":{"status":"Verified"}}'
  [ -n "${STUB_CUSTOM_PENDING:-}" ] && states='{"Domain":{"status":"Pending"}}'
  # Ownership proved, sending records not configured — the expected state when
  # only the TXT has been published.
  [ -n "${STUB_PARTIAL_VERIFY:-}" ] && states='{"Domain":{"status":"Verified"},"SPF":{"status":"NotStarted"},"DKIM":{"status":"NotStarted"}}'
  cat <<JSON
{"id":"/sub/x/domains/custom",
 "verificationRecords":{
   "Domain":{"type":"TXT","name":"${STUB_DOMAIN_RECORD_NAME:-$STUB_DOMAIN_FQDN}","value":"ms-domain-verification=abc"},
   "SPF":{"type":"TXT","name":"","value":"v=spf1 include:spf.protection.outlook.com -all"},
   "DKIM":{"type":"CNAME","name":"selector1-azurecomm-prod-net._domainkey","value":"selector1-azurecomm-prod-net._domainkey.azurecomm.net"},
   "DMARC":{"type":"TXT","name":"_dmarc","value":"v=DMARC1; p=none;"}},
 "verificationStates":$states}
JSON
  exit 0
fi
if [[ "$*" == *"communication email domain show"* ]]; then
  [ -n "${STUB_DOMAIN_MISSING:-}" ] && exit 1
  if [[ "$*" == *"fromSenderDomain"* ]]; then echo "abc123.azurecomm.net"; else echo "/subscriptions/x/domains/AzureManagedDomain"; fi
  exit 0
fi
if [[ "$*" == *"communication email show"* ]]; then
  [ -n "${STUB_EMAIL_SVC_MISSING:-}" ] && exit 1
  echo "exists"; exit 0
fi
if [[ "$*" == *"communication show"* ]]; then
  [ -n "${STUB_COMMS_MISSING:-}" ] && exit 1
  # The linked-domain query drives whether the sender secret is rewritten, so
  # it has to answer with an id rather than a placeholder.
  if [[ "$*" == *"linkedDomains"* ]]; then
    [ -n "${STUB_LINKED_READ_FAIL:-}" ] && exit 1
    [ -n "${STUB_NO_LINKED_DOMAIN:-}" ] && { echo ""; exit 0; }
    if [ -n "${STUB_STATE:-}" ] && [ -f "${STUB_STATE}" ]; then
      echo "/subscriptions/x/domains/AzureManagedDomain"; exit 0
    fi
    echo "${STUB_LINKED_DOMAIN:-/subscriptions/x/domains/AzureManagedDomain}"; exit 0
  fi
  echo "exists"; exit 0
fi
if [[ "$*" == *"communication email domain create"* && "$*" == *"CustomerManaged"* ]]; then
  [ -n "${STUB_CUSTOM_CREATE_FAIL:-}" ] && exit 1
  echo created; exit 0
fi
if [[ "$*" == *"communication update"* ]]; then
  [ -n "${STUB_LINK_LOG:-}" ] && echo relink >> "$STUB_LINK_LOG"
  # STUB_LINK_APPLIED models the ambiguous case: the change lands server-side
  # and the CLI still reports failure.
  [ -n "${STUB_LINK_APPLIED:-}" ] && : > "${STUB_STATE:-/dev/null}"
  [ -n "${STUB_LINK_FAIL:-}" ] && exit 1
  : > "${STUB_STATE:-/dev/null}"
  exit 0
fi
if [[ "$*" == *"resource show"* ]]; then
  [ -n "${STUB_RESOURCE_READ_FAIL:-}" ] && exit 1
  echo "${STUB_LINKED_SENDER_DOMAIN:-previous.azurecomm.net}"; exit 0
fi
if [[ "$*" == *"sender-username list"* ]]; then
  [ -n "${STUB_USERNAME_READ_FAIL:-}" ] && exit 1
  [ -n "${STUB_NO_USERNAMES:-}" ] && { echo ""; exit 0; }
  echo "${STUB_SENDER_USERNAME:-DoNotReply}"; exit 0
fi
if [[ "$*" == *"communication list-key"* ]]; then
  [ -n "${STUB_NO_CONNECTION:-}" ] && { echo ""; exit 0; }
  echo "endpoint=https://x.communication.azure.com/;accesskey=a2V5"; exit 0
fi
if [[ "$*" == *"communication email create"* || "$*" == *"communication email domain create"* || "$*" == *"communication create"* ]]; then
  [ -n "${STUB_CREATE_FAIL:-}" ] && exit 1
  echo "created"; exit 0
fi
exit 0
STUBEOF

cat > "$STUB/dig" <<'STUBEOF'
#!/usr/bin/env bash
echo "${STUB_DIG:-asverify.acct.blob.core.windows.net.}"
STUBEOF

cat > "$STUB/npx" <<'STUBEOF'
#!/usr/bin/env bash
# Only `wrangler secret list|put` is used by the deploy scripts.
if [[ "$*" == *"secret list"* ]]; then
  [ -n "${STUB_SECRET_LIST_FAIL:-}" ] && exit 1
  [ -n "${STUB_SECRET_LIST_GARBAGE:-}" ] && { echo "<html>not json</html>"; exit 0; }
  echo "${STUB_EXISTING_SECRETS:-[]}"; exit 0
fi
if [[ "$*" == *"secret delete"* ]]; then
  [ -n "${STUB_SECRET_DELETE_FAIL:-}" ] && exit 1
  [ -n "${STUB_SECRET_DELETE_LOG:-}" ] && echo "${@: -2:1}" >> "$STUB_SECRET_DELETE_LOG"
  exit 0
fi
if [[ "$*" == *"secret put"* ]]; then
  value=$(cat)
  [ -n "${STUB_SECRET_VALUE_LOG:-}" ] && echo "${!#}=$value" >> "$STUB_SECRET_VALUE_LOG"
  [ -n "${STUB_SECRET_PUT_FAIL:-}" ] && exit 1
  [ -n "${STUB_SECRET_LOG:-}" ] && echo "${!#}" >> "$STUB_SECRET_LOG"
  exit 0
fi
exit 0
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

echo "provision-email.sh  (never fatal: the site works without a contact form)"
export CONTACT_RECIPIENT_ADDRESS=inbox@example.test
SECRET_LOG="$STUB/secrets"; : > "$SECRET_LOG"

check "provisions and sets all three secrets"        0 \
  env STUB_SECRET_LOG="$SECRET_LOG" "$D/provision-email.sh"
# Two secrets, not three: the sender is a variable now, so it cannot be one
# deploy behind the domain it names.
if [ "$(sort -u "$SECRET_LOG" | tr '\n' ' ')" = "COMMUNICATION_SERVICES_CONNECTION_STRING CONTACT_RECIPIENT_ADDRESS " ]; then
  printf '  ok    %s\n' "and sets exactly the two secrets the Worker still needs"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and sets exactly the two secrets the Worker still needs" "$(tr '\n' ' ' < "$SECRET_LOG")"; fail=$((fail + 1))
fi

# Rotation must stay an explicit act, not something a deploy does silently.
: > "$SECRET_LOG"
check "leaves existing secrets alone when nothing moved" 0 \
  env STUB_SECRET_LOG="$SECRET_LOG" \
      STUB_EXISTING_SECRETS='[{"name":"COMMUNICATION_SERVICES_CONNECTION_STRING"},{"name":"CONTACT_SENDER_ADDRESS"},{"name":"CONTACT_RECIPIENT_ADDRESS"}]' \
      "$D/provision-email.sh"
if [ ! -s "$SECRET_LOG" ]; then
  printf '  ok    %s\n' "and overwrote nothing"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and overwrote nothing" "$(tr '\n' ' ' < "$SECRET_LOG")"; fail=$((fail + 1))
fi

# The sender follows whatever Azure reports is linked, read after the fact.
#
# This replaces a pile of machinery that existed only because a secret cannot be
# read back: writing the sender before linking so a failed write could not
# strand the two systems, rolling it back when the link failed, and re-reading
# Azure because a non-zero exit is not proof the change did not happen. A
# variable derived from reality at the end needs none of it.
SENDER_ENV="$STUB/senderenv"

: > "$SENDER_ENV"
check "publishes the sender of whatever is actually linked" 0 \
  env GITHUB_ENV="$SENDER_ENV" STUB_LINKED_DOMAIN=/subscriptions/x/domains/SomeOtherDomain \
      "$D/provision-email.sh"
if grep -q '^SENDER_ADDRESS=DoNotReply@previous.azurecomm.net$' "$SENDER_ENV"; then
  printf '  ok    %s\n' "and not the one it set out to link"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and not the one it set out to link" "$(grep SENDER_ADDRESS "$SENDER_ENV" || echo none)"; fail=$((fail + 1))
fi

# The local part is registered on the domain and is not always lowercase.
: > "$SENDER_ENV"
check "takes the local part from Azure rather than assuming one" 0 \
  env GITHUB_ENV="$SENDER_ENV" STUB_SENDER_USERNAME=Postmaster "$D/provision-email.sh"
if grep -q '^SENDER_ADDRESS=Postmaster@' "$SENDER_ENV"; then
  printf '  ok    %s\n' "and preserves its case"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and preserves its case" "$(grep SENDER_ADDRESS "$SENDER_ENV" || echo none)"; fail=$((fail + 1))
fi

# A link that fails is a warning, not a reason to publish a sender Azure will
# not accept.
: > "$SENDER_ENV"
check "keeps the linked sender when linking fails"   0 \
  env GITHUB_ENV="$SENDER_ENV" STUB_LINKED_DOMAIN=/subscriptions/x/domains/SomeOtherDomain \
      STUB_LINK_FAIL=1 "$D/provision-email.sh"
if grep -q '^SENDER_ADDRESS=DoNotReply@previous.azurecomm.net$' "$SENDER_ENV"; then
  printf '  ok    %s\n' "and never publishes one Azure has not authorised"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and never publishes one Azure has not authorised" "$(grep SENDER_ADDRESS "$SENDER_ENV" || echo none)"; fail=$((fail + 1))
fi

# A read that fails is not evidence that nothing is linked. Treating the two
# alike meant a timed-out read could select the managed domain and then relink
# the service to it, replacing a custom domain somebody had chosen.
: > "$SENDER_ENV"
LINK_LOG="$STUB/links"; : > "$LINK_LOG"
check "stops when the linked-domain read fails"      0 \
  env GITHUB_ENV="$SENDER_ENV" STUB_LINKED_READ_FAIL=1 STUB_LINK_LOG="$LINK_LOG" \
      "$D/provision-email.sh"
if [ ! -s "$SENDER_ENV" ] && [ ! -s "$LINK_LOG" ]; then
  printf '  ok    %s\n' "and neither relinks nor republishes a sender"; pass=$((pass + 1))
else
  printf '  FAIL  %s (env=%s links=%s)\n' "and neither relinks nor republishes a sender" \
    "$(tr '\n' ' ' < "$SENDER_ENV")" "$(tr '\n' ' ' < "$LINK_LOG")"; fail=$((fail + 1))
fi

: > "$SENDER_ENV"
check "stops when the linked domain cannot be read"  0 \
  env GITHUB_ENV="$SENDER_ENV" STUB_RESOURCE_READ_FAIL=1 "$D/provision-email.sh"
if [ ! -s "$SENDER_ENV" ]; then
  printf '  ok    %s\n' "and publishes no sender from a failed read"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and publishes no sender from a failed read" "$(tr '\n' ' ' < "$SENDER_ENV")"; fail=$((fail + 1))
fi

# An unreadable or empty username list is not evidence that `donotreply` works.
: > "$SENDER_ENV"
check "stops when the sender usernames cannot be read" 0 \
  env GITHUB_ENV="$SENDER_ENV" STUB_USERNAME_READ_FAIL=1 "$D/provision-email.sh"
if [ ! -s "$SENDER_ENV" ]; then
  printf '  ok    %s\n' "and does not fall back to a guessed local part"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and does not fall back to a guessed local part" "$(tr '\n' ' ' < "$SENDER_ENV")"; fail=$((fail + 1))
fi

: > "$SENDER_ENV"
check "stops when a custom domain has no sender registered" 0 \
  env GITHUB_ENV="$SENDER_ENV" STUB_NO_USERNAMES=1 \
      STUB_LINKED_DOMAIN=/subscriptions/x/domains/kyryll.com "$D/provision-email.sh"
if [ ! -s "$SENDER_ENV" ]; then
  printf '  ok    %s\n' "rather than publishing an address ACS would reject"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "rather than publishing an address ACS would reject" "$(tr '\n' ' ' < "$SENDER_ENV")"; fail=$((fail + 1))
fi

# The managed domain is the one case where an empty list has a known default.
: > "$SENDER_ENV"
check "still uses donotreply on the managed domain"  0 \
  env GITHUB_ENV="$SENDER_ENV" STUB_NO_USERNAMES=1 \
      STUB_LINKED_DOMAIN=/subscriptions/x/domains/AzureManagedDomain "$D/provision-email.sh"
if grep -q '^SENDER_ADDRESS=donotreply@' "$SENDER_ENV"; then
  printf '  ok    %s\n' "where Azure creates it"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "where Azure creates it" "$(tr '\n' ' ' < "$SENDER_ENV")"; fail=$((fail + 1))
fi

# The secret must outlive provisioning; the deploy that replaces it comes later.
: > "$SENDER_ENV"; : > "$DELETE_LOG"
check "flags the shadowing secret instead of deleting it" 0 \
  env GITHUB_ENV="$SENDER_ENV" STUB_SECRET_DELETE_LOG="$DELETE_LOG" \
      STUB_EXISTING_SECRETS='[{"name":"CONTACT_SENDER_ADDRESS"}]' "$D/provision-email.sh"
if [ ! -s "$DELETE_LOG" ] && grep -q '^SENDER_SECRET_SHADOWS_VAR=true$' "$SENDER_ENV"; then
  printf '  ok    %s\n' "and leaves removal to after the variable is deployed"; pass=$((pass + 1))
else
  printf '  FAIL  %s (deletes=%s)\n' "and leaves removal to after the variable is deployed" "$(tr '\n' ' ' < "$DELETE_LOG")"; fail=$((fail + 1))
fi

check "stops when nothing at all is linked"          0 \
  env STUB_NO_LINKED_DOMAIN=1 "$D/provision-email.sh"
expect_output "and says the form cannot send" "cannot send" \
  env STUB_NO_LINKED_DOMAIN=1 "$D/provision-email.sh"

# A failed read must not cause a working secret to be overwritten.
#
# The exit code alone does not show that. An earlier version of this test
# asserted only that, and the script was overwriting all three: the listing and
# the parse shared one pipeline ending in `|| true`, so a failed listing gave an
# empty string, every secret looked absent, and every one was rewritten — each
# write publishing a new version of the Worker.
: > "$SECRET_LOG"
check "survives the secret list failing"             0 \
  env STUB_SECRET_LIST_FAIL=1 STUB_SECRET_LOG="$SECRET_LOG" "$D/provision-email.sh"
if [ ! -s "$SECRET_LOG" ]; then
  printf '  ok    %s\n' "and writes nothing when the list cannot be read"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and writes nothing when the list cannot be read" "$(tr '\n' ' ' < "$SECRET_LOG")"; fail=$((fail + 1))
fi

: > "$SECRET_LOG"
check "survives an unparseable secret list"          0 \
  env STUB_SECRET_LIST_GARBAGE=1 STUB_SECRET_LOG="$SECRET_LOG" "$D/provision-email.sh"
if [ ! -s "$SECRET_LOG" ]; then
  printf '  ok    %s\n' "and writes nothing when the list will not parse"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and writes nothing when the list will not parse" "$(tr '\n' ' ' < "$SECRET_LOG")"; fail=$((fail + 1))
fi

# Reporting success after a failed write sends whoever reads the log looking
# anywhere but at the thing that broke.
expect_output "does not claim success when a write fails" "not fully configured" \
  env STUB_SECRET_PUT_FAIL=1 "$D/provision-email.sh"

check "skips when no recipient is configured"        0 env CONTACT_RECIPIENT_ADDRESS= "$D/provision-email.sh"
check "skips when the provider is unregistered"      0 env STUB_PROVIDER_STATE=NotRegistered "$D/provision-email.sh"
expect_output "and names the one-off command" "az provider register" \
  env STUB_PROVIDER_STATE=NotRegistered "$D/provision-email.sh"
check "creates the resources when absent"            0 \
  env STUB_EMAIL_SVC_MISSING=1 STUB_COMMS_MISSING=1 "$D/provision-email.sh"
check "warns, not fails, when a create is refused"   0 \
  env STUB_EMAIL_SVC_MISSING=1 STUB_CREATE_FAIL=1 "$D/provision-email.sh"
check "warns, not fails, with no connection string"  0 env STUB_NO_CONNECTION=1 "$D/provision-email.sh"
check "warns, not fails, when a secret put is denied" 0 env STUB_SECRET_PUT_FAIL=1 "$D/provision-email.sh"

echo "the sender address must follow Azure, whoever changed it"
# The failure this is for: the linked domain was changed in the portal, so the
# script saw the link already correct, concluded nothing had changed, and left
# the Worker naming a domain that had been deleted.
SENDER_ENV="$STUB/senderenv"; : > "$SENDER_ENV"
DELETE_LOG="$STUB/deletes2"; : > "$DELETE_LOG"

check "publishes the sender for the deploy to pass as a var" 0 \
  env GITHUB_ENV="$SENDER_ENV" STUB_SECRET_DELETE_LOG="$DELETE_LOG" \
      STUB_EXISTING_SECRETS='[{"name":"CONTACT_SENDER_ADDRESS"}]' "$D/provision-email.sh"
if grep -q '^SENDER_ADDRESS=DoNotReply@' "$SENDER_ENV"; then
  printf '  ok    %s\n' "and takes the local part from Azure, not a guess"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and takes the local part from Azure, not a guess" "$(tr '\n' ' ' < "$SENDER_ENV")"; fail=$((fail + 1))
fi
: > "$DELETE_LOG"
check "removes nothing when no such secret exists" 0 \
  env STUB_SECRET_DELETE_LOG="$DELETE_LOG" "$D/provision-email.sh"
if [ ! -s "$DELETE_LOG" ]; then
  printf '  ok    %s\n' "and does not delete what is not there"; pass=$((pass + 1))
else
  printf '  FAIL  %s\n' "and does not delete what is not there"; fail=$((fail + 1))
fi

# The managed domain can be removed on purpose once a custom one works.
expect_output "uses the already linked domain instead of recreating a deleted one" "Using the already linked sender domain" \
  env STUB_DOMAIN_MISSING=1 "$D/provision-email.sh"

echo "custom-sender-domain.sh  (must publish the ownership TXT and nothing else)"
export ZONE_NAME=kyryll.com EMAIL_SERVICE=kyryll-email
export DOMAIN_VERIFY_ATTEMPTS=1 DOMAIN_VERIFY_SLEEP=0
DNS_LOG="$STUB/dns"

check "verifies a subdomain"                         0 \
  env CONTACT_SENDER_DOMAIN=send.kyryll.com "$D/custom-sender-domain.sh"
check "accepts the zone apex"                        0 \
  env CONTACT_SENDER_DOMAIN=kyryll.com "$D/custom-sender-domain.sh"
check "refuses a domain outside the zone"            0 \
  env CONTACT_SENDER_DOMAIN=example.com "$D/custom-sender-domain.sh"
expect_output "and says why" "not inside the zone" \
  env CONTACT_SENDER_DOMAIN=example.com "$D/custom-sender-domain.sh"

# The point of this one is that nothing happens to SPF or DMARC. They are live
# mail configuration; proving ownership does not require touching either.
: > "$DNS_LOG"
check "publishes only the ownership record"          0 \
  env CONTACT_SENDER_DOMAIN=kyryll.com STUB_CUSTOM_PENDING=1 STUB_HAS_SPF=1 STUB_HAS_DMARC=1 \
      STUB_DNS_LOG="$DNS_LOG" "$D/custom-sender-domain.sh"
if [ -s "$DNS_LOG" ] && ! grep -qiE 'v=spf1|v=DMARC1|_domainkey' "$DNS_LOG"; then
  printf '  ok    %s\n' "and writes no SPF, DMARC or DKIM record"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and writes no SPF, DMARC or DKIM record" "$(tr '\n' ' ' < "$DNS_LOG")"; fail=$((fail + 1))
fi
# Azure returns the full domain as the record name. Appending the domain to it
# produced kyryll.com.kyryll.com, which would never have verified.
expect_output "writes the ownership TXT at the domain itself" "ownership: TXT kyryll.com$" \
  env CONTACT_SENDER_DOMAIN=kyryll.com STUB_CUSTOM_PENDING=1 "$D/custom-sender-domain.sh"
expect_output "and at the subdomain when that is the sender" "ownership: TXT send.kyryll.com$" \
  env CONTACT_SENDER_DOMAIN=send.kyryll.com STUB_CUSTOM_PENDING=1 "$D/custom-sender-domain.sh"
# A relative label still works, so this is not one assumption swapped for another.
expect_output "still handles a relative label" "ownership: TXT _acme.kyryll.com$" \
  env CONTACT_SENDER_DOMAIN=kyryll.com STUB_CUSTOM_PENDING=1 STUB_DOMAIN_RECORD_NAME=_acme \
      "$D/custom-sender-domain.sh"

# Ownership proved is not the same as able to send.
expect_output "does not adopt the sender while SPF and DKIM are unverified" "Not sending from it yet" \
  env CONTACT_SENDER_DOMAIN=kyryll.com STUB_PARTIAL_VERIFY=1 "$D/custom-sender-domain.sh"

# DMARC is not in Azure's readiness set and commonly stays NotStarted for ever.
expect_output "adopts the domain with DMARC still NotStarted" "All records verified" \
  env CONTACT_SENDER_DOMAIN=kyryll.com "$D/custom-sender-domain.sh"

# Republishing on every deploy contradicts "you can remove it once verified".
: > "$DNS_LOG"
check "does not rewrite the TXT once ownership is verified" 0 \
  env CONTACT_SENDER_DOMAIN=kyryll.com STUB_DNS_LOG="$DNS_LOG" "$D/custom-sender-domain.sh"
if [ ! -s "$DNS_LOG" ]; then
  printf '  ok    %s\n' "and touches no DNS at all on that path"; pass=$((pass + 1))
else
  printf '  FAIL  %s (%s)\n' "and touches no DNS at all on that path" "$(tr '\n' ' ' < "$DNS_LOG")"; fail=$((fail + 1))
fi

check "warns, not fails, when ownership is still pending" 0 \
  env CONTACT_SENDER_DOMAIN=send.kyryll.com STUB_CUSTOM_PENDING=1 "$D/custom-sender-domain.sh"
expect_output "and says the record is published" "TXT record is published" \
  env CONTACT_SENDER_DOMAIN=send.kyryll.com STUB_CUSTOM_PENDING=1 "$D/custom-sender-domain.sh"
check "warns, not fails, when the domain cannot be created" 0 \
  env CONTACT_SENDER_DOMAIN=send.kyryll.com STUB_CUSTOM_DOMAIN_MISSING=1 STUB_CUSTOM_CREATE_FAIL=1 "$D/custom-sender-domain.sh"

echo
printf '%s passed, %s failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
