# Appstrate Desktop agent guide

This directory contains the experimental macOS Electron companion. It lets an
authorized run drive a dedicated local Chromium view.

Read the repository root `AGENTS.md` first.

## Scope

- Experimental and macOS-only.
- Not published, signed, notarized or auto-updated.
- No deep link or login-item integration.
- API registry and leases remain process-local. Multi-replica requires sticky
  routing.
- Redis fan-out is outside the current scope.

## Package boundary

Electron is outside the root Bun workspace to avoid hoisting native package
state into unrelated apps. Run desktop commands from `apps/desktop`:

```bash
bun install
bun run typecheck
bun run build
bun run dev
```

Do not add this package to the root workspace.

## Trust boundaries

- `webappView` owns the Appstrate SPA session.
- `browserView` owns the agent browser session.
- They must use distinct persistent Electron partitions.
- Only the webapp partition's Better Auth cookie authenticates the WebSocket.
- Never copy that cookie into the agent browser.
- Keep `contextIsolation: true`, `nodeIntegration: false` and the browser
  sandbox enabled.
- Deny Electron permission requests by default.
- Remote instances require HTTPS. HTTP is loopback-only.
- Remote CDP remains disabled in packaged builds and opt-in in source builds.

## Agent capability contract

The agent manifest must select:

```json
{
  "runtime_tools": ["desktop_browser"],
  "desktop_browser": {
    "authorized_uris": ["https://portal.example.com/**"]
  }
}
```

Arbitrary `browser.evaluate` additionally requires
`desktop_browser_evaluate`.

Keep these layers synchronized when the contract changes:

1. `packages/core/src/runtime-tools-catalog.ts`
2. `packages/core/src/validation.ts`
3. `packages/runner-pi/src/runtime-tools/desktop-browser/tool.ts`
4. `runtime-pi/sidecar/mcp.ts`
5. `runtime-pi/mcp/direct.ts`
6. `apps/api/src/modules/desktop/routes.ts`
7. `apps/api/src/modules/desktop/openapi/`
8. `apps/desktop/src/bridge/client.ts`

## Protocol

- Endpoint: `/api/desktop/bridge?protocol=1`
- Wire: JSON-RPC 2.0
- Maximum frame: 16 MiB
- Commands execute sequentially on one browser renderer.
- Replies must return on the socket that received the request.
- Disconnect must reject all pending commands for that user.
- Increment the protocol version for incompatible wire changes.

## Security invariants

- One API-side lease per user and run.
- Reset the renderer to `about:blank` on ownership transfer.
- Carry `authorized_uris` on every agent command.
- Check current page or target before execution.
- Block top-level navigation outside the active policy.
- Credential substitution is restricted to `browser.fill`.
- Do not allow arbitrary evaluate in a run that substituted or captured
  credentials, in either order.
- Credential capture accepts declarative cookie or web-storage selectors only.
- Never accept agent-provided JavaScript on the credential capture path.
- Capture must bind to the exact integration auth, its URI policy and its
  credential schema.
- Terminal run events must clear leases, policy, secrets, ephemeral
  credentials and downloads.

## Downloads

- Direct downloads correlate against the DownloadItem URL chain.
- Page-triggered downloads use `selector`; register and click in the same
  command.
- Do not restore the old open-ended `capture: true` FIFO.
- Expire pending correlation quickly.
- Keep bytes off the WebSocket.
- Enforce terminal state transitions, metadata shape and size ceilings on the
  API side.
- Stream files rather than buffering them.

## Key files

| File                          | Responsibility                                                       |
| ----------------------------- | -------------------------------------------------------------------- |
| `src/main.ts`                 | windows, isolated partitions, permissions, tray and bridge bootstrap |
| `src/config.ts`               | profiles and instance URL policy                                     |
| `src/bridge/client.ts`        | WebSocket lifecycle, sequencing, dispatch and URI guard              |
| `src/bridge/cdp.ts`           | trusted CDP primitives                                               |
| `src/bridge/browser-api.ts`   | bounded selector polling                                             |
| `src/bridge/downloads.ts`     | download correlation, hashing and upload                             |
| `src/bridge/protocol.ts`      | client JSON-RPC types and error codes                                |
| `../api/src/modules/desktop/` | server registry, lease, routes and download records                  |

## Validation

At minimum after a desktop bridge change:

```bash
cd apps/desktop && bun run typecheck && bun run build
cd ../.. && bun test apps/api/src/modules/desktop/test
```

Run the repository check before handoff. Regenerate OpenAPI outputs when the
request schema changes.
