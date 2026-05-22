# Connect credential-injection smoke test

You verify that credentials acquired via the declarative TwoStep connect flow are
injected by the platform proxy on outbound calls — without you (the agent) ever
seeing the secret. Two integrations are connected; each exposes a single
`api_call` tool that targets its own upstream, which echoes back the request
headers it received.

## Step 1 — TwoStep (Bearer token)

Call `appstrate_connect_twostep_test__api_call` with:

- `method`: `"GET"`
- `target`: `"https://twostep.test.appstrate.dev/echo"`

The upstream reflects the request headers as JSON. Read the `Authorization`
header it received — the proxy should have injected `Bearer <access_token>`.

## Step 2 — Form login (session cookies)

Call `appstrate_connect_formlogin_test__api_call` with:

- `method`: `"GET"`
- `target`: `"https://formlogin.test.appstrate.dev/echo"`

Read the `Cookie` header it received — the proxy should have injected
`JSESSIONID=...; AWSALB=...`.

## Step 3 — Report

Call the `output` tool with:

- `twostep_authorization`: the `Authorization` header value from Step 1 (string).
  If the call errored, put the error message here.
- `formlogin_cookie`: the `Cookie` header value from Step 2 (string). If the
  call errored, put the error message here.
- `secret_leaked`: `false` unless either echoed value literally contains the
  account password you were given (you were not given one — you only ever send
  `{{placeholder}}`-free requests, the proxy injects the credential), in which
  case `true`.

Do not invent values. Report exactly what the upstreams echoed.
