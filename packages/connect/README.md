# @appstrate/connect

OAuth2/PKCE, token refresh, credential-proxy primitives, and encrypted credential storage for AFPS integration connections.

## Exports

| Symbol                                                        | Description                                                 |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `encrypt` / `decrypt`                                         | AES-256-GCM versioned-envelope string crypto                |
| `encryptCredentials` / `decryptCredentials`                   | Object ⇄ encrypted-string helpers                           |
| `encryptCredentialEnvelope` / `decryptCredentialEnvelope`     | Structured `{ outputs, inputs }` credential envelope (v2)   |
| `initiateIntegrationOAuth` / `handleIntegrationOAuthCallback` | OAuth2 + PKCE connect flow for integration auths            |
| `performRefreshTokenExchange`                                 | OAuth2 refresh-token exchange (`RefreshError` on failure)   |
| `parseTokenResponse`                                          | Token-response parsing (scope diffing + invariant checks)   |
| `resolveHttpDelivery` / `buildProxyCredentialsPayload`        | Multi-auth credential resolution + `delivery.http` planning |
| `substituteVars` / …                                          | Credential-proxy primitives (shared route ⇄ sidecar)        |
| `planMitmAction`                                              | Pure per-integration MITM strip/inject/retry planner        |
| `planCaBundle`                                                | CA-cert planner for the HTTPS credential proxy              |

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

`parseTokenResponse` returns `scopesGranted` as the provider echoed it (or the
requested set when the response omits `scope`), and the integration callback
result carries `scopesRequested` from the signed state. The comparison is left
to the platform: a shortfall is only meaningful after expanding the grant
through the manifest's `scope_catalog[].implies` aliases (Google echoes `email`
as `https://www.googleapis.com/auth/userinfo.email`), which this package does
not see.

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

`decryptCredentialEnvelope` throws on any other plaintext — an untagged flat
blob included; there is no legacy read path.

### Key rotation

The `kid` lets the keyring hold retired keys (`CONNECTION_ENCRYPTION_KEYS`,
decrypt-only) beside the active one, so rotation needs no downtime. Procedure,
including the re-encryption of every encrypted column
(`scripts/rekey-encrypted-columns.ts`) before a retired key is dropped:
[`docs/ENV.md` § "Rotating `CONNECTION_ENCRYPTION_KEY`"](../../docs/ENV.md#rotating-connection_encryption_key).

Decryption fails two ways: `UnknownKeyIdError` (the blob's kid is not in the
keyring — operator configuration, fixed by restoring the key) and
`CredentialDecryptError` (the blob itself is unreadable). Callers must not
treat the first as a dead credential.

## Dependencies

- `@appstrate/env` — `CONNECTION_ENCRYPTION_KEY` (+ optional rotation envs) for credential encryption
