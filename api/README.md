# api/

Managed Azure Functions for the site, deployed alongside it by Azure Static Web
Apps. There is no separate Function App to create — SWA hosts these as part of
the same resource.

## `POST /api/contact`

Delivers the contact form. Request body:

```json
{
  "sendername": "…",
  "email": "…",
  "phone": "…",
  "comments": "…",
  "website": ""
}
```

`website` is a honeypot — it is hidden off-screen in the form, and a submission
that fills it is silently discarded with a 200.

| Status | Meaning |
|---|---|
| 200 | Delivered (or honeypot silently discarded) |
| 400 | Validation failure. Body carries `{ field, message }`; the front end rumbles that field. |
| 429 | More than 5 submissions from one IP in an hour |
| 500 | Email is not configured — see below |
| 502 | Azure Communication Services rejected the send |

## Configuration

Three application settings must exist on the Static Web App
(**Configuration → Application settings**, or `az staticwebapp appsettings set`).
None of them belong in this repository.

| Setting | Value |
|---|---|
| `COMMUNICATION_SERVICES_CONNECTION_STRING` | Connection string from the Azure Communication Services resource |
| `CONTACT_SENDER_ADDRESS` | Verified sender, e.g. `donotreply@<your-domain>` |
| `CONTACT_RECIPIENT_ADDRESS` | Where messages land, e.g. `info@kyryll.com` |

Setting them from the CLI:

```bash
az staticwebapp appsettings set --name <swa-name> --setting-names COMMUNICATION_SERVICES_CONNECTION_STRING="<connection-string>" CONTACT_SENDER_ADDRESS="donotreply@<domain>" CONTACT_RECIPIENT_ADDRESS="info@kyryll.com"
```

Until they are set the endpoint returns 500 and the form shows "Could not
reach the server". That is the same message the original showed, so nothing
regresses while the resource is being provisioned.

### Provisioning Communication Services Email

One-off, in the Azure portal:

1. Create an **Email Communication Service** resource.
2. Add a domain — the free `Azure Managed Domain` works immediately and sends
   from `donotreply@<guid>.azurecomm.net`, or connect `kyryll.com` and add the
   SPF/DKIM records it gives you.
3. Create a **Communication Services** resource and connect the email domain.
4. Copy its connection string into the setting above.

## Local development

```bash
npm install --prefix api
npm install -g @azure/static-web-apps-cli azure-functions-core-tools@4
swa start faithful/dist --api-location api
```

Put the three settings in `api/local.settings.json` (git-ignored) under
`Values` for local runs.

## Reply-to

The message is sent from `CONTACT_SENDER_ADDRESS` with `replyTo` set to the
visitor's address, so replying from your mail client goes to them. The
visitor's address is never used as the From header — that would fail SPF and
land the mail in spam.
