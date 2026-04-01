# @appstrate/connect

OAuth2/PKCE, API key authentication, and encrypted credential storage for provider connections.

## Exports

| Function                                         | Description                      |
| ------------------------------------------------ | -------------------------------- |
| `getProvider(id)`                                | Fetch provider definition by ID  |
| `getProviderOrThrow(id)`                         | Same, throws if not found        |
| `getProviderAdminCredentials(providerId, orgId)` | Decrypt stored admin credentials |

## Auth modes

- **oauth2** — OAuth 2.0 with PKCE, automatic token refresh
- **oauth1** — OAuth 1.0a with HMAC-SHA1
- **api_key** — Single key stored in header
- **basic** — Username/password Base64
- **custom** — Multi-field credential schema rendered as dynamic form

## Dependencies

- `@appstrate/db` — Database access for credential storage
- `@appstrate/env` — `CONNECTION_ENCRYPTION_KEY` for credential encryption
- `@appstrate/shared-types` — Provider and connection type definitions
