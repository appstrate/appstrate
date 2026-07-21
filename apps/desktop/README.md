# @appstrate/desktop — Electron companion app

> **Status**: experimental. Not shipped, not signed, not on the published roadmap. Ported from the original `electron-poc` branch onto current `main` and re-validated end-to-end on macOS arm64: bridge connected, `desktop_browser` advertised by the sidecar's MCP surface, browser driven from both the user-facing `/api/desktop/me/command` route and a real sidecar tool call.
>
> **Not ported**: server-side credential substitution (`integration_id` + `substituteParams`, the `{{password}}` templates described below). It relied on the pre-integrations provider model (`resolveManifestProviders`, `getProviderCredentialId`, `resolveCredentialsForProxy`), none of which survive on `main` — reinstating it is a rewrite against the integrations / credential-proxy model, not a port. Until then an agent that fills a password field passes the value in clear through its own context.

A desktop companion that lets a remote Appstrate agent drive a local Chromium browser surface on the user's machine, with the user's own cookies, sessions, and saved logins.

## Why

Existing browser-automation tools force one of two bad trade-offs:

- **Server-side headless browser** (Browserbase, Steel cloud): the platform stores the user's credentials. Sketchy for banking, utilities, anything sensitive.
- **Pure HTTP reverse-engineering** (provider_call): works for clean APIs, falls over on hostile sites (Cloudflare, Akamai, multi-step OIDC, fingerprint-bound tokens). And many sites simply have no public API.

This bridge gets both: the agent stays cloud-hosted, the browser lives on the user's machine, credentials stay encrypted in Appstrate (never resolved in the LLM context).

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Appstrate platform (server)                                │
│                                                             │
│  Agent (Pi runtime in Docker)                               │
│   └─ desktop_browser tool ──► sidecar MCP ──► /internal/   │
│                                                desktop-cmd  │
│                                                    │        │
│                                                    ▼        │
│                                              Registry       │
│                                              Map<uid, WS>   │
│                                              substituteVars │
│                                                    │        │
│                                                    │ WS     │
└────────────────────────────────────────────────────┼────────┘
                                                     │ wss://
┌────────────────────────────────────────────────────┼────────┐
│  User's machine                                    │        │
│                                                    ▼        │
│  Appstrate Desktop.app                                      │
│   ├─ Webapp WebContentsView (SPA at ${INSTANCE},            │
│   │    user logs in here via Better Auth — primary pane)    │
│   ├─ Bridge client (reads session cookie from webapp pane   │
│   │    on every reconnect — no JWT, no Keychain)            │
│   ├─ Browser WebContentsView (agent-driven, secondary pane) │
│   ├─ session.will-download → ~/Documents/AppstrateDesktop/  │
│   └─ Tray icon: status, pane toggle, sign out, quit         │
└─────────────────────────────────────────────────────────────┘
```

The agent never sees credentials. The platform substitutes `{{key}}` placeholders server-side from the encrypted credential store before the command crosses the wire.

## Layout

```
src/
├── main.ts                        Electron entry: 3 WebContentsView (webapp + navbar + browser), tray, bridge wiring, setup
├── preload.ts                     contextBridge for navbar + setup renderers
├── config.ts                      Instance URL persistence (Electron userData) + normalizeInstance
├── bridge/
│   ├── client.ts                  WebSocket: cookie-refreshing reconnect, JSON-RPC dispatcher
│   └── browser-api.ts             6 browser primitives wrapping webContents
└── renderer/
    ├── navbar.html                URL bar + back/forward/reload + spinner (browser pane only)
    └── setup.html                 First-launch form to enter the instance URL
