# IMPL: Fathom Provider

## Provider Info
- **Slug**: `fathom`
- **Display Name**: Fathom
- **Auth Mode**: API Key
- **Base URL**: `https://api.fathom.video/v1`
- **Docs**: https://developers.fathom.ai/

## Auth Details
- **Auth Mode**: `api_key`
- **Credential Schema**:
  - `api_key` (string) — Fathom API key (from Settings)
- **Header**: `Authorization: Bearer {api_key}`

## Note on OAuth
Fathom also supports OAuth2 for public integrations, but the primary and simplest auth method is API keys. OAuth is for building integrations for other Fathom users.

## Authorized URIs
- `https://api.fathom.video/*`

## Setup Guide
1. Go to Fathom Settings → API section
2. Generate an API key
3. Copy the API key

## Key Endpoints to Document
1. GET /v1/calls — List recent meetings/calls
2. GET /v1/calls/{id} — Get call details (includes transcript, summary, action items)
3. GET /v1/calls?attendee_email={email} — Filter calls by attendee
4. GET /v1/calls?from={date}&to={date} — Filter calls by date range
5. POST /v1/webhooks — Create webhook subscription
6. GET /v1/webhooks — List webhooks
7. DELETE /v1/webhooks/{id} — Delete webhook

## Compatibility Notes
- API keys are user-scoped: access meetings recorded by you or shared to your Team
- Admin API keys do NOT grant access to other users' unshared meetings
- Rate limit: 60 calls per minute per user (across all API keys)
- Rate limit headers: `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
- Pagination uses cursor-based pagination with `next_cursor` parameter
- Call objects include: title, transcript, summary, action items, CRM matches, attendees
- Webhook events notify when new meetings are processed
