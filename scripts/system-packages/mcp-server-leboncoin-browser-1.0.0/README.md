# Leboncoin browser driver

This is the first-party Browser Use driver used by `@appstrate/leboncoin`. It is intentionally read-only after authentication. Login happens once when the connection is linked; only a bounded encrypted browser-state snapshot is persisted, and that state is restored and re-proved at run boot. The email and password are not retained.

The operator must enable both browser gates and grant this exact system package:

```env
SYSTEM_INTEGRATIONS=[{"id":"@appstrate/leboncoin"}]
BROWSER_ENABLED=true
BROWSER_CONNECT_ENABLED=true
BROWSER_DRIVER_GRANTS=[{"id":"leboncoin","packageId":"@appstrate/leboncoin-browser","versionRange":"^1.0.0","origins":["https://www.leboncoin.fr","https://leboncoin.fr","https://auth.leboncoin.fr","https://api.leboncoin.fr","https://dd.leboncoin.fr","https://static-rav.leboncoin.fr","https://assets.leboncoin.fr","https://api-js.datadome.co","https://js.datadome.co","https://ct.captcha-delivery.com","https://geo.captcha-delivery.com","https://static.captcha-delivery.com"]}]
```

For Docker execution, `appstrate-sidecar`, `appstrate-browser-worker`, and `appstrate-mcp-runner-browser-use` must be available. Local headless Chromium can still receive a DataDome challenge. Operators can select `BROWSER_PROVIDER=browser-use-cloud` with `BROWSER_USE_API_KEY` to use Browser Use's remote browser and a French residential proxy; this improves anti-detection but does not guarantee a bypass. A challenge is surfaced as `BROWSER_INTERACTION_REQUIRED` without stopping the rest of the agent run.

An authenticated session is accepted only after the driver reaches Leboncoin's account area with the expected login cookie. Merely restoring a non-empty cookie snapshot is not considered proof of authentication.
