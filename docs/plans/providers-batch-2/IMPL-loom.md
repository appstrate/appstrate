# IMPL: Loom Provider

## Provider Info
- **Slug**: `loom`
- **Display Name**: Loom
- **Auth Mode**: API Key
- **Base URL**: `https://developer.loom.com/v1` (limited public API)
- **Docs**: https://dev.loom.com/docs

## Auth Details
- **Auth Mode**: `api_key`
- **Credential Schema**:
  - `api_key` (string) — Loom Developer API key
- **Header**: `Authorization: Bearer {api_key}`

## ⚠️ Limited API
Loom's public REST API is **very limited**. Loom primarily offers:
1. **Record SDK** — JavaScript SDK for embedding recording in web apps
2. **Embed SDK** — For embedding Loom videos
3. **oEmbed** — For fetching video embed metadata

There is NO comprehensive REST API for managing videos, workspaces, etc. The developer platform is focused on the SDK, not on API-level access.

**Recommendation**: Create the provider for basic oEmbed/API usage, with PROVIDER.md documenting the limited API surface. The provider is primarily useful for:
- Fetching video metadata via oEmbed
- Embedding Loom videos
- Getting video transcripts (if available via API)

## Authorized URIs
- `https://www.loom.com/*`
- `https://developer.loom.com/*`

## Setup Guide
1. Create a Loom developer account → https://dev.loom.com/
2. Create an app in the Developer Portal
3. Copy your API credentials

## Key Endpoints to Document
1. GET /v1/oembed?url={loom_url} — Get video embed metadata (oEmbed)
2. GET /v1/videos/{id} — Get video info (if available)
3. GET /v1/videos — List videos (if available)

## Compatibility Notes
- **Very limited API surface** — Loom is primarily an SDK-based platform
- Most integrations use the Record SDK or Embed SDK (JavaScript)
- oEmbed endpoint is the most reliable REST endpoint
- Provider mainly useful for fetching video metadata and embedding
- No granular read/write permissions — SDK-based access model
