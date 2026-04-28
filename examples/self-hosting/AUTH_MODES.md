# Auth modes — open vs closed

Appstrate ships in **open mode** by default: anyone who can reach the instance
can sign up and create their own organization. Great for public SaaS, demos,
and multi-tenant POCs.

Self-hosters who run Appstrate on a public domain usually want **closed mode**:
no public signup, organizations created by invitation only, optional domain
restriction. This page explains how to switch between the two and how to
bootstrap the first owner safely.

---

## TL;DR

| Goal                                             | Set                                                                                            |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Public SaaS / demo (default)                     | nothing — leave all `AUTH_*` flags unset                                                       |
| Lock down signup, allow invitations              | `AUTH_DISABLE_SIGNUP=true`                                                                     |
| Lock down org creation too (single-org tenant)   | `AUTH_DISABLE_SIGNUP=true` + `AUTH_DISABLE_ORG_CREATION=true` + `AUTH_PLATFORM_ADMIN_EMAILS=…` |
| Restrict to specific email domains               | `AUTH_ALLOWED_SIGNUP_DOMAINS=acme.com,foo.io`                                                  |
| Auto-provision the root org on first deploy      | `AUTH_BOOTSTRAP_OWNER_EMAIL=admin@acme.com` (+ `AUTH_BOOTSTRAP_ORG_NAME="Acme"`)               |
| Unattended install, claim ownership later (#344) | (auto) — `appstrate install --yes` generates `AUTH_BOOTSTRAP_TOKEN`, redeem at `/claim`        |

---

## Reference — env variables

All flags default to "off" so an existing `.env` keeps working unchanged.

### `AUTH_DISABLE_SIGNUP`

`true` | `false` (default `false`).

When `true`, Appstrate rejects new account creation across **every** auth
path: email/password, magic-link, social OIDC. Three exceptions always pass
through, in priority order:

1. The email matches `AUTH_BOOTSTRAP_OWNER_EMAIL` (bootstrap path, see
   below).
2. The email is in `AUTH_PLATFORM_ADMIN_EMAILS`.
3. A non-expired `pending` invitation exists for the email in
   `org_invitations` — the **invitation override** that prevents the
   common Infisical-style breakage where invite links stop working when
   signup is locked.

Existing users continue to log in normally. Closed mode only prevents the
**creation** of brand-new Better Auth users.

### `AUTH_DISABLE_ORG_CREATION`

`true` | `false` (default `false`).

When `true`, only platform admins may call `POST /api/orgs`.
Org-less users see a **"Waiting for invitation"** page in the dashboard
instead of the org-creation onboarding step. Pair this with
`AUTH_PLATFORM_ADMIN_EMAILS` so at least one human can create the root org
(or use the bootstrap path below).

### `AUTH_PLATFORM_ADMIN_EMAILS`

Comma-separated email allowlist (case-insensitive). Default empty.

Platform admins:

- Bypass `AUTH_DISABLE_SIGNUP`.
- Can call `POST /api/orgs` even when `AUTH_DISABLE_ORG_CREATION=true`.

Declarative on purpose: no UI, no migration, IaC-friendly. Add or remove
admins by editing the env and restarting the API.

```env
AUTH_PLATFORM_ADMIN_EMAILS=admin@acme.com,ops@acme.com
```

### `AUTH_ALLOWED_SIGNUP_DOMAINS`

Comma-separated email-domain allowlist. Default empty (no restriction).

When set, signups are limited to the listed domains. Matching is
case-insensitive and the leading `@` is optional. The **invitation
override** still applies — an invited contractor with an external email
can join an organization without their domain being on the list.

```env
AUTH_ALLOWED_SIGNUP_DOMAINS=acme.com,foo.io
```

### `AUTH_BOOTSTRAP_OWNER_EMAIL` + `AUTH_BOOTSTRAP_ORG_NAME`

Declarative bootstrap path for fresh closed-mode instances.

When `AUTH_BOOTSTRAP_OWNER_EMAIL` is set:

1. The signup gate lets this email through even if `AUTH_DISABLE_SIGNUP=true`.
2. As soon as that user signs up (dashboard, magic-link, social OIDC), an
   organization named `AUTH_BOOTSTRAP_ORG_NAME` (default `"Default"`) is
   created automatically with that user as `owner`.

Idempotent: if the user already owns an org, the after-hook is a no-op.
Slug collisions add a numeric suffix.

```env
AUTH_DISABLE_SIGNUP=true
AUTH_DISABLE_ORG_CREATION=true
AUTH_BOOTSTRAP_OWNER_EMAIL=admin@acme.com
AUTH_BOOTSTRAP_ORG_NAME=Acme HQ
```

### `AUTH_BOOTSTRAP_TOKEN` (single-shot redemption — closed-by-default)

Companion to `AUTH_BOOTSTRAP_OWNER_EMAIL` for the case where you can't
provide an email at install time — typically `curl … | bash -s -- --yes`
or any unattended flow (Ansible, cloud-init, GitHub Actions). The CLI
generates a 256-bit base64url token, writes it to `.env`, and prints a
banner with the redemption URL.

The platform reads the token at boot, holds it in memory, and lets the
**first** POST to `/api/auth/bootstrap/redeem` matching that token claim
ownership of the instance — closing the historical "silent open mode
after `curl|bash`" footgun (issue #344).

State machine:

| Condition                              | Pending? | Redeemable? |
| -------------------------------------- | -------- | ----------- |
| `AUTH_BOOTSTRAP_TOKEN=""` (default)    | no       | no          |
| Set, no orgs exist, not yet redeemed   | yes      | yes         |
| Set, an org exists (any path)          | yes      | **no**      |
| Set, redeemed in this process lifetime | no       | no          |

The DB-org-count check is the durable replay guard: even if the operator
forgets to remove the token from `.env`, once any organization exists
the token is dead — a process restart cannot reopen the redemption
window.

```env
# Generated by `appstrate install --yes` when no APPSTRATE_BOOTSTRAP_OWNER_EMAIL
# is provided. Do NOT commit. Single-use.
AUTH_DISABLE_SIGNUP=true
AUTH_DISABLE_ORG_CREATION=true
AUTH_BOOTSTRAP_TOKEN=kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk
```

The operator opens `<APP_URL>/claim`, pastes the token + their owner
email/password, submits. The redeem route runs Better Auth signup inside
an explicit signup-gate bypass, then creates the bootstrap organization
in the same round-trip and sets the session cookie so the SPA lands
authenticated.

Mutually exclusive with `AUTH_BOOTSTRAP_OWNER_EMAIL` — set one or the
other, never both. (The CLI never generates both; this is a guard for
hand-written `.env` files.)

---

## Recipes

### Recipe 0 — closed mode at install time (easiest)

The `appstrate install` command picks up closed-mode config in two ways,
so you usually never have to touch `.env` by hand:

**Interactive** (`appstrate install` from a terminal):

```
? Bootstrap admin email (or empty to skip): admin@acme.com
```

Type your email → install writes `AUTH_DISABLE_SIGNUP=true`,
`AUTH_DISABLE_ORG_CREATION=true`, `AUTH_PLATFORM_ADMIN_EMAILS=…`, and
`AUTH_BOOTSTRAP_OWNER_EMAIL=…` into the generated `.env`. Empty input
keeps the default open mode.

**Non-interactive** (`curl|bash`, CI, Ansible, cloud-init):

```sh
APPSTRATE_BOOTSTRAP_OWNER_EMAIL=admin@acme.com \
APPSTRATE_BOOTSTRAP_ORG_NAME="Acme" \
curl -fsSL https://get.appstrate.dev | bash
```

Same result, no prompt. The env vars are read by the installer and
written into the generated `.env`.

After install, the CLI prints the exact next step:

```
┌  Next: create your owner account
│
│  Open  http://localhost:3000/register
│  Sign up as  admin@acme.com  (the form is pre-filled and locked)
│  Pick any password — the org "Acme" is created automatically.
│
└
```

Open the URL — `/register` is rendered with the email field already
filled in and disabled (so a typo can't diverge you from the configured
bootstrap account). Pick a password, submit. The org is created
synchronously by the signup after-hook, then you're routed through the
rest of the onboarding (configure your first model, connect providers,
invite teammates). Done.

> **How signup works in closed mode.** The signup link is hidden from
> `/login` (no public discoverability) but `/register` itself stays
> mounted. When `AUTH_BOOTSTRAP_OWNER_EMAIL` is set, the SPA pre-fills
> and locks the email field via `__APP_CONFIG__.bootstrapOwnerEmail` so
> the bootstrap owner can't accidentally submit a different email. The
> server-side gate is the real authority: any other email submitted on
> the same form is rejected with a `signup_disabled` error surfaced
> inline. Google/GitHub/SMTP also work and skip the form entirely if
> configured.

### Recipe 1 — public SaaS (default)

Leave every `AUTH_*` flag unset. Anyone with the URL can sign up and gets
a fresh org of their own. This is the default and matches the cloud
deployment model.

### Recipe 2 — closed self-host with auto-bootstrap (recommended)

For a single-tenant production deployment (your team or your customer):

```env
AUTH_DISABLE_SIGNUP=true
AUTH_DISABLE_ORG_CREATION=true
AUTH_PLATFORM_ADMIN_EMAILS=admin@acme.com
AUTH_BOOTSTRAP_OWNER_EMAIL=admin@acme.com
AUTH_BOOTSTRAP_ORG_NAME=Acme
```

Workflow:

1. Deploy with the env above.
2. Open the dashboard, sign up as `admin@acme.com` (signup gate lets you
   through, after-hook creates the `Acme` org with you as owner).
3. Invite teammates from the dashboard — they receive standard invitations
   that bypass the signup lock thanks to the invitation override.

If anything goes wrong, the manual bootstrap script (Recipe 4) is
idempotent and can recover the state.

### Recipe 3 — closed multi-tenant (operators provision orgs)

Several customer organizations on one self-hosted instance, with you (the
operator) creating each org manually:

```env
AUTH_DISABLE_SIGNUP=true
AUTH_DISABLE_ORG_CREATION=true
AUTH_PLATFORM_ADMIN_EMAILS=ops@acme.com
```

Workflow:

1. Deploy.
2. Sign up as `ops@acme.com` in the dashboard.
3. For each new tenant: create the org via `POST /api/orgs` (or the
   dashboard org switcher), then invite the customer's owner. The
   customer receives an invitation that lets them sign up despite the
   lockdown.

### Recipe 4 — manual bootstrap via script

For air-gapped envs, IaC pipelines, or recovery:

```sh
bun apps/api/scripts/bootstrap-org.ts \
  --owner=admin@acme.com \
  --name="Acme" \
  [--slug=acme]
```

The script connects directly to PostgreSQL (using your `DATABASE_URL`).
The owner user **must already exist** — sign them up first (the
`AUTH_BOOTSTRAP_OWNER_EMAIL` / `AUTH_PLATFORM_ADMIN_EMAILS` allowlist is
how they get past the closed-mode signup gate).

Output is a single JSON line for IaC consumption:

```json
{ "created": true, "orgId": "…", "slug": "acme", "ownerId": "…", "ownerEmail": "admin@acme.com" }
```

Exit codes: `0` success or already-owner (idempotent), `1` invalid args,
`2` owner not found.

### Recipe 5 — domain-restricted SSO

Combine social OIDC with a domain allowlist for a corporate-only
instance:

```env
GOOGLE_CLIENT_ID=…
GOOGLE_CLIENT_SECRET=…
AUTH_ALLOWED_SIGNUP_DOMAINS=acme.com
```

Anyone with an `@acme.com` Google identity can sign up. External users
need an explicit invitation.

---

## Migration — open → closed on a running instance

1. Identify your platform admins. Add their emails to
   `AUTH_PLATFORM_ADMIN_EMAILS` so they don't lose access.
2. Set `AUTH_DISABLE_SIGNUP=true` and (optionally) `AUTH_DISABLE_ORG_CREATION=true`.
3. Restart the API.
4. Existing users keep working. New public signups are blocked. Pending
   invitations remain valid.

To go back to open mode, unset the flags and restart. No data migration.

---

## Pitfalls

- **Forgot `AUTH_PLATFORM_ADMIN_EMAILS` after enabling `AUTH_DISABLE_ORG_CREATION`** — no
  one can create an org. Add at least one admin email and restart.
- **Bootstrap email must complete signup once** — setting
  `AUTH_BOOTSTRAP_OWNER_EMAIL` does nothing on its own; the org is
  created by the after-hook when the owner first signs up. If you change
  the email after the org exists, the new email won't get a fresh org
  (idempotent on user-already-owns-an-org).
- **Social OIDC + closed mode** — Google/GitHub callbacks go through the
  same signup gate. An external Google user without an invitation gets a
  `signup_disabled` redirect. Add their domain to
  `AUTH_ALLOWED_SIGNUP_DOMAINS` if you want company-wide self-service.
- **Magic-link emails are sent even when blocked** — to avoid leaking
  account-existence information to a stranger. The token simply fails to
  consume on click. This matches the upstream Better Auth behavior.

---

## See also

- `examples/self-hosting/.env.example` — copy-paste starting point.
- `apps/api/scripts/bootstrap-org.ts` — manual bootstrap script.
- Issue [appstrate#228](https://github.com/appstrate/appstrate/issues/228)
  — design rationale and SOTA references (Langfuse, Infisical, Better
  Auth).
