# Desktop module

Bridge between platform-hosted agents and a Chromium surface running on the
user's own machine — the Appstrate Desktop Electron companion (`apps/desktop/`).
The agent stays in its sandbox; the browser, its cookies and its logged-in
sessions stay on the user's hardware.

**Status: experimental, opt-in.** Not in the default `MODULES`. Enable with
`MODULES=<default>,desktop`.

## Surfaces

| Route                            | Auth           | What                                                               |
| -------------------------------- | -------------- | ------------------------------------------------------------------ |
| `GET /api/desktop/bridge`        | session cookie | WebSocket upgrade the desktop app connects to (one per user)       |
| `GET /api/desktop/me/status`     | cookie/API key | is MY desktop connected                                            |
| `POST /api/desktop/me/command`   | cookie/API key | drive my own desktop (smoke tests, CLI) — no substitution          |
| `POST /internal/desktop-command` | run token      | agent path, backs the `desktop_browser` runtime tool, substitution |

All `/api/desktop/*` routes are user-scoped and org-agnostic (whitelisted in
core `skipOrgContext` — path-based, harmless when the module is off).

## Credential substitution — how agents use passwords they can never read

The agent's LLM writes `{{field}}` placeholders; the platform resolves them
AFTER the command has left the model:

1. The agent calls `desktop_browser` with
   `{ method: "browser.fill", params: { selector: "#pw", value: "{{password}}" },
integration_id: "@scope/somesite", substitute_params: true }`.
2. `/internal/desktop-command` verifies the run token, then applies the same
   fail-closed gate as `/internal/integration-credentials`: the running agent
   must DECLARE the integration in its manifest dependencies.
3. `resolveLiveIntegrationCredentials` decrypts the run actor's connection for
   that integration; every `{{field}}` in `params` is replaced server-side.
4. The resolved values travel platform → WS → desktop → DOM. They never enter
   the agent container, the sidecar reply, or the LLM context.
5. **Both directions are covered**: every value ever substituted for a run is
   remembered (`secret-scrub.ts`) and redacted from EVERY subsequent desktop
   reply of that run. An agent that fills a password and then evaluates
   `document.querySelector('#pw').value` gets `[redacted:substituted-credential]`
   back, not the secret.

Credentials-wise, a site without an API is just an integration with an
`api_key`/`custom` auth declaring the fields (`email`, `password`, …) and no
tools — the user connects it once via the normal connect flow, agents fill
login forms with placeholders forever after.

## Security model

- **CSWSH origin guard** on the WS upgrade: a cookie-carrying handshake is not
  covered by CORS; browser-borne upgrades must come from `TRUSTED_ORIGINS` /
  `APP_URL`. No `Origin` (native clients, e.g. the Electron bridge) passes —
  that attack class is browser-only. `SameSite=lax` already blocks modern
  browsers; the guard is the second lock.
- **One desktop per user, keyed by userId**: the internal route dispatches to
  the RUN OWNER's desktop only; user-scoped routes only ever reach the
  caller's own client. Runs without an owning user (end-user / remote) get 403.
- **Substitution gate**: run token + agent-declares-integration + actor-scoped
  connection resolution — a leaked run token cannot enumerate or exfiltrate
  other integrations' secrets.
- **Reply scrubbing**: see above — closes the read-back exfiltration path.
- Error messages from the desktop are scrubbed too before reaching the agent.

## Coupling with runtime images

`desktop_browser` is registered in `RUNTIME_INJECTED_TOOLS`
(`packages/runner-pi/src/runtime-tools/`), and `buildMcpDirectFactories`
refuses to start a run when the sidecar doesn't advertise every listed tool —
so runtime images MUST be rebuilt when the tool list changes
(`bun run docker:build:sidecar && bun run docker:build:runtime`). The tool is
always present in the image; with the module disabled, calling it surfaces a
clean 404 from `/internal/desktop-command`.

## Process-local state

The client registry and the scrub store live in process memory:

- multi-replica deployments need sticky routing or a Redis fan-out (not built);
- `bun --hot` empties both while clients keep their sockets — restart the API
  without `--hot` after touching bridge code, or the tray says "connected"
  while the platform says 503.

## Not built (yet)

- Redis fan-out for multi-replica.
- UI surface (the SPA gets `features.desktop` but nothing consumes it).
- Per-integration allowlist of which METHODS may carry substituted values
  (today any method can; the scrubber is the backstop).
