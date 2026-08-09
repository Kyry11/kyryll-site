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
  # If something is already linked, use that rather than creating anything.
  #
  # The managed domain can be deleted on purpose once a custom one is working,
  # and recreating it here would undo that — and quietly move sending back to
  # an address nobody chose.
  # Only a *successful* empty answer means nothing is linked.
  #
  # Swallowing the failure with `|| true` made an unreadable answer look
  # identical to an empty one, and the consequence was not cosmetic: the script
  # would go on to select the managed domain and then relink the service to it,
  # replacing a custom domain somebody had deliberately linked, because a read
  # timed out.
  existing_link=""
  if az communication show --name "$COMMS_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" >/dev/null 2>&1; then
    if ! existing_link=$(az communication show --name "$COMMS_SERVICE" \
        --resource-group "$AZURE_RESOURCE_GROUP" --query "linkedDomains" -o tsv 2>/dev/null); then
      echo "::warning::Could not read the linked domains; leaving the sender configuration alone."
      exit 0
    fi
    existing_link=$(printf '%s\n' "$existing_link" | head -n1)
  fi

  if [ -n "$existing_link" ]; then
    domain_id="$existing_link"
    if ! sender_domain=$(az resource show --ids "$existing_link" \
        --query "properties.fromSenderDomain" -o tsv 2>/dev/null); then
      echo "::warning::Could not read the linked domain; leaving the sender configuration alone."
      exit 0
    fi
    [ -n "$sender_domain" ] && echo "Using the already linked sender domain $sender_domain"
  fi
fi

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
else
  if ! linked=$(az communication show --name "$COMMS_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" \
      --query "linkedDomains" -o tsv 2>/dev/null); then
    echo "::warning::Could not read the linked domains; not relinking."
    exit 0
  fi

  if ! printf '%s\n' "$linked" | grep -qxF -- "$domain_id"; then
    echo "Linking sender domain $sender_domain"
    az communication update --name "$COMMS_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" \
      --linked-domains "$domain_id" --only-show-errors >/dev/null 2>&1 \
      || echo "::warning::Could not link $sender_domain; whatever is currently linked stays in use."
  fi
fi

# Everything above was an *intention*. This is what actually happened.
#
# The sender is derived here, after the fact, from whatever Azure reports is
# linked — not from what this script set out to link. That one change removes a
# whole class of problem that earlier versions fought with: writing the sender
# before linking so a failed write could not strand the two systems, rolling it
# back when the link failed instead, and re-reading Azure because a non-zero
# exit is not proof the change did not happen. None of that is needed once the
# value is simply read from reality at the end and republished on every deploy.
#
# It also fixes the failure that prompted all this: the linked domain changed in
# the portal, the script saw the link already correct, concluded nothing had
# changed, and left the Worker naming a domain that had been deleted.
if ! actual=$(az communication show --name "$COMMS_SERVICE" --resource-group "$AZURE_RESOURCE_GROUP" \
    --query "linkedDomains" -o tsv 2>/dev/null); then
  echo "::warning::Could not confirm which domain is linked; leaving the sender configuration alone."
  exit 0
fi
actual=$(printf '%s\n' "$actual" | head -n1)

if [ -z "$actual" ]; then
  echo "::warning::No sender domain is linked to $COMMS_SERVICE; the contact form cannot send."
  exit 0
fi

if ! actual_domain=$(az resource show --ids "$actual" \
    --query "properties.fromSenderDomain" -o tsv 2>/dev/null); then
  echo "::warning::Could not read the linked domain's sender address; leaving the sender configuration alone."
  exit 0
fi

# The local part comes from Azure too, rather than being assumed. This was
# hardcoded `donotreply@`, which is what the managed domain happens to use; a
# custom domain's sender usernames are whatever you registered, and on
# kyryll.com that is `DoNotReply`. A mismatch is rejected at send time with
# nothing on the site to say why.
if ! actual_user=$(az communication email domain sender-username list \
    --domain-name "$(basename "$actual")" \
    --email-service-name "$EMAIL_SERVICE" \
    --resource-group "$AZURE_RESOURCE_GROUP" \
    --query "[0].username" -o tsv 2>/dev/null); then
  echo "::warning::Could not read the sender usernames for $(basename "$actual"); leaving the sender configuration alone."
  exit 0
fi

if [ -z "$actual_user" ]; then
  # An empty list is only evidence of a default on the managed domain, where
  # `donotreply` is the one Azure creates. On a domain you registered yourself
  # an empty list means no sender exists, and guessing publishes an address ACS
  # will reject — which is the failure this whole change is about.
  if [ "$(basename "$actual")" = "AzureManagedDomain" ]; then
    actual_user=donotreply
  else
    echo "::warning::No sender usernames are registered on $(basename "$actual"); leaving the sender configuration alone."
    exit 0
  fi
fi

if [ -z "$actual_domain" ]; then
  echo "::warning::Could not read the linked domain's sender address; the contact form may not send."
  exit 0
fi

SENDER_ADDRESS="$actual_user@$actual_domain"
[ "$sender_domain" = "$actual_domain" ] || echo "Sender follows what is linked: $SENDER_ADDRESS"

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
put_secret CONTACT_RECIPIENT_ADDRESS "$CONTACT_RECIPIENT_ADDRESS"

# The sender is published as a plain variable, not a secret.
#
# It is a public From address, so nothing is gained by hiding it — and a great
# deal is lost. A secret cannot be read back, so the script could only guess
# whether it was current, and it guessed by watching for changes *it* made. When
# the linked domain was changed in the portal instead, the link looked correct,
# nothing appeared to have changed, and the Worker went on naming a domain that
# had been deleted. Every send failed and no deploy would have repaired it.
#
# A variable is written on every deploy from whatever Azure says is linked, so
# it cannot drift, whoever moved it.
echo "SENDER_ADDRESS=$SENDER_ADDRESS" >> "${GITHUB_ENV:-/dev/null}"

# A secret of the same name shadows the variable, so one left by an older deploy
# has to go — but not here.
#
# `wrangler secret delete` publishes a new version of the Worker immediately,
# and the variable that replaces it is not deployed until several steps later.
# Removing it now would leave the Worker with no sender at all for the length of
# the upload and prune, and permanently if any of those failed. Flagged instead,
# and removed after the deploy that carries the variable.
if printf '%s\n' "$existing" | grep -qx -- CONTACT_SENDER_ADDRESS; then
  echo "SENDER_SECRET_SHADOWS_VAR=true" >> "${GITHUB_ENV:-/dev/null}"
fi

# Only claim success when it is true. A run that failed to write a secret leaves
# the endpoint answering 500, and saying "provisioned" would send whoever reads
# the log looking anywhere but here.
if [ "$wrote_all" = true ]; then
  echo "Contact form provisioned: sender $SENDER_ADDRESS"
else
  echo "::warning::The contact form is not fully configured; /api/contact will answer 500 until the missing secrets are set."
fi
exit 0
