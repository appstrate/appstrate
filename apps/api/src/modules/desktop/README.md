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
| `GET /api/desktop/bridge?protocol=2` | session cookie | versioned WebSocket used by the native client    |
| `GET /api/desktop/me/status`         | user auth      | report whether the caller's desktop is connected |
| `POST /api/desktop/me/command`       | user auth      | direct smoke-test primitives only                |
| `POST /internal/desktop-command`     | run token      | capability-gated agent path                      |
| `GET /internal/desktop-download/:id` | run token      | bounded download stream owned by the run         |

The public command route deliberately excludes platform-mediated methods such
as credential capture, download status and batch execution.

## Security invariants

- The webapp and the browser tabs use different Electron partitions. No tab
  can inherit the Better Auth session.
- Each agent gets its OWN browser profile by default (`desktop_browser.session`:
  `agent`, or `isolated` per run, or `user` to opt into the human's profile).
  A session one agent opens is therefore unreadable by another, whether they
  run at the same time or one after the other.
- Remote CDP is disabled unless a source build explicitly opts in.
- Electron permission requests default to denied.
- Remote Appstrate instances require HTTPS. Loopback development may use HTTP.
- The WebSocket validates the origin, protocol version and frame size.
- Pending commands are tied to the authenticated socket and fail immediately
  on disconnect.
- Leases are per TAB: a run drives only the tabs it opened (409 otherwise),
  the manual route drives only the user's own, and neither side can adopt the
  other's. Terminal run events close the run's tabs and clear its leases,
  policy cache, secrets, ephemeral credentials and downloads. A five-minute
  idle expiry is the crash fallback. Quotas: 3 tabs per run, 8 per user.
- Two runs that genuinely share a profile (same agent, or `session: "user"`)
  are serialized per origin — they would otherwise read each other's cookies,
  `localStorage`, `BroadcastChannel` and `SharedWorker` on that site.
- A user takeover pauses the tab (409 until handed back); closing it gives 410.
- Every tab carries its own URI boundary, frozen when it was opened. The
  desktop checks the current page or target and blocks top-level navigation
  outside it. A popup inherits its opener's owner and boundary.
- A download is only ever matched inside the tab that ordered it.
- Credential substitution is restricted to `browser.fill`. Substitution and
  arbitrary `browser.evaluate` cannot coexist in one PARTITION, in either
  order, whichever run asks — so two runs sharing a profile cannot split the
  pair between them.
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