```

No `auth/` directory, no `desktop-client.ts`, no `@napi-rs/keyring` dependency — the bridge inherits the SPA's Better Auth session cookie directly, so the device-flow + Keychain stack the POC started with is gone.

Server-side pieces (in the same monorepo branch):

| Path                                                    | What                                                                                                                                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api/src/routes/desktop.ts`                        | `/api/desktop/bridge` (WS upgrade), `/me/status`, `/me/command`. No custom auth — relies on the standard auth pipeline accepting Better Auth cookies (already the case for every browser-driven route) |
| `apps/api/src/services/desktop-registry.ts`             | In-memory `Map<userId, WS>` + correlated send/reply                                                                                                                                                    |
| `apps/api/src/routes/internal.ts`                       | `/internal/desktop-command` (run-token auth; dispatches to the run OWNER's desktop)                                                                                                                    |
| `apps/api/src/lib/auth-pipeline.ts` `skipOrgContext`    | Whitelists `/api/desktop/bridge` + `/api/desktop/me/*`                                                                                                                                                 |
| `runtime-pi/sidecar/mcp.ts`                             | `desktop_browser` MCP tool exposed to agents                                                                                                                                                           |
| `packages/runner-pi/src/runtime-tools/desktop-browser/` | Canonical tool descriptor — name, description, parameter schema (no TOOL.md: the description IS the LLM-facing doc)                                                                                    |
| `apps/api/src/index.ts`                                 | Mounts the router AND passes `websocket:` to `Bun.serve` — the bridge is the platform's only WebSocket, without that field the upgrade silently 404s                                                   |
| `apps/api/src/openapi/paths/desktop.ts`                 | Spec for the three routes (`verify:openapi` fails otherwise)                                                                                                                                           |

## Capabilities (6 browser primitives)

| Method                    | Effect                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `browser.navigate`        | `webContents.loadURL` — returns immediately on dispatch (doesn't wait for `did-finish-load`, which hangs on long-polling pages)                 |
| `browser.click`           | `executeJavaScript` to find selector + `.click()`                                                                                               |
| `browser.fill`            | Uses the native `HTMLInputElement.prototype.value` setter via property descriptor (React/MUI/Vue tracking-aware) + dispatch input/change events |
| `browser.evaluate`        | `webContents.executeJavaScript` — returns the JSON-serialisable result                                                                          |
| `browser.screenshot`      | `webContents.capturePage` → PNG dataURL (auto-spills to MCP `resource_link` over 32 KB)                                                         |
| `browser.waitForSelector` | Polls `document.querySelector` every 100 ms with configurable timeout (default 10 s, max 120 s)                                                 |

Each can carry `integration_id` + `substitute_params: true` so `{{key}}` placeholders inside `params` get resolved server-side from the named provider's credentials.

## Auth model

One mechanism: the webapp pane's Better Auth session cookie.

1. First launch → setup form collects the instance URL → webapp pane loads the SPA at that URL → SPA shows its own login form.
2. User signs in inside the SPA. Better Auth writes the session cookie to the Electron session store (persisted across launches by Chromium under `userData/Cookies`).
3. The bridge reads cookies on every (re)connect via `session.cookies.get({ domain: host })` and sends them as `Cookie: …` on the WS upgrade.
4. The platform's standard auth pipeline resolves the cookie to a user, the registry indexes the WS under that user, the bridge is online.

**Why domain filter, not url filter**: Better Auth marks its session cookie `Secure`. Electron's url-based filter drops Secure cookies when the URL scheme is `http` (local dev). Domain filter ignores scheme. The server checks the cookie value, not transport scheme, so it accepts the cookie over plain `ws://` localhost.

**Origin guard on the upgrade (CSWSH)**: cookie auth on a WebSocket is not covered by CORS — the handshake is a plain GET the browser sends with the user's cookies. Without a check, a page on any origin could open the bridge in a logged-in victim's browser and be registered as _their_ desktop; since a new connection displaces the previous one, that both cuts the user off and hands the attacker every command dispatched to them. So: an `Origin` header, which only a browser sets and page script cannot forge, must match `TRUSTED_ORIGINS` / `APP_URL`; no `Origin` at all is allowed, because that is what a native client sends (this app included) and the attack being blocked is browser-borne. `SameSite=lax` on the session cookie already blocks this in current browsers — the guard is the second lock.

No JWT, no refresh token, no Keychain. The SPA owns the auth lifecycle; the bridge is a downstream consumer.

**Sign out** (tray menu): stops the bridge, clears the host's cookies, reloads the webapp pane so the SPA renders the login form, starts a fresh bridge. As soon as the user signs back in, the next reconnect tick picks up the new session.

## Credential substitution (NOT ported — historical)

> This section describes the original POC behaviour. It does not exist on `main`: the provider-model plumbing it relied on is gone. Kept as the spec to re-implement against the integrations / credential-proxy model.

Mirrors `provider_call.substituteBody`. Inside `params`, any string containing `{{key}}` is replaced server-side by the matching field from the named provider's credentials before the command leaves the platform.

```ts
desktop_browser({
  method: "browser.fill",
  params: { selector: "#password", value: "{{password}}" },
  integration_id: "@scope/somesite",
  substitute_params: true,
});
```

The LLM's conversation only ever contains `{{password}}`. The Electron app receives the resolved value. Unknown placeholders are left intact (spec-correct fail-safe).

Validated against a real Communauto / Reservauto login (Material UI inputs, multi-step Username/Password flow, Azure-style identity provider): 5 substitutions per run, byte-length verification proved the actual credentials reached the DOM, zero leak in the LLM trace.

## End-to-end Communauto example

`apps/desktop/../../implantation/electron/` contains the reference bundles:

- `communauto-login-demo/` — minimal login validation
- `communauto-fetch-invoices/` — full workflow: login (if needed) → extract OIDC access token from `localStorage` → list invoices via REST → trigger PDF downloads via `<a download>` clicks → Electron auto-saves to `~/Documents/AppstrateDesktop/`

The lesson worth keeping: once auth lands the user in a logged-in dashboard, the agent extracts the page's own bearer token from `localStorage` and switches to direct REST API calls. 10× faster + more reliable than clicking through pages. The bridge handles the _auth_, the REST API handles the _data_.

## Setup + run

### Dev (run from source)

```sh
# 1. Start an Appstrate instance (Tier 0 or Tier 3 — both work)
cd /path/to/appstrate
cp -n .env.example .env
bun run --filter @appstrate/web build   # the app loads the SPA from the instance
bun --hot apps/api/src/index.ts         # → http://localhost:3000

# 2. Build + launch the Electron app
cd apps/desktop
bun install
APPSTRATE_INSTANCE=http://localhost:3000 bun run dev
```

The window opens with the SPA. Sign in via the embedded login form. The tray icon `APP` flips to `Bridge: connected` within a couple seconds.

**`bun --hot` silently drops the bridge.** The registry is process memory: editing any file it imports gives the reloaded module an empty `Map`, while the client keeps its socket open and still believes it is connected. You get `503 No Appstrate Desktop connected` with a happily-connected tray icon. Restart the API without `--hot` (or restart the app) after touching bridge code.

`APPSTRATE_INSTANCE` only seeds the config on FIRST launch. Afterwards the instance URL lives in the profile file and the env var is ignored — dev builds read `~/Library/Application Support/@appstrate/desktop/config.json`, packaged builds `~/Library/Application Support/Appstrate Desktop/config.json`. Point an existing install at another instance by editing `defaultProfile` there.

**Agents need rebuilt runtime images.** `desktop_browser` is registered in `RUNTIME_INJECTED_TOOLS`, and `buildMcpDirectFactories` fails a run outright when the sidecar doesn't advertise every tool on that list. A run against a pre-bridge sidecar image therefore dies at boot, it does not silently lose the tool. Rebuild and pin both images before running an agent:

```sh
bun run docker:build:sidecar && bun run docker:build:runtime
# then in .env:  PI_IMAGE=appstrate-pi   SIDECAR_IMAGE=appstrate-sidecar
```

Smoke-test the whole chain without a model: start the sidecar by hand against a `running` run's token and call the tool over MCP.

```sh
PORT=8099 PLATFORM_API_URL=http://localhost:3000 RUN_TOKEN=<signed run token> \
  bun runtime-pi/sidecar/server.ts

curl -s localhost:8099/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -H 'Host: localhost' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"desktop_browser",
       "arguments":{"method":"browser.navigate","params":{"url":"https://example.org"}}}}'
```

### Packaged .app (cliquable depuis Finder / Spotlight)

```sh
cd apps/desktop
bun run package
# → release/mac-arm64/Appstrate Desktop.app
```

Drag the `.app` to `/Applications`. First launch shows a setup form asking for the instance URL — type it, click Connect, sign into the SPA, you're in. No env var, no terminal.

The .app is unsigned (POC scope). First launch on a fresh Mac trips Gatekeeper — bypass with:

```sh
xattr -dr com.apple.quarantine "/Applications/Appstrate Desktop.app"
```

For real distribution: Apple Developer ID ($99/year) + notarization + `electron-updater` for auto-updates.

### Smoke-test the bridge without the GUI (curl + mock WS)

```sh
TOKEN="ask_..."   # any valid auth token

# Terminal 1 — mock desktop client
cat > /tmp/mock.ts <<'EOF'
const ws = new WebSocket("ws://localhost:3000/api/desktop/bridge", {
  headers: { Authorization: `Bearer ${process.env.TOKEN}` },
} as unknown as undefined);
ws.addEventListener("open", () => console.log("connected"));
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data));
  console.log("recv:", msg);
  ws.send(JSON.stringify({ id: msg.id, result: { mocked: true } }));
});
setInterval(() => {}, 1000);
EOF
TOKEN=$TOKEN bun /tmp/mock.ts

# Terminal 2 — drive it
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"method":"browser.navigate","params":{"url":"https://example.com"}}' \
  http://localhost:3000/api/desktop/me/command
# → {"result":{"mocked":true}}
```

The Electron client itself uses cookie auth, but the bridge route also accepts API keys (standard auth pipeline behaviour) — convenient for synthetic load tests.

## Cloud Appstrate compatibility

The bridge is outbound HTTPS (WS over `wss://`) so it traverses any NAT / corporate firewall. Identical to dev locally.

Two caveats for multi-replica cloud:

1. **Process-local registry**: the `Map<userId, WS>` lives in one API server process. With multiple replicas behind a load balancer, the user's WS lands on replica A but their agent's `/internal/desktop-command` might land on replica B → "desktop not connected". Fix is either sticky load balancing (route the user's traffic to the replica their WS is on) or Redis pub/sub fan-out so any replica can dispatch to any user's WS.
2. **Latency budget**: agent → server → user → browser → user → server → agent. Local: <50 ms. Cloud: 100-500 ms typical. Fine for browser automation; agent prompts may want explicit timeouts on `waitForSelector`.

Single-replica self-host (the current setup) needs neither fix.

## Local debugging

| Tool                    | How                                                                                                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser-pane DevTools   | Tray menu → **Open browser pane DevTools** (or `Cmd+Alt+I`)                                                                                                       |
| Webapp-pane DevTools    | Tray menu → **Open webapp pane DevTools**                                                                                                                         |
| Remote CDP attach       | Electron opens `--remote-debugging-port=9222` on `127.0.0.1` — `curl http://localhost:9222/json` lists targets; attach Chrome MCP, Playwright, or raw CDP clients |
| Main-process logs       | `/tmp/electron-debug.log` (POC tee — every navbar console message + IPC call + bridge cookie reads)                                                               |
| Server-side bridge logs | `grep "Desktop registry\|desktop-command\|credential substitution" <appstrate-log>`                                                                               |

## What's left for distribution

| Need                                                     | Effort                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Apple Developer ID + notarization                        | $99/year + CI integration                                                        |
| `electron-updater` for auto-update                       | ~1 day                                                                           |
| Windows + Linux builds                                   | ~3 days (no Keychain dep to port now — mostly build + auto-download + CDP paths) |
| Multi-replica fan-out (sticky LB or Redis) for cloud     | ~2 days                                                                          |
| Real tray icon (templated PDF for macOS)                 | trivial                                                                          |
| Multi-instance picker (mirror CLI's `config.toml` shape) | ~1 day                                                                           |
| End-to-end Playwright tests                              | ~2 days                                                                          |

For TRACTR self-host + personal use + early-access clients, the current POC is usable as-is.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
