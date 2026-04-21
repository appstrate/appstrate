# @afps/environment

Canonical platform-identity prelude for AFPS 1.3+.

Describes the agent execution contract in **tool-agnostic terms** — provider
tools, file references, workspace semantics. Replaces the pre-1.3 vendor-specific
`@appstrate/environment@^1`, which hardcoded `$SIDECAR_URL` and a `curl`-based
authenticated-request protocol.

```yaml
systemPreludes:
  - name: "@afps/environment"
    version: "^2.0.0"
```

Runtimes render `prompt.md` as logic-less Mustache against the canonical
`PromptView` plus any platform-specific `platform.*` flags. The same
prelude renders identically on every AFPS-compliant runner.

Legacy `@appstrate/environment@^1` remains published indefinitely for
back-compat with bundles that depend on it by name.
