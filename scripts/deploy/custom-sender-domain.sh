#!/usr/bin/env bash
#
# Provisions a customer-managed sender domain on the Email Communication
# Service: creates it, publishes the records Azure asks for into Cloudflare,
# asks Azure to verify each one, and waits.
#
# Opt-in, via CONTACT_SENDER_DOMAIN. Without it the caller uses the free
# Azure-managed domain, which needs none of this.
#
# Never fatal, and never a reason to fall back to nothing: if any of it fails
# the caller keeps the managed domain and the contact form keeps working. This
# is a deliverability improvement, not a dependency.
#
# On success it writes SENDER_DOMAIN and SENDER_DOMAIN_ID to $GITHUB_ENV.
set -uo pipefail
. "$(dirname "$0")/common.sh"

: "${CONTACT_SENDER_DOMAIN:?required}"
: "${EMAIL_SERVICE:?required}"
: "${AZURE_RESOURCE_GROUP:?required}"

# tr, not ${x,,}: that is bash 4+ and macOS ships 3.2, so the local
# test run would never have exercised any of this.
domain=$(printf '%s' "$CONTACT_SENDER_DOMAIN" | tr '[:upper:]' '[:lower:]')
zone=$(printf '%s' "${ZONE_NAME:-}" | tr '[:upper:]' '[:lower:]')

# ---- guards -------------------------------------------------------------------
#
# The apex is allowed. An earlier version refused it, and that was aimed at the
# wrong record: the ownership TXT Azure asks for is `ms-domain-verification=...`,
# which is inert and affects nothing, exactly as the portal says.
#
# The records that genuinely could break live mail are SPF and DMARC, and they
# are handled below by merging and by leaving well alone — never by writing what
# Azure suggests over the top. kyryll.com publishes an SPF record authorising
# Google Workspace and a DMARC record with real reporting addresses; both
# survive.

if [ -n "$zone" ] && [ "$domain" != "$zone" ] && [[ "$domain" != *".$zone" ]]; then
  echo "::warning::CONTACT_SENDER_DOMAIN ($domain) is not inside the zone ${ZONE_NAME}. Refusing, since the records could not be published."
  exit 0
fi

# ---- the domain resource -----------------------------------------------------

if ! az communication email domain show \
      --domain-name "$domain" --email-service-name "$EMAIL_SERVICE" \
      --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Creating customer-managed sender domain $domain"
  if ! az communication email domain create \
        --domain-name "$domain" \
        --email-service-name "$EMAIL_SERVICE" \
        --resource-group "$AZURE_RESOURCE_GROUP" \
        --location Global \
        --domain-management CustomerManaged \
        --only-show-errors >/dev/null; then
    echo "::warning::Could not create the sender domain $domain; keeping the managed domain."
    exit 0
  fi
fi

describe() {
  az communication email domain show \
    --domain-name "$domain" --email-service-name "$EMAIL_SERVICE" \
    --resource-group "$AZURE_RESOURCE_GROUP" -o json 2>/dev/null
}

domain_json=$(describe)
if [ -z "$domain_json" ]; then
  echo "::warning::Could not read $domain; keeping the managed domain."
  exit 0
fi

# ---- publish what Azure asks for --------------------------------------------
#
# Iterated rather than hard-coded. Azure returns Domain, SPF, DKIM, DKIM2 and
# DMARC today; reading them back means a change to that set does not silently
# leave a record unpublished.
records=$(printf '%s' "$domain_json" | jq -c '.verificationRecords // {} | to_entries[]' 2>/dev/null)
if [ -z "$records" ]; then
  echo "::warning::$domain returned no verification records; keeping the managed domain."
  exit 0
fi

# Only the ownership record is published.
#
# Azure returns five verification records — Domain, SPF, DKIM, DKIM2, DMARC —
# and an earlier version of this script published all of them, merging Azure's
# include into the existing SPF record and skipping DMARC if one was present.
# Careful, but not asked for: the request was proof of ownership, and SPF and
# DMARC are live mail configuration that this has no business rewriting.
#
# `ms-domain-verification=...` is inert. It authorises nothing, it is additive,
# and it can be deleted once verification completes. That is the whole of what
# gets written here.
#
# Sending from the domain additionally needs SPF and DKIM verified. Until they
# are, this proves ownership and nothing changes: the managed domain keeps
# sending, and the block at the end only adopts the custom domain once every
# record is verified — so configuring the rest by hand later is picked up
# automatically on the next deploy.
# Already proved? Then there is nothing to publish. Rewriting the record on
# every deploy contradicted the documented "you can remove it once verified" —
# it would simply reappear.
if [ "$(printf '%s' "$domain_json" | jq -r '.verificationStates.Domain.status // empty')" = "Verified" ]; then
  echo "  ownership: already verified, leaving DNS alone"
else

entry=$(printf '%s' "$records" | jq -c 'select(.key == "Domain")' 2>/dev/null | head -n1)
if [ -z "$entry" ]; then
  echo "::warning::$domain returned no ownership record; keeping the managed domain."
  exit 0
fi

rtype=$(printf '%s' "$entry" | jq -r '.value.type // "TXT"')
rname=$(printf '%s' "$entry" | jq -r '.value.name // ""')
rvalue=$(printf '%s' "$entry" | jq -r '.value.value // empty')

if [ -z "$rvalue" ]; then
  echo "::warning::$domain returned an empty ownership record; keeping the managed domain."
  exit 0
