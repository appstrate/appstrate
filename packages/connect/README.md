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

## OAuth error classification

Both the initial token exchange (`handleOAuthCallback`) and the refresh flow
(`forceRefresh`) classify failures through the shared `parseTokenErrorResponse`
helper so revocation handling stays symmetric per RFC 6749 §5.2.

| Error class          | Triggered by                           | Caller behavior                              |
| -------------------- | -------------------------------------- | -------------------------------------------- |
| `OAuthCallbackError` | initial token exchange (callback path) | distinguish `kind: "revoked" \| "transient"` |
| `RefreshError`       | token refresh (already-connected path) | same `kind` discriminant                     |

`kind: "revoked"` (HTTP 400 + `{"error": "invalid_grant"}`) means the
authorization code or refresh token is dead and the user must reconnect.
Anything else is `transient` — retry the request, not the entire OAuth flow.

## Scope validation

`parseTokenResponse` returns two diff arrays alongside `scopesGranted`:

- `scopeShortfall` — scopes requested but not granted (provider narrowing).
  `services/connection-manager/oauth.ts` flags the saved connection with
  `needsReconnection: true` when this is non-empty.
- `scopeCreep` — scopes granted that were never requested (provider over-grant).
  Some providers (Slack, GitHub legacy) always return all owner scopes; logged
  as a warning, not blocked.

## Credential encryption — versioned envelope

Stored credentials use AES-256-GCM with a versioned envelope:

```
v1:<kid>:<base64(iv|authTag|ciphertext)>
```

Legacy ("v0") blobs — raw `base64(iv|authTag|ciphertext)` with no header —
carry no kid, so `decrypt()` tries every key in the keyring (active + retired)
until AES-GCM tag verification succeeds. A wrong key cannot pass GCM
verification by chance (~2^-128), so the multi-key probe is safe. New writes
always emit v1.

### Online key rotation playbook

Rotation does not require downtime or an offline batch re-encrypt. The version
tag plus key id let the platform run with a multi-key keyring during the
transition window.

```
# 1. Generate a new key
NEW_KEY=$(openssl rand -base64 32)

# 2. Move the current key into the retired keyring (decrypt-only)
#    and promote the new key as primary.
export CONNECTION_ENCRYPTION_KEYS='{"k1":"<current CONNECTION_ENCRYPTION_KEY value>"}'
export CONNECTION_ENCRYPTION_KEY=$NEW_KEY
export CONNECTION_ENCRYPTION_KEY_ID=k2

# 3. Restart the platform. New writes emit `v1:k2:...`. Existing `v1:k1:...`
#    blobs remain readable via the retired keyring; v0 blobs decrypt by
#    probing every key in the keyring (active + retired) until AES-GCM tag
#    verification succeeds.

# 4. Run a background re-encrypt sweep (read → decrypt → encrypt → write) to
#    rewrite every `userProviderConnections.credentialsEncrypted` row. Idempotent.
#    The sweep migrates v0 → v1 *and* re-keys v1:<old-kid> blobs to v1:<active-kid>.

# 5. Only after the sweep confirms no blob still depends on the retired key,
#    drop it:
unset CONNECTION_ENCRYPTION_KEYS
```

Restrictions:

- `CONNECTION_ENCRYPTION_KEY_ID` must match `^[A-Za-z0-9_-]{1,32}$`.
- Retired keys must use a different kid than the active one (validated at boot).
- Each retired key must be 32 bytes (256-bit) base64-encoded.

**Step ordering invariant.** A key may be removed from
`CONNECTION_ENCRYPTION_KEYS` (step 5) **only after** the sweep (step 4)
confirms zero rows still encrypted under that key. Removing it sooner
permanently corrupts every credential that still depends on it — the v0
multi-key probe protects against silent breakage during the rotation window
but not against a key being deleted outright.

## Dependencies

- `@appstrate/db` — Database access for credential storage
- `@appstrate/env` — `CONNECTION_ENCRYPTION_KEY` (+ optional rotation envs) for credential encryption
- `@appstrate/shared-types` — Provider and connection type definitions
