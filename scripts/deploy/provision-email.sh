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

# A customer-managed sender domain, if one was asked for.
#
# Opt-in via CONTACT_SENDER_DOMAIN, and never a dependency: if any part of it
# fails, the managed domain below is used instead and the contact form keeps
# working. The only thing lost is deliverability.
sender_domain=""
domain_id=""

if [ -n "${CONTACT_SENDER_DOMAIN:-}" ]; then
  child_env=$(mktemp)
  GITHUB_ENV="$child_env" EMAIL_SERVICE="$EMAIL_SERVICE" \
    "$(dirname "$0")/custom-sender-domain.sh" || true
  sender_domain=$(grep '^SENDER_DOMAIN=' "$child_env" 2>/dev/null | cut -d= -f2- | head -n1)
  domain_id=$(grep '^SENDER_DOMAIN_ID=' "$child_env" 2>/dev/null | cut -d= -f2- | head -n1)
  rm -f "$child_env"
fi

# The Azure-managed domain is free and needs no DNS records, which is what makes
# it the right fallback: a custom sender cannot send until its SPF and DKIM are
# verified, and until then there still has to be a working sender.
if [ -z "$sender_domain" ]; then
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
fi

if [ -z "$domain_id" ] || [ -z "$sender_domain" ]; then
  echo "::warning::Could not resolve a sender domain; skipping contact-form provisioning."
  exit 0
fi

# The secret list is read here, before anything is linked, because the sender
# secret has to be written *before* the link — see below.
if ! listing=$(cd worker && npx wrangler secret list 2>/dev/null); then
  echo "::warning::Could not list the Worker's secrets, so none were written. Nothing is overwritten on a failed read."
  exit 0
fi

if ! existing=$(printf '%s' "$listing" | jq -r '.[]?.name' 2>/dev/null); then
  echo "::warning::Could not parse the Worker's secret list, so none were written."
  exit 0
fi

wrote_all=true

put_secret() {
  local name="$1" value="$2" force="${3:-false}"
  if [ "$force" != true ] && printf '%s\n' "$existing" | grep -qx -- "$name"; then
    echo "  $name already set; leaving it alone"
    return 0
  fi
  if printf '%s' "$value" | (cd worker && npx wrangler secret put "$name" >/dev/null 2>&1); then
    echo "  $name set"
    return 0
  fi
  echo "::warning::Could not set the Worker secret $name."
  wrote_all=false
  return 1
}

if ! az communication show --name "$COMMS_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
  echo "Creating Communication Service $COMMS_SERVICE"
  az communication create \
    --name "$COMMS_SERVICE" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --location Global \
    --data-location "$DATA_LOCATION" \
    --linked-domains "$domain_id" \
    --only-show-errors || { echo "::warning::Could not create $COMMS_SERVICE; skipping."; exit 0; }
  put_secret CONTACT_SENDER_ADDRESS "donotreply@$sender_domain" true || true
else
  # Moving between the managed domain and a custom one changes which address is
  # allowed to send. Read what is linked rather than assuming, because the
  # sender secret has to follow it and a secret cannot be read back.
  # This read must succeed. Swallowing a failure into an empty string made the
  # domain look unlinked, so the script would try to link and then have nothing
  # to roll back to.
  if ! linked=$(az communication show --name "$COMMS_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" \
      --query "linkedDomains" -o tsv 2>/dev/null); then
    echo "::warning::Could not read the linked domains; leaving the sender configuration alone."
    exit 0
  fi

  if ! printf '%s\n' "$linked" | grep -qxF -- "$domain_id"; then
    # Secret first, link second, and the link is gated on the write.
    #
    # The other order is a trap. Link, then fail to write the secret, and Azure
    # is on the new domain while the Worker still names the old one — and the
    # next deploy sees the link already correct, decides nothing changed, and
    # leaves the stale secret alone for ever. Sending stays broken with nothing
    # reporting why.
    #
    # This way a failed write leaves both sides on the old domain, consistent
    # and working, and the next deploy tries the whole thing again.
    echo "Linking sender domain $sender_domain"
    if ! put_secret CONTACT_SENDER_ADDRESS "donotreply@$sender_domain" true; then
      echo "::warning::Not linking $sender_domain, since the Worker could not be told about it. Both sides stay on the current domain; the next deploy will retry."
      exit 0
    fi

    update_reported_failure=false
    az communication update --name "$COMMS_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" \
      --linked-domains "$domain_id" --only-show-errors >/dev/null 2>&1 || update_reported_failure=true

    # Re-read rather than believe the exit code.
    #
    # A non-zero az is not proof the change did not happen: the request can
    # succeed server-side and the CLI still fail while receiving the response.
    # Rolling the sender back on that assumption would leave Azure linked to the
    # new domain and the Worker naming the old one — and since the link then
    # looks correct, every later deploy concludes nothing changed and leaves the
    # stale secret alone for ever. Ask Azure what is actually linked.
    if ! actual=$(az communication show --name "$COMMS_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" \
        --query "linkedDomains" -o tsv 2>/dev/null); then
      echo "::error::Could not confirm which domain is linked after the update. The Worker is set to donotreply@$sender_domain; check that Azure agrees before relying on the contact form."
      exit 0
    fi

    if printf '%s\n' "$actual" | grep -qxF -- "$domain_id"; then
      if [ "$update_reported_failure" = true ]; then
        echo "The link update reported failure, but Azure is linked to $sender_domain. Keeping the new sender."
      fi
    else
      echo "::warning::Could not link $sender_domain."

      # Roll the sender back to whatever Azure is actually linked to. wrangler
      # publishes a secret immediately, so without this the Worker would be
      # sending as an address Azure has not authorised.
      previous=$(printf '%s\n' "$actual" | head -n1)
      previous_sender=""
      [ -n "$previous" ] && previous_sender=$(az resource show --ids "$previous" \
        --query "properties.fromSenderDomain" -o tsv 2>/dev/null || true)

      if [ -n "$previous_sender" ]; then
        if put_secret CONTACT_SENDER_ADDRESS "donotreply@$previous_sender" true; then
          echo "Sender rolled back to donotreply@$previous_sender, which is what is linked."
        else
          echo "::error::Could not roll the sender back. The Worker is set to donotreply@$sender_domain but Azure is linked to $previous — the contact form will fail until the next successful deploy."
        fi
      else
        echo "::error::Could not determine the linked sender to roll back to. The Worker is set to donotreply@$sender_domain but Azure is not linked to it."
      fi

      exit 0
    fi
  fi
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

put_secret COMMUNICATION_SERVICES_CONNECTION_STRING "$connection"
# Forced above only when the linked domain is changing. This is the other case:
# the link is already correct but the secret is absent — a first provision, or
# someone deleted it — where it simply has to be created.
put_secret CONTACT_SENDER_ADDRESS "donotreply@$sender_domain"
put_secret CONTACT_RECIPIENT_ADDRESS "$CONTACT_RECIPIENT_ADDRESS"

# Only claim success when it is true. A run that failed to write a secret leaves
# the endpoint answering 500, and saying "provisioned" would send whoever reads
# the log looking anywhere but here.
if [ "$wrote_all" = true ]; then
  echo "Contact form provisioned: sender donotreply@$sender_domain"
else
  echo "::warning::The contact form is not fully configured; /api/contact will answer 500 until the missing secrets are set."
fi
exit 0
