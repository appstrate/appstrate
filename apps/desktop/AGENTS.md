# Appstrate Desktop — Agent Quickstart

This is an exploratory POC, not a shipping product. If an Appstrate
maintainer or user has asked you to make a change here, read this first.
For the human-facing architecture writeup, read `README.md`.

## What this app is

A minimal Electron companion that:

- Embeds the Appstrate SPA as the primary view (a Chromium
  `WebContentsView` pointed at the configured instance URL). The user
  signs in with the SPA's own Better Auth form — there is no separate
  device flow.
- Exposes a second Chromium `WebContentsView` whose surface a remote
  Appstrate agent drives via a small JSON-RPC vocabulary tunneled over
  an authenticated WebSocket bridge. Toggle between the two panes via
  the tray menu.
- Authenticates the bridge by reading the Better Auth session cookie
  off the webapp pane's session and sending it on every WS connect.
  Sign in inside the SPA, the bridge auto-picks up the cookie on its
  next backoff tick.
- Substitutes provider credentials server-side before they ever reach
  the agent's LLM context — the agent only writes `{{key}}` templates.

The point: let cloud-hosted agents act in the user's own browser session
without exfiltrating their credentials. Validated end-to-end against
Communauto (login + invoice PDF download).

## What this app is NOT

- Not on the published Appstrate roadmap. Lives on branch `electron-poc`.
- Not multi-platform yet. **macOS only** (build/auto-download/CDP paths
  haven't been exercised on Windows or Linux; nothing else binds the
  app to macOS now that the Keychain dependency is gone).
- Not multi-instance. One Appstrate instance per install (configured
  through the first-launch setup form or `APPSTRATE_INSTANCE` env var).
- Not auto-updated, not signed, not notarized — `bun run package`
  produces an ad-hoc-signed `.app` that trips Gatekeeper on first
  launch.
- Not safe for multi-replica cloud deployments without a sticky LB or
  Redis pub/sub fan-out — the registry is process-local.

## When to make changes

Allowed:

- Server-side: the desktop bridge endpoint (`apps/api/src/routes/desktop.ts`),
  the in-memory registry (`apps/api/src/services/desktop-registry.ts`),
  the internal dispatch + substitution path (`apps/api/src/routes/internal.ts`
  `/desktop-command`), the sidecar MCP tool (`runtime-pi/sidecar/mcp.ts`
  `desktop_browser`), the runner-pi tool descriptor
  (`packages/runner-pi/src/runtime-tools/desktop-browser/`).
