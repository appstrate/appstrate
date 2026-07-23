# Appstrate Desktop

Experimental Electron companion that exposes a local Chromium surface to an
authorized Appstrate agent run.

## Trust boundaries

The app owns three `WebContentsView` instances:

- local navbar;
- Appstrate SPA;
- agent browser.

The SPA and agent browser use separate persistent session partitions. The
bridge authenticates with the Better Auth cookie from the SPA partition. The
agent browser never receives that cookie.

Remote Appstrate instances require HTTPS. Loopback development may use HTTP.
Electron permission requests are denied by default.

## Agent contract

The API module must be enabled, and the agent manifest must opt in:

```json
{
  "runtime_tools": ["desktop_browser"],
  "desktop_browser": {
    "authorized_uris": ["https://portal.example.com/**"]
  }
}
```

Add `desktop_browser_evaluate` only when arbitrary page JavaScript is required.
The sidecar omits all desktop tools when `desktop_browser` is not selected.

## Bridge

The native client connects to:

```text
/api/desktop/bridge?protocol=1
```

The connection is authenticated, origin-checked, versioned and frame-bounded.
Commands run sequentially on the single browser renderer. A response is sent
only on the socket that received the request.

One API-side lease lets one run control a user's browser. Ownership changes
reset the renderer to `about:blank`. Terminal run events release all
run-scoped desktop state.

## Browser primitives

| Method                       | Implementation                             |
| ---------------------------- | ------------------------------------------ |
| `browser.navigate`           | CDP navigation with bounded load wait      |
| `browser.click`              | native trusted mouse input                 |
| `browser.fill`               | focus, select and native text insertion    |
| `browser.selectOption`       | native select mutation                     |
| `browser.evaluate`           | CDP JavaScript, separate unsafe capability |
| `browser.screenshot`         | `capturePage`                              |
| `browser.waitForSelector`    | bounded DOM polling                        |
| `browser.download`           | authorized URL or atomic selector click    |
| `browser.batch`              | sequential bounded list, no nesting        |
| `browser.capture_credential` | declarative cookie or web-storage capture  |

Credential substitution is accepted only for `browser.fill`. Arbitrary
evaluate cannot share a run with substituted or captured credentials.

## Downloads

Direct URL orders are correlated against the DownloadItem URL chain.
Authenticated page downloads use `selector`; the same command registers the
order and clicks the control. Pending orders expire after ten seconds.

Chromium writes to a temporary file, the desktop streams it to the
platform-minted upload URL, then deletes the temporary file. The WebSocket
carries lifecycle notifications only, never file bytes.

## Development

Install and validate from this directory:

```bash
bun install
bun run typecheck
bun run build
bun run dev
```

The package has its own lockfile because Electron is intentionally outside the
root Bun workspace.

Remote CDP is off by default. A non-packaged local build may opt in:

```bash
APPSTRATE_DESKTOP_REMOTE_DEBUG=1 bun run dev
```

Main-process file logging is also opt-in and asynchronous:

```bash
APPSTRATE_DESKTOP_DEBUG_LOG=1 bun run dev
```

## Packaging

```bash
bun run package
```

Signing, notarization, auto-start, deep links, Windows and Linux packaging are
outside the current experimental scope.

## Process-local limitation

The API registry and lease are process-local. Multi-replica deployments need
sticky routing. Redis fan-out is intentionally not implemented.
