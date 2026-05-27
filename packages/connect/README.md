# @appstrate/connect

OAuth2/PKCE, token refresh, credential-proxy primitives, and encrypted credential storage for AFPS integration connections.

## Exports

| Symbol                                                        | Description                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| `encrypt` / `decrypt`                                         | AES-256-GCM versioned-envelope string crypto                    |
| `encryptCredentials` / `decryptCredentials`                   | Object ⇄ encrypted-string helpers                               |
| `encryptCredentialEnvelope` / `decryptCredentialEnvelope`     | Structured `{ outputs, inputs }` credential envelope (v2)       |
| `initiateIntegrationOAuth` / `handleIntegrationOAuthCallback` | OAuth2 + PKCE connect flow for integration auths                |
| `performRefreshTokenExchange`                                 | OAuth2 refresh-token exchange (`RefreshError` on failure)       |
| `parseTokenResponse` / `parseTokenErrorResponse`              | Token-response parsing + revoked/transient error classification |
| `resolveHttpDelivery` / `buildProxyCredentialsPayload`        | Multi-auth credential resolution + `delivery.http` planning     |
| `substituteVars` / `matchesAuthorizedUriSpec` / …             | Credential-proxy primitives (shared route ⇄ sidecar)            |
| `planMitmAction`                                              | Pure per-integration MITM strip/inject/retry planner            |
| `planCaBundle`                                                | CA-cert planner for the HTTPS credential proxy                  |

See `src/index.ts` for the authoritative export surface.

## Auth modes

- **oauth2** — OAuth 2.0 with PKCE, automatic token refresh
- **api_key** — Single key stored in header
- **basic** — Username/password Base64
- **mtls** — Client-certificate authentication (AFPS §7.2)
- **custom** — Multi-field credential schema rendered as dynamic form

## OAuth error classification

Both the initial token exchange (`handleIntegrationOAuthCallback`) and the refresh flow
(`performRefreshTokenExchange`) classify failures through the shared `parseTokenErrorResponse`
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

- `scopeShortfall` — scopes requested but not granted (upstream narrowing).
  The platform flags the affected `integration_connections` row
  `needsReconnection: true` (`apps/api/src/services/integration-credentials-resolver.ts`).
- `scopeCreep` — scopes granted that were never requested (upstream over-grant).
  Some IdPs (Slack, GitHub) always return all owner scopes; logged
  as a warning, not blocked.

## Credential encryption — versioned envelope

Stored credentials use AES-256-GCM wrapped in a versioned envelope:

```
v1:<kid>:<base64(iv|authTag|ciphertext)>
```

`decrypt()` requires the `v1:` prefix and throws otherwise — there is no
unversioned/raw blob path. The `kid` embedded in the envelope drives a
**direct** key lookup against the in-process keyring (active + retired keys);
there is no multi-key probe. A wrong key cannot pass AES-GCM tag verification
(~2^-128), so a mislabelled kid fails closed rather than silently decrypting.

### Structured credential envelope (v2)

The decrypted **plaintext** is itself versioned (independently of the `v1:`
crypto envelope). `encryptCredentialEnvelope` writes a tagged
`{ v: 2, outputs, inputs }` JSON object:

- `outputs` — the ONLY injectables. `delivery.{http,env,files}` may reference
  these and nothing else.
- `inputs` — bootstrap login secrets, persisted solely to re-bootstrap an
  expired session. Read ONLY by the connect-login path; never by the credential
  injection path nor the agent. Omitted when empty.

A legacy untagged flat `Record<string,string>` blob (no `v: 2` tag) reads back
as `{ outputs: <whole blob>, inputs: {} }` — zero DDL, zero re-encryption.

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
#    blobs remain readable: their embedded kid resolves to the retired key.

# 4. Run a background re-encrypt sweep (read → decrypt → encrypt → write) to
#    rewrite every `integration_connections.credentials_encrypted` row. Idempotent.
#    The sweep re-keys v1:<old-kid> blobs to v1:<active-kid>.

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
confirms zero rows still encrypted under that kid. Removing it sooner makes
every blob whose envelope names that kid undecryptable — `getKey()` throws
"No encryption key registered for kid" rather than silently corrupting data,
but the credentials are unrecoverable until the key is restored.

## Dependencies

- `@appstrate/db` — Database access for credential storage
- `@appstrate/env` — `CONNECTION_ENCRYPTION_KEY` (+ optional rotation envs) for credential encryption
- `@appstrate/shared-types` — Integration and connection type definitions