- Client-side: stay inside `apps/desktop/`. The auth/ directory + the
  `appstrate-desktop` OAuth client + the Keychain integration are
  gone — don't reintroduce them unless the cookie path proves
  fundamentally inadequate (it hasn't).

Forbidden during POC phase:

- Don't publish anything from this directory.
- Don't add the desktop app to default install instructions or the main
  `README.md`.
- Don't enable browser-substitution `{{key}}` resolution by default on
  `desktop_browser` — substitution is opt-in via `substituteParams: true`
  so a forgotten flag never silently leaks credentials.

## Editing rules

- **Minimum viable**: build what's asked, nothing speculative. The POC
  exists to validate cloud-agent → local-browser with credential
  isolation. Don't bolt on profile management, multi-window, telemetry,
  sub-account support, etc., before they're requested.
- **Surgical**: don't refactor adjacent code. Match the existing style
  even when imperfect. The OVH `requestSignature` work + FlareSolverr
  patches on this branch are unrelated to the POC — do not touch them.
- **Assumptions visible**: if there are two reasonable interpretations,
  surface both and ask.
- **No emojis** in code, comments, commit messages, or docs.

## Mental model of the bridge

```
[ Agent (Pi runtime in Docker) ]
        │
        │  desktop_browser({method, params, providerId?, substituteParams?})
        ▼
[ Sidecar (runtime-pi/sidecar/mcp.ts) ]
        │
        │  POST /internal/desktop-command  (run-token auth)
        ▼
[ Platform (apps/api/src/routes/internal.ts) ]
        │
        │  Resolve provider credentials → substituteVars on `params`
        │  Find user's WS in desktop-registry
        ▼
[ Electron main process (apps/desktop/src/bridge/client.ts) ]
        │  Cookie auth on the WS upgrade: webapp pane's
        │  better-auth.session_token is read on every (re)connect.
        │
        │  Dispatch JSON-RPC to browser-api wrappers
        ▼
[ WebContentsView Chromium ]  ← user's cookies, localStorage, password fill
```

Credentials live only in the rightmost two boxes (platform memory during
the substitution call, then the browser DOM). The LLM only ever sees
`{{key}}` placeholders.

## File map

### Electron client

| File                        | Role                                                                                                                                                                                                            |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.ts`               | Electron entry: BaseWindow + 3 WebContentsView (navbar + browser + webapp), tray, IPC, bridge bootstrap, first-launch setup window, auto-download (`session.will-download`), CDP debug port 9222, sign-out flow |
| `src/preload.ts`            | `contextBridge` exposing `window.appstrate.*` to navbar + `window.appstrateSetup.*` to setup window                                                                                                             |
| `src/config.ts`             | Per-install config — just the instance URL — under Electron `userData`. `normalizeInstance()` lives here too                                                                                                    |
| `src/bridge/client.ts`      | WS bridge: cookie-refreshing reconnect via `getCookieHeader` callback, JSON-RPC dispatcher, error surfacing via `onError`                                                                                       |
| `src/bridge/browser-api.ts` | The 6 browser primitives. `fill()` uses native `HTMLInputElement.prototype.value` descriptor (React/MUI/Vue-aware)                                                                                              |
| `src/renderer/navbar.html`  | URL bar + back/forward/reload + spinner (browser pane only)                                                                                                                                                     |
| `src/renderer/setup.html`   | First-launch form to enter the instance URL                                                                                                                                                                     |

What's NOT in `src/` anymore (deleted in phase 3 of the auth refactor):

- `auth/device-flow.ts`, `auth/keyring.ts`, `auth/login.ts` — RFC 8628
  - macOS Keychain + token refresh orchestration. Gone with the
    device flow.
- `desktop-client.ts` — `DESKTOP_CLIENT_ID` constant. No more dedicated
  OAuth client; the SPA's own Better Auth session is what the bridge
  consumes.

### Server-side (in the same branch)

| Path                                                                  | Role                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/desktop.ts`                                      | `GET /api/desktop/bridge` (WS upgrade), `/me/status`, `/me/command`. No custom auth — relies on the platform auth pipeline accepting Better Auth cookies (already the case for every browser-driven route) |
| `apps/api/src/services/desktop-registry.ts`                           | In-memory `Map<userId, WS>` + `sendCommand` with correlation IDs and per-call timeout (default 30 s)                                                                                                       |
| `apps/api/src/routes/internal.ts`                                     | `POST /internal/desktop-command` — run-token auth, optional credential substitution via `substituteInValue` helper, dispatches via registry                                                                |
| `apps/api/src/lib/auth-pipeline.ts` `skipOrgContext`                  | Whitelists `/api/desktop/bridge` + `/api/desktop/me/*` — the bridge has no org context                                                                                                                     |
| `apps/api/src/modules/oidc/services/instance-client-sync.ts`          | Whitelists the legacy `appstrate-desktop` clientId so a row left over from the device-flow era doesn't trigger a permanent "orphan client" warning                                                         |
| `runtime-pi/sidecar/mcp.ts`                                           | Registers `desktop_browser` as the 4th first-party MCP tool alongside `provider_call`, `run_history`, `recall_memory`                                                                                      |
| `packages/runner-pi/src/runtime-tools/desktop-browser/{tool,TOOL.md}` | Runner-pi tool descriptor + LLM-facing prose. Adding to `RUNTIME_INJECTED_TOOLS` in `index.ts` is what exposes it in the agent's MCP catalog                                                               |

## Auth model

One mechanism: the webapp pane's Better Auth session cookie.

1. First launch: setup form collects the instance URL → webapp pane
   loads `${INSTANCE}` → SPA shows its own login form.
2. User signs in inside the SPA → Better Auth posts the session cookie
   to the Electron session store (persistent across launches).
3. The bridge reads the cookie on every (re)connect via
   `session.cookies.get({ domain: host })` — **domain filter, not url
   filter** (Better Auth marks the cookie `Secure` and Electron's
   url-based filter drops Secure cookies on http schemes; the receiving
   server checks the cookie value, not the transport scheme).
4. WS upgrade includes the cookie. The platform's standard auth
   pipeline resolves it to a user, the registry indexes the WS under
   that user, the bridge is online.
5. Sign out from the tray: clears the host's cookies, reloads the
   webapp pane so the SPA renders its login form again, restarts the
   bridge so it sits in `disconnected` and auto-picks up the next
   session.

There is no JWT, no refresh token, no Keychain dependency, no separate
OAuth client. If the SPA can talk to the instance, the bridge can.

## Credential substitution (the security boundary)

When an agent calls:

```ts
desktop_browser({
  method: "browser.fill",
  params: { selector: "#password", value: "{{password}}" },
  providerId: "@scope/somesite",
  substituteParams: true,
});
```

`/internal/desktop-command` resolves the provider (same chain as
`/internal/credentials/:scope/:name`: manifest declaration → pinned
connection profile → application credential row), decrypts, walks
`params` recursively, and replaces every `{{key}}` string via
`substituteVars()` (from `@appstrate/connect/proxy-primitives`) BEFORE
dispatching to the desktop. Unknown placeholders are left intact
(spec-correct fail-safe).

Same primitives as `provider_call.substituteBody`. Same security
posture. The LLM only writes templates.

## Running

### Dev

```sh
APPSTRATE_INSTANCE=http://localhost:3000 bun run dev
```

(`bun run dev` chains `tsc` + copy `src/renderer/` to `dist/renderer/`
so the same code path works in dev and inside the `.app` bundle.)

### Packaged `.app`

```sh
bun run package
# → release/mac-arm64/Appstrate Desktop.app
```

First launch shows the setup form (`src/renderer/setup.html`). User
types the instance URL → the webapp pane opens at that URL with the
SPA's login form. After sign-in, the bridge auto-connects.

## Local debugging

| Tool                  | How                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser-pane DevTools | Tray menu → **Open browser pane DevTools** (or `Cmd+Alt+I`)                                                                                                         |
| Webapp-pane DevTools  | Tray menu → **Open webapp pane DevTools**                                                                                                                           |
| Remote CDP attach     | Electron exposes `--remote-debugging-port=9222` bound to `127.0.0.1`. `curl http://localhost:9222/json` lists targets; raw CDP / Chrome MCP / Playwright can attach |
| Main-process tee log  | `/tmp/electron-debug.log` — every navbar console message + IPC call + bridge state (cookie counts surfaced per connect)                                             |
| Server-side activity  | `grep "Desktop registry\|desktop-command\|credential substitution" <appstrate-log>`                                                                                 |

## What's NOT here yet (open follow-ups)

- React `fill()` works but `screenshot()` occasionally returns `Current display surface not available for capture` after several navigations. Workaround: focus the browser pane before capturing.
- No keyboard shortcut wiring on the main window (`Cmd+L` to focus URL, `Cmd+R` to reload from anywhere) — only via tray menu / navbar buttons.
- Reference agent bundles (`@default/communauto-login-demo`,
  `@default/communauto-fetch-invoices`) live in
  `implantation/electron/` outside the Appstrate repo since they
  contain a user-specific provider. The patterns inside them are the
  canonical examples — re-use the structure.
- Windows + Linux not tested. Nothing structurally binds the app to
  macOS anymore (the Keychain dependency is gone), but the build,
  auto-download, and CDP paths haven't been exercised on other OSes.
- No multi-instance picker. Single instance per install. Mirror the
  CLI's `config.toml` shape (`[profile.local]`, `[profile.cloud]`) if
  multi-instance is needed.
