# IMPL: ActiveCampaign Provider

## Provider Info
- **Slug**: `activecampaign`
- **Display Name**: ActiveCampaign
- **Auth Mode**: API Key
- **Base URL**: `https://{account}.api-us1.com/api/3`
- **Docs**: https://developers.activecampaign.com/reference/overview

## Auth Details
- **Auth Mode**: `api_key`
- **Credential Schema**:
  - `account_name` (string) — ActiveCampaign account name (subdomain)
  - `api_key` (string) — API key from Settings → Developer
- **Header**: `Api-Token: {api_key}`

## Authorized URIs
- `https://*.api-us1.com/*`

## Setup Guide
1. Go to Settings → Developer in your ActiveCampaign account
2. Copy the API URL and API Key
3. Enter your account name and API key

## Key Endpoints to Document
1. GET /api/3/contacts — List contacts
2. GET /api/3/contacts/{id} — Get contact
3. POST /api/3/contacts — Create contact
4. PUT /api/3/contacts/{id} — Update contact
5. DELETE /api/3/contacts/{id} — Delete contact
6. GET /api/3/deals — List deals
7. GET /api/3/deals/{id} — Get deal
8. POST /api/3/deals — Create deal
9. GET /api/3/campaigns — List campaigns
10. GET /api/3/lists — List mailing lists
11. POST /api/3/contactLists — Subscribe contact to list
12. GET /api/3/automations — List automations

## Compatibility Notes
- API key is sent as `Api-Token` header (NOT `Authorization: Bearer`)
- Custom `credentialHeaderName: "Api-Token"`, NO prefix
- Base URL is account-specific: `https://{account}.api-us1.com`
- Agent needs to construct the base URL from the account name
- Pagination uses `offset` and `limit` parameters
- Rate limit: 5 requests/second
