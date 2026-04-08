# IMPL: Webhooks Provider

## Provider Info
- **Slug**: `webhooks`
- **Display Name**: Webhooks
- **Auth Mode**: API Key (generic)
- **Base URL**: N/A (user-configured)
- **Docs**: N/A

## Concept
A generic webhook provider that allows agents to send HTTP requests to arbitrary URLs. Unlike other providers that connect to a specific API, this provider enables:
- Sending outbound webhooks to any URL
- Configuring custom headers and authentication
- Posting JSON payloads to external services

## Auth Details
- **Auth Mode**: `api_key`
- **Credential Schema**:
  - `webhook_url` (string) — Target webhook URL
  - `secret_header_name` (string, optional) — Custom header name for auth (e.g. `X-Webhook-Secret`)
  - `secret_header_value` (string, optional) — Secret value for the auth header
- **allowAllUris**: true (webhooks can target any URL)

## Authorized URIs
- `allowAllUris: true` — Webhooks can send to any URL

## Setup Guide
1. Enter the webhook URL you want to send data to
2. Optionally configure a secret header for authentication
3. Test the connection by sending a test payload

## Key Endpoints to Document
This is a generic provider — the PROVIDER.md will document:
1. How to construct POST requests to webhook URLs
2. Common webhook payload formats
3. How to add custom headers
4. Common webhook verification patterns (HMAC signatures)
5. Retry strategies for failed deliveries

## Compatibility Notes
- This is a **special provider** — it doesn't connect to a specific API
- `allowAllUris: true` is required since target URLs are user-defined
- Agent should default to POST with JSON content type
- Useful for integrating with services that don't have dedicated providers (e.g. Zapier, Make, custom APIs)
