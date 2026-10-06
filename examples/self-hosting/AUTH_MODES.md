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
| Name the owner of the root org on first deploy   | `AUTH_BOOTSTRAP_OWNER_EMAIL=admin@acme.com` + `AUTH_BOOTSTRAP_TOKEN=…`, redeem at `/claim`     |
| Unattended install, claim ownership later (#344) | (auto) — `appstrate install --yes` generates `AUTH_BOOTSTRAP_TOKEN`, redeem at `/claim`        |

---

## Reference — env variables

All flags default to "off" so an existing `.env` keeps working unchanged.

### `AUTH_DISABLE_SIGNUP`

`true` | `false` (default `false`).

When `true`, Appstrate rejects new account creation across **every** auth
path: email/password, magic-link, social OIDC. Three exceptions always pass
through, in priority order:

1. The email matches `AUTH_BOOTSTRAP_OWNER_EMAIL` **and the caller proves
   it controls that address** (bootstrap path, see below).
2. The email is in `AUTH_PLATFORM_ADMIN_EMAILS` **and the caller proves it
   controls that address** (same proof, see "Accounts the environment
   names" below).
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

- Bypass `AUTH_DISABLE_SIGNUP` and `AUTH_ALLOWED_SIGNUP_DOMAINS` when
  their account is created with proof of ownership (below).
- Can call `POST /api/orgs` even when `AUTH_DISABLE_ORG_CREATION=true`.
- Can call the platform-admin routes.

The privilege is read off the account's address on every request, so the
account of a listed address is created only for a caller who proves
control of that address — the rule of the bootstrap owner, in "Accounts
the environment names" below. The plain sign-up form refuses a listed
address that has no account yet. An account that already holds a listed
address is not re-examined: it signs in and uses the privilege as before,
so list only addresses whose account you can sign in to, or that have no
account yet.

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

`AUTH_BOOTSTRAP_OWNER_EMAIL` says **which** account owns the instance. The
moment that account is created, an organization named
`AUTH_BOOTSTRAP_ORG_NAME` (default `"Default"`) is created with it as
`owner`.

#### Accounts the environment names

The owner's account is born owner, and the account of an address in
`AUTH_PLATFORM_ADMIN_EMAILS` is born platform admin, so knowing such an
address is not enough to create its account. The platform creates it only
for a caller who proves control:

| How the account is created                                                      | Accepted? |
| ------------------------------------------------------------------------------- | --------- |
| `/claim` with `AUTH_BOOTSTRAP_TOKEN` (see below)                                | yes       |
| Google / GitHub sign-in, when the provider asserts the address is verified      | yes       |
| Magic link sent to the address (requires SMTP)                                  | yes       |
| Email + password on `/register`, with or without SMTP                           | **no**    |
| An existing account changing its e-mail to the address (`email_change_refused`) | **no**    |

The sign-up form refuses whatever else is configured — open or closed
sign-up, a pending invitation, a sign-up on a hosted end-user page. A
verification e-mail does not count: it shows who reads the inbox, not who
chose the password. The refusal does not state its reason: it carries the
status and body the form gives any address it will not register
(`signup_disabled`, `signup_domain_not_allowed`, or "User already
exists"), and the address is not sent to the browser. The reason is in
the server log
(`refused to create an account named in AUTH_BOOTSTRAP_OWNER_EMAIL / AUTH_PLATFORM_ADMIN_EMAILS without proof of ownership`);
the recovery is under Pitfalls below.

The token at `/claim` creates one account, on an instance that has no
organization yet: the named owner's when `AUTH_BOOTSTRAP_OWNER_EMAIL` is
set, otherwise the address its holder types — a listed admin address
included. Every other listed address is created by a magic link or a
verified social sign-in.

The named owner is exempt from `AUTH_ALLOWED_SIGNUP_DOMAINS` on every
accepted path: the operator named that address. A listed admin address
is exempt on the social and magic-link paths, not at `/claim`: the token
claims an admin address outside the allowlist only if it is also the
named owner (`403 signup_domain_not_allowed` otherwise).

While a bootstrap token is redeemable the dashboard shows `/claim` and
nothing else to a signed-out visitor, so the token is the path to use
whenever one is set (the installer always sets one). The social and
magic-link paths are for an instance configured without a token.

#### Known limits

- **A named address can still be guessed and confirmed.** With sign-up
  open and no SMTP, the refusal is answered after the password is hashed
  while a really taken address is answered before, so response time tells
  them apart. And without SMTP, a signed-in account that tries to change
  its e-mail to the owner's address or to one in
  `AUTH_PLATFORM_ADMIN_EMAILS` gets `403 email_change_refused`, which an
  ordinary address does not. With SMTP the request is answered like any
  other and no e-mail is sent: the refusal is only in the server log.
  Confirming the address does not let anyone create its account.
- **A space that runs its own SMTP server can tell whether an address is
  its own or free.** A sign-in e-mail requested on that space's hosted
  pages reaches its server only for one of the space's accounts or for an
  address nobody holds; for any other address nothing arrives, which the
  server's owner can observe. No link is delivered in that case.
- **An account that already holds a named address is not re-examined.**
  The rule is on creation. Whoever holds the account of an address in
  `AUTH_BOOTSTRAP_OWNER_EMAIL` or `AUTH_PLATFORM_ADMIN_EMAILS` has its
  privilege from the next restart. Before naming an address, and once
  after upgrading to this rule, look up its row in the `user` table: it
  should be an account you can sign in to, with `realm = 'platform'`. A
  row with `email_verified = false` was created by the plain sign-up form
  with no proof of ownership — if it is not yours, delete it and create
  the account again with proof.
- **Social sign-in links onto an existing account by address.** Google
  and GitHub are trusted providers: signing in with one attaches it to
  the existing account that has the same address, and that step does not
  check whether the provider verified the address. The provider's
  verified flag decides how a NEW account is created (including the
  owner's, above), not linking.

Idempotent: if the user already owns an org, the after-hook is a no-op.
Slug collisions add a numeric suffix.

```env
AUTH_DISABLE_SIGNUP=true
AUTH_DISABLE_ORG_CREATION=true
AUTH_BOOTSTRAP_OWNER_EMAIL=admin@acme.com
AUTH_BOOTSTRAP_ORG_NAME=Acme HQ
AUTH_BOOTSTRAP_TOKEN=<openssl rand -base64 32 | tr '+/' '-_' | tr -d '='>
```

### `AUTH_BOOTSTRAP_TOKEN` (single-shot redemption — closed-by-default)

The secret that proves the person creating the owner account is the
operator. The CLI generates a 256-bit base64url token on every closed
install, writes it to `.env`, and prints a banner with the redemption URL.

- With `AUTH_BOOTSTRAP_OWNER_EMAIL`: the token claims that address and no
  other (`bootstrap_owner_email_mismatch` otherwise). If an account already
  exists for it, the answer is `409 bootstrap_user_exists`: sign in with
  that account and use the script of Recipe 4.
- Alone — typically `curl … | bash -s -- --yes` or any unattended flow
  (Ansible, cloud-init, GitHub Actions) where no email is known at install
  time: the token holder picks the owner address on `/claim`.

The platform reads the token at boot, holds it in memory, and lets the
**first** POST to `/api/auth/bootstrap/redeem` matching that token claim
ownership of the instance — closing the historical "silent open mode
after `curl|bash`" footgun (issue #344).

State machine:

| Condition                              | Pending? | Redeemable? |
| -------------------------------------- | -------- | ----------- |
| `AUTH_BOOTSTRAP_TOKEN=""` (default)    | no       | no          |
| Set, no orgs exist, not yet redeemed   | yes      | yes         |
| Set, an org exists (any path)          | no\*     | **no**      |
| Set, redeemed in this process lifetime | no       | no          |

\* Reconciled at boot: when the env still carries a token but at least
one org already exists, the platform flips the in-memory consumed flag
during startup so the SPA stops sending returning visitors to `/claim`.

**Remove `AUTH_BOOTSTRAP_TOKEN` from `.env` once the instance is
claimed.** What keeps a claimed token dead across restarts is the
organization count: the token is redeemable while the instance has no
organization at all. A token left in `.env` is therefore redeemable
again after a restart if every organization has since been deleted, by
whoever can read that file or an old copy of it.

> **Reverse-proxy deployments:** the redeem endpoint is rate-limited to
> 5 requests/minute **per source IP**. If you front the platform with a
> load balancer or reverse proxy (nginx, Traefik, Caddy, cloud LB),
> configure `TRUST_PROXY` to the number of trusted hops so
> `lib/client-ip.ts` resolves the real client IP from
> `X-Forwarded-For` instead of treating every request as the proxy's
> address. Without it the limiter degrades to a single global counter
> shared by every visitor — the brute-force window remains far below
> the entropy floor (132 bits) but the rate-limit signal in your SIEM
> becomes noise. See the `TRUST_PROXY` row in `docs/ENV.md`
> for hop semantics.

```env
# Generated by `appstrate install`. Do NOT commit. Single-use.
AUTH_DISABLE_SIGNUP=true
AUTH_DISABLE_ORG_CREATION=true
AUTH_BOOTSTRAP_TOKEN=kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk
```

The operator opens `<APP_URL>/claim`, pastes the token + their owner
email/password, submits. The redeem route runs Better Auth signup inside
an explicit signup-gate bypass, then creates the bootstrap organization
in the same round-trip and sets the session cookie so the SPA lands
authenticated.

While a token is redeemable, every signed-out page of the dashboard
leads to `/claim`.

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
`AUTH_DISABLE_ORG_CREATION=true`, `AUTH_PLATFORM_ADMIN_EMAILS=…`,
`AUTH_BOOTSTRAP_OWNER_EMAIL=…` and a fresh `AUTH_BOOTSTRAP_TOKEN=…` into
the generated `.env`. Empty input keeps the default open mode.

**Non-interactive** (`curl|bash`, CI, Ansible, cloud-init):

```sh
APPSTRATE_BOOTSTRAP_OWNER_EMAIL=admin@acme.com \
APPSTRATE_BOOTSTRAP_ORG_NAME="Acme" \
curl -fsSL https://get.appstrate.dev | bash
```

Same result, no prompt. The env vars are read by the installer and
written into the generated `.env`.

After install, the CLI opens the dashboard in your browser and prints the
next step:

```
┌  Closed-by-default install — claim ownership
│
│  Open  http://localhost:3000/claim
│  Claim it as  admin@acme.com  with a password of your choice.
│
│    Bootstrap token:
│    kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk
│
└
```

Paste the token, type the owner address and a password, submit. The org
is created in the same round-trip and you land signed in, then go through
the rest of the onboarding (configure your first model, connect
providers, invite teammates). Done.

> **How signup works in closed mode.** The signup link is hidden from
> `/login` (no public discoverability) but `/register` itself stays
> mounted for invited addresses. The server-side gate is the real
> authority: any other email submitted on that form is rejected with a
> `signup_disabled` error surfaced inline, and the addresses the
> environment names (bootstrap owner, platform admins) are refused there
> too — those accounts are created at `/claim`, by a magic link or by a
> verified social sign-in.

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
AUTH_BOOTSTRAP_TOKEN=<openssl rand -base64 32 | tr '+/' '-_' | tr -d '='>
```

Workflow:

1. Deploy with the env above.
2. Open `<APP_URL>/claim`, paste the token, claim the instance as
   `admin@acme.com` (the `Acme` org is created with you as owner).
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
AUTH_BOOTSTRAP_TOKEN=<openssl rand -base64 32 | tr '+/' '-_' | tr -d '='>
```

Workflow:

1. Deploy.
2. Open `<APP_URL>/claim`, paste the token and claim the instance as
   `ops@acme.com`: the account is created together with a first
   organization it owns (`AUTH_BOOTSTRAP_ORG_NAME`, default `"Default"`).
   With SMTP, Google or GitHub configured you can leave the token out and
   sign in as `ops@acme.com` by magic link or social sign-in instead. The
   sign-up form refuses that address.
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
The owner user **must already exist**. The script creates no account: an
address named in `AUTH_BOOTSTRAP_OWNER_EMAIL` or
`AUTH_PLATFORM_ADMIN_EMAILS` gets its account by a magic link or a
verified social sign-in (the sign-up form refuses it), any other address
by the sign-up form or an invitation.

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
   `AUTH_PLATFORM_ADMIN_EMAILS` so they don't lose access. List addresses
   that already have an account, and check you can sign in to each: an
   existing account is not re-examined, and a listed address without one
   is created only with proof of ownership (Pitfalls below).
2. Set `AUTH_DISABLE_SIGNUP=true` and (optionally) `AUTH_DISABLE_ORG_CREATION=true`.
3. Restart the API.
4. Existing users keep working. New public signups are blocked. Pending
   invitations remain valid.

To go back to open mode, unset the flags and restart. No data migration.

---

## Pitfalls

- **Forgot `AUTH_PLATFORM_ADMIN_EMAILS` after enabling `AUTH_DISABLE_ORG_CREATION`** — no
  one can create an org. Add at least one admin email and restart.
- **Bootstrap email must be claimed once** — setting
  `AUTH_BOOTSTRAP_OWNER_EMAIL` does nothing on its own; the org is
  created when the owner account is. If you change the email after the
  org exists, the new email won't get a fresh org (idempotent on
  user-already-owns-an-org).
- **`AUTH_BOOTSTRAP_OWNER_EMAIL` without a token** — the sign-up form
  refuses that address like any address it will not register, and the
  server log says why. This is the state of an instance installed before
  the token accompanied a named owner, if its owner never signed up. Add
  `AUTH_BOOTSTRAP_TOKEN=<openssl rand -base64 32 | tr '+/' '-_' | tr -d '='>`
  to `.env` by hand, restart, and claim the instance at `/claim`. The token is redeemable only while the instance has no
  organization at all.
- **`AUTH_BOOTSTRAP_OWNER_EMAIL` on an instance that already has an
  organization, owner account absent** — no token can claim it (`/claim`
  answers 410) and the sign-up form refuses the address. Without Google,
  GitHub or SMTP (magic link) the recovery is: remove the address from
  `AUTH_BOOTSTRAP_OWNER_EMAIL` and from `AUTH_PLATFORM_ADMIN_EMAILS`,
  restart, create the account as an ordinary address (with sign-up closed
  that takes an invitation, or sign-up reopened for the time it takes),
  put the address back in `AUTH_PLATFORM_ADMIN_EMAILS` if it was there,
  restart, then run
  `bun apps/api/scripts/bootstrap-org.ts --owner=<email>` (Recipe 4).
- **An address in `AUTH_PLATFORM_ADMIN_EMAILS` that has no account yet**
  — the sign-up form refuses it like any address it will not register,
  and the server log says why. While the instance has no organization,
  set `AUTH_BOOTSTRAP_TOKEN`, restart and claim the instance with that
  address at `/claim` (if `AUTH_BOOTSTRAP_OWNER_EMAIL` is set, the token
  claims that address only). Otherwise sign in with a magic link (SMTP)
  or a Google / GitHub identity that verifies the address. Otherwise
  remove the address from the list, restart, create the account as an
  ordinary address (invitation, or sign-up reopened for the time it
  takes), put the address back and restart.
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
