#!/usr/bin/env bash
#
# Creates the Azure Communication Services resources the contact form needs, in
# the same resource group as the storage account, and hands the Worker its three
# secrets.
#
# Idempotent: everything is created only if absent, so this is a no-op on every
# deploy after the first.
#
# Never fatal, for the same reason as the fallback scripts — the site serves
# perfectly well without a working contact form, and this step runs before the
# upload and the Worker deploy, so failing here would take the whole deployment
# with it. When it cannot finish, the endpoint keeps returning the honest 500 it
# returns today.
#
# One thing it deliberately does not do: overwrite a secret that already exists.
# Rotation stays an explicit act — delete the secret and redeploy — rather than
# something that happens silently on a schedule nobody chose.
set -uo pipefail

: "${AZURE_RESOURCE_GROUP:?required}"

if [ -z "${CONTACT_RECIPIENT_ADDRESS:-}" ]; then
  echo "::notice::CONTACT_RECIPIENT_ADDRESS is not set, so the contact form is not being provisioned. /api/contact will answer 500 until it is."
  exit 0
fi

EMAIL_SERVICE="${EMAIL_SERVICE_NAME:-kyryll-email}"
COMMS_SERVICE="${COMMS_SERVICE_NAME:-kyryll-comms}"
DATA_LOCATION="${ACS_DATA_LOCATION:-Australia}"

# Registration is a subscription-level action and the deploy identity is only
# Contributor on one resource group, so this cannot self-heal. Say exactly what
# to run rather than failing with Azure's own wording, which does not mention
# that a one-off command fixes it for good.
if ! az provider show --namespace Microsoft.Communication --query "registrationState" -o tsv 2>/dev/null | grep -qi "^Registered$"; then
  echo "::warning::Microsoft.Communication is not registered on this subscription, and the deploy identity cannot register it. Run once, as an owner: az provider register --namespace Microsoft.Communication --wait"
  exit 0
fi

if ! az communication email show --name "$EMAIL_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Creating Email Communication Service $EMAIL_SERVICE"
  az communication email create \
    --name "$EMAIL_SERVICE" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --location Global \
    --data-location "$DATA_LOCATION" \
    --only-show-errors || { echo "::warning::Could not create $EMAIL_SERVICE; skipping contact-form provisioning."; exit 0; }
fi

# The Azure-managed domain is free and needs no DNS records, which is what makes
# this scriptable at all — a custom sender domain would need SPF and DKIM
# records published and verified before it could send anything.
if ! az communication email domain show --domain-name AzureManagedDomain \
      --email-service-name "$EMAIL_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Creating the Azure-managed sender domain"
  az communication email domain create \
    --domain-name AzureManagedDomain \
    --email-service-name "$EMAIL_SERVICE" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --location Global \
    --domain-management AzureManaged \
    --only-show-errors || { echo "::warning::Could not create the managed domain; skipping."; exit 0; }
fi

domain_id=$(az communication email domain show \
  --domain-name AzureManagedDomain \
  --email-service-name "$EMAIL_SERVICE" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query id -o tsv 2>/dev/null || true)

sender_domain=$(az communication email domain show \
  --domain-name AzureManagedDomain \
  --email-service-name "$EMAIL_SERVICE" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query "fromSenderDomain" -o tsv 2>/dev/null || true)

if [ -z "$domain_id" ] || [ -z "$sender_domain" ]; then
  echo "::warning::Could not read the managed domain; skipping contact-form provisioning."
  exit 0
fi

if ! az communication show --name "$COMMS_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Creating Communication Service $COMMS_SERVICE"
  az communication create \
    --name "$COMMS_SERVICE" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --location Global \
    --data-location "$DATA_LOCATION" \
    --linked-domains "$domain_id" \
    --only-show-errors || { echo "::warning::Could not create $COMMS_SERVICE; skipping."; exit 0; }
fi

connection=$(az communication list-key \
  --name "$COMMS_SERVICE" \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --query primaryConnectionString -o tsv 2>/dev/null || true)

if [ -z "$connection" ]; then
  echo "::warning::Could not read the Communication Services connection string; skipping."
  exit 0
fi
echo "::add-mask::$connection"

# Only set what is missing. `wrangler secret list` is the check; if it cannot be
# read, nothing is written, because overwriting a working secret on a bad read
# is the one outcome worth avoiding here.
existing=$(cd worker && npx wrangler secret list 2>/dev/null | jq -r '.[]?.name' 2>/dev/null || true)

put_secret() {
  local name="$1" value="$2"
  if printf '%s\n' "$existing" | grep -qx -- "$name"; then
    echo "  $name already set; leaving it alone"
    return 0
  fi
  if printf '%s' "$value" | (cd worker && npx wrangler secret put "$name" >/dev/null 2>&1); then
    echo "  $name set"
  else
    echo "::warning::Could not set the Worker secret $name."
  fi
}

put_secret COMMUNICATION_SERVICES_CONNECTION_STRING "$connection"
put_secret CONTACT_SENDER_ADDRESS "donotreply@$sender_domain"
put_secret CONTACT_RECIPIENT_ADDRESS "$CONTACT_RECIPIENT_ADDRESS"

echo "Contact form provisioned: sender donotreply@$sender_domain"
exit 0
