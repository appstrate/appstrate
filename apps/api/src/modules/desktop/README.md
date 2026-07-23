# Desktop module

Experimental bridge between an agent run and a Chromium surface on the run
owner's machine. Enable the API module with `MODULES=<default>,desktop`.

## Agent opt-in

The module being enabled is not enough. An agent must explicitly select the
runtime capability and declare its network boundary:

```json
{
  "runtime_tools": ["desktop_browser"],
  "desktop_browser": {
    "authorized_uris": ["https://portal.example.com/**"]
  }
}
```

`browser.evaluate` additionally requires `desktop_browser_evaluate`. Keep that
capability disabled unless arbitrary page JavaScript is essential.

When `desktop_browser` is absent, the launcher may skip the sidecar and the
sidecar does not advertise `desktop_browser`, `desktop_download` or
`desktop_batch`.

## Surfaces

| Route                                | Auth           | Purpose                                          |
| ------------------------------------ | -------------- | ------------------------------------------------ |
| `GET /api/desktop/bridge?protocol=1` | session cookie | versioned WebSocket used by the native client    |
| `GET /api/desktop/me/status`         | user auth      | report whether the caller's desktop is connected |
| `POST /api/desktop/me/command`       | user auth      | direct smoke-test primitives only                |
| `POST /internal/desktop-command`     | run token      | capability-gated agent path                      |
| `GET /internal/desktop-download/:id` | run token      | bounded download stream owned by the run         |

The public command route deliberately excludes platform-mediated methods such
as credential capture, download status and batch execution.

## Security invariants

- The webapp and agent browser use different persistent Electron partitions.
  The agent browser cannot inherit the Better Auth session.
- Remote CDP is disabled unless a source build explicitly opts in.
- Electron permission requests default to denied.
- Remote Appstrate instances require HTTPS. Loopback development may use HTTP.
- The WebSocket validates the origin, protocol version and frame size.
- Pending commands are tied to the authenticated socket and fail immediately
  on disconnect.
- One process-local lease lets only one run control a user's browser. Terminal
  run events clear the lease, policy cache, secrets, ephemeral credentials and
  downloads. A five-minute idle expiry is the crash fallback.
- Every agent command carries its declared URI boundary. The desktop checks
  the current page or target and blocks top-level navigation outside it.
- Credential substitution is restricted to `browser.fill`. A run cannot mix
  substituted credentials with arbitrary `browser.evaluate`, in either order.
- `browser.capture_credential` is declarative. It accepts cookie,
  `localStorage` or `sessionStorage` selectors, validates the exact auth and
  credential schema, applies field and byte limits, and returns field names
  only. It never executes agent-provided JavaScript.
- Captured credentials remain in the run-scoped ephemeral store and are
  deleted on terminal status.
- Downloads use either an authorized direct URL or a selector clicked by the
  same command. Pending correlation expires after ten seconds. Completion
  metadata, terminal transitions and size ceilings are validated server-side,
  and retrieval remains bounded while streaming.

Reply scrubbing remains defense in depth. The primary boundary is preventing
arbitrary JavaScript from sharing a run with substituted or captured secrets.

## Process-local boundary

The registry, leases and run-scoped stores intentionally remain process-local.
A multi-replica deployment therefore needs sticky routing. Redis fan-out is
not part of this experimental scope.
