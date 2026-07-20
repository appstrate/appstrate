# Vinted browser driver

This first-party Browser Use driver backs `@appstrate/vinted`. It signs the user in when the connection is linked, persists only bounded encrypted browser state, and exposes catalog plus explicitly confirmed listing-publication tools. The email and password are used once by the private driver and are not retained.

The operator must enable both browser gates and grant this exact system package:

```env
SYSTEM_INTEGRATIONS=[{"id":"@appstrate/vinted"}]
BROWSER_ENABLED=true
BROWSER_CONNECT_ENABLED=true
BROWSER_DRIVER_GRANTS=[{"id":"vinted","packageId":"@appstrate/vinted-browser","versionRange":"^1.0.0","origins":["https://vinted.fr","https://www.vinted.fr","https://images1.vinted.net","https://marketplace-web-assets.vinted.com","https://static-assets.vinted.com","https://cdn.cookielaw.org","https://api-js.datadome.co","https://js.datadome.co","https://ct.captcha-delivery.com","https://geo.captcha-delivery.com","https://static.captcha-delivery.com"]}]
```

At run boot, the trusted driver restores and re-proves the persisted browser state. A DataDome, CAPTCHA, email-code, or 2FA challenge is reported as `BROWSER_INTERACTION_REQUIRED` without stopping the rest of the agent run. Operators may opt into Browser Use Cloud for a stealth browser and residential proxy; it remains an anti-detection improvement, not a challenge-solving guarantee.

Listing creation is split into two calls. `prepare_item_draft` validates workspace-relative JPEG, PNG, or WebP images, fills the form, and returns a one-time token without submitting anything. `publish_item` is destructive and accepts only that token after the user has approved the exact draft summary. The browser worker mounts the opted-in run workspace read-only so Chromium can upload those files.
