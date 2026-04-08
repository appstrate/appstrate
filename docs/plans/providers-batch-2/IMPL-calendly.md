# IMPL: Calendly Provider

## Provider Info
- **Slug**: `calendly`
- **Display Name**: Calendly
- **Auth Mode**: OAuth2
- **Base URL**: `https://api.calendly.com`
- **Docs**: https://developer.calendly.com/api-docs

## Auth Details
- **Authorization URL**: `https://auth.calendly.com/oauth/authorize`
- **Token URL**: `https://auth.calendly.com/oauth/token`
- **Refresh URL**: `https://auth.calendly.com/oauth/token`
- **PKCE**: true
- **Token Auth Method**: `client_secret_post`
- **Scope Separator**: space

## Scopes
- **Default (read-only)**:
  - `default` — Read access to user's Calendly data
- **Available**:
  - `default` — Standard read/write access
  - `admin` — Organization admin access

## Authorized URIs
- `https://api.calendly.com/*`

## Setup Guide
1. Create a Calendly OAuth app → https://developer.calendly.com/create-a-developer-account
2. Configure redirect URI
3. Copy Client ID and Client Secret

## Key Endpoints to Document
1. GET /users/me — Get current user
2. GET /event_types — List event types
3. GET /event_types/{uuid} — Get event type
4. GET /scheduled_events — List scheduled events
5. GET /scheduled_events/{uuid} — Get scheduled event
6. GET /scheduled_events/{uuid}/invitees — List invitees
7. POST /scheduling_links — Create scheduling link
8. GET /organization_memberships — List organization members
9. POST /webhook_subscriptions — Create webhook subscription
10. GET /webhook_subscriptions — List webhook subscriptions

## Compatibility Notes
- Calendly uses UUIDs for resource identification
- All list endpoints use cursor-based pagination with `page_token` and `count`
- Resources are scoped by organization URI (returned in /users/me)
- Tokens expire after 2 hours, refresh tokens are long-lived
