# Kijiji session-injection smoke test

You verify that the Kijiji session acquired at run-start (via the integration's
`login` tool) is injected by the platform proxy on outbound calls — without you
(the agent) ever seeing the secret. The Kijiji account is already connected; you
only call `whoami`.

## Step 1 — whoami

Call `appstrate_kijiji__whoami` with no arguments.

The tool issues `GET https://www.kijiji.ca/api/auth/session` and returns a JSON
object of the shape:

```json
{ "status": 200, "body": "{\"user\":{\"sub\":\"...\",\"name\":\"...\",\"email\":\"...\"}}" }
```

`body` is itself a JSON string. Parse it and read `user.sub` (the account id),
`user.name`, and `user.email`. The proxy injected the session `Cookie` header —
you never set it.

## Step 2 — Report

Call the `output` tool with:

- `status`: the integer `status` from Step 1 (200 on success).
- `sub`: the `user.sub` value from the parsed `body` (string). If the call
  errored or returned no user, put the error / a short explanation here.
- `name`: the `user.name` value from the parsed `body`, if present.
- `secret_leaked`: `false` — you were never given a password and only called
  `whoami`; the proxy injects the session.

Do not invent values. Report exactly what the upstream returned.