fi

# Azure returns the *full* name here, not a label relative to the domain — the
# portal's own verification dialog shows "TXT name: kyryll.com". Appending the
# domain unconditionally produced kyryll.com.kyryll.com, which would never have
# verified, and the fixture hid it by leaving the name empty.
#
# Both shapes are accepted rather than swapping one assumption for another:
# empty or "@" means the domain itself, a name that already ends with the domain
# is used as it stands, and anything else is treated as a relative label.
case "$rname" in
  ""|"@")               fqdn="$domain" ;;
  "$domain"|*".$domain") fqdn="$rname" ;;
  *)                    fqdn="$rname.$domain" ;;
esac

found=$(cf -G "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
  --data-urlencode "type=$rtype" --data-urlencode "name=$fqdn")
if ! cf_ok "$found"; then
  echo "::warning::Could not read existing $rtype records at $fqdn; keeping the managed domain."
  exit 0
fi

# Matched by prefix so a re-issued value replaces the old one rather than
# accumulating, and so nothing else at that name is ever touched. SPF, DMARC,
# Google's site verification and anything else sharing the name are invisible
# to this.
id=$(printf '%s' "$found" \
  | jq -r '.result[]? | select((.content // "") | startswith("ms-domain-verification=")) | .id' \
  | head -n1)

payload=$(jq -n --arg t "$rtype" --arg n "$fqdn" --arg c "$rvalue" \
  '{type:$t, name:$n, content:$c, ttl:3600, proxied:false}')

if [ -n "$id" ]; then
  response=$(cf -X PUT "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records/$id" \
    -H "Content-Type: application/json" --data "$payload")
else
  response=$(cf -X POST "$CF_API/zones/$CLOUDFLARE_ZONE_ID/dns_records" \
    -H "Content-Type: application/json" --data "$payload")
fi

if cf_ok "$response"; then
  echo "  ownership: $rtype $fqdn"
else
  echo "::warning::Could not publish the ownership record for $domain; keeping the managed domain."
  cf_report "$response"
  exit 0
fi

fi

# ---- ask Azure to check, then wait ------------------------------------------

# Ownership only. Asking Azure to verify SPF or DKIM would be asking it to
# check records this script has deliberately not written.
if [ "$(printf '%s' "$domain_json" | jq -r '.verificationStates.Domain.status // empty')" != "Verified" ]; then
  az communication email domain initiate-verification \
    --domain-name "$domain" --email-service-name "$EMAIL_SERVICE" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --verification-type Domain --only-show-errors >/dev/null 2>&1 || true
fi

attempts="${DOMAIN_VERIFY_ATTEMPTS:-20}"
for attempt in $(seq 1 "$attempts"); do
  domain_json=$(describe)
  owned=$(printf '%s' "$domain_json" | jq -r '.verificationStates.Domain.status // empty' 2>/dev/null)
  if [ "$owned" != "Verified" ]; then
    echo "  waiting on ownership (attempt $attempt/$attempts)"
    sleep "${DOMAIN_VERIFY_SLEEP:-30}"
    continue
  fi

  # Ownership is proved. Adopting it as the sender is a separate question:
  # Azure will not send from a domain whose SPF and DKIM are unverified, and
  # this script does not write those. If they have been configured by hand, ask
  # Azure to re-check them — that reads DNS, it does not modify it, and without
  # it records published by hand would sit at NotStarted for ever.
  for kind in SPF DKIM DKIM2; do
    state=$(printf '%s' "$domain_json" | jq -r --arg k "$kind" '.verificationStates[$k].status // empty')
    [ "$state" = "Verified" ] && continue
    az communication email domain initiate-verification \
      --domain-name "$domain" --email-service-name "$EMAIL_SERVICE" \
      --resource-group "$AZURE_RESOURCE_GROUP" \
      --verification-type "$kind" --only-show-errors >/dev/null 2>&1 || true
  done
  domain_json=$(describe)

  # Only the four Azure requires to send. DMARC is not one of them and commonly
  # stays NotStarted for ever — gating on every state meant a domain whose
  # sending records were all verified could never be adopted, and the tests hid
  # it by pretending DMARC was verified too.
  pending=$(printf '%s' "$domain_json" \
    | jq -r '[["Domain","SPF","DKIM","DKIM2"][] as $k | select((.verificationStates[$k].status // "NotStarted") != "Verified") | $k] | join(",")' 2>/dev/null)

  if [ -n "$pending" ]; then
    echo "Ownership of $domain is verified. Not sending from it yet: $pending still unverified, and this deploy does not write SPF or DKIM records. Configure them if you want to send from $domain."
    exit 0
  fi

  if [ -z "$pending" ]; then
    id=$(printf '%s' "$domain_json" | jq -r '.id // empty')
    echo "All records verified for $domain"
    {
      echo "SENDER_DOMAIN=$domain"
      echo "SENDER_DOMAIN_ID=$id"
    } >> "${GITHUB_ENV:-/dev/null}"
    exit 0
  fi

  echo "  waiting on: $pending (attempt $attempt/$attempts)"
  sleep "${DOMAIN_VERIFY_SLEEP:-30}"
done

# DNS takes as long as it takes. Not an error — the records are published and
# the next deploy picks up where this left off.
echo "::warning::Ownership of $domain is not verified yet. The TXT record is published; re-run the deploy once DNS has settled. The managed domain is being used in the meantime."
exit 0
