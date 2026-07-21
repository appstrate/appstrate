# Appstrate Browser Companion

The companion performs the first-party login on the user's own machine, exports only cookies and
local storage for exact manifest-authorized origins, and submits that bounded state to an Appstrate
attempt capability. The API immediately re-proves the session in its connection-scoped target
profile; the companion waits for that proof before reporting success.

On macOS, build and register the local app with:

```sh
bun run build:macos
open "dist/Appstrate Browser.app"
```

Production releases should sign and notarize the generated `.app` instead of using the local
ad-hoc signature. The Bun worker never receives provider API keys, connection encryption keys, or
other Appstrate credentials; its only authority is the short-lived one-attempt bearer embedded in
the `appstrate-browser://` URL.
