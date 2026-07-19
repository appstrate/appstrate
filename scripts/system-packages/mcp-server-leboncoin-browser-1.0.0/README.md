# Leboncoin browser driver

This is the first-party browser driver used by `@appstrate/leboncoin`. It is intentionally read-only after authentication and does not attempt to solve or bypass DataDome challenges.

The operator must enable both browser gates and grant this exact system package:

```env
SYSTEM_INTEGRATIONS=[{"id":"@appstrate/leboncoin"}]
BROWSER_ENABLED=true
BROWSER_CONNECT_ENABLED=true
BROWSER_DRIVER_GRANTS=[{"id":"leboncoin","packageId":"@appstrate/leboncoin-browser","versionRange":"^1.0.0","origins":["https://www.leboncoin.fr","https://leboncoin.fr","https://auth.leboncoin.fr","https://api.leboncoin.fr","https://dd.leboncoin.fr","https://static-rav.leboncoin.fr","https://assets.leboncoin.fr","https://api-js.datadome.co","https://js.datadome.co","https://ct.captcha-delivery.com","https://geo.captcha-delivery.com","https://static.captcha-delivery.com"]}]
```

For Docker execution, `appstrate-sidecar`, `appstrate-browser-worker`, and `appstrate-mcp-runner-bun` must be available. A residential egress proxy may reduce false-positive anti-bot challenges, but the driver still fails with `BROWSER_INTERACTION_REQUIRED` whenever a challenge is present.
