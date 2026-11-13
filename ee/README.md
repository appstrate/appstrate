# `@appstrate/ee`

The commercial features of Appstrate, one module loaded through `MODULES`
(manifest id `enterprise`). Today it holds enterprise sign-in; the user-facing
description is [`docs/site/features/enterprise-sign-in.mdx`](../docs/site/features/enterprise-sign-in.mdx).

**This directory is not Apache-2.0.** It is source-available under the Appstrate
Commercial License in `LICENSE` beside this file. Every `.ts` file carries
`// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial`, and
`bun run verify:license-boundary` fails the build if one does not. No
Apache-2.0 file may import it statically (`verify:module-isolation`).

## In this monorepo

- **Opt-in.** Append `@appstrate/ee` to `MODULES`. Absent from it, nothing is
  imported: no routes, no `org-sso:*` permissions, no Better Auth plugin.
- **Tables in the platform database, journal of its own.** `init()` migrates
  `sso_connections`, `sso_domains` and `sso_sessions` from `drizzle/` under
  `drizzle.appstrate_ee_migrations` (distinct from the platform's and from
  `@appstrate/module-ee`'s), so it needs PostgreSQL and refuses to start on
  PGlite. Platform rows are reached through `ctx.services` only
  (`verify:module-sql-boundary`); no foreign key crosses the boundary, and
  `onOrgDelete` drops an organization's rows.
- **No variable of its own.** It relies on the instance's Microsoft sign-in
  (`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`).

## Enterprise sign-in, in code

- `src/sso/auth-plugin.ts`: the Better Auth plugin. The choke point is session
  creation, a fail-closed allowlist (`src/sso/policy.ts`); the password refusal
  happens in a `before` hook, ahead of the password check; the Microsoft
  tenant is read from the ID token Better Auth stores on the account.
- `src/sso/service.ts`: the settings, and the one rule over who changes them
  (an owner, from a dashboard session), so every door gets it.
- `src/sso/routes.ts` + `src/sso/openapi.ts`: `/api/org-sso`.

## Known limits (documented for the IT administrator)

- A member removed by an owner joins again at their next Microsoft sign-in
  while their Entra account is enabled: deprovision in Entra too.
- Only dashboard sessions are capped at 24 h. CLI logins and OAuth/MCP tokens
  obtained after enforcement started, and API keys, live until the person is
  removed from the organization. Enforcement itself ends the domain's sessions,
  CLI logins and OAuth refresh tokens (the platform's credential-change
  revocation).
- The owners' emergency password can be reset by email: it is only as strong as
  their mailbox.
- A domain proof is checked once, at verification, never again.

## Testing

`test/requirements.ts` declares PostgreSQL, so the tests run under the tier-3
harness only (`bun test ee/test`). A domain that cannot carry a TXT record is
marked verified directly in the database on a throwaway instance:

```sql
UPDATE sso_domains SET verified_at = now() WHERE domain = 'example.com';
```
