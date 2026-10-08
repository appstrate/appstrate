# Changelog

All notable changes to Appstrate will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **BREAKING (API): `POST /api/runs/remote` no longer answers
  `409 agent_not_ready`** (#1783). A connection cascade that changed between
  the readiness check and the run's creation answers
  `409 missing_integration_connection` with its `errors[]`, like the readiness
  check. A cascade binding several connections to one integration answers the
  same 409 with one `remote_binds_one_connection` item per integration
  (`field: integrations.<id>`). A client matching on the `agent_not_ready`
  code breaks; no known consumer reads it (the CLI prints the status and body).

### Fixed

- **A `400 validation_failed` response reports a missing body field with
  `errors[].code: "required"`** (#1790), as documented, instead of
  `invalid_type`, `invalid_value` or `invalid_union`. The dashboard now shows
  its "field is required" message for it. A missing coerced numeric field,
  such as `size` on `POST /api/uploads`, still reports `invalid_type`.

## [1.0.0-beta.65] - 2026-10-07

### Operators

- **An account named by `AUTH_BOOTSTRAP_OWNER_EMAIL` or
  `AUTH_PLATFORM_ADMIN_EMAILS` that does not exist yet is no longer created
  by the sign-up form** (#1707). On an instance with no organization yet, set
  `AUTH_BOOTSTRAP_TOKEN`, restart and claim it at `<APP_URL>/claim`; remove
  the token from `.env` once claimed. Once an organization exists the token
  is dead (`/claim` answers 410): a newly named address then gets its account
  only through a magic link (SMTP) or a Google/GitHub sign-in whose provider
  asserts the address verified, and without either it cannot get one while
  it is named (recovery under Pitfalls in the doc below). Check that you can
  sign in to the account of every named address: an existing one is not
  re-examined. Recipes and known limits: `examples/self-hosting/AUTH_MODES.md`.
- **The API reads a live model catalog from `get.appstrate.dev`** (#1717,
  #1732, #1735). A new variable, `MODEL_CATALOG_URL` (default
  `https://get.appstrate.dev/model-catalog`), names a signed file listing the
  models a later Pi registry records and this build can serve, so a new model
  becomes selectable without a release. Each API process reads it in the
  background when it starts and every hour (two anonymous GETs) and holds it in
  memory; nothing about the instance is sent, nothing is stored and boot never
  waits on it. Set the variable to `off` to run on the bundled registry alone;
  an empty value is the default channel, not a switch.
  On a Docker install the variable reaches the container only when the
  `appstrate` service lists it under `environment:`. The shipped compose files
  now do; an install that keeps an older compose file adds
  `- MODEL_CATALOG_URL` there before setting it.
  Until a file is published for a Pi version the read answers 404 and nothing
  changes. Reference: `docs/architecture/MODEL_CATALOG.md`.
- **The Pi SDK moves to 1.0.4 and the model offer moves with it** (#1705).
  Run `bun run verify:system-models` with the platform env before the deploy:
  a `SYSTEM_PROVIDER_KEYS` model the new registry no longer records refuses
  boot. Removed from the offer: OpenCode Go `glm-5.1`, `kimi-k2.6`,
  `qwen3.6-plus`, `qwen3.7-max`, `qwen3.7-plus`, `qwen3.8-max`; Together AI
  `deepseek-ai/DeepSeek-V4-Pro`, `google/gemma-4-31B-it`,
  `moonshotai/Kimi-K2.6`, `moonshotai/Kimi-K2.7-Code`, `openai/gpt-oss-20b`;
  Fireworks `accounts/fireworks/models/glm-5p2` and
  `accounts/fireworks/routers/glm-5p2-fast`; Mistral `magistral-small`;
  OpenRouter `inclusionai/ling-3.0-flash-fin:free`,
  `inclusionai/ling-3.0-flash-vl:free`, `nex-agi/nex-n2.5-mini:free`,
  `nex-agi/nex-n2.5-pro:free`, `qwen/qwen3.8-27b:free`. An
  existing `org_models` row on one of them keeps its stored values and loses
  the catalog defaults (label, limits, capabilities, price); it can no longer
  be created.
- **Log levels and messages changed; update any alert that matches them**
  (#1679). `LOG_LEVEL=debug` now writes one `request` line per request
  (method, matched route pattern, status, duration, `Request-Id`). No longer at
  `error`: a refused organization delete (no line), a subprocess the platform
  stopped itself (`Subprocess stopped`, info), a chat turn the model failed
  (`chat turn failed on a model error`, warn; it used to be logged as
  `chat ui stream processing failed`), and an LLM upstream timeout
  (`llm-proxy: upstream fetch failed`, warn). The three draft-lookup lines
  about a referenced mcp-server are now `debug`.
- **An integration calling an internal API needs its host in
  `EGRESS_ALLOW_INTERNAL_HOSTS`** (#1657). In a run, an `api_call` used to
  reach a private, loopback or link-local address as soon as the
  integration's `authorized_uris` named the host literally. It is now refused
  (403 `URL targets a blocked network range`; the sidecar logs
  `Target refused (SSRF)` with the host) until the operator lists that host.
  Before the deploy, add the internal hosts your integrations name; a listed
  host is trusted by every egress site that reads the variable and by every
  organization's integrations that name it. Through the platform credential
  proxy the reverse tightening applies: a listed host is reached only when
  `authorized_uris` names it literally, no longer through `allow_all_uris`,
  a wildcard entry or a host taken from a connection value. A run's sidecar
  now resolves an `api_call` host itself (a literal host used to skip the
  lookup), so it needs working DNS even when it sends through `PROXY_URL`:
  without it the call is a 502 `Target host could not be resolved`. An
  exempt internal host (listed in `EGRESS_ALLOW_INTERNAL_HOSTS` and named
  literally in `authorized_uris`) is the exception: it is not looked up. The
  local resolver of `appstrate run` is unchanged.
- **Pre-flight the stored integration manifests before the deploy**:
  `DATABASE_URL=… bun scripts/migration/0035-verify-manifest-expressions.ts`
  lists every draft or version holding a template or runtime expression the
  platform does not evaluate, or a `{{field}}` in a delivery template
  (`[expression]`: its connect or its delivery fails, or the placeholder is
  sent as literal text) and every auth whose injected credential runs will now refuse as exfiltration
  (`[exfiltration]`: no `authorized_uris`, with or without `allow_all_uris`,
  or an entry that does not bound the host); it exits 1 while any draft or
  published version of an org integration has one, not only `latest`: a range
  such as `^1.0.0` still runs an older version. Replace a broken version by a
  fixed one every range reaching it accepts, then delete it
  (`scripts/migration/README.md` § 0035). `allow_all_uris` beside a bounded
  list is not listed (a run drops it and serves the list), but the next draft
  save refuses it: fix it when convenient. System packages are skipped: the
  image ships them (#1641).
- **Magic links and OAuth sign-ins in flight at the deploy cannot finish**
  (Better Auth 1.7.7, GHSA-965c-763c-88jm). Their stored identifiers now carry
  a purpose prefix: a link mailed before the restart is refused, and a Google
  or GitHub sign-in or account link started before it has to be started again.
  No data is rewritten. Upgrade every replica in the same cutover.
- **Migration `0078` rewrites `runs` under an exclusive lock** (the
  `model_source` column becomes the `credential_source` enum) and adds three
  CHECKs and the nullable `package_schedules.disabled_reason`. It writes no
  row. Before the deploy each of these must return no row, else the migration
  fails and the release does not boot:
  `SELECT type FROM notifications WHERE type NOT IN ('run_completed', 'package_shared') LIMIT 1;`
  `SELECT 1 FROM runs WHERE model_source IS NOT NULL AND model_source NOT IN ('system', 'org') LIMIT 1;`
  `SELECT 1 FROM runs WHERE run_origin = 'remote' AND (model_source IS NOT NULL OR model_id IS NOT NULL OR inference_route IS NOT NULL) LIMIT 1;`
  (#1641).
- **A run's connection snapshot is parsed on read** (#1641): every element of
  `runs.resolved_connections` must carry a string `label` and `accountId`,
  which the platform has written since connections are labelled at creation.
  This must return no row before the deploy; a run it names fails to load
  until its snapshot elements are given both strings:
  `SELECT r.id FROM runs r, jsonb_each(r.resolved_connections) e(k, v), jsonb_array_elements(CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE jsonb_build_array(v) END) el WHERE jsonb_typeof(el->'label') IS DISTINCT FROM 'string' OR jsonb_typeof(el->'accountId') IS DISTINCT FROM 'string' LIMIT 1;`
- **Rotating `CONNECTION_ENCRYPTION_KEY` can now finish**:
  `scripts/rekey-encrypted-columns.ts` re-encrypts, under the active key,
  every live ciphertext a retired kid wrote in the seven encrypted columns (a
  closed or expired run sink's secret is never read again and is skipped); its
  dry run is the per-kid inventory and exits 0 only when nothing live is left
  outside the active kid. Procedure: `docs/ENV.md` § "Rotating
  `CONNECTION_ENCRYPTION_KEY`" (#1641).
- **Billing pins the Stripe API version `2026-09-30.endive`** (stripe-node 23,
  #1738). A webhook endpoint renders its payloads at the version it was
  created with and that version cannot be changed: before the deploy, the
  billing endpoint (`<APP_URL>/api/billing/webhooks`) must be one created at
  `2026-09-30.endive`, with its signing secret in `STRIPE_WEBHOOK_SECRET`. Never
  leave two endpoints active on the same URL: the module does not deduplicate
  events. Only instances that load `@appstrate/module-ee` are concerned.

### Changed

- **BREAKING (CLI): `appstrate run` with an API key reads the org and space
  only from `APPSTRATE_ORG_ID` / `APPSTRATE_SPACE_ID`** (#1752), never from
  the active profile, whose pins could contradict the key's and answer 403. A
  remote run needs neither; a local run still requires `APPSTRATE_SPACE_ID`,
  and one with a preset model now also requires `APPSTRATE_ORG_ID`.
- **BREAKING (CLI): `appstrate api` uses an API key when one is set** (#1720):
  `--api-key` or `APPSTRATE_API_KEY`, the pair `appstrate run` already reads,
  with `APPSTRATE_INSTANCE` (else the profile's instance). **This changes
  behaviour for a shell that already exports `APPSTRATE_API_KEY` for
  `appstrate run`**: every `appstrate api` call there now goes out as the key
  instead of the logged-in user — another principal, no `X-Org-Id` /
  `X-Space-Id` (the key's own org and space apply), and the instance
  `APPSTRATE_INSTANCE` names. Unset the variable to keep the login. The keyring
  is not read and no profile is required. `--api-key ""` and a key with
  whitespace or non-ASCII characters are refused, for `run` as well, and `run`
  now treats an empty `APPSTRATE_INSTANCE` / `_SPACE_ID` / `_ORG_ID` as unset.
- **`appstrate install` with a named owner writes `AUTH_BOOTSTRAP_TOKEN` and
  sends the operator to `/claim`** (#1707), instead of opening a `/register`
  form pre-filled and locked to the owner's address. Every fresh closed
  install now writes the token, and with `AUTH_BOOTSTRAP_OWNER_EMAIL` set the
  claim accepts that address only (403 `bootstrap_owner_email_mismatch`); an
  upgrade mints no token. `bootstrapOwnerEmail` is gone from
  `window.__APP_CONFIG__`.
- **In a run, `api_call` forwards a header named like a credential proxy
  control header instead of refusing the call** (#1670). `X-Integration-Id`,
  `X-Target`, `X-Substitute-Body`, `X-Stream-Response`,
  `X-Max-Response-Size`, `X-Truncated`, `X-Truncated-Size` and
  `X-Auth-Refreshed` were the request controls and response markers of the
  sidecar's HTTP proxy route. That route is retired and nothing in the sidecar
  reads them: they now reach the upstream like any other header, and the tool
  description no longer mentions them. The platform credential proxy, which
  still reads some of them, is unchanged. The sidecar also stops re-checking
  the type of `target` and the case of `method`: the agent runtime validates
  a model's arguments against the tool's schema before it calls.
- **BREAKING (API): models, proxies and endpoint URLs refuse three states they
  used to accept** (#1681). A disabled model cannot be the organization default:
  `PUT /api/models/default` naming one, and `PATCH /api/models/{id}` with
  `enabled: false` on the current default, answer 409 `model_disabled` (move or
  clear the default first). `base_url_override` / `base_url` on
  `POST /api/model-provider-credentials`, `/discover` and `/test` must be
  http(s), else 400. A proxy's `urlPrefix` masks the username as well as the
  password. Deleting a model or a proxy now also clears the per-space agent
  settings naming it; settings left dangling by earlier deletions are not
  rewritten.
- **Changing a verified email address is approved from the current address
  first** (#1673). With SMTP configured, `change-email` used to send its one
  link to the new address. It now emails the current address; once approved
  there, the verification link goes to the new one, and the address changes
  when that second link is opened. An account whose current mailbox is no
  longer reachable cannot change its address on its own any more.
- **Three account e-mails are new** (#1673, SMTP only): a notice after every
  password change or reset, a notice to the owner when a sign-up is attempted
  on an address that already has an account (the sign-up screen announced an
  e-mail that was never sent), and the approval e-mail above. The
  verification, magic-link and password-reset e-mails state how long their
  link stays valid (1 hour, 15 minutes, 1 hour). `@appstrate/module-ee` has no
  branded version of the three new ones: they go out in the plain template.
  On a hosted (OIDC) password reset the notice leaves through the space's own
  SMTP transport, as does the verification e-mail re-sent at hosted sign-in.
- **`POST /api/webhooks/{id}/test` sends a real request** (#1683): one signed
  `test.ping` to the webhook URL, single attempt, listed in its deliveries and
  recorded as a `webhook.test_sent` audit event. A delivery whose hostname does
  not resolve is retried up to its third attempt
  (`Delivery target hostname could not be resolved`) instead of failing for
  good on the first. Without Redis, cron schedules now fire on the minute
  rather than up to 30 s late.
- **BREAKING (API): deleting the default space answers
  `409 default_space_not_deletable`** (#1680), was `400 invalid_request`.
  Every refusal of `DELETE /api/spaces/{id}` that is about the space's state
  is now a named 409.
- **`GET /api/orgs` and `GET /api/spaces` have a defined order** (#1680).
  Organizations are listed oldest membership first (there was no order: a
  rename moved an organization). Spaces are listed default first, then
  personal spaces, then team spaces, each oldest first (a personal space was
  ranked by its creation date, a different place for each member).
- **BREAKING (API): six refusals answer with their own problem `code`, and a
  taken package identifier is always a 409** (#1677). A client that branches on the old
  value must follow; `detail`, `param` and the other statuses are unchanged.
  - `POST /api/orgs` with `AUTH_DISABLE_ORG_CREATION` set, for a caller who
    is not a platform admin: 403 `forbidden` → 403 `org_creation_disabled`.
  - Schedule create/update with an invalid cron expression: 400
    `invalid_request` → 400 `invalid_cron_expression`; with a timezone that
    cannot be scheduled against: → 400 `invalid_timezone`; with an actor who
    cannot fire it: → 400 `schedule_actor_invalid`.
  - Model create/update/seed with a model outside its provider's catalog
    offer: 400 `invalid_request` → 400 `model_not_offered`.
  - Webhook create/update with a target on a private or reserved network:
    400 `invalid_request` → 400 `blocked_url` (the code `/api/proxies`
    already used).
  - `name_collision` was a 400 or a 409 depending on which check met the
    taken identifier. It is now **409** everywhere: package create
    (`POST /api/packages/{type}`), fork, and the import routes (a system
    package's identifier, or one owned by another organization).
  - A model or proxy connection test that is refused at the TCP level
    answers `TestResult.error: "CONNECTION_REFUSED"` (was `NETWORK_ERROR`).
- **BREAKING (CLI): one process reads the Pi model registry, the API** (#1706).
  It hands every model builder the record's _dialect_ (`name`,
  `thinkingLevelMap`, `compat`) next to the limits, modalities, reasoning and
  price it already resolved. The agent container reads it from `MODEL_DIALECT`,
  the sidecar from `PI_MODEL_SWAP_JSON` (`backing.dialect`), the chat and the
  CLI from `pi_dialect` on `GET /api/models` (opaque, `null` for a gateway and
  for an alias). None of them looks a model up, so a model's dialect does not
  depend on which Pi registry an image or a CLI was built with; the request is
  still serialized by each one's own Pi code. The field is required wherever a
  Pi provider is named (`null` when Pi keeps no record), and a consumer handed a
  provider without it refuses instead of building the model bare: the container
  and the sidecar at boot, `appstrate run --model-source preset` before any
  call. A preset run therefore needs the CLI and the instance at the same
  version. `ModelSwapBacking.dialect` is a required field of `@appstrate/core`:
  its next release is a major. Plan: `docs/plans/live-model-catalog.md`, step 1.
- **`claude-sonnet-5-5` replaces `claude-sonnet-5` among the featured models**
  of the `anthropic` and `claude-code` providers (#1705), now that the pinned
  Pi registry (`@earendil-works/pi-ai` 1.0.4) records it; existing
  `org_models` rows are untouched and `claude-sonnet-5` stays in the offer.
  OpenCode Go no longer features `kimi-k2.6`, `glm-5.1`, `qwen3.7-max`,
  `qwen3.7-plus` and `qwen3.6-plus`, which left its offer. The registry also
  adds `gpt-6.1-sol` (`openai`, `codex`).
- **`claude-opus-5-5` replaces `claude-opus-5` among the featured models** of
  the `anthropic` and `claude-code` providers (#1642), now that the pinned Pi
  registry (`@earendil-works/pi-ai` 0.87.1) records it. Featured ids are
  seeded into `org_models` on a provider's first connection, the first one
  becoming the default of an org that has none, so a first Claude Code
  connection now defaults to Opus 5.5. Existing `org_models` rows are untouched; `claude-opus-5` stays in
  the offer.
- **BREAKING (API): the credential and LLM proxies answer their own failures
  with stable problem codes** (#1641). Credential proxy:
  `unauthorized_target`, `blocked_target`, `credential_exfiltration_refused`
  (403), `credential_not_found` (404), `unresolved_placeholder` (400). LLM
  proxy: a model whose upstream resolves into a blocked range is
  `403 blocked_target` (was `400 invalid_request`). Both: an upstream that
  cannot be resolved or reached (on the credential proxy, the target or a
  redirect hop) is a 502 (`upstream_unresolvable`, `upstream_unreachable`), a
  timeout a 504 (`upstream_timeout`); was a 500.
- **BREAKING (API): the credential and LLM proxies mark every response with
  RFC 9209 `Proxy-Status`** (#1641): `appstrate; received-status=<n>` on a relayed
  upstream response, `appstrate; error=<type>` on the proxy's own. A relayed
  upstream 401 no longer carries the platform's `invalid_token` challenge.
- **BREAKING (OpenAPI): the LLM proxies document a relayed upstream error as
  `default`, not `502`** (#1641). They relay a provider error at the
  provider's own status, told apart from the proxy's own problem document by
  `Proxy-Status: appstrate; received-status=<n>`, and document the 402 a
  metering module's `beforeUsage` hook can answer.
- **BREAKING (API): the LLM proxy reports its cache outcome as RFC 9211
  `Cache-Status`** (#1641): `appstrate-llm-proxy; hit` on a cached reply,
  `appstrate-llm-proxy; fwd=uri-miss; stored` on a stored miss.
  `x-llm-proxy-cache-status` is gone.
- **BREAKING (API): the three api_call paths share one outbound
  implementation** (#1641).
  The platform credential proxy, the sidecar and `appstrate run` follow
  redirects under one rule: an origin the `authorized_uris` allowlist names
  keeps the credential (Dropbox `api.` to `content.`), any other origin change
  strips it, and an https→http hop never carries it. Every hop is SSRF-checked
  and connected to its DNS-validated address, except a host exempt from the
  SSRF gate (#1657, under Security). One 30 s deadline bounds every
  call (`appstrate run` had none), and the sidecar answers a timeout 504 like
  the platform proxy (was 502). A streaming upload's redirect is returned
  unfollowed.
- **BREAKING (manifests): one template grammar per concept, and nothing
  unrendered reaches an upstream** (#1641). Every delivery template (`http`,
  `env`, `files`) renders `{$credential.<field>}` and nothing else: the
  `{$outputs.*}` or any other `{$…}` there is refused when the manifest is
  written and throws at render, so `appstrate run` on a bundle that skipped
  validation fails instead of sending it as text. `authorized_uris` likewise
  refuses, when written, any `{$…}` but `{$credential.<field>}`. A stored
  manifest holding one still loads. A
  connect output is referenced as `{$credential.<name>}`, the jwt extractor's
  `token` included; login inputs are `{{name}}`.
- **BREAKING (API): an integration OAuth client is updated with `PATCH`, and
  its `client_id` can no longer change** (#1641). `PATCH` replaces the `PUT`
  of `/api/integrations/{packageId}/oauth-clients/{clientId}` and of
  `/api/org-integrations/{scope}/{name}/oauth-clients/{clientId}`
  (`updateIntegrationOAuthClient`, `updateOrgIntegrationOAuthClient`); an
  absent field is left unchanged (`null` clears `redirect_uri`), a `client_id`
  is a 400. The audit action `integration.oauth_client.rotated` is now
  `integration.oauth_client.updated`; create/update/delete rows record the
  client before and after (never its secret).
- **BREAKING (API): OAuth clients name their owning tier** (#1641).
  `GET …/auths/{authKey}/clients` returns `source: "system" | "org" | "space"`
  instead of `"built-in" | "org" | "custom"`, where `custom` meant the space.
- **BREAKING (API): member pins are addressed by path, like admin pins**
  (#1641). `PUT` and `DELETE`
  `/api/me/integration-pins/{agentPackageId}/integrations/{integrationPackageId}`
  take both ids in the path; the PUT body is `{ connection_ids }` alone.
  `GET /api/me/integration-pins?agent_package_id=` is unchanged. A member-pin
  write by an end-user, which has no member pins, is a 403 `forbidden`, not a
  401 with an `invalid_token` challenge: its key is valid.
- **BREAKING (API): one name per role across the pin and connection family**
  (#1641). The agent is `agent_package_id` and the integration
  `integration_package_id` on `IntegrationPin`, `IntegrationConnection`,
  consuming agents, connection readiness, the `connections[]` of
  `GET /api/me/context` (was `integration_id`) and the run's
  `connections_used`, whose `label` and `account_id` are always strings and
  `source` the cascade layer enum.
- **BREAKING (MCP): `read_skill` returns a binary file as an embedded
  resource** (#1641). The `content_base64` field is gone; the bytes arrive as
  a `resource` content block with `blob`, whose `uri` is the file's REST
  content URL.
- **BREAKING (API): the Stripe webhook receiver answers its refusals as RFC
  9457 problem documents** (#1641). `POST /api/billing/webhooks` answers
  `400 invalid_request` for a missing or invalid `stripe-signature` and
  `500 internal_error` instead of plain text; Stripe reads only the status.
- **BREAKING (API): the OAuth endpoints' 429 is a standard OAuth error**
  (#1641):
  `/api/auth/oauth2/*` answers `Retry-After` and a JSON body with
  `"error": "temporarily_unavailable"` instead of Better Auth's
  `X-Retry-After` and untyped `{message}`. The code is the one RFC 6749
  §4.1.2.1 defines for the authorization endpoint, reused on the token
  endpoint.
- **Notification kinds are a declared union** (#1641). `GET /api/notifications`
  items are a `oneOf` on `type` (`run_completed`, `package_shared`) with a
  typed payload each, and the database refuses any other kind.
- **`runs.model_source` is the `credential_source` enum** (#1641): the
  column, the run DTO and OpenAPI accept only `system`, `org` or `null`, and
  the CHECK `runs_remote_has_no_platform_model` forbids a model source, model
  id or inference route on a remote-origin run. The runner ledger no longer
  coerces an unknown source to `null`, which silently switched a run to
  pass-through pricing.
- **The sidecar refuses a malformed `RUNTIME_TOOLS_JSON` or `OUTPUT_SCHEMA`
  at boot** (#1641) instead of silently dropping the runtime tools or the
  output schema; a connect run without a 32-byte `CONNECT_RESULT_KEY` fails
  its env validation.
- **BREAKING (API): the retired `X-Integration` header is no longer
  stripped** by the credential proxy or the sidecar (#1641); it reaches the upstream like any
  other header.
- **An integration cannot name itself as its MCP server** (#1675): a manifest
  write refuses an integration whose `source.server.name` is the integration
  itself, which could never resolve and failed every run with
  `mcp_server_unresolved`. A stored manifest holding one still loads.
- **The import 409s `draft_overwrite` and `integrity_mismatch` name what the
  import would overwrite** (#1675), as RFC 9457 extension members:
  `packageId`, plus `active_version` on `draft_overwrite` (`null` when the
  draft declares none) and `version` on `integrity_mismatch`, or on a
  `draft_overwrite` whose published version of that number also differs.
- **An OIDC client's `https://<x>.localhost` redirect URI is refused**
  (#1748), like `https://localhost` already was, now that every `*.localhost`
  name is a blocked host. `http://<x>.localhost` is still accepted as
  loopback (RFC 8252 §7.3).
- **The repository requires Bun 1.3.14 or later** (#1654): the root
  `engines.bun` moves from `>=1.3.9` to `>=1.3.14`, the version CI, the
  Dockerfile and `packageManager` pin, and the root test preload refuses an
  older Bun. Published packages keep their own `>=1.3.9`.
- **`@appstrate/afps-runtime`, `@appstrate/runner-pi` and
  `@appstrate/module-chat` are private workspace packages** (#1641). No
  release of them was ever published (npm holds only a
  `@appstrate/afps-runtime@0.0.0` placeholder); the dead `publishConfig` is
  removed.

### Added

- **`GET /api/profile` reports `can_create_org`** (#1680): whether
  `POST /api/orgs` would accept the user — true on an open instance, and for
  platform admins alone under `AUTH_DISABLE_ORG_CREATION`. The dashboard
  routes on it, so the `orgCreationDisabled` flag is gone from
  `window.__APP_CONFIG__`.
- **`GET /api/me/context` names the space it resolved** (#1721): the payload
  (the MCP `get_me` tool) carries `space: { id, name, personal }`, the space
  every list in it is scoped to. An agent holding a key bound to an empty space
  could not tell an empty space from the wrong one. The descriptions also say
  an empty list can mean the caller's permissions do not cover it. Run and
  model `cost` descriptions in the OpenAPI spec now state USD instead of
  "dollars" or no currency; no wire field changes.
- **Live model catalog, read side** (#1717, #1732): a process accepts a file
  only on its Ed25519 signature (public key in the source), its exact Pi SDK
  version, a strict shape and a `serial` not lower than the one it holds, then
  keeps the records whose dialect the pinned Pi code already knows (provider
  and API shape together, compat keys, non-boolean compat values, thinking
  levels and their effort words). It only adds models an organization can bind
  with its own credentials: bundled ids, featured ids and system models (boot
  rules, price, limits and dialect) read the bundled registry, and a
  subscription provider is offered no model with a price tier one request can
  reach. The file lives in memory: a model bound from it runs without its
  catalog defaults until a restarted process has read the channel. The channel
  cannot forge a file or roll a running process back; it can withhold a newer
  one. Plan: `docs/plans/live-model-catalog.md`, step 2.
- **Live model catalog, producer** (#1731): `scripts/build-model-catalog.ts`
  and `.github/workflows/publish-model-catalog.yml` build, every six hours and
  per Pi version in use, the file instances read. Of the latest Pi package
  only JSON data is read. A record is published when an instance would keep it,
  every field and endpoint Pi gave it is one a bundled sibling has, and the
  pinned code builds its request at every thinking level; the signed file is
  read back as an instance reads it before anything is pushed. The workflow
  signs with the repository secret `MODEL_CATALOG_SIGNING_KEY`, the seed of
  the key pinned in `model-catalog-overlay.ts`.
- **A schedule the system disabled says why** (#1641). `disabled_reason`
  (`actor_invalid`, `actor_left_org`, `connection_deleted`) is set by the
  system act, cleared on re-enable and `NULL` otherwise: on an enabled
  schedule (CHECK) and on one a person paused. It is on the schedule DTO and
  shown on the schedule badge and detail page. Deleting a connection a
  schedule overrides disables only an enabled schedule; one already disabled
  keeps its reason.
- **Credential-proxy use of another member's connection is audited** (#1641).
  The first call of an `X-Session-Id` through a connection the caller does not
  own writes one `integration.connection.proxied` row per acting principal
  (`principalType`, `principalId` in `after`); the call log names the
  connection used. A call that fails after the credential may have left
  (timeout, unreachable upstream, refused redirect) is audited like one that
  returns; one refused before sending is not.
- **Platform MCP tools return structured output** (#1641). Every JSON result
  carries `structuredContent` beside its text block (MCP 2025-06-18); an error
  carries the text only.

### Fixed

- **A failed connection-use audit write is retried on the session's next
  call** (#1753): the dedupe key is released when the write fails.
- **Byte sizes render in English on a malformed locale tag** (#1753) instead
  of failing the page.
- **Disabling the default model and making a disabled model the default can
  no longer both succeed** (#1749): the two writes take the same row lock, so
  one of them answers 409 `model_disabled`.
- **A refused mutation shows one error toast, not two** (#1752), and detail
  pages no longer show an error state while a retry is in flight. The
  connection delete confirmation waits for its impact before it can be
  confirmed.
- **The chat interface is translated** (#1752): its remaining French-only
  strings follow the interface language.
- **The chat no longer re-creates a deleted conversation** (#1682). Its URL
  showed the empty welcome screen with a live composer, and the first message
  sent there re-created the conversation under its old id; a conversation
  that is deleted or not the caller's now reads as not found. The model
  picker no longer stores the organization's default as the user's pick, so
  a changed default reaches everyone who never chose a model. Deleting a
  conversation asks for confirmation, a reader (`chat:read` only) is no
  longer offered "New conversation", and every failed turn carries a request
  id, the chat request's own when the upstream named none.
- **The self-hosting compose files forward the variables the docs and the
  installer set** (#1726). `AUTH_BOOTSTRAP_TOKEN`, which the installer writes
  to `.env`, and `EGRESS_ALLOW_INTERNAL_HOSTS` reached no container, so `/claim`
  could not find the token. The tier templates also dropped SMTP, Google and
  GitHub sign-in, run limits, proxies and a few others the root file forwards.
  All are bare passthroughs: an unset variable stays unset.
  `deploy/docker-compose.yml`, which loads `.env` whole, is not affected.
- **A subscription pairing token minted on a `*.localhost` instance is
  accepted** (#1648), as loopback (RFC 6761 §6.3). It needs
  `@appstrate/connect-helper` 0.3.1.
- **A gateway model declared reasoning takes a reasoning level** (#1736). An
  `openai-compatible` or `anthropic-compatible` model created with
  `reasoning: true` offered no level, not even `off`: every one was refused
  with `reasoning_level_unsupported`, and its runs always reasoned at
  `medium`. It now takes `off`, `low`, `medium` and `high`, the set every
  reasoning backend accepts; `minimal`, which OpenAI's o-series and gpt-5.1+
  refuse, and `xhigh`/`max` stay refused, and an alias over it sends `low`
  for `minimal`. The default stays `medium`. On an `openai-compatible` model,
  `off` sends no reasoning parameter: the server keeps its own behaviour, and
  the level control says so.
- **The space authentication tab no longer offers to keep a stored secret**
  (#1725). With SMTP or a social provider already configured, the password
  or client secret field read "leave empty to keep the current one" and was
  optional, while saving always replaces the secret: an empty field failed
  with a raw validation error in a toast. The field is now required on every
  save, and its hint says the stored value is never displayed and has to be
  entered again.
- **An import no longer answers 201 for a version it does not create**
  (#1699). Importing a new version lower than the highest published one
  replaced the draft, published nothing and still answered 201. It is now
  refused before anything is written, with `409 version_not_higher`, forced
  or not. A bundle import refuses such a root the same way, and leaves such
  a dependency as the organization has it, with a warning.
- **A re-import onto an existing version no longer leaves the draft dirty**
  (#1675). Importing a version that already exists, identical or forced,
  kept the draft marked as holding unpublished changes, so every later import
  answered a spurious 409 `draft_overwrite`. When that version is the latest
  published one, the draft is now settled against it.
- **`/api/admin/storage-deletion-jobs` no longer asks for `X-Org-Id`**
  (#1713). The routes are instance-wide, so a platform administrator who
  belongs to no organization got a 400. A header that is sent is ignored.
  The operator guard is unchanged.
- **An aliased run backed by OpenAI keeps its output cap and temperature**
  (#1705). Pi 1.0 reads a credential that is not `sk-`-shaped as a ChatGPT
  sign-in and drops `max_output_tokens`, `temperature` and the cache
  retention; the sidecar's placeholder key matched.
- **Run guard-rails** (#1674). A double click on Run created two runs: the
  launcher now lets one launch through at a time. An agent whose `output` call
  is refused five times (an output schema no value satisfies, typically) is
  stopped and its run fails, instead of retrying one paid turn at a time until
  the run timeout — this ships in the runtime image. A run that falls back to
  a default model because the one pinned on its agent or schedule is no longer
  usable now says so in its log (`model_fallback`), and the run form and the
  agent's model setting warn about the unusable pin.
  On the agent page the two Run buttons share one verdict (the empty-list one
  stayed live for an agent switched off or without a model), a caller with
  `agents:run` but not `agents:read` no longer reads "the prompt is empty",
  "no default model" is told apart from "no model", and the reason a button is
  disabled shows on hover. The API tab documents the real response (201 and
  the run, field `id`). Timed-out and cancelled runs show their cause on the
  run page; an unnamed schedule no longer reads as its raw id; memory rows are
  deleted behind a confirmation and only by a caller holding
  `persistence:delete`; integer launch fields are numeric inputs and the
  duplicated error summary of the launch form is gone.
- **The magic-link e-mail works on an instance that does not load the `oidc`
  module** (#1673). Its link always pointed at the module's confirmation page
  and answered 401 without it; it now points at a confirmation page of the
  dashboard (`/magic-link/confirm`), whose button is what spends the one-time
  link — a mail scanner that opens the link does not. A spent or expired link
  returns to `/magic-link` with a message. The `allowedAttempts` option, which
  the installed Better Auth ignores, is gone; the hosted "check your inbox"
  page announced a 7-day validity for a link that lives 15 minutes.
- **Sign-up from an invitation returns to the invitation after e-mail
  verification** (#1673): the verification link carried `/`, and the invitee
  landed on "create your organization"; the link re-sent when an unverified
  account signs in from the invitation carries it too. Also in the built-in
  sign-in pages:
  signing in to an unverified account opens the "check your inbox" screen
  instead of a raw `Email not verified`; a verification link that is invalid
  or expired says so; `/verify-email` opened on its own redirects to
  `/login`; and changing one's e-mail to an address already in use no longer
  reports success. Signing in from an invitation reloads the invitation page
  (Better Auth's client follows the `callbackURL` it is given).
- **The dashboard no longer offers what the server refuses around spaces**
  (#1680). In a personal space the Members, API keys, end-user OAuth clients
  and End-Users pages are not there (each write behind them was a 409), and a
  personal space is no longer listed in an invitation's or an OAuth signup
  policy's space assignments (400). The space selector of the space settings
  listed closed spaces the caller cannot enter and fell back silently; it now
  shows the same list as the sidebar. On an instance where organization
  creation is disabled, `/onboarding/create` and "create organization" are
  shown only to those who may create one, and a platform admin without an
  organization lands on the creation form. The last space used in each
  organization is restored after an organization switch and after sign-out.
- **Accepting an invitation says whether it created the membership**
  (#1676). `POST /invite/{token}/accept` now returns `created`. For a caller
  who was already a member it is `false`, and `role` / `permissions` are those
  of the role they keep; the response used to echo the invitation's role, so
  the dashboard told an existing member they had been promoted.
- **The dashboard no longer hides a failure** (#1676). An expired session
  lands on the login screen instead of rendering empty lists, every refused
  write produces one message, a 4xx is no longer retried behind a spinner, a
  changed role or a lost space is picked up without a reload, and a resource
  the caller cannot read shows one "not found or not accessible" panel.
- **An `api_call`'s target, headers and body templates are checked the same
  way on the three paths** (#1660). The platform proxy, the sidecar and the
  local resolver of `appstrate run` each checked and substituted them in
  their own order; one function now does it (`prepareApiCallRequest`,
  `@appstrate/afps-runtime`). What a caller sees:
  - `appstrate run --integrations=local` repairs an `Authorization` header
    written `Bearer{{field}}` (no space after the scheme), as the sidecar
    does; it was sent as `Bearerghp_…` and answered 401. Only a manifest
    that lets the caller override `Authorization` keeps that header.
  - One wording for a refused request, naming the first defect:
    `Unresolved placeholders in target|header "X"|body: {{a,b}}` (each key
    once) or `Header "X" is not a valid HTTP field value`. The sidecar said
    `in URL`; the local resolver listed every unresolved key of the call.
  - A defect of the request (an unresolved placeholder, a caller header
    value that is no HTTP field value) is reported ahead of a refusal by the
    URL policy. On the platform proxy it is also reported ahead of a
    credential no header can carry, when that credential sits in an earlier
    header or the defect is in the body (was 502 `credential_unusable`).
  - The local resolver judges a caller header value as written, first, as
    the two other paths do: `RESOLVER_HEADER_INVALID` ahead of the URL
    policy, of an unresolved placeholder elsewhere and of a body error, and
    also for a header it then replaces (the injected one, a `Content-Type`
    the body sets): that call used to go out without the caller's value.
  - In a run, a 401 is not replayed when the refreshed credentials no longer
    hold a field the call names, in its target, a header or the body: the
    replay used to send a header or a body with the literal `{{field}}`.
    The 401 is returned.
- **An OAuth refresh keeps the connection's other outputs** (#1629).
  Refreshing an integration connection rewrote its credential with
  `access_token` and `refresh_token` only, so a manifest reading
  `token_type`, `id_token` or `scope` worked after the connect and failed
  with an unresolved placeholder after the first refresh. A refresh now
  starts from the stored outputs and replaces what the provider returns.
- **The integration editor's default auth allowlist is the source host**
  (#1641): a new integration's `authorized_uris` starts empty and takes the
  remote source's host (`https://<host>/**`) as the URL is typed, until the
  author edits it. The former default, `https://**`, is what the host-bound
  rule refuses.
- **An upstream verdict is credited to the credential that earned it**
  (#1641). The sidecar reports a 401 or 2xx against the
  `credential_revision` its request carried, not the one held when the
  answer arrived. A response a redirect hop stripped the credential from
  (including a chain that comes back to the origin) is neither counted nor
  credited, on the sidecar and the platform proxy alike. A BYOK key is
  flagged only while its row still holds the rejected key. A count and the
  platform proxy's reset apply only while the caller still reaches the
  connection. `credential_revision` must be 16 hex digits (empty or malformed
  → `400`).
- **Credential proxy: two failures no longer end as a 500 or a spurious
  400** (#1641). A `{{word}}` inside a credential value was reported as an
  unresolved placeholder: placeholders are now looked up in the template. A
  relayed body that breaks off after its headers answers
  `502 upstream_unreachable` (or `504 upstream_timeout`) naming the target
  host.
- **A rejection or a success counts against the credential that saw it**
  (#1641). The integration credentials payload carries `credential_revision`,
  a short digest of the stored ciphertext, which the sidecar sends back on
  `/refresh` and `/upstream-success`: a 401 on a credential the connection no
  longer holds is not counted and gets the current credential back (`200`),
  and a success on a replaced credential no longer ends the new one's streak.
  A connection already flagged keeps its count; `/upstream-success`
  refuses a connect run (`409 connect_run_no_refresh`); and the remote-HTTP
  transport no longer reports a success from an origin a redirect took the
  request to.
- **An upstream that keeps rejecting an API key flags it; 401s between
  successful calls no longer do** (#1641). A credential that cannot refresh
  (api_key, basic, custom, OAuth2 with no refresh client) is flagged
  `needs_reconnection` at the `INTEGRATION_REFRESH_MAX_FAILURES`-th
  CONSECUTIVE upstream 401, however far apart; an OAuth2 connection holding
  no refresh token is not counted, and its first 401 flags it (`410`), as
  before. Any successful (2xx) call
  through a non-OAuth2 connection ends the streak; an OAuth2 connection's
  count is cleared only by a credential write (a reconnect, or a successful
  refresh), never by a 2xx. Two counts therefore run until a reconnect: an
  OAuth2 connection whose refresh cannot run (no resolvable client or token
  endpoint), and a local MCP server reporting rejections through the
  `dev.appstrate/credential: rejected` tool-result meta (e.g. `@appstrate/ssh`),
  which has no success signal. Every path counts and resets: the platform
  credential proxy (CLI, GitHub Action), which counted none before and
  flagged an OAuth2 connection without a refresh client on its first 401, and
  the sidecar's `api_call`, MITM egress and remote-HTTP sinks, which report
  the first success after a counted rejection to
  `POST /internal/integration-credentials/{scope}/{name}/upstream-success`
  (the credentials GET payload announces a pending streak as
  `rejection_streak`). For an API-key integration connection that replaces a count since the last
  reconnect; a revoked BYOK model key, never flagged before, is counted the
  same way through the LLM proxy, which a 2xx resets, and stops inference
  until it is re-entered. An OAuth2 subscription keeps its own counter, the
  refresh streak, which a successful refresh resets. The refresh `502` now
  reads `N/M consecutive upstream rejections before it is flagged`.
- **An OAuth client update that sends a new `client_secret` without
  `token_endpoint_auth_method` keeps the stored method** (#1641); it reset
  the client to the manifest's method. A public client (`none`) given a
  secret takes the manifest's method.
- **BREAKING (API): a `connection_overrides` key the agent does not declare
  is a 400** (#1641). It was dropped without a trace, and a schedule froze it onto its
  row, so the run bound a lower cascade layer instead of the account asked
  for. It is refused on the agent run, the inline run and `/inline/validate`,
  on schedule create, and on a schedule update that changes
  `connection_overrides` or `version_override`.
- **Audit rows record the whole change** (#1641). `schedule.created` records
  every override; `schedule.updated` records before and after of only the
  fields the write changed, including the connection-override reset an actor
  change implies, and a write that changes nothing records no row. A
  placement `PATCH` writes `package.placement.updated` for `modelId`,
  `proxyId` and `generationConfig`. Pin and org-default writes record
  `before`; admin and member pin rows share one `resourceId`.
- **BREAKING (manifests): `connect.login` reads the regex extractor's
  `source`** (#1641):
  `$response.body` or `$response.header.<name>`; it was ignored. An
  expression, selector or criterion context the engine cannot evaluate is
  refused when the manifest is written and fails the login as `invalid_config` instead of
  silently not matching.
- **BREAKING (config): a UUID-shaped system id is refused** (#1641). Such an
  id would take precedence over an organization's own row with the same id.
  A system OAuth
  client with one fails boot; a `SYSTEM_PROVIDER_KEYS` entry whose key or
  model id is UUID-shaped is skipped and logged, like any other invalid entry.
- **Every error response in the OpenAPI document declares its body**
  (#1641), and `verify:openapi` §6b enforces it: `application/problem+json`
  (`ProblemDetail`), or the media type a reviewed exemption names (Better
  Auth's OAuth endpoints, HTML pages, the health report, proxied upstream
  responses).
- **The root `zod` override no longer pins below the declared floor** (#1641).
  `overrides.zod` moves from 4.5.4 to 4.6.5, the version every workspace
  declares; `verify:overrides` (in `bun run check`) fails when an override
  does not satisfy a declared range.

### Security

- **A bundle import cannot take a dependency another organization owns**
  (#1749): a package created by another organization after the import's
  preflight is a 409 `bundle_conflict`, never a "reused" dependency naming
  that organization's latest version.
- **A connect-login secret is bound like an injected credential** (#1751):
  the MITM listener refuses (403) a login request a secret would be
  substituted into when the auth's `authorized_uris` leaves the host to the
  caller.
- **Every `*.localhost` name is a blocked host** (#1748), like `localhost`
  itself (RFC 6761 §6.3); `EGRESS_ALLOW_INTERNAL_HOSTS` still lifts it.
- **The sidecar's forward proxy logs a request target as origin + path**
  (#1751), never its query string.
- **A cookie captured over https is never sent to a non-https URL** (#1753).
  After an https → http redirect on a host the allowlist names for both
  schemes, the sticky-cookie jar re-added the session cookies the downgrade
  had stripped.
- **A bundle import whose root is below its highest published version is
  refused before anything is written** (#1753): the 409 `version_not_higher`
  came after the dependencies ordered ahead of the root were inserted.
- **An invalid `PROXY_URL` is not logged** (#1753): it can carry credentials.
- **No session manages OAuth clients through Better Auth's client endpoints**
  (#1754). `/api/auth/oauth2/create-client`, `get-client(s)`,
  `update-client`, `client/rotate-secret` and `delete-client` answer 401 to
  every session; platform clients are managed through the org and space
  OAuth client routes. Unauthenticated dynamic registration is unchanged.
- **The chat's Pi runtime no longer reads the host's Pi CLI credentials**
  (#1646). Without a credential store of its own it opened the default one
  (`~/.pi/agent/auth.json`), where a credential outranks the key the platform
  registers: a `pi` login on the API host answered in place of the
  organization's subscription. Each turn now gets an empty in-memory store.
- **Dependency advisories**: `proxy-addr` and `source-map-js` patched (#1696);
  the `braces` advisory accepted for the dev tree only, until 2026-12-31
  (#1654).
- **Better Auth 1.7.7** (GHSA-965c-763c-88jm, critical; #1734, #1743, #1742).
  Before it, an OAuth sign-in state value was accepted as a magic-link token:
  anyone who knew an address could start a Google or GitHub sign-in for it and
  finish a magic-link sign-in to that account without reading its mail, or
  create it marked verified. The platform enables the magic link whenever the
  instance `SMTP_*` variables are set and keeps OAuth state in the database,
  so an instance with them and working Google or GitHub credentials (the
  instance's or a space's) was exposed. `better-auth`, `@better-auth/core`,
  `@better-auth/oauth-provider` and `@better-auth/cimd` move together, as the
  advisory requires. Better Auth's rate limiter now answers its 429 as JSON,
  declared on the four Better Auth routes of the spec.
- **MCP TypeScript SDK 1.32.1** (GHSA-6qxp-vccf-f47h). The SDK's OAuth
  client could send credentials to an authorization server chosen by the MCP
  server. The platform does not use that client; the bump clears the audit.
- **An account the environment names needs proof of ownership** (#1707).
  The account of `AUTH_BOOTSTRAP_OWNER_EMAIL` or of an
  `AUTH_PLATFORM_ADMIN_EMAILS` address is created by the bootstrap token, a
  provider-verified social sign-in or a magic link, never by the sign-up
  form, and no existing account can change its e-mail to such an address.
- **A space's own SMTP server carries auth e-mails only to that space's
  accounts** (#1707), or to an address with no account that the environment
  does not name. Any other mail is withheld; the page answers as before.
- **A magic link signs in an account of the audience it was issued for**
  (#1707): the client's when a hosted sign-in page issued it, else the
  platform's. A refusal redirects with `error=signup_disabled` and leaves the
  account untouched; a link whose client was deleted or disabled is refused
  too.
- **A pending-client cookie left in the browser binds nothing** (#1707): a
  magic link or a sign-up asked from the dashboard creates a platform
  account.
- **A Google or GitHub identity is attached to an existing account only
  when the provider asserts its e-mail as verified** (#1707), and a new
  Google account is created verified only on that same assertion.
- **`/claim` answers a refused account creation as a `403` with the
  refusal's code** (#1707), with or without SMTP, instead of a `500`.
- **An `api_call` reaches an internal host only when the manifest and the
  operator both allow it** (#1657). The three paths disagreed: a run's
  sidecar skipped the SSRF gate for any host `authorized_uris` named
  literally, so a manifest's author chose which addresses of the operator's
  network a run reached, and a public name made to resolve there passed
  unchecked; the platform proxy skipped it for any
  `EGRESS_ALLOW_INTERNAL_HOSTS` host, including one picked by the agent
  under `allow_all_uris` or by a redirect. One rule now lives in
  `fetchApiCall`: the manifest names the host literally (never
  `allow_all_uris`, a wildcard or a rendered entry) AND the operator of the
  network allows it — `EGRESS_ALLOW_INTERNAL_HOSTS` on the sidecar and the
  platform proxy, always on the local resolver of `appstrate run`, where the
  network is the caller's own. `internalHost` is required: a new caller
  cannot inherit an exemption by omission.
- **The MITM listener connects each upstream request to the address it
  validated** (#1658). It checked the address the SNI host resolved to at
  CONNECT, then let `fetch` resolve the name again: a name answering a public
  address first and an internal one next reached the internal one. Each
  request now goes through `guardedFetch`, which resolves, checks and
  connects to that address, the name kept on `Host` and the TLS identity. A
  host resolving into a blocked range at request time is a 403
  (`target blocked by SSRF policy`); one that no longer resolves, a 502.
- **A credential no HTTP header can carry is refused, never quoted** (#1641).
  A stored or rendered credential holding CR, LF, NUL, another control
  character or a character above U+00FF made `Headers` throw an error quoting
  the value. Every path now checks the value first (`isHttpFieldValue`): the
  platform proxy answers `502 credential_unusable`
  (`Proxy-Status: …; error=proxy_configuration_error`) naming the header
  only, the sidecar a 502 (a caller's own invalid header a 400), the CLI
  `RESOLVER_HEADER_INVALID`, the MITM listener a fixed 403. The proxy route
  logs an unexpected error's name only; the MITM listener answers any
  unexpected throw with a fixed 500, never serves the runtime's development
  error page, emits error classes instead of messages, and its events name
  the path before login substitution, without the query.
- **The target host an `api_call` message names is read from the target
  template** (#1641). Messages show the template's host with `{{field}}` in
  place of each rendered part (`<templated>` when it does not parse); a
  literal host is shown as written. Redirect hops keep the value scrub.
- **A process-mode sidecar binds loopback only** (#1641). Its MCP server and
  the agent's forward proxy listened on every interface; the process
  orchestrator now sets the sidecar env `LISTEN_HOST=127.0.0.1` and probes
  its ports there. Container and VM sidecars keep binding all interfaces.
- **`/upstream-success` resets a streak only while the run can still reach
  the connection** (#1641). The reset is one UPDATE scoped by integration,
  space and the run actor's own-or-shared access; a run with no actor, or
  whose actor lost access, resets nothing.
- **The CLI's `api_call` hop to the platform applies the same caller-header
  rule as every other path** (#1641). The agent's `Host`, hop-by-hop,
  `Connection`-named and `Content-Length` headers no longer ride on the CLI's
  request to `/api/credential-proxy/proxy` beside its bearer token; a streamed
  `{ fromFile }` upload always carries its real size, and the transport hints
  (`X-Stream-Request`, `X-Stream-Response`, `X-Max-Response-Size`) are set by
  the CLI, never by the agent.
- **An `api_call` tells the caller's input apart from the credential**
  (#1641). The sidecar, like the platform proxy, looks for unresolved
  placeholders in the template, so a `{{word}}` inside a credential value is
  no longer named in a 400. The platform proxy answers a caller header value
  that is no HTTP field value `400 invalid_request` (was
  `502 credential_unusable`) and no longer forwards the caller's `X-Org-Id`
  upstream. A streamed body's `Content-Length` never comes from a caller
  header.
- **The MITM listener applies the host-bound credential rule to its replay
  too** (#1641). A request replayed after a credential refresh or a
  `connect.tool` re-login is checked like the first attempt: a credential
  whose auth leaves the host to the caller is never injected.
- **BREAKING (API): `api_call` forwards only end-to-end caller headers**
  (#1641). The shared
  outbound engine drops, on every path (platform proxy, sidecar, CLI), a
  caller's `Host`, the RFC 9110 connection-specific headers (`Connection`,
  `Keep-Alive`, `Proxy-Connection`, `TE`, `Trailer`, `Transfer-Encoding`,
  `Upgrade`, and any header `Connection` names, except the credential),
  `Proxy-Authorization`/`Proxy-Authenticate`, and `Content-Length`. The
  upstream's virtual host follows the target URL; the request framing is the
  one fetch computes, and a streamed upload is sent with the length of the
  platform request that carries it, else chunked.
- **The SSRF blocklist judges IPv4 addresses embedded in NAT64 and 6to4 IPv6
  addresses** (#1641): `64:ff9b::/96` and `2002::/16` are checked against the
  IPv4 blocklist like IPv4-mapped ones; the local-use `64:ff9b:1::/48` prefix
  is blocked. The SIIT IPv4-translated form `::ffff:0:0:0/96` is judged as its
  IPv4, and site-local `fec0::/10`, multicast `ff00::/8` and an IPv6
  literal that does not expand to eight groups are blocked.
- **BREAKING: an auth whose credential the proxy injects must name its
  hosts** (#1641). Manifest writes and imports refuse, on such an auth,
  `allow_all_uris`, no `authorized_uris`, or an entry that leaves the host to
  the caller; the platform proxy, the sidecar, its MITM egress and
  `appstrate run` refuse the same calls. One parser
  (`parseAuthorizedUriPattern`) reads an entry for this rule, the URL matcher,
  the runner egress policy and the literal-host pin that skips the SSRF gate.
  An entry is malformed when its authority (after `scheme://`, up to the
  first `/`) is empty, is not spelled as WHATWG serialises it (only case and
  a default port may differ), or holds `%`, `\`, `@`, `?`, `#`, whitespace, a
  control or non-ASCII character (`https://%2A%2A\**`, `https://@x:y@**/**`):
  it matches, grants and pins nothing, and counts as leaving the host to the
  caller. Otherwise an entry names its host only with a literal scheme, a
  non-empty host and no wildcard in its last two labels (not `https://**`,
  `https://*.com./**`, `**://…`), nor anywhere in an IP literal or an
  IPv4-shaped host, whose last label is numeric (not `https://[::**/**`,
  `https://*.0.1/**`, which matches `https://0x2d210001/`); a public suffix
  (`https://*.co.uk/**`) is not detected. List the hosts instead.
- **An `authorized_uris` scheme glob matches scheme characters only**
  (#1641): `**://api.example.com/**` no longer matches a URL on another host
  whose query holds `://api.example.com/`.
- **BREAKING (API): an `api_call` whose auth declares no `authorized_uris`
  and not `allow_all_uris` is refused on every path** (#1641). The sidecar used to
  relay it anywhere the SSRF gate allowed; the platform proxy answers
  `403 unauthorized_target`. An empty authorized set authorizes nothing (AFPS
  §7.9).
- **BREAKING (API): the credential proxy authorizes a call against the
  published integration manifest** (#1641). A call naming a run (`X-Run-Id`) reads the version that
  run froze at kickoff; any other call reads the `latest` published version,
  never the editable draft. An integration that was never published is
  refused: publish it before calling it through the proxy (`appstrate run`
  without `--report` included).
- **OAuth client secrets and upstream session cookies no longer sit in
  plaintext in Redis** (#1641). The OAuth connect state stores only the client
  reference, re-resolved at the callback like token refresh does; the
  credential-proxy cookie jar is encrypted with the connection-credential
  keyring. A connect started before the deploy fails at its callback and must
  be retried; a cookie jar written before it reads as empty.

## [1.0.0-beta.64] - 2026-09-30

### Operators

- **Two one-off scripts run before the drizzle batch, with the app container
  stopped** (`docker stop` — a Coolify stop takes the whole compose down,
  Postgres included, and prunes the images). From the release checkout, with
  the platform env loaded (`set -a && . ./.env && set +a`):
  1. `docker stop` the app container;
  2. `pg_dump` the platform database — the only rollback, so after the stop;
  3. `bun scripts/migration/0033-unshare-space-access-loss.ts --apply` — a dry
     run without `--apply`; refuses an empty `DATABASE_URL`;
  4. `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v ran_0033=1 -f scripts/migration/0032-connection-sets.sql`
     — PostgreSQL 16+, a UTF8 database; refuses without `-v ran_0033=1`;
     every "after" count must read 0;
  5. deploy: drizzle `0077` applies at boot and refuses the batch when a
     skipped `0032` left a scalar override or snapshot, or a duplicate label;
     schedule jobs held in Redis need no rewrite;
  6. reopen.

  `0033` unshares connections whose owner lost their space before the deploy;
  `0032` turns stored connection choices into sets, drops outranked schedule
  overrides, freezes the old fallback's shared picks as member pins and
  normalizes then deduplicates labels. Details: each file's header and its
  "Detail —" section in `scripts/migration/README.md`.

- **Deploy the platform and the runtime images (`appstrate-pi` /
  `appstrate-sidecar`) at the same version.** The internal credential routes
  now require the `connection_id` of a run-bound connection, which only this
  release's sidecar sends: an older sidecar gets `400` and its integration
  tools fail. Docker-mode dev hosts rebuild with `bun run docker:build:runtime`;
  Firecracker hosts must run the kernel and rootfs published with this release.
- **Before the window, find who loses an implicit shared connection** (the
  fallback now binds only the actor's own, see `### Changed`):
  - end-users own no member pins, so the freeze skips them: the standalone
    query at the end of `0032` lists the (space, agent, integration) triples
    whose end-user runs will answer `409 must_choose_connection` until the API
    caller passes `connection_overrides` or an admin pins a connection;
  - a space that blocks personal connections (`block_user_connections`) so
    that members fall through to an admin's shared connection must make it the
    org default (`PUT /api/integrations/{packageId}/default`).
- **Run `bun scripts/migration/0034-integration-url-allowlists.ts --apply`
  just before the deploy** (env loaded, it decrypts): it adds `api_url`
  (`https://<account_name>.api-us1.com`) to ActiveCampaign connections without
  one, which the running release ignores, and lists every ActiveCampaign,
  WordPress, WooCommerce and Webhooks connection whose URL field will have its
  calls refused (exit 1 while any remains: its owner fixes the URL, an
  ActiveCampaign account outside `api-us1.com` its `api_url`). Re-run the dry
  run after the deploy.

### Added

- **An agent can use several connections of one integration in a single run**
  — two SSH hosts, two mailboxes, up to 10 per declared integration. The tools
  do not change: when a namespace receives several connections, the sidecar
  adds a required `connection` parameter (an enum of their labels) to each of
  its tools and strips it before forwarding; a namespace with one connection is
  advertised as before. A tool declaring its own `connection` property fails
  the sidecar boot with `connection_param_conflict`. Each bound connection gets
  its own runner, credential, `api_call` cookie jar and `401` state. A set is
  spawned whole or not at all (`integration_dropped` reasons `no_delivery`,
  `bound_set_incomplete`). Under the `process` runner adapter, a connection
  declaring a `delivery.files` path another connection of the run already
  holds refuses to spawn, so an integration with a fixed file path (SSH's
  `/run/secrets/ssh_key`) binds several connections only under the `docker`
  runner adapter. A remote run (`POST /api/runs/remote`) binding
  several connections to one integration is refused with
  `409 agent_not_ready`.
- **`GET /api/me/connections/{connectionId}/delete-impact`** lists the
  caller's own member pins and schedules a delete would rewrite, `disables`
  marking the schedules it would disable; the delete confirmation shows them.

- **The chat shows the model's reasoning phase instead of a blank bubble**
  (#1601). The thinking dots disappeared as soon as the model started
  reasoning and nothing replaced them, so a reasoning model left an empty
  bubble until its first word: 3.2 s with a 3 s reasoning mock in Chromium,
  67 ms now. Each run of reasoning renders as a collapsed « Réflexion… » row
  with the dots while it is the tail of a running turn, then settles to
  « Réflexion » once text or a tool call follows, or once the turn is stopped,
  fails or is reloaded. The row expands to the reasoning as plain text. Models
  that emit no reasoning keep the dots, then the answer, as before.

### Changed

- **BREAKING (API): an integration binds a SET of connections.** Every field
  naming the connections bound to an integration is an array — one pick is a
  one-element array, a bare string is refused. Fields naming ONE connection
  stay scalar (a `409` item's `connection_id`, a `GET /api/me/connections`
  entry).
  - `connection_overrides` is `{ "@scope/integration": ["<id>", …] }`, 1 to 10
    distinct uuids (`400` otherwise), on agent runs, inline runs
    (+ `/validate`), schedules and the MCP `run_and_wait` tool, and in run and
    schedule responses.
  - A run's `connections_used` has one entry per bound connection, so
    `integration_id` may repeat.
  - Member pins (`PUT /api/me/integration-pins`), admin pins
    (`PUT /api/integrations/{packageId}/pins/{agentPackageId}`) and org
    defaults (`PUT /api/integrations/{packageId}/default`) take and return
    `connection_ids` instead of `connection_id`, and no longer carry
    `auth_key`. A write replaces the whole set; `DELETE` clears it.
  - Connection readiness (`integrations[].resolution`):
    `resolved_connection_id`, `admin_pinned_connection_id`,
    `member_pinned_connection_id` and `org_default_connection_id` become
    `…_connection_ids`; `resolved_owned_by_actor` is removed.
  - `GET /internal/integration-credentials/{scope}/{name}` and `/refresh`
    require `?connection_id=`, one the run bound (`400 connection_not_in_run`).
  - `@appstrate/core` and `@appstrate/afps-runtime` change their public types
    with it; see their `CHANGELOG.md`.
- **BREAKING (API): a connection label is required and unique per (space,
  integration)** across owners, compared verbatim: it is how a tool call
  addresses a connection.
  `PATCH /api/integrations/{packageId}/connections/{connectionId}` refuses a
  taken `label` with `409 connection_label_taken`, and with `400` one that is
  null, empty, padded with whitespace, or holds a control, invisible or
  bidirectional-override character (it reaches the model verbatim). A new
  connection takes its account id or the connect flow's hint, sanitized, else
  `Connexion N`, suffixed ` (2)`, ` (3)`… when taken, within 80 UTF-16 code
  units; a reconnect keeps it.
- **BREAKING (API): deleting a connection an admin pin or org default names is
  refused** with `409 connection_pinned`, like unsharing it, whether directly
  or by deleting the OAuth client that minted it. Either delete drops the
  connection from its owner's member pins and schedule overrides in the same
  transaction; a schedule left with no connection for an integration is
  disabled rather than fall back to another account. Any other set naming it
  fails its next run with `pinned_connection_unavailable` or
  `override_connection_unavailable`.
- **BREAKING (API): a connection serving none of the agent's selected tools is
  refused.** Bound by a pin, an org default or a launch override on such an
  auth, it answers `auth_serves_no_selected_tool` (with its `connection_id`) at
  kickoff, in readiness and at an enabled schedule's write; the fallback never
  picks one. An agent whose own `integrations_configuration.<id>.auth_key`
  names such an auth gets the new `auth_key_serves_no_selected_tool` (with
  `required_auth_key`, no `connection_id`, no connect offer) where it got
  `auth_key_mismatch` or `not_connected`; publishing or importing it is a
  `400`.
- **BREAKING: the fallback binds only the actor's single own connection**, on
  a serving auth, healthy or not (`needs_reconnection` rather than a silent
  switch). It used to bind the one healthy connection the actor reached, a
  colleague's shared one included, so an end-user could run on an employee's
  account. No own connection while shared ones exist, or several, is
  `409 must_choose_connection` for members and end-users alike: a shared
  connection binds only through an explicit pick. `candidate_connections[]`
  lists every connection on a serving auth, each with `needs_reconnection`.
- **BREAKING (API): connection readiness reports the resolver's verdict.**
  `GET /api/agents/{scope}/{name}/connection-readiness` replaces
  `integrations[].resolution.status` with `source` (the cascade layer that
  bound the set or whose set failed) and `error_code` (what the kickoff 409
  would carry), `null` when not applicable. The layers, in unchanged order:
  admin pin → enforced org default → launch override (`run_override` or
  `schedule_override`) → member pin → soft org default → fallback.
- **BREAKING (API): a launch override an admin pin or enforced org default
  outranks is refused, not ignored.** A run's or schedule's
  `connection_overrides` naming a connection outside the governing set is a
  `409 missing_integration_connection` item with the new code
  `override_outranked` — at kickoff, at an enabled schedule's write, and at a
  fire, which records a failed run. A subset of the governing set binds that
  subset.
- **BREAKING: a soft org default binds its whole set or fails**, like an
  enforced one: a member the actor cannot reach fails the run with
  `pinned_connection_unavailable` instead of being skipped for the fallback. A
  member pin or a launch override still beats it.
- **BREAKING (API): an enabled schedule cannot leave its connection choice
  open.** Writing a schedule that is (or stays) enabled resolves it as a fire
  would and answers `409 missing_integration_connection` for
  `must_choose_connection`, `override_connection_unavailable` or (its own
  overrides) `auth_serves_no_selected_tool`; other connection problems are
  still accepted. An actor who could never fire it (no `agents:run` in the
  space, outside the organization, an end-user absent from the space) is a
  `400` on `actor`, so such an enabled schedule cannot be updated until
  disabled or given another actor.
- **BREAKING (API): a schedule running as another member is an org owner or
  admin matter** (#738), from their own user session. Anyone else — a
  `builder`, a custom role, a space admin whose org role is `member`, any API
  key or OAuth / MCP client — gets `403`: on `actor` for naming another
  member, and on any `PATCH` or `DELETE` of a schedule already running as one.
  Such a write names and sees only connections shared in the space
  (`override_connection_unavailable` for any other id) unless it leaves the
  actor and that set unchanged; changing the actor resets the picks.
- **BREAKING (API): a pin or org-default target the caller may not pin is one
  `404`** — unknown, of another space or integration, not shared, or (member
  pin) neither own nor shared (`validatePinTargets`). Some were `400`, which
  told a colleague's private connection id from a made-up one; `400` now only
  refuses the set's shape.
- **BREAKING (API): the credential proxy applies the connection cascade.**
  `/api/credential-proxy/proxy` ignored the run's snapshot and, without
  `X-Connection-Id`, took the first accessible row, a colleague's shared one
  included. With `X-Run-Id` the call must name an in-flight run of the caller
  in this space (`404` unknown, `403` another actor's, `400` finished) and
  reaches only the connections it bound; several need an `X-Connection-Id`
  inside the set (`409 must_choose_connection`, `400 connection_not_in_run`).
  Without it: an enforced org default (`400 connection_not_in_org_default` for
  a name outside it), else the named connection, else a soft default, else the
  caller's single own connection; otherwise `409 must_choose_connection`, and
  `409 pinned_connection_unavailable` / `409 needs_reconnection` as for runs.
  The `401` retry refreshes the connection used, never re-selects. The cookie
  jar is per connection, and `@appstrate/afps-runtime` drops an `api_call`'s
  own `x-run-id` header.
- **BREAKING (CLI): `appstrate run` offers `api_call` only for the tools the
  agent selected** (`@appstrate/runner-pi`'s `buildApiCallExtensionFactory`),
  by the platform's rule: `tools`, else `default_tools`, `"*"` granting all. An
  agent that called an unselected `api_call` remotely must select it.

- **Entering a space costs one query instead of two** (#1601). Every
  space-scoped request, the MCP endpoint and the per-space `/api/spaces/{id}`
  routes looked the space up in the org, then read it again joined to the
  caller's membership. For a caller with an org role and no role preview, that
  second statement already filters on the org, so it is now the only one.
  `GET /api/me/context` also runs its package-access read beside the other
  listings instead of before them. Together, 115 to 150 ms
  off the chat's first visible token in the #1601 benchmark. Responses
  are unchanged, refusals included.
- **A chat turn's MCP handshake sends two requests to the platform, not four**
  (#1601). Each one pays the full pipeline: auth, a Redis rate-limit round
  trip, the space lookups and a server rebuild. The endpoint is stateless, so
  `notifications/initialized` (always a bare `202`) and the client's SSE `GET`
  (always a `405`) are now answered in the chat itself. Measured on the first
  visible token: 34 to 53 ms sooner.
- **A chat turn skips the MCP handshake when its permissions were seen before**
  (#1601). The server instructions and tool descriptors depend only on the
  permission list the turn's bearer carries, so the process caches them per
  list (64 lists at most, 5 minutes each) and opens the MCP client on the
  first tool call instead. On such a turn a broken MCP endpoint no longer fails
  the turn before the model is called: it surfaces as the error of the tool
  call that needed it, and the list leaves the cache, so the next turn
  handshakes up front and fails there, as before. Measured on the first
  visible token: 180 to 201 ms sooner
  (`mcpHandshakeMs` from ~200 ms to ~1 ms). The `chat turn construction` log
  line gains `mcpSurfaceCached`.
- **ActiveCampaign, WordPress, WooCommerce and Webhooks send their credential
  only to the connection's own URL** (#1627, #1628), no longer to any host
  (`allow_all_uris`). ActiveCampaign 1.0.3 adds a required `api_url`; prefer
  `{{api_url}}/…` in new prompts, while `https://{{account_name}}.api-us1.com/…`
  keeps working for accounts on `api-us1.com`. Webhooks admits its exact URL
  only, redirect hops included. A connection whose URL field does not qualify
  is refused when it is created or updated.

### Fixed

- **"Continuer" on the onboarding members step sends the invitation still
  typed in the email field** instead of dropping it; an invalid address shows
  the form's error and a failed invitation keeps the step.
- **The sidecar no longer warns on the expected `502` of a rejected API key.**
  The platform answers it on purpose while it counts the rejection; the report
  is still sent, and a failed OAuth refresh still warns.
- **Tier 0 dev no longer corrupts its PGlite database on a hot reload.**
  `bun --hot` opened a second PGlite on the directory the first still held; the
  instance now lives on `globalThis`, keyed by data directory.
- **A connection an admin pin or org default names says so before the
  refusal**: `locked_by` (`admin_pin` | `org_default` | `null`) on connection
  listings, and the integration page disables unshare and delete with the
  reason. Connection refusals are translated.
- **The credential proxy answers `Cache-Control: no-store`** instead of
  relaying the upstream's, so an HTTP client cannot replay one connection's
  response for another.
- **Deleting a connection from a browser session is audited**, in the
  connection's org, with the schedules the delete disabled.
- **A member who loses access to a space stops sharing their connections
  there.** Leaving or being removed from the organization, losing a space
  membership, a demotion or a space closing left their shared connections
  powering colleagues' runs. The access change now unshares them in the same
  transaction (`unsharedConnectionIds` on `org.member_removed`,
  `org.member_left`, `org.member_role_updated`); a pin or default still naming
  one fails with `pinned_connection_unavailable`. A racing share is refused
  with `409 connection_owner_without_access`. An `integrations:configure`
  holder may unshare a colleague's connection; sharing stays the owner's.
- **`PATCH /api/schedules/{id}` writes only the schedule it checked**: two
  concurrent patches could combine into a schedule running as a member on
  their private connection. It is a compare-and-set on `updated_at`, answering
  `409 schedule_modified_concurrently` when the schedule was written since it
  was read (a patch, a connection delete, a fire disabling it for an actor
  who lost access): reload and retry.
- **A schedule fire runs what the schedule row holds now.** The queue job
  carried a copy of the schedule taken when armed, so a stale job could fire a
  disabled schedule or replay replaced values; it carries only
  `{ scheduleId }`, and a fire skips a deleted or disabled schedule.
- **Runs on an `openai-compatible` model that is not aliased reach
  `/chat/completions` again** (#1600). The agent installed its credential with
  `setRuntimeApiKey`, which leaves Pi's builtin `openai` provider untouched,
  and that provider streams Responses only. So a gateway model's
  `openai-completions` call went out as `POST /responses`, and the sidecar
  refused it with `404 Not an inference endpoint`. Every provider is now
  registered as an overlay, which streams each model with its own api, as the
  chat engine already did. `appstrate run` shared the bug and the fix;
  aliased models and the chat were not affected.
- **The agent's forward proxy logs the runners it refuses** (#1548). It
  answered a runner peer with a 403 and wrote nothing, so the one runner-egress
  refusal missing from the sidecar log was this one; it now logs
  `forward proxy event` (`request-refused` or `tunnel-refused`,
  `reason: "peer-not-allowed"`, the target and the peer address), like the
  integration listeners.
- **The sidecar no longer warns `integration boot wait exceeded` on runs whose
  integrations booted in time** (#1548). The 30 s deadline was never disarmed,
  so every run that outlived it logged the warning operators are told to look
  for when an agent cannot see an integration.
- **Unicode tag characters (U+E0000–U+E007F) are stripped from third-party MCP
  tool descriptors** (`packages/mcp-transport/src/sanitize.ts`). They render
  as nothing yet reach the model, and the hidden-character filter compared
  UTF-16 units, so it could not match these surrogate pairs; it now walks code
  points. Connection labels, which share that filter, refuse and drop them too.
- **An integration's injected session cookie survives the credential proxy**
  (#1613). Delivered in `Cookie`, it was lost from the second call of an
  `X-Session-Id` through `/api/credential-proxy/proxy` on, once the upstream
  had set any cookie. The platform proxy and the sidecar now share one cookie
  jar: a cookie the upstream sets or rotates wins, a deleted one falls back to
  the injected value, and each redirect hop keeps its cookies to its own origin
  unless both hosts are literal `authorized_uris` entries. In-flight proxy
  sessions lose their stored cookies once at deploy.
- **Recreating a package, or republishing a deleted version's number, keeps
  its files** (#1612). When the successor was written before the deferred
  storage purge ran, the purge deleted its bytes: the draft fell back to
  `SKILL.md` + `manifest.json` and the version answered
  `422 version_artifact_unavailable`. The purge now skips a key a live package
  or version claims.
- **`appstrate packages push` on a skill says how to try it** (#1632). It
  printed `appstrate code sync --target claude-user --source draft`, which
  swaps every synced skill for its draft; it now prints
  `claude --plugin-dir '<work folder>'`, which loads the folder as it is for
  one Claude Code session.

### Security

- **The platform credential proxy no longer sends a templated credential to
  any host** (#1624). `/api/credential-proxy/proxy` honoured `allow_all_uris`
  for a call templating a credential (`{{api_key}}`) into its URL, a header or
  its body, so an API-key caller could ship the secret anywhere. Like the
  sidecar and the CLI's local resolver, such a call now needs a matching
  `authorized_uris` entry on the target and every redirect hop, else `403`; the
  sidecar's redirect follower, which skipped that check, now applies it. The
  proxy no longer relays upstream `Set-Cookie`, and no path echoes a templated
  secret in its error messages.
- **Patched transitive `brace-expansion` and `undici` copies** (#1630).

## [1.0.0-beta.63] - 2026-09-26

### Operators

- **Three migrations, applied at boot, no operator script.** `0074_chat_session_skills`
  (the enum `chat_skill_mode` and two `chat_sessions` columns with constant
  defaults) and `0076_space_packages_chat_enforced` (one `space_packages` column
  with a constant default) are shape only. `0075_org_integration_oauth_clients`
  adds `integration_oauth_clients.org_id`, fills it from each row's space and
  makes it `NOT NULL`, then relaxes `space_id` to nullable: every existing client
  stays a space client. No new or renamed environment variable. The platform,
  `PI_IMAGE` and `SIDECAR_IMAGE` move together, as always.
- **Boot log lines renamed** (#1129). A failed orchestrator handshake logs
  `Container orchestrator initialize failed — retrying in background`, then
  `Container orchestrator initialize retry failed` once per minute while it
  stays broken. The realtime LISTEN install logs
  `Realtime LISTEN failed — retrying in background` (formerly
  `Could not initialize realtime LISTEN`, still `error`). Alerts keyed on the
  old texts need updating.
- **Firecracker hosts**: the guest protocol moves to 4 (#1547). The kernel and
  rootfs published with this release must run with this release's runner daemon.

### Added

- **Skills in the chat: automatic, manual and strict modes per conversation**
  (#1494). Automatic (the default) lists the space's skills and lets the
  assistant load one on demand; manual and strict inject the chosen skills'
  `SKILL.md` in full (5 at most, 64 000 characters shared); strict also removes
  every `skills:*` permission from the turn, so the assistant can neither list,
  read nor attach another skill. The choice is made in the composer and travels
  with the next message: `POST /api/chat` accepts `skill_mode` and
  `pinned_skills` (both or neither), and every chat session DTO carries them.
- **A space can enforce skills on its chat** (#1586). `chat_enforced` on
  `PATCH /api/spaces/{spaceId}/packages/{scope}/{name}` (skills only, gated
  `skills:write` in the space) injects the skill's latest published `SKILL.md`
  in every conversation held there, in every skill mode and whatever the
  member's `skills:*` grants; the member cannot remove it. At most three per
  space, within the chat's skills budget. Enforcing discloses the `SKILL.md` to
  everyone who chats in the space. `GET /api/chat/enforced-skills` names them.
- **MCP `read_skill` tool** (#1586), declared on every connection: a skill's
  `SKILL.md`, its file list and the version served, or one of its files with
  `path`. With `skills:read` it serves what `GET /api/packages/{scope}/{name}/files`
  serves (the draft to an author, else the latest published version). A skill a
  chat turn injected — enforced or chosen, in any skill mode — is readable by
  that turn's own bearer even without `skills:*`: at the published version
  injected, or the draft only while unchanged since injection (409
  `injected_draft_changed` after an edit), in the turn's space, and while the
  caller still holds `chat:write` there. Switching the skill off or withdrawing
  `skills:read` mid-turn does not cut it off for the rest of that turn — its
  `SKILL.md` is already in context. REST permissions are unchanged. Refusals
  carry the REST status and problem body (403 without `skills:read`, else 404).

- **Integration OAuth clients can be registered once for the whole
  organization** (#1264). `/api/org-integrations/{scope}/{name}/...` (list,
  register, rotate, delete, set default; `org-integrations:configure`, owner and
  admin, session-only) manages org-level clients that every space inherits;
  connect resolves space > org > system.
  `POST /api/integrations/{packageId}/oauth-clients/{clientId}/promote`
  (`integrations:configure` and `org-integrations:configure`) moves a space
  client to the org without re-entering its secret; its connections keep
  working. Deleting an org client deletes the connections it minted in every
  space of the org. Auto-provisioned (DCR/CIMD) clients stay per space.
  Limitation: a space that had chosen the system client over its own clients
  inherits the org default once the org flags one.

### Changed

- **BREAKING (API): a space's integration OAuth client routes return and
  accept only that space's clients and the default it inherits** (#1264).
  `GET /api/integrations/{packageId}/auths/{authKey}/clients` lists the space's
  own clients plus the one inherited default (org or system), no other org or
  system client, and is reachable with `integrations:read` (API keys included).
  `PUT …/auths/{authKey}/default-client` answers `400` for a system client that
  is not the inherited default. `PUT`/`DELETE …/oauth-clients/{clientId}` answer
  `404` when the client does not belong to `{packageId}`.
  `IntegrationOAuthClient.spaceId` is nullable (`null` = org client), and a
  client descriptor's `source` gains `"org"`.

- **"latest" now comes from a signed channel manifest, not the GitHub Releases
  API** (#1271). `appstrate self-update`, the dev CLI's `runner install` /
  `runner update` daemon download, and `scripts/bootstrap.sh` /
  `scripts/bootstrap-runner.sh` (when `APPSTRATE_VERSION` is `latest` or left
  unrendered) read `https://get.appstrate.dev/channels/latest.json`
  (`{ schema: 1, channel: "latest", tag: "v…" }`) and its `.minisig`, verified
  against the pinned release key before the body is parsed. No GitHub API call,
  so no 60 req/h rate limit. Behaviour changes: an unpinned `self-update` now
  needs minisign even when the CLI is already up to date;
  `APPSTRATE_SKIP_VERIFY=1` together with `latest` is refused — pin a version;
  `publish-installer.yml` only moves the root installers and the manifest
  forward by SemVer, so re-publishing an older release no longer rolls them
  back.

- **`appstrate code sync` prints each entry's version** (#1590): `+ <slug> <v>`
  for a new entry, `~ <slug> <before> → <after>` when the version moved
  (`~ <slug> <v>` when only the content did), `- <slug> <v>` for a removed one,
  under `--dry-run` as after a real sync. `--print-path` output and every
  materialized file are unchanged.

### Fixed

- **A chat turn error shows its own sentence again** (#1582). Out of credits,
  blocked subscription, a connection to reconnect, rate limiting and an org
  being deleted each get their own message instead of the generic « La
  génération a échoué » ; a billing refusal points a billing manager to the
  billing page and tells anyone else to contact an administrator, and offers no
  Retry.
- **`/health` recovers after a failed boot handshake with the run backend**
  (#1129). A transient failure of the orchestrator's `initialize()` (an image
  pull, a socket proxy or runner daemon not up yet) pinned `checks.agents` to
  `degraded` — and the container `unhealthy` — for the life of the process; it
  is now retried in the background and `/health` turns `healthy` once it
  succeeds, without a restart. The platform-network probe no longer caches "not
  in Docker" after a daemon 5xx or transport error.
- **The sidecar exits when its forward proxy cannot bind its port** (#1587),
  so the run fails fast instead of starting an agent whose `HTTP_PROXY` points
  at nothing.
- **The MITM egress listener honours the CONNECT port** (#1588). It checked
  the SNI against port 443 and always forwarded to `:443`, so a `delivery.http`
  runner asking for `host:8443` was answered by `host:443`, and an integration
  declaring a non-443 port could not work. The SNI is now checked at the
  CONNECT port and the request goes to that port.
- **Local integration runners inside Firecracker guests are bound by their
  connection's egress allowlist** (#1547). Every runner ran on one shared uid
  with direct egress, so the sidecar could not tell runners apart and let any of
  them through. Each runner now gets its own uid, is attributed by the kernel
  socket owner, has loopback-only egress (its DNS steered to the sidecar), and
  cannot reach another runner's listeners or MITM servers. Docker mode is
  unchanged apart from the MITM inner servers moving to unix sockets.
- **Runs on an aliased model backed by the OpenCode Go provider no longer fail
  with `400 MissingSessionID`** (#1583). The sidecar now re-originates an aliased
  call through the backing's pi-ai provider, so provider-level headers such as
  `x-opencode-session` reach the upstream call. A deployment that set
  `"aliased": false` on its system model in `SYSTEM_PROVIDER_KEYS` as a
  workaround can restore the alias, which keeps the backing hidden from the
  agent container.

## [1.0.0-beta.62] - 2026-09-25

### Added

- **`generation_setting_dropped` — a run's log now says when a stored
  generation setting was ignored** (#1571). A schedule's override or a space
  default (`temperature`, `reasoning_level`) that the run's model
  refuses (the setting, that value, or a temperature alongside reasoning) is
  still dropped for that run rather than refused, but it no longer lives only in
  server logs: one `warn` run log per setting, next to `integration_dropped`,
  carrying `setting`, `value`, `model` and `reason: "refused_by_model"`.
- **`appstrate code sync` installs the pinned space's agents as Claude Code
  commands** (#1268). Each agent active in the pinned space becomes
  `/appstrate:run-<agent>` in the plugin: Claude builds the input from your
  request, uploads local files and launches the agent with the plugin MCP
  server's `run_and_wait`, whose permission prompt shows the input first. The
  command follows the space's prompted / prefilled / locked fields, never
  writes a stored value, and pins the agent's version. Needs `agents:run`,
  `runs:read` (or `runs:read-all`) and `mcp:invoke` in that space. Plugin
  target only; no server change.
- **The conformance monitor now probes the provider API of seven
  credential-only integrations without a credential** (`auth-reject`, tier
  `mcp`). A 401 alone proves little — most providers answer 401 with or
  without the header, and some authenticate before routing — so each
  `AUTH_PROBES` endpoint gets three requests: an invalid credential rendered
  through the manifest's own `delivery.http`, the same on a sibling path that
  cannot exist, and none at all. The probe must refuse the credential (a
  404/410 or an accepted invalid credential fails the run), and its answer must
  differ from the no-credential answer — otherwise the provider never read the
  header the manifest declares, and the run fails. A sibling path answering 404
  verifies the path too; when it answers 401 the report says only the host was
  verified. New probes: brevo, fathom, firecrawl, shortcut, twilio (stripe and
  google-calendar gain the credential-free half). The run also names the
  credential-only integrations whose API nothing probes.
- **`identity-source` conformance check** (every tier, WARN): an `oauth2` auth
  declaring none of `identity_claims`, `userinfo_endpoint` or `issuer` resolves
  every connection to accountId `"default"` unless its token response happens
  to carry `email`/`sub`. Nine shipped integrations are in that state today:
  dropbox, dynamics365, hubspot, linear, mailchimp, monday, notion,
  quickbooks-online, youtube.
- **`GET /api/models` names each model's Pi registry provider, `pi_provider`**
  (#1549) — always present: the key of the provider in Pi's model registry that
  describes the model (`moonshotai` for `moonshot`, `openai-codex` for `codex`).
  A client builds the model's record (limits, request dialect) from
  `pi_provider` + `modelId`. `null` for a gateway (`openai-compatible`,
  `anthropic-compatible`) and for a managed alias, whose binding stays hidden.
- **The provider registry says which providers are searched live,
  `live_model_search`** (#1549) — `true` for OpenRouter alone: its models are
  searched on `GET /api/models/openrouter` and any id it serves is accepted,
  where every other named provider takes only the ids of its `models`.
- **`/api/llm-proxy/openai-responses/v1/responses`** (#1549) — the LLM proxy
  routes the OpenAI Responses API (`openai`, `xai`), metered like the other
  shapes. It forces `store: false` and refuses with a `400` naming the field
  what it cannot meter: `background`, `previous_response_id`, `conversation`,
  `prompt`, a `service_tier` other than `auto`/`default`, and any tool the
  vendor executes (only `function` and `custom` tools pass).
- **`@appstrate/gmail` 1.1.4 and `@appstrate/gmail-mcp` 2.3.3 declare
  `issuer: https://accounts.google.com`**, like the other Google integrations.
  Their explicit endpoints still win; the issuer lets the conformance monitor
  verify them against Google's published metadata, which it reported as
  UNVERIFIED until now.
- **`build:system-packages` (and its `--check`, in `bun run check`) fails on a
  system package whose `schema_version` is not `AFPS_SCHEMA_VERSION`** (#1544).
  Reading accepts any `0.x` on purpose, so nothing noticed the reference
  manifests staying at `0.1`; the build lists every offender in one pass and
  fails before touching `system-packages/`.

### Changed

- **Operator-visible log and error text changed** (#1571) — update any alert
  or grep keyed on the old wording:
  - the error log `Sidecar exited before run completed` and the debug log
    `Sidecar exit watcher errored` are gone. An agent run's launcher reports
    the sidecar's exit code and log tail as
    `Sidecar exited while the run was in progress`; a connect run whose sidecar
    dies before printing a result logs
    `connect-run: sidecar exited without emitting a result` with `connectId`,
    `exitCode` and the last 30 log lines, and its error now names the exit
    code (`connect-run: sidecar exited with code N without emitting a result`);
  - the internal credentials-refresh `502` now reads
    `N/M upstream rejections since the connection was last (re)connected before it is flagged`
    (was `N/M consecutive rejections before the connection is flagged`) — the
    count was never a streak;
  - the server `warn`
    `Stored generation settings refused by the model, dropped for this scheduled run`
    now ends `dropped for this run`, and also covers space defaults;
  - `failed to append dropped-integration run log` is now
    `failed to append drop marker run log`;
  - a run the stall watchdog stops now always fails with the watchdog's own
    error (`Runner stopped reporting — …` or `Run never started executing — …`,
    visible to users and webhooks), never `Agent container exited with code N`
    from a lost race; the launcher no longer logs
    `Agent container exited non-zero` or a sidecar crash for such a run;
  - the run abort signal now also carries watchdog stops (still on the
    `runs:cancel` channel), so a non-owning replica logs its cross-instance
    abort for watchdog sweeps too, and its messages are renamed:
    `Aborting run via cross-instance cancel` →
    `Aborting run on a cross-instance stop request`,
    `Failed to publish run cancel after retries` →
    `Failed to publish run abort after retries`,
    `Retrying run cancel publish` → `Retrying run abort publish`.

- **BREAKING (operators): every run on an API-key model is served through the
  platform's metered LLM proxy, like chat** (#1568). A run whose model is a
  `SYSTEM_PROVIDER_KEYS` preset or an organization's own API-key credential
  now reaches its model through `/internal/llm-proxy/<api>/…`, authenticated by
  the run token: the sidecar receives the proxy route instead of a provider key,
  the proxy serves the run's own model whatever the request names, and the same
  request guards apply as on `/api/llm-proxy`. Usage is metered per request
  from the provider's response, on `llm_usage` proxy rows attributed to the run
  (`credential_source` `system` or `org`); such a run no longer writes a
  `runner` row. An organization-credential run's cost is therefore priced per
  request, price tiers included, rather than from the runner's aggregate at the
  base rate. Only an OAuth-subscription run (claude-code, codex) keeps the
  sidecar's bearer swap and its `runner` row. New nullable columns
  `runs.model_id` (migration `0072`), the model a platform run launched with,
  and `runs.inference_route` (migration `0073`, `proxy` | `sidecar`), who
  serves its inference; a NULL route keeps the runner ledger row and is refused
  by the proxy.
  Operators:
  - drain active runs (let them finish or cancel them) before deploying: a run
    in flight across the upgrade has no route, so the new proxy gate refuses
    its model calls;
  - boot now fails when a module registers an `api_key` model provider whose
    API shape the proxy does not serve (served: `openai-completions`,
    `openai-responses`, `anthropic-messages`, `mistral-conversations`);
  - the inference of these runs now depends on the API being up: a restart
    refuses new calls and graceful shutdown waits for open streams (and their
    metering) within its existing drain window; the agent's retry policy covers
    a short restart;
  - the request body of these calls is capped by
    `LLM_PROXY_LIMITS.max_request_bytes` (default 10 MiB) alone, not by
    `API_BODY_LIMIT_BYTES`;
  - a model on a private or local endpoint (Ollama, a LAN vLLM) is now dialed
    from the API process, not from the run's sidecar: its host must resolve and
    be reachable from the API's own network (`localhost` is the API's
    loopback), and still needs `EGRESS_ALLOW_INTERNAL_HOSTS`. The launch-time
    check is literal (no DNS lookup): a host that only resolves to a blocked
    range is refused by the proxy on the run's first model call. The same
    holds for any model endpoint: one reachable only from the runner network
    must now be reachable from the API process;
  - these runs' model calls count against the per-run `/internal/*` rate
    limit (200 requests per minute per run token), shared with the run's
    other internal calls;
  - the sidecar's `api_key` LLM mode is gone (`PI_API_KEY` and `PI_PLACEHOLDER`
    are no longer read; a sidecar serves `platform` or `oauth` only), so the
    API, `PI_IMAGE`, `SIDECAR_IMAGE` and the Firecracker runner daemon must be
    deployed together.

- **Run-scoped secrets are never in the environment of the process that runs
  the agent.** The agent image's first process is now `runtime-pi/launcher.ts`
  (Docker ENTRYPOINT and Firecracker guest argv): it starts the entrypoint
  without the sink credentials, `SIDECAR_URL` and `SIDECAR_AUTH_TOKEN` and
  hands them over on the entrypoint's stdin; the process orchestrator does the
  same handover itself. Both the launcher and the entrypoint set
  `prctl(PR_SET_DUMPABLE, 0)` first, so no other process of the agent uid can
  read their `/proc/<pid>/environ`, `mem` or `fd`, and they exit rather than run
  the agent without it. The entrypoint refuses to start with any of these keys
  in its environment. The secrets live only in that process's memory, and the
  code it runs comes only from the read-only runtime image: `/runtime` (bundle,
  `node_modules`, transpiler cache) is root-owned and not writable by the agent
  uid, and the entrypoint's working directory is that read-only tree, so the
  agent cannot load code into the process that holds the secrets. The launcher,
  as PID 1, reaps orphaned processes. The `prctl` flag is Linux-only: the
  process orchestrator on a macOS dev host isolates nothing, as before.
- **The sidecar's forward proxy exempts only the platform API endpoint (host
  and port) from the egress policy.** Any other port on the platform host goes
  through the same internal-range policy as every other destination, including
  the upstream-proxy routing; a platform URL without a port matches its
  scheme's default port. In local dev, an agent that reached another service on
  `host.docker.internal` through the proxy now gets 403, and
  `EGRESS_ALLOW_INTERNAL_HOSTS` does not change that — the agent's forward
  proxy never reads it. That variable covers the sidecar's own egress to an OAuth
  subscription's `/llm` upstream and to remote MCP servers, so an internal service meant for the agent is
  declared as a remote MCP integration with its host in
  `EGRESS_ALLOW_INTERNAL_HOSTS`. Integration runners never use this proxy.
- **BREAKING (operators): one run topology — every run boots its sidecar.**
  The agent container gets a placeholder credential and the restricted
  network, like every run: inference goes through the sidecar's `/llm` proxy
  (`MODEL_BASE_URL`), and every other outbound request through its forward
  proxy, under the egress policy every run already had (`HTTP_PROXY`, the
  internal-range blocklist, `EGRESS_ALLOW_INTERNAL_HOSTS`). Runs that used to
  start without a sidecar now start one more container.
  **Operators with a model on a private or local endpoint** (Ollama on
  `localhost`, `host.docker.internal`, a LAN vLLM): list its host in
  `EGRESS_ALLOW_INTERNAL_HOSTS`. A run whose model base URL targets a blocked
  range fails before provisioning, with an error naming the variable.
  The agent image refuses to boot without `SIDECAR_URL` and
  `SIDECAR_AUTH_TOKEN`, and the agent env no longer carries `OUTPUT_SCHEMA`
  (the sidecar's `output` tool has its own copy); the platform, `PI_IMAGE` and
  `SIDECAR_IMAGE` ship together as usual. The `appstrate.run.container_spawn`
  metric drops its `sidecar` attribute, which is now constant.
  **Firecracker operators**: every VM is sized with its sidecar — agent memory
  plus 512 MiB (256 MiB sidecar, 256 MiB kernel/init/overlay), agent vCPUs plus
  1, between 2 and 8. The runner protocol moves to `2` (the boundary request
  takes `{ runId }` alone) and the guest protocol to `3` (the config drive drops
  `agent.unrestricted_egress` and `sidecar.enabled`). Upgrade the platform, the
  `appstrate-runner` daemon and the guest artifacts together; a platform and a
  daemon on different runner protocols refuse each other at `initialize`.

- **BREAKING (operators): MinIO runs from `cgr.dev/chainguard/minio`, as uid
  65532 — an existing MinIO volume must be re-owned before the upgrade.**
  MinIO's own registries (`quay.io/minio/*`, Docker Hub `minio/*`) now refuse
  anonymous pulls, which failed every compose file that starts MinIO: CI,
  development tier 3, the self-hosting examples and the production deploy. They
  all pull Chainguard's build instead, pinned by digest (MinIO
  `RELEASE.2026-09-22T19-25-18Z`); the bucket-init containers reuse it for `mc`.
  It runs as uid 65532, and a volume the previous image wrote holds root-owned
  files: started on one, MinIO crash-loops with
  `FATAL Unable to initialize backend: Unable to write to the backend`. A fresh
  install needs nothing.
  **Operators**, once per existing MinIO volume — production `<uuid>_miniodata`,
  self-hosting `<project>_miniodata`, development `appstrate-dev_miniodata` —
  run the commands in `deploy/README.md` (production) or
  `examples/self-hosting/README.md`, "Data Persistence" (self-hosting and
  development), which carry the pinned image:
  1. Stop the stack (production: stop the application in Coolify).
  2. **Snapshot the volume. This is a forward-only MinIO upgrade**: production
     moves from `quay.io/minio/minio:latest` — whichever release the host last
     pulled — to `RELEASE.2026-09-22T19-25-18Z`, nothing guarantees an older
     MinIO reopens a backend a newer one has written, and the previous image
     can no longer be pulled anonymously.
  3. Re-own it: `chown -R 65532:65532` on the volume, as root.
  4. Deploy. `appstrate-minio` reports healthy and serves the objects already
     stored; skipping step 3 fails loudly with the error above, not silently.
- **BREAKING (integrations): a local integration runner can reach only what its
  connection's `authorized_uris` grant** (#1458). Every sidecar listener
  enforces it: the CONNECT listener by `host:port` and by the TLS SNI inside
  the tunnel (a shared CDN front cannot be steered by SNI to a name the list
  does not grant, but the tenant behind a granted front is not bound), the
  transparent plane by SNI / `Host`, the MITM listener per URL (403 instead of
  forwarding un-injected). A pattern without a port grants only its scheme's
  default (443, 80, 22 for ssh); `scheme://**` stays any host, any port. Each
  listener checks which runner is connecting, and the agent's forward proxy
  refuses runners. `mtls` runners now get the bounded CONNECT route. A pattern
  may carry `{$credential.<field>}` in its host and port, rendered per
  connection: the field must be required, templates are refused on `connect`,
  `api_call` and `oauth2` auths, a value outside host/port characters (or only
  dots) drops the pattern, and an empty result denies everything. `@appstrate/ssh` 1.0.1 uses
  `ssh://{$credential.host}:{$credential.port}` (`port` required, IPv4-only
  host). A runner that reached hosts outside its declared list now fails; a
  `uv` runner fetches its dependencies at startup through that egress, so its
  integration must declare the package index or its bundle vendor them. Not
  enforced on the process/Firecracker backend, where runners egress directly.
  **Operators**: run `scripts/migration/0024-verify-egress-allowlist.ts` before
  the deploy (expected 0; it also lists, for review, the third-party local
  runners the lists now bind); tag `afps-shared@0.9.1` at merge.
- **BREAKING (API keys): keys use a checksummed `apst_` format, and every
  existing `ask_` key stops authenticating.** A key is now `apst_` + 30 base62
  characters + a 6-character base62 CRC32 of those 30, so a secret scanner can
  recognise and validate a leaked key offline, and a malformed key is refused
  before any database lookup. Keys are stored hashed and cannot be converted:
  an `ask_` key stops working; create a new `apst_` key. **Every API-key
  client (CI, GitHub Action secrets, MCP clients) fails from the moment of the
  upgrade until a new key, created after it, is swapped in.**
  Run `scripts/migration/0022-revoke-retired-api-keys.sql` after the deploy: it
  revokes the stored `ask_` keys, so Settings → API keys stops listing them. The
  display prefix grows from `ask_` + 4 to `apst_` + 8 characters.
- **BREAKING (CLI): `appstrate packages sync` is now `appstrate code sync`, and
  `--target` is required** (#1559). The command does not mirror AFPS packages:
  it writes the org's skills, and the pinned space's agents as commands, into
  coding-agent tools, so it is named for them and leaves `packages` to `pull`,
  `status`, `push` and `publish`. Same flags otherwise, same on-disk state: a
  machine that synced before keeps its plugin and the skill directories it
  owns. `appstrate packages sync` no longer exists (`unknown command`), and
  there is no default target any more: a bare `appstrate code sync` exits 1
  with a usage line naming the three (`claude-plugin`, `codex`,
  `claude-user`). What users do once:
  - **Claude Code plugin:** the marketplace (`appstrate/claude-plugins`) runs
    the new command from this release on. Claude Code stops re-running a
    changed command in the background until it is accepted again: run
    `claude plugin update appstrate@appstrate` and accept it once.
  - **CLI older than this release:** the marketplace runs a globally installed
    `appstrate` before falling back to `npx`, and an older one does not know
    `code sync`, so the plugin stops refreshing until it is upgraded:
    `appstrate self-update` (curl install) or `npm i -g appstrate@latest`
    (npm install).
  - **Scripts:** a cron or launchd entry running `packages sync` (e.g.
    `--target claude-user`) must be edited to `code sync`, keeping its
    `--target`; one that relied on the default must add
    `--target claude-plugin`.
- **BREAKING (CLI): `appstrate packages pull --version <spec>` is now
  `appstrate packages pull <package>@<spec>`** — the shape `appstrate run` and
  npm already take: `@acme/pdf@1.2.0`, `pdf@latest`, `@acme/pdf@^1.2`. The flag
  never worked in the form most people type (#1516, below), so it is removed,
  not aliased: `--version` after a command is now refused as an unknown option.
  `<package>@draft` pulls the draft explicitly, and is refused to someone who
  cannot write the package instead of falling back to the published version.
- **BREAKING (API): partial updates are served on `PATCH`, and the `PUT`
  spelling of each is removed** (RFC 9110 §9.3.4: `PUT` replaces). Same bodies,
  same `operationId`s, merge semantics (RFC 7396): an absent field is left
  unchanged, `null` clears a nullable one. A `PUT` to these paths now answers
  `404` (`API endpoint not found`). Moved: `/api/schedules/{id}`, `/api/webhooks/{id}`,
  `/api/proxies/{id}`, `/api/models/{id}`, `/api/model-provider-credentials/{id}`,
  `/api/orgs/{orgId}`, `/api/orgs/{orgId}/settings`,
  `/api/spaces/{spaceId}/packages/{scope}/{name}`, the package draft save
  `/api/packages/{agents|skills|mcp-servers|integrations}/{scope}/{name}`,
  `/api/agents/{scope}/{name}/model` (an absent `generation` keeps the stored
  settings) and `/api/orgs/{orgId}/invitations/{invitationId}` (an absent
  `space_assignments` keeps the stored ones). The
  dashboard and the CLI (`packages push`) send `PATCH`. `PUT` stays on routes
  whose body is the whole resource (`…/input-settings`, `…/home`,
  `/api/billing/managers`, the `…/default` pointers, and
  `…/oauth-clients/{clientId}`, whose absent secret is write-only, …).
- **BREAKING (API, CLI): drafts are versioned by `ETag` + `If-Match`, and
  `lock_version` leaves the wire.** The package detail, create, update,
  restore, fork and home-move responses carry the draft version as a strong
  `ETag` and no longer have a `lock_version` field. The draft save
  (`PATCH /api/packages/{type}/{scope}/{name}`) requires `If-Match` with that
  ETag — absent is `428 precondition_required`, stale is `412
precondition_failed` (it was `409 conflict`), and a body still sending
  `lock_version` is a `400` (unknown field). Publishing
  (`POST …/versions`) and restoring take an optional `If-Match` in place of
  the body's `lock_version`. MCP: `invoke_operation` results carry
  `etag`, and the tool takes `if_match`. CLI: `appstrate packages` records
  ETags per working folder; a lock table written by an older CLI is refused as
  invalid, with the steps to rebuild it — delete it, then re-pull or
  `push --force` each folder.
- **BREAKING (API): a run refused for a missing or ambiguous integration
  connection answers `409`, not `412`.** `missing_integration_connection`
  (including its `must_choose_connection` items with `candidate_connections`)
  keeps its code and body on every run door (`POST …/run`, `POST /api/runs/inline`,
  `POST /api/runs/remote`) and through the MCP `run_and_wait` tool. `412` is
  reserved for failed conditional requests (RFC 9110 §15.5.13). Clients should
  branch on `code`.
- **BREAKING (API): chat answers `409 needs_reconnection`, not `401`, when the
  selected model's subscription credential is dead** (`POST /api/chat`). The
  caller's own token is valid, so the response no longer carries a
  `WWW-Authenticate: Bearer error="invalid_token"` challenge that generic 401
  handlers read as "log out".
- **BREAKING (API): chat's capacity refusal (`429 chat_capacity`) is a standard
  problem document**: it carries `retry_after` as every problem does, and
  `instance`/`request_id` are present.
- **BREAKING (LLM proxy): raw callers can no longer request work the vendor
  bills but the proxy cannot meter** (#1549). Each refusal is a
  `400 invalid_request` naming the field. Every shape refuses a
  `cache_control` whose `ttl` is not `5m` (a one-hour write bills 2× input) and
  forwards only the `anthropic-beta` values Pi itself emits, dropping the rest
  and `x-anthropic-beta`. `anthropic-messages` refuses `fallbacks`,
  `inference_geo`, any tool whose `type` is not `custom` (the server-executed
  ones) and a `service_tier` other than `standard_only`. `openai-completions`
  (and `mistral-conversations`, which shares its adapter) refuses OpenRouter's
  `models`, `route`, `provider`, `plugins`, `transforms` and
  `web_search_options`, `store: true`, a non-standard `service_tier` and a
  non-boolean `stream`. The new `openai-responses` shape applies the same rule
  from the start (see Added). Requests built by Pi pass unchanged. A usage
  frame larger than the buffer bound is metered from a bounded skeleton instead
  of being recorded unpriced, and upstream error logs keep the error's type,
  code and first 300 characters of its message only.
- **BREAKING (LLM proxy): `/api/llm-proxy/*` forwards the caller's request
  headers upstream under the run sidecar's policy, replacing its per-wire
  allowlists.** Both proxies now share one rule
  (`@appstrate/connect/llm-request-headers`): every header goes through except
  transport headers, inbound credentials, platform headers (`x-appstrate-*`,
  `appstrate-*`, `X-Org-Id`, `X-Space-Id`, `X-Run-Id`) and client network
  identity (`Forwarded`, `Via`, `X-Forwarded-*`, `X-Real-IP`, every `cf-*`
  header, identity-aware-proxy tokens, request-rewriting overrides), and
  `OpenAI-Organization` / `OpenAI-Project`, which would re-scope a stored key.
  A raw caller's other headers (`user-agent`,
  `x-stainless-*`, vendor headers) now reach the vendor where they were
  dropped before. Provider-specific headers Pi sets are no longer lost, which
  fixes chat with an OpenCode model (`400 MissingSessionID`, the
  `x-opencode-session` header). The `anthropic-beta` filter applies to the
  forwarded headers on every route.
- **BREAKING (API): timestamps named `expiresAt` / `createdAt` are RFC 3339
  strings, and the universal ids and timestamps are spelled camelCase on the
  surfaces that still used snake_case.** The hosted-connect session
  (`POST /api/integrations/{packageId}/auths/{authKey}/connect/session`) returns
  `{ connect_url, expiresAt }`, and each connect offer on a `409
missing_integration_connection` item carries `connect_url`, `expiresAt` and
  `packageId`: `expires_at` (epoch ms) and `package_id` are gone. Also renamed:
  `GET /api/me/context` (`recent_runs[].packageId`, `recent_runs[].runNumber`,
  `agents[].packageId`, `skills[].packageId`), `GET /api/notifications`
  (`data[].createdAt`), the schedule `actor` request field on
  `POST /api/agents/{scope}/{name}/schedules` and `PATCH /api/schedules/{id}`
  (`{ userId }` or `{ endUserId }`; the snake_case keys are refused with a 400) and, with `@appstrate/module-ee`, the billing managers (`userId`,
  `createdAt`). Chat connect cards saved before the upgrade lose
  their integration icon and name; their links had already expired.
- **BREAKING (API): the remaining snake_case ids and timestamps take the
  carve-out casing.** `SpaceAssignment.space_id` is `spaceId` on invitation
  bodies, member bodies and OIDC clients' `signup_space_assignments`; the schema
  is strict, so the old key is a `400`. Also renamed: `ShareTarget` /
  `ShareTargetView` `userId` / `spaceId`, `PackageShare.createdAt`,
  `SpaceSweepResult.spaceId`, and `packageId` on
  `GET /api/integrations/connect/context`. Stored assignments move with
  `scripts/migration/0021` (see the operators entries below).
- **BREAKING (audit): audit payload keys are camelCase** — `after.viewAs` (with
  `orgRole` and `space.spaceId`), `before.revokedSpaceAssignments` on
  `org.member_role_updated`, and the space-role payloads. Rows written before
  the upgrade keep their snake_case keys (`after.view_as`, …) and are not
  rewritten: a reader of the history meets both.
- **BREAKING (API): four more lists use the list envelope**
  (`{ object: "list", data, hasMore }`): a package's versions
  (`GET /api/packages/{type}/{scope}/{name}/versions`), its file index
  (`GET /api/packages/{scope}/{name}/files`), `GET /api/oauth/scopes` and, with
  `@appstrate/module-ee`, `GET /api/billing/managers`. The agent persistence
  response gains `object: "agent_persistence"`.
- **BREAKING (webhooks): the delivery envelope's `created` (Unix seconds) is
  replaced by `timestamp`, an RFC 3339 string** — the Standard Webhooks
  payload field. The `webhook-timestamp` signing header is unchanged (Unix
  seconds, as the spec requires).
- **The sidecar's own `/llm/*` refusals are provider-shaped**
  (`{ "type": "error", "error": { "type", "message" } }`) instead of
  `{ "error": "…" }`, so the agent's model SDK reports the message (LLM proxy
  not configured, blocked base URL, OAuth token failures, oversized body,
  upstream unreachable) rather than an opaque status.
- **Browser clients on `TRUSTED_ORIGINS` can read the API's response headers.**
  CORS now sends `Access-Control-Expose-Headers` for `Link`, `Request-Id`,
  `RateLimit`, `RateLimit-Policy`, `Retry-After`, `ETag`, `Location`,
  `Appstrate-Version`, `Idempotent-Replayed`, `WWW-Authenticate` and the other
  non-safelisted headers the API sets.
- **`Retry-After` is sent with every error that carries `retry_after`**: the
  per-organization run rate limit (`429 org_run_rate_limited`, which only put
  the delay in `detail`), the shutdown refusal (`503 shutting_down`, 5 s) and
  chat's `429 chat_capacity`.
- **Credential provisioning is a platform table, not a manifest declaration**
  (#1528). `_meta["dev.appstrate/provisioning"]` is no longer read; the platform
  mints `@appstrate/ssh`'s `primary` key only for the system package, so the
  400s for provisioning on a non-system package are gone and a copy of the SSH
  manifest is an ordinary custom auth whose `private_key` the user supplies.
  `POST …/connect/fields` still refuses a caller-supplied key for
  `@appstrate/ssh`. `@appstrate/ssh` 1.0.1 drops the now-ignored key.
- **BREAKING (operators): `deploy/docker-compose.yml` declares
  `- MODULES=${MODULES:?}` instead of pinning a default list** (#1528). Set
  `MODULES` on the Coolify resource, or in `.env` for a raw `docker compose`,
  with `@appstrate/module-ee` for the deployment to bill. Unset or empty, a raw
  `docker compose` refuses to start and Coolify documents `${VAR:?}` as
  blocking the deploy, instead of falling back to the code default, which has
  no billing. Production already sets `MODULES` on its resource. See
  `deploy/README.md`.
- **BREAKING (API): bundle export, the file explorer, version download and
  fork answer `422 version_artifact_unavailable` when a published version's
  archive is missing from storage** (#1533). They answered 404 — fork `400` "no
  published version" — which read as an unknown package or version.
- **BREAKING (runs): the finalize contract is explicit.**
  `POST /api/runs/{runId}/events/finalize` requires `status`, and `usage` when
  it is `success`; the API no longer infers a status from `error`. Every
  in-tree runner sends both, but an out-of-tree runner, an older runner image
  or a CLI published before this release (`appstrate run` reporting to an
  instance) gets a `400`.
- **BREAKING (CLI): upgrade the CLI and the server together.** A CLI published
  before this release cannot author packages on it (its draft save is a `PUT`
  carrying `lock_version`, now a `404`), and this CLI cannot author on an older
  server (it sends `PATCH` + `If-Match`).
- **BREAKING (integrations): manifest JSONPaths are strict, on import AND on
  every read of a stored manifest.** `identity_claims` and the
  `connect.login` `jsonpath` selectors and success criteria are parsed with one
  subset (`$`, `.name`, `['name']`, `[0]`, `[-1]`). Forms the previous release
  evaluated fine are refused: a bare claim (`"sub"`), a member name that is not
  an identifier (`$.x-auth-token`), a digit dot segment (`$.data.0`), a
  leading-zero index (`$.data[00]`). Write `$.sub`, `$['x-auth-token']`,
  `$.data[0]`. Because the schema also runs when a stored draft or published
  version is read, an organization's integration holding one of these fails
  every connect and run with `invalid_manifest` from the deploy on, and a
  published version cannot be rewritten: publish a fixed version.
  `scripts/migration/0023-verify-integration-jsonpaths.ts` lists every one,
  and is step 1 of the deploy (see the operators entry
  below). `@appstrate/wrike` 1.0.5 is updated accordingly.
- **BREAKING (credential proxy): the `X-Substitute-Body`, `X-Stream-Request`
  and `X-Stream-Response` flags take `1` or `0` only**; any other value
  (`true`, `yes`, …) is a `400` naming the header.
- **BREAKING (MCP servers): one grammar for exposed tool names** —
  `{namespace}__{body}`, `body` in `[A-Za-z0-9_-]+`, at most 56 characters.
  Upstream case and hyphens are kept, and a name too long or already taken is
  truncated with an 8-hex FNV-1a suffix instead of `tool_N` (the description
  names the upstream tool). Exposed names of such tools change; manifests keep
  referencing upstream names and are unaffected.
- **BREAKING (chat): `POST /api/chat` validates the new message** with the AI
  SDK's `safeValidateUIMessages` and caps it at 256 KB; a malformed or larger
  message is a `400` on `messages`.
- **Bundle signatures: `AFPS_SIGNATURE_POLICY` defaults to `warn`** (was
  `off`). Verification runs only where a bundle is loaded for execution, never
  refuses under `warn`, and skips the image-shipped system packages.
  `AFPS_TRUST_ROOT` is parsed at boot — an invalid value fails boot instead of
  the first run — and the effective policy is logged.
- **Log lines of the sidecar, the agent container and the runner are
  pino-shaped**: numeric `level` on pino's scale (`40` = warn), epoch-ms
  `time`, `msg`. They used to carry a string `level` and an ISO `time`; a
  collector filtering on `level >= 40` now sees their errors.
- **BREAKING (operators): schema migrations and data scripts of this release.**
  Drizzle `0069` widens `run_logs.id`, `llm_usage.id`, `chat_messages.seq` and
  the `chat_sessions` read pointers to `bigint` — it rewrites `run_logs` and
  `llm_usage` under `ACCESS EXCLUSIVE`, so rehearse it on a production dump to
  size the window. `0070` replaces the webhook-deliveries index with a keyset
  one.
  `@appstrate/module-ee` applies its own `0008` (the `llm_usage` id columns of
  its ledger, cursor and floor, to `bigint`) at init. Scripts, in
  `scripts/migration/`, in order: **1. `0023`, `0024` and `0029` BEFORE the
  deploy**, read-only — each must exit 0, and `0020` (#1532: widens custom
  space roles to the reads their actions require) applied while the old image
  still runs (`0023`: every integration draft and
  published version whose JSONPath the release refuses on read is fixed or
  superseded, see the integrations entry above; `0024`: see the egress entry above; `0029`: every org integration
  whose draft or `latest` version declares a camelCase identity claim key is
  fixed, see the identity-claims entry below); inside the deploy window (old
  application stopped, new one not started), `0021`, `0025`, `0027` and
  `0028`, then `0030` (#1549: deletes the org models Pi's registry does not
  offer into a backup file, repoints an org default naming one to a surviving
  model of the same credential or clears it, clears the other references; `.ts`,
  dry run by default, `--apply` to commit), then `0031` (#1568: deletes the
  retired `google-ai` credentials and their org models). Drain active runs
  before stopping the platform (#1568). Before the deploy, with the platform
  env loaded, the new `bun run verify:system-models` must exit 0 — the image
  refuses to boot on a `SYSTEM_PROVIDER_KEYS` model outside Pi's offer, and
  `0030 --apply` refuses to run; on production change `deepseek-v4-flash` →
  `deepseek-flash`, keeping the entry's `id`. It is a pre-deploy step of every
  release from now on: any Pi bump can move the offer.
  Right after the deploy, `0022` and `0026`, and re-run the `0020` dry run: it
  must list 0 rows. `0025`–`0028` are
  one-way against the image: snapshot the database before the window, and roll
  forward (the previous build reads the new spellings as unknown — agent
  launches answer 500).
- **BREAKING (operators): more env values fail boot instead of falling back.**
  A `CHAT_PI_MAX_CONCURRENCY` that is not a positive integer
  (`@appstrate/module-chat`), `MODEL_RETRY_ENABLED` / `MODEL_COMPACTION_ENABLED`
  that are not booleans and a `TOOL_RESULT_BYTE_LIMIT` that is not a positive
  integer (platform and agent container), and a sidecar missing `RUN_TOKEN`,
  `PLATFORM_API_URL` or `PORT`. The CLI's local `appstrate run` now refuses the
  same malformed `MODEL_RETRY_ENABLED` / `MODEL_COMPACTION_ENABLED` /
  `TOOL_RESULT_BYTE_LIMIT` values from the shell; it used to ignore them.
- **BREAKING (API): model generation settings are snake_case** (#1545).
  `reasoningLevel` is `reasoning_level` wherever generation settings travel:
  the run's `generation` / `generation_override`, a schedule's
  `generation_config_override`, `PATCH /api/agents/{scope}/{name}/model`, the
  run-launch and chat bodies, and the space package, whose `generationConfig`
  is now `generation_config`. Model capabilities (`OrgModel.generation`, the
  provider registry's models) carry `reasoning.temperature_compatible`. The
  old names are refused with a `400`. Stored
  settings are rewritten by `scripts/migration/0025` (operators entry above).
  The chat's saved generation preference (`localStorage`
  `appstrate.chat.generation`, `{ reasoningLevel }`) no longer parses and
  resets once to the defaults. A CLI published before this release runs
  `appstrate run <package>` locally without the space's reasoning level:
  release `cli@` with the API.
- **BREAKING (API): Pi's model registry is the model catalog** (#1549). The
  provider registry's `models`, the featured models, an org model's default
  label, limits, capabilities and generation controls, and the price the
  platform bills all come from the model registry pinned with the Pi SDK
  (`@earendil-works/pi-ai`), read locally. A named provider offers exactly the
  records of its Pi provider served over its `apiShape`: creating or rebinding
  an org model (`POST`, `PATCH /api/models`) and the seed refuse any other id
  with a `400` on `modelId`. The gateways (`openai-compatible`, `anthropic-compatible`) and
  OpenRouter's live search still take any id, and an OpenRouter model keeps the
  price read from OpenRouter. A model `cost` may carry `tiers` (a rate set that
  prices the whole request above an input-token threshold — OpenAI's
  long-context rates): the LLM proxy prices each request with them, while a
  run's aggregated usage and a subscription chat turn are priced at the base
  rate. xAI is served over `openai-responses`, which `/api/llm-proxy/*` now
  routes. Registry and org models no longer carry
  `generation.reasoning.native_levels`. Existing `org_models` outside the offer
  are removed by `scripts/migration/0030` (operators entry above).
- **BREAKING (API): `POST /api/model-provider-credentials/test` takes no
  `apiShape`** (#1549): the provider — or the stored credential named by
  `credentialId` — decides what is tested, so the field is refused with a `400`
  like any unknown field, and `providerId` is required.
- **BREAKING (API): `POST /api/models/test` takes no `existing_model_id`**
  (#1549): the probe uses `api_key`, or the stored key of the credential named
  by `credentialId` — the same key the model's would be — so the field is
  refused with a `400` like any unknown field. A built-in credential answers
  `403`.
- **BREAKING (API): a managed alias offers the same reasoning levels whatever
  model backs it** (#1549): `off`, `minimal`, `low`, `medium`, `high` in its
  `generation.reasoning.levels`, validated as such on every surface (runs,
  schedules, space and agent settings, chat); `xhigh` and `max` are refused. A
  run sends the backing model's nearest supported level (Pi's
  `clampThinkingLevel`, the chat's Pi session likewise) — the run's
  `generation` keeps the level chosen. A non-aliased model is unchanged.
- **BREAKING (API): xAI is served over the OpenAI Responses API** (#1549): the
  `xai` provider's `apiShape` is `openai-responses` (was `openai-completions`),
  the only shape Pi records its Grok models on. A client calling the LLM proxy
  for an xAI model uses `/api/llm-proxy/openai-responses/v1/responses`.
- **BREAKING (operators): a `SYSTEM_PROVIDER_KEYS` model outside its provider's
  offer fails boot** (#1549), naming the entry and the model — except on a
  gateway or OpenRouter, which take any id. On production, change
  `deepseek-v4-flash` to `deepseek-flash` before starting the new image (see the
  script order above).
- **`appstrate run` with a model preset takes the limits of the model's Pi
  record** (#1549): the context window and max output of the model the
  platform names through `pi_provider`, unless the org model overrides them.
  A preset no longer falls back to a 200k context window and 8192 output
  tokens.
- **BREAKING (chat): `POST /api/chat` refuses unknown body fields** (#1545)
  with a `400` instead of dropping them, so a misspelled field no longer runs
  the turn on the default model in silence.
- **BREAKING (API): the model-provider surfaces use one casing per object**
  (#1545). Only the provider-registry names (`providerId`, `apiShape`,
  `authMode`, `displayName`, `iconUrl`, …), the universal ids and timestamps,
  and the org model / proxy / credential ids `modelId`, `proxyId`,
  `credentialId` (camelCase wherever they appear) stay camelCase; every other
  field is snake_case. Credentials: `api_key` and `base_url_override` on
  create and update (were `apiKey`, `baseUrlOverride`), `base_url`, `api_key`
  on the inline test, which takes the stored credential it falls back to as
  `credentialId` (was `existingKeyId`), `base_url` on the credential;
  `POST …/discover` takes `credentialId` and `providerId` (were
  `credential_id`, `provider_id`), like the other bodies. Org models:
  `provider_name`, `base_url`; seed `model_ids` and `promoted_default`; test
  `api_key`. OAuth pairing: `consumed_at` on the pairing,
  and the redeem route (`POST /api/model-providers-oauth/pair/redeem`) takes
  `access_token`, `refresh_token`, `account_id` (RFC 6749 names) and returns
  `available_model_ids`. The old names are refused with a `400`.
- **BREAKING (sidecar): `GET /internal/oauth-token/{credentialId}` (and
  `/refresh`) returns `access_token` and `account_id`** (#1545). The sidecar
  reads only those names, so the `SIDECAR_IMAGE` must be the one of this
  release — an older sidecar fails every OAuth-model run on the new platform.
  Stored credentials are unchanged.
- **BREAKING (connect-helper): the dashboard pins the helper,
  `npx @appstrate/connect-helper@0.3.x <token>`, instead of `@latest`**
  (#1545). Helper 0.3.0 posts the snake_case redeem body: this API refuses the
  0.2.x body (`accessToken` / `refreshToken`) with a `400`, and an older API
  refuses 0.3.0's. **Publish connect-helper 0.3.0 (npm dist-tag `next`)
  BEFORE deploying this release** — until then the pinned command finds no
  version to run. A range resolves against every published version whatever
  its dist-tag, while `latest` stays on 0.2.2: platforms released before this
  one still emit `@latest`, keep getting 0.2.2 and keep working. Move `latest`
  to 0.3.x only once no supported platform emits `@latest`. A pairing redeemed
  by a mismatched helper is consumed before its body is rejected: mint a new
  one. The range lives in one constant,
  `CONNECT_HELPER_PACKAGE` (`apps/api/src/lib/connect-helper.ts`), bumped with
  each helper minor that changes the wire.
- **BREAKING (API): OIDC management bodies and views are snake_case**
  (#1545). Per-space SMTP config: `from_address`, `from_name`, `secure_mode`
  (were `fromAddress`, `fromName`, `secureMode`), and the test send returns
  `message_id`. Per-space social providers: `client_id`, `client_secret`. The
  bootstrap redeem returns `bootstrap.org_slug`. The request schemas are
  strict, so the old names are a `400`. No data moves: the values live in
  columns.
- **BREAKING (API): problem documents carry `request_id` and `retry_after`**
  (#1545), like their other extension members, instead of `requestId` /
  `retryAfter`. The `Request-Id` and `Retry-After` headers are unchanged.
- **BREAKING (API): `runId` joins the universal ids, and notifications and
  files follow** (#1545). `GET /api/notifications` returns `runId` on each
  notification, `packageId` in a `package_shared` payload (was `package_id`),
  and the list envelope (`object: "list"`, `hasMore`) instead of `has_more`.
  A `run_completed` payload carries `packageId` (was `agent_id`). The File
  DTO carries `runId`, and `GET /api/files` filters on `?runId=` (was
  `?run_id=`). Its query is strict: an undeclared parameter (`run_id`,
  `offset`) or an invalid `purpose` is a 400 instead of a silently wider
  list. The MCP `list_files` tool mirrors it — its `runId` argument
  (was `run_id`) and output. Stored notification payloads are rewritten by
  `scripts/migration/0027`.
- **BREAKING (MCP): every tool refuses an argument it does not declare**
  (#1545) with `-32602 Unknown argument(s): …` instead of ignoring it —
  `search_operations`, `describe_operation`, `invoke_operation` (top-level
  keys; `path_params`, `query` and `body` stay open), `get_me`, `list_files`,
  `read_file` and the package-file tools. `run_and_wait` already refused one,
  as a tool error.
- **BREAKING (API): platform-written keys in returned JSONB are snake_case**
  (#1545). `spaces.settings.branding` is `logo_url`, `primary_color`,
  `accent_color`, `support_email`, `from_name` (rewritten by
  `scripts/migration/0028`; the OIDC branding reader is strict, so a space
  still holding the camelCase keys renders the default branding). The
  runner's `file.published` event carries `fileId`; the runtime image must
  be the one of this release for published files to be logged.
- **BREAKING (integrations): identity claim keys are snake_case** (#1545).
  Every integration write (create, save, publish, restore, import, fork)
  refuses an
  `identity_claims` key or a `connect.login.identity_outputs` entry that is
  not snake_case (`findNonSnakeCaseIdentityClaimKeys` in core), and the
  account key is read from `account_id` only. A stored manifest declaring
  `accountId` still reads; its new connections key on the `email` / `sub`
  fallback. The 37 system integrations that declared camelCase keys
  (`accountId`, `avatarUrl`, `teamName`, …) get a patch release (e.g.
  `@appstrate/gmail` 1.1.6, `@appstrate/github` 1.0.5).
  `scripts/migration/0026` rewrites the stored `identity_claims` keys of
  existing connections; their account keys do not change. **Operators: run
  `scripts/migration/0029` BEFORE the deploy** and fix every org integration
  it lists (edit the draft, publish a fixed version): an unfixed one keys new
  connects on the fallback, so reconnecting or upgrading the scopes of a
  connection made before the deploy fails 409 `identity_mismatch`.
- **BREAKING (audit): four more audit payloads use camelCase keys** (#1545):
  `org.settings_updated`, `space.updated`, `oauth_client.updated` (signup
  space assignments) and the bundle import (`fileId`). Rows written before
  the upgrade are not rewritten. Module authors: `PlatformServices.audit.record`
  types `before` / `after` as `AuditPayload`, so a snake_case top-level key
  does not compile.
- **The 69 system packages declare AFPS `schema_version: "0.3"`** (#1544), the
  value every manifest the platform writes carries since #1542; they said
  `0.1`, and they are the reference manifests authors copy. Content only, but a
  published version is immutable, so 29 packages get a patch release (e.g.
  `@appstrate/hubspot` 1.0.4, `@appstrate/github-git-mcp` 1.0.2) and the 40
  already bumped in this release keep their version: each republishes once.
  Dependents pin `^1.0.0`, unchanged.

### Removed

- **BREAKING (API, operators): the `google-ai` model provider is removed**
  (#1568). Its API shape, `google-generative-ai`, is one the LLM proxy does not
  serve, and every API-key run is served by it; Gemini models stay reachable
  through OpenRouter. The shared API-shape list drops `google-generative-ai`,
  `google-vertex`, `azure-openai-responses` and `bedrock-converse-stream`,
  which no provider declares. The provider listing's `apiShape` enum loses
  them, and so does `appstrate run --model-source env`'s `--model-api`: that
  mode calls the vendor directly, but its api→provider table is keyed by the
  same list. Run
  `scripts/migration/0031-drop-google-ai-provider.sql` inside the deploy window,
  before the new image boots: it deletes the `google-ai` credentials and their
  org models, clearing the org default, space pin or schedule override that
  names one first. A model bound to a credential whose provider the instance
  does not register now fails with `409 model_provider_unregistered` instead of
  falling through to the default model.
- **BREAKING (API): `POST /api/model-provider-credentials/{id}/refresh-models`
  is removed, with the credential's `available_model_ids`** (#1549). Nothing
  read the list any more: the models a credential can back are its provider's
  offer in Pi's registry, and `POST /api/model-provider-credentials/discover`
  still enumerates an endpoint on demand. Drizzle `0071` drops
  `model_provider_credentials.available_model_ids` (one-way: a previous build
  reads the column on every credential read). The pairing redeem still returns
  `available_model_ids`: the provider's offer.
- **BREAKING (operators): `FEATURED_MODELS_EXCLUDE` is removed** (#1549), with
  the LiteLLM pricing pipeline and the models.dev featured list it filtered:
  each provider pins its featured model ids, and an `.env` still setting the
  variable has it ignored.
- **BREAKING (MCP): `describe_operation` no longer returns `conditional`**
  (#1528). `granted`, `required_permissions` and `target_space_permissions` are
  unchanged; an operation refused on the record it loads answers with its own
  problem+json reason (RBAC spec §13.10, §13.13), so clients learn it from the
  call.
- **BREAKING (API): `PUT /api/agents/{scope}/{name}/skills`
  (`updateAgentSkills`) is removed** (#1519). It wrote the draft's
  `dependencies.skills` and was the one package-authoring body field spelled
  camelCase (`skillIds`); nothing in the platform, CLI or web app called it.
  Set skills by editing the draft manifest instead:
  `PATCH /api/packages/agents/{scope}/{name}` with `If-Match` and a `manifest`
  whose `dependencies.skills` maps each skill id to its range (`"^1.2.0"`). That
  route refuses a newly referenced skill the caller cannot read, as the removed
  one did, and checks `mcp_servers` and `integrations` the same way. Two
  answers differ: a skill id that exists nowhere is accepted and reported by
  the agent's readiness (the removed route answered `404`), and an edit made
  while a run is in progress is accepted (the removed route answered
  `409 agent_in_use`; no other draft edit ever did).

### Fixed

- **A custom space role sees exactly what it can open, and no page load fires
  a request the server refuses** (#1556). Navigation entries, routes, settings
  tabs and actions follow one access declaration per route, the permissions its
  API calls guard on. Every read waits for its own permission: the dashboard
  shows only the sections its caller can read (an empty state when none), run
  panes and tabs show a no-access state, the chat composer is read-only without
  `chat:write`, and requests carry a space only once the caller is known to be
  able to enter it. `GET /api/realtime/runs` no longer refuses a caller without
  `runs:read` or `runs:read-all`: it drops the run channels and answers `403`
  only when none of the requested channels remains. `chat_session_update` now
  requires `chat:read` in the space, like every `/api/chat` route, so an API key
  never receives it; a key still needs `integrations:read` for
  `connection_update`. The single-run and per-agent streams still require a run
  read, and the dashboard stops reconnecting on a refusal instead of retrying it
  every 30 seconds. `can_add_connection` in the agent connection readiness now
  also requires `integrations:connect`, the permission the connect routes guard
  on.
- **A schedule whose stored generation settings its model no longer takes
  still fires** (#1549). Like a space's defaults, a refused temperature or
  reasoning level is dropped for that run, with a warning naming the schedule
  and the setting, instead of failing every fire until the schedule is edited.
- **Google connections are ready again, and their agents launch** (#1131).
  Google's token endpoint echoes the requested OIDC `email` scope as
  `https://www.googleapis.com/auth/userinfo.email`, and no manifest declared the
  equivalence, so readiness kept asking for a reconnect and any agent whose
  integration config uses `tools: "*"` failed to launch with
  `missing_integration_connection`. `@appstrate/gmail` 1.1.5,
  `@appstrate/gmail-mcp` 2.3.4 and
  `@appstrate/google-{calendar,contacts,drive,forms,sheets}` 1.0.4 add that
  canonical scope to their catalog with `implies: ["email"]`; the OAuth callback
  no longer logs a false scope shortfall for such echoes; a new gate-tier
  conformance check, `scope-echo`, fails any oauth2 auth whose `issuer` is
  `https://accounts.google.com` and requests `email`/`profile` without the
  alias. No data migration: existing connections
  already store the echoed form.
- **`appstrate … --version` after a command no longer prints the CLI's version
  and exits 0** (#1516). `-V, --version` was a program option, which commander
  recognises anywhere on the line, so it shadowed every subcommand:
  `appstrate packages pull @acme/pdf DIR --version 1.0.0` printed
  `1.0.0-beta.61`, exited 0 and pulled nothing. The flag is answered only
  before the command word (`appstrate --version`, `appstrate -p prod -V`);
  after it, the command refuses it like any option it does not declare.
- **CLI errors no longer glue two sentences with `.:` or repeat the server's
  reason** (#1517). A refusal the CLI already explains
  (`…or push --force to replace it.`) is printed alone, not followed by the
  server's own wording of it, and any other error chain starts its cause as a
  new sentence after a full stop.
- **`@appstrate/clickup-mcp` 1.2.3 matches ClickUp's live tool surface again**
  (#1480). The upstream server (public beta) dropped `clickup_merge_document`
  and `clickup_merge_document_page`, and added
  `clickup_list_document_page_attachments`,
  `clickup_download_document_page_attachment`, `clickup_get_schema`,
  `clickup_get_operators` and `clickup_execute_operator`. The last two are
  declared for parity but listed in `hidden_tools`: `clickup_execute_operator`
  runs whatever operators ClickUp enables server-side, a surface the per-tool
  allowlist cannot bound, so it stays out of the picker and off `tools/list`.
- **The npm `appstrate` CLI knows it was installed from npm** (#1518). Every
  npm release up to 1.0.0-beta.61 shipped a bundle stamped with install source
  `unknown` instead of `bun`: the publish step rebuilt it without the stamp, so
  `appstrate self-update` reported a binary with no install-source stamp
  instead of pointing to the npm upgrade command. The release now publishes the
  exact tarball it tested, and both smoke tests check its stamp and version. A
  good release no longer fails while npm propagates it (the check waits up to
  12 minutes on what bun resolves), and its GitHub Release is created whenever
  the npm publish succeeded.
- **The conformance monitor only opens, comments on or closes its tracking
  issue from `main`.** A run dispatched on a fix branch to check the fix
  against the live servers closed #1480 while `main` still shipped the drift.
  A branch run still goes red on drift; it no longer touches the issue.
- **A run event Postgres refuses no longer wedges the run** (#1501). A NUL byte
  or lone UTF-16 surrogate in a runner string (binary tool output, a model
  cutting an emoji) made the `run_logs` insert fail identically on every retry:
  the event 500'd forever, every later event buffered behind it failed too, and
  the run could not finalize until the watchdog killed it. Those characters are
  now replaced with U+FFFD wherever run logs, run results, memories and chat
  messages are written, and any other write refused for its own values
  (SQLSTATE class 22 or `23514`) is recorded as a `system`/`event_dropped` log
  row instead, so the stream moves on.
- **BREAKING (API): a published version with a broken archive is refused,
  not half-served** (#1533). `POST /api/runs/remote` answers `422
version_artifact_unavailable`, not `400 empty_prompt` or
  `missing_integration_connection`; restore refuses instead of writing an
  empty draft; `GET …/versions/{v}` refuses, not 200 `content: null`;
  `appstrate run` no longer says "package not found"; the version page shows an
  error. On runs, schedules, input-settings, package/version reads and restore,
  a storage outage is now 5xx, not that 422; on the doors that run the version,
  a signature-policy refusal keeps its own coded 422.
- **`appstrate run <package>` without `--model` uses the organization's
  default model again, and `appstrate models list` marks it** (#1545). The CLI
  read the model's `is_default` under a camelCase name, so every run without
  `--model` failed with "No default preset". `models list` no longer crashes on
  a model alias.
- **`appstrate run --remote` reports the run's token usage and timings**
  (#1545) instead of 0/0 tokens: the CLI read `token_usage`, `started_at` and
  `completed_at` under camelCase names. The chat's run cards show the start
  and end times for the same reason.

## [1.0.0-beta.61] - 2026-09-23

### Added

- **Edit a package in a local folder with `appstrate packages`** (#1499). `pull`
  brings a package's draft (or, for someone who cannot write it, its published
  version, read-only) into a working folder; `status` shows what the folder
  would change; `push` writes it back to the draft; `publish` cuts a version as
  a separate step. Skills, agents, integrations and MCP servers alike, with any
  editor or coding agent. A push is ONE atomic write under the draft's lock: a
  draft edited elsewhere since the folder last saw it (the dashboard, another
  machine, a colleague) is refused, never overwritten. Dot-named entries
  (`.env`, `.git/`, editor state), `__pycache__` and the signature `RECORD` are
  never sent, never deleted from the draft and never written by a pull.
  `push --create` creates a package through the import route and says it
  publishes the first version. `publish` picks the version exactly as the
  dashboard's dialog does (`--bump patch|minor|major`).
- **`GET /api/packages/{scope}/{name}/home`** — a package's type, home space and
  the spaces the caller reads it from, resolved by id alone across every space
  the caller reaches. A package homed in a personal space is found from a team
  space; an id the caller cannot read is `404 package_not_found`, exactly
  where the catalog refuses it.
- **`GET /api/packages/{scope}/{name}/draft/download`** — the draft as one
  archive, for whoever may write the package (`403 draft_not_writable`
  otherwise). An author fetching their own draft is editing it, so
  `restrict_package_copy` does not apply to it; published versions keep that
  gate.

- **A member can leave an organization.** New operation
  `POST /api/orgs/{orgId}/leave` (`leaveOrganization`): any member, `204`, no
  RBAC permission beyond membership. It takes the first-party dashboard
  session — an API key, an OAuth delegate, an MCP or CLI token is refused with
  `403` (see Security). Leaving is the same
  exit as being removed, with the same effects (below), and is audited
  `org.member_left` with `after: { orphanedSpaceIds, revokedApiKeyIds }`
  (removal keeps `org.member_removed`). In the web app, Settings → General's
  danger zone carries « Quitter l'organisation » for every member, disabled
  with an explanation for the sole owner and during a role preview. Its
  confirmation spells out the consequences: the personal space is kept 30 days
  (a re-invite inside that window gives it back), connections shared in team
  spaces stay usable, and leaving the last organization lands on onboarding.

- **An organization can have several owners.** An owner may promote another
  member to owner (`PUT /api/orgs/{orgId}/members/{userId}` now accepts
  `role: "owner"`), and manages every other member, owners included; the
  Members page offers it, and demoting an owner, behind a confirmation. Only
  an owner assigns `owner`,
  and only by a role change on an existing member: invitations and an OIDC
  client's `signupRole` still accept `guest`, `member` and `admin` only. There
  is no ownership-transfer endpoint — promote, then leave or be demoted by the
  new owner. **An organization always keeps at least one owner:** the last
  owner cannot leave — `409 last_owner` ("promote another member to owner
  first, or delete the organization"), checked in the same transaction under a
  lock on the organization row. Removal and demotion cannot empty the owner
  set, since they are acts of another owner, who remains. API consumers: one
  new operation, a new `owner` value in `changeMemberRole`'s request body, and
  `409 last_owner` on `leaveOrganization` only. No database migration. With several owners, the EE
  billing fallback contact (no `billing_email` set) is the owner who joined
  first; when that owner leaves, the new fallback is pushed to the Stripe
  customer.

- **Module event `onOrgMemberRemove(orgId, userId)`**, emitted by the
  platform's member service once a leave or a removal has committed, for a
  module to drop what it granted to that pair. Best-effort like every module
  event: a failing handler is logged, not retried. `@appstrate/module-ee` uses it to delete the member's
  billing-manager row, so a re-invited ex-billing-manager no longer regains
  `billing:manage` — for exits from this release on: rows left by members who
  departed before it are not repaired. This extends the `@appstrate/core` module contract: minor
  core release.

### Changed

- **BREAKING (CLI): `appstrate skills sync` is now `appstrate packages sync`.**
  A skill is a package, and every package command lives under one noun —
  `packages sync` next to `pull`, `status`, `push` and `publish`. Same flags,
  same targets, same on-disk state: a machine that synced before keeps its
  plugin and the skill directories it owns. `appstrate skills` no longer
  exists. What users do once:
  - **Claude Code plugin:** the marketplace (`appstrate/claude-plugins`) now
    runs the new command. Claude Code stops re-running a changed command in the
    background until it is accepted again: run
    `claude plugin update appstrate@appstrate` and accept it once.
  - **CLI older than this release:** the new command is unknown to it; update
    with `appstrate self-update` (curl install) or
    `npm i -g appstrate@latest` (npm install).
  - **Scripts:** a cron or launchd entry running `skills sync` (e.g.
    `--target claude-user`) must be edited to `packages sync`.
- **Draft writes have no operation-count limit any more.** A `PUT` carrying file
  operations used to accept at most 200, so a large edit had to be split into
  several non-atomic writes. The real bounds are unchanged: the request body
  limit, 1 MiB per written file and the tree limits.
- **A bumped version of unchanged content is refused.** The publish dialog's
  patch/minor/major bump (and `appstrate packages publish --bump`) with nothing
  else changed now answers `409 no_changes`. Before, the bumped number alone
  changed the archive's digest and the same content was published again under
  every bump. A version the author writes into the manifest (promoting
  `1.0.0-rc.1` to `1.0.0`, say) is still theirs to cut.
- **Publishing can be pinned to the draft the caller read.** The versions
  endpoint accepts `lock_version`; a draft that moved since is refused with
  `409 conflict` instead of being published unseen. The dashboard's publish
  dialog and `appstrate packages publish` both send it.
- **Removing a member now revokes their credentials in the organization.**
  Removal and leaving share one exit path. Beside what removal already did
  (membership row and notifications deleted, explicit space roles dropped,
  personal space put on its 30-day clock, schedules disabled), it now
  **revokes the member's API keys in that organization** (`revoked_at`) and
  **their OAuth refresh tokens and opaque access tokens bound to the
  organization** — those issued by its own org-level OAuth clients, and those
  whose audience is its MCP resource (`/api/mcp/o/<orgId>`). JWT access tokens
  cannot be revoked server-side and stay valid until their TTL (1 h by
  default), refused meanwhile by the per-request membership check. API-key
  creation now takes the creator's membership row lock, so a key created during
  an exit cannot escape the revocation. Until now a removed member's keys were only
  inert, and came back to life if the same user was invited again; and a
  background token refresh through an auto-signup (`allowSignup`) client could
  silently re-add a member who had left. Signing in again interactively
  through such a client still re-joins, as a deliberate act. Instance-level
  tokens not bound to the organization are untouched: membership is re-checked
  on every use. Connections a
  departed member created in team spaces are not revoked (unchanged).
  **Operators: run `scripts/migration/0019-revoke-departed-members-credentials.sql`
  once after deploying** — it revokes the API keys and OAuth tokens left behind
  by members removed before this release, which the new exit path never saw.

- **Deleting or leaving an organization no longer reloads the page.** The web
  app moves to another organization, or to onboarding when none is left.

### Fixed

- **Setting an agent's skills moves the draft's lock.** The agent skills
  endpoint rewrote the draft manifest without the draft lock or a new
  `lock_version`, so a client holding the previous token could write its stale
  manifest back over the change.
- **A change to a package's annex files alone can be published from the
  dashboard.** Its publish button compared only the manifest and the main
  content file, so an edit to any other file left it disabled. It now follows
  the server's own change flag, like `appstrate packages publish`, and the
  server judges the content (annexes included) when the version is cut. A
  publish refused as `no_changes` (an edit reverted) clears the "modified"
  marker, so the draft stops offering it.
- **CLI errors carry the server's explanation.** Error responses were read for
  a `message` field the API does not send (RFC 9457 carries `detail`), so most
  refusals printed only `HTTP 404`.

### Security

- **Owner changes and leaving need the first-party dashboard session.**
  Promoting to owner, demoting or removing an owner, and leaving the
  organization are refused with `403` unless the request comes from the
  dashboard's cookie session — API keys, OAuth delegates, MCP and CLI tokens
  alike, even when their user is an owner. Requiring a `user` principal was not
  enough: self-registered (DCR/CIMD) MCP clients are instance-level and resolve
  to one, so a prompt-injected MCP agent could have seized ownership. The
  acting member's role and the target's are read from the database under the
  organization lock, where the service decides.

## [1.0.0-beta.60] - 2026-09-23

### Added

- **Agents can reach a host over SSH.** Two new system packages: the
  `@appstrate/ssh` integration and the `@appstrate/ssh-mcp` local mcp-server it
  backs. One connection is one key on one Unix account, and **that account is
  the boundary** — `ssh_exec` hands its string to the account's login shell, so
  what the agent can do is exactly what the account can do. Grant root only if
  you mean it; otherwise use a dedicated user, restricted with sudoers or a
  restricted shell. The private key reaches the runner as a file
  (`/run/secrets/ssh_key`, `0600`) and never enters the agent container.
  **Read-only is a property of the agent, not of the connection**: an agent that
  must not change the target is granted `ssh_probe` and `ssh_read` and not
  `ssh_exec`, `ssh_write_file` or `ssh_edit_file`, so one connection serves a
  reader and a writer at once; every tool also carries the MCP
  `readOnlyHint`/`destructiveHint` annotations. `ssh_read` lists a directory or
  returns a file's lines numbered like `cat -n`, windowed by `offset`/`limit`;
  `ssh_edit_file` replaces one exact string (or every occurrence) in place,
  keeping the file's mode and owner (a failed write puts the original back);
  `ssh_write_file` creates new files `0600` and refuses a directory. `ssh_exec`
  takes a `timeout_seconds` (120 s by default, 600 s at most): when it expires
  the call returns `timed_out: true`, `exit_code: null` and the output so far,
  and drops the connection, but
  **the remote process may keep running** — wrap long commands in `timeout` on
  the target. Oversized output keeps its head and tail; every SFTP transfer is
  bounded at 120 s and a dead connection is dropped by SSH keepalives. Exit
  status 255 belongs to ssh itself, so a command exiting 255 reads as an ssh
  failure. Paths are relative to the account's home; `~` is not expanded. The host key is pinned
  (`StrictHostKeyChecking=yes`) with no trust-on-first-use — in an autonomous
  run nobody is there to accept one. A target on a private address is refused by
  the SSRF floor on the runner's egress path: a public VPS works, a LAN box does
  not (#1228; per-connection host scoping of that listener is #1458).

- **Connecting an SSH host never asks for a private key.** The platform mints
  the ed25519 pair itself into the credential envelope: never displayed, never
  readable again. Reconnecting the same host, port and account reuses the
  existing pair, so the key already authorised on the target keeps working; a
  changed target gets a fresh one. The form asks only what the user can answer —
  host, port, account, and the target's own host key, read off the machine from
  a session they already authenticated; the platform opens no SSH socket at any
  point. After creation the connect page shows the block to paste on the target:
  it authorises the public key on the named account with `restrict` (no port
  forwarding, agent forwarding, X11 or pty), performs every file operation as
  that account, and prints the host's own fingerprint to compare against the one
  submitted. The target must run **OpenSSH 7.2 or later**: an older sshd
  rejects the whole `restrict` line, so the block reads the target's sshd
  version first and refuses, writing nothing, below 7.2 (an unreadable version
  — no sshd found, or not OpenSSH — is only warned on). Pin the host's ed25519
  key; `ssh-rsa` only when the server has none. On a locked account password
  the block warns unless `sshd -T` reports `usepam yes`, since only an sshd
  without PAM refuses such an account. The same screen carries the block that REMOVES the key, and
  `GET /api/me/connections/{id}/handoff` hands that one back when the connection
  is deleted months later — neither block is stored, both are derived on demand.
  An auth opts into platform-minted credentials with
  `_meta["dev.appstrate/provisioning"]` (AFPS §10), honoured for system
  packages only: any other package declaring it is refused by the hosted connect
  form (served and submitted) and by `POST …/connect/fields` rather than asking
  the user for the key, and its handoff carries no block. No door lets a caller
  bring its own key: the hosted form is served a schema with the minted names
  removed and the platform overwrites them on submit whatever the body carried,
  and `POST …/connect/fields` rejects a submission naming one.

### Fixed

- **The hosted connect form showed raw field names.** It derived inputs from the
  credential property NAMES only, so `title`, `description` and `default`
  declared in a manifest reached nobody, and a declared default was neither
  shown nor submitted. The form renders all three and seeds the defaults it
  displays.

### Security

- **Removing a space member judges BOTH of its bounds under the membership
  lock.** `DELETE /api/spaces/{id}/members/{userId}` asks two questions: whether
  the caller could have granted the standing the removal LEAVES BEHIND (dropping
  an explicit restriction in an `open` space hands out its default role), and
  whether they could have granted the standing being DROPPED. The second moved
  inside the lock in #1438; the first stayed at the route, resolved against an
  `org_members` row read on its own statement — so a concurrent organization
  promotion could move the target's role between that read and the DELETE, and
  the refusal was computed against an open space's default instead of a preset
  `admin`. Both bounds now run inside `removeSpaceMember`'s transaction, after
  `lockOrgMemberForSpaceGrant`, and `access_after` is reported from that same
  transaction rather than from a lookup after it. Only a caller racing a
  promotion sees a difference, and it is a refusal (403) where the stale read
  reported the swept row as merely missing (404). (#1439)

### Added

- **The chat composer shows what the assistant may do, and which model
  answered.** A chip beside the model picker names the caller's role in the
  space and lists the acts the assistant can perform for them, each computed
  from the guards the server checks. Each assistant message shows the model
  that answered it, and reopening a conversation pre-selects that model
  (never a deleted or disconnected one). An "agent authoring" toggle next to
  the attachment button lets a caller who may create agents keep the assistant
  to published agents: off, the turn's MCP bearer is minted without
  `agents:write` (request body `agent_authoring`, absent = on; remembered per
  user and browser).

### Changed

- **BREAKING: composing an inline agent requires `agents:write` and
  `agents:run`.** `POST /api/runs/inline`, `POST /api/runs/inline/validate` and
  an `inline` source on `POST /api/runs/remote` asked `agents:run` alone; they
  now also ask `agents:write` — composing a manifest is authoring an agent. The
  `admin` and `builder` presets compose; `operator` (the default role of open
  spaces), `runner` and `viewer` no longer do, and an OIDC end-user token can no
  longer reach these routes. An API key with an explicit scope list needs
  `agents:write` in it for `appstrate run ./agent.afps`. The platform MCP
  `run_and_wait` tool and its server instructions offer `kind: "inline"` only to
  a caller holding both grants.

## [1.0.0-beta.59] - 2026-09-18

### Added

- **MCP Emails — one MCP surface over Gmail, Fastmail, iCloud, Yahoo, Zoho,
  Yandex and any IMAP/SMTP account the member has connected upstream.**
  `@appstrate/mcpemails@1.0.0` is a system integration backed by the hosted
  [MCP Emails](https://mcpemails.com) server, and it joins the DCR-based
  remote-MCP family (`notion-mcp`, `canva-mcp`, `clickup-mcp`):
  `source.kind: remote` + `streamable-http` against
  `https://mcpemails.com/api/mcp`, and an `oauth` auth the sidecar fills with
  the actor's access token. RFC 9728 protected-resource discovery, RFC 8414 AS
  metadata, RFC 7591 DCR as a public client and RFC 7636 PKCE (S256) — no OAuth
  app is registered by hand: the operator installs the connector and each member
  clicks Connect. The manifest was read off the live server and the AGPL source
  rather than the marketing page, which disagrees with the code in two places
  that would have cost real scopes — `search:email` is vestigial (no tool
  requires it; `read:email` already gates the search action) and the surface is
  26 tools, not the 23 the docs advertise. `accountId` maps to `$.sub` rather
  than `$.email`, because userinfo returns the address only when the token
  carries `openid` or `email`; both are in `default_scopes`, so a connection is
  still labelled by address. There are no webhooks and no server-initiated
  events, so an agent that must react to new mail polls `email_read` with
  `action: "list"`.

- **The production compose ships in this repository, as `deploy/`, and
  `appstrate/cloud` is retired.** That repository had held no product code since
  the billing module came in-tree as `@appstrate/module-ee`; its
  `docker-compose.yml` now lives at `deploy/docker-compose.yml`, with
  `deploy/.env.example` and a runbook beside it, under the project name
  `appstrate-prod`. It is deliberately NOT merged with
  `examples/self-hosting/docker-compose.yml`, which teaches a stock install: the
  project name, the service names Coolify's domain routing points at
  (`appstrate-postgres`, `appstrate-minio`, … against `postgres`, `minio`, …)
  and the `internal: true` network the example uses — which on `appstrate` would
  cut its egress to the model providers — all differ, and the top-level
  `volumes:` keys are load-bearing as well. Each file points at the other, so a
  change that belongs in both is carried across by hand.

  Moving it in-tree put it under the three `bun run check` gates that glob every
  tracked `*docker-compose*.yml`. None had ever run on it, and three failed.
  `verify:env-docs` caught the expensive one: its `.env.example` omitted
  `CONNECT_SESSION_SECRET`, `RUN_TOKEN_SECRET` and `UPLOAD_SIGNING_SECRET`, all
  three hard-required with no default, so a raw `docker compose up` from that
  file could not boot and had not been able to for months.
  `verify:compose-defaults` found ten YAML defaults restating the Zod schema's
  own, plus only four of `@appstrate/module-ee`'s eight variables forwarded.
  `verify:release-version` now holds its sixteen image refs to the release like
  every other shipped compose. And `SIDECAR_POOL_SIZE`, deleted from the platform
  along with the sidecar pool, had survived here configuring nothing — removed.

  **Operators:** Coolify names the volumes after the RESOURCE uuid, not after the
  repository, and that cuts both ways. Repointing an EXISTING resource at this
  file moves, renames and orphans nothing; standing up a NEW one hands you empty
  volumes however faithfully the compose is copied, and is therefore a data
  migration rather than a configuration change. `deploy/README.md` says so,
  because the file reads like a configuration artifact and that is exactly the
  wrong intuition to bring to it. The resource UUID is written nowhere on
  purpose — a value that has to be correct to be useful is worse than absent once
  it is stale — so read it off the resource.

### Changed

- **BREAKING (modules): every principal DECLARES what it is, and
  `@appstrate/core` goes to 11.0.0.** `AuthResolution` carries a required
  `principalKind`: `"user"` for the platform user by any transport, `"delegate"`
  for their authority under a ceiling of its own (an API key, a third-party
  OAuth client), `"end_user"` for an external identity, set iff `endUser` is. A
  strategy that omits it, declares an unknown value or contradicts `endUser` is
  refused by the pipeline with a thrown error — never a default bucket — so an
  out-of-tree auth strategy fails to compile until it declares one. What it
  replaces was a proxy: `callerPersonalOwnerId` inferred "is this credential the
  human themselves?" from the transport (`authMethod === "session"`, the
  `deferOrgResolution` pipeline flag), copied into four gates asking four
  different questions, with `!orgRole` standing in for "end-user" and some twenty
  routes asking "is this the person?" through `authMethod === "api_key"`. The
  extension point was open — a module may contribute an auth strategy — while the
  authority model was a closed enumeration, so the first contributed principal
  landed in the most restricted bucket on four unrelated gates, with four
  symptoms and only one of them visible. Every gate that asks who the caller is
  now reads `isUserPrincipal`; the three other inputs survive with the question
  each actually answers (`api_key` about the key object, `session` about the
  first-party cookie transport, `deferOrgResolution` about when the pipeline
  resolves), and the webhooks scope and `/me/connections` read the credential's
  binding rather than a kind.

  **A third-party OAuth client and an OIDC end-user token are now refused on the
  profile and its password, on onboarding, on space and organization creation and
  on the organization library — exactly like an API key**, and the organization
  listings bind a delegate to its organization and fail closed without one.

- **Migration `0068` validates `packages_org_package_has_home`.** `0067` added
  that CHECK as `NOT VALID`, which governs every write from the moment it applies
  while leaving the inherited rows unbacked; `0068` runs the
  `ALTER TABLE packages VALIDATE CONSTRAINT` that finishes the job (#1450). It is
  a no-op on a deployment that has already run
  `scripts/migration/0014-packages-home-space-backfill.sql`, which ends by
  validating the constraint itself — it is the fresh install that would otherwise
  carry the constraint marked `NOT VALID` forever.

### Fixed

- **A chat turn in a personal space no longer 404s (#1456).** The turn failed on
  its first MCP call with a 404 naming a space that exists, in the right
  organization, owned by the session's author: the chat module's server-minted
  loopback bearer is neither a cookie session nor the `deferOrgResolution`
  pipeline, so the transport proxy the gate used answered "not the person" for
  the person. A turn in the caller's own personal space now works and carries
  their per-principal grants. The mechanism is the required `principalKind`
  above.

- **Operator variables no longer travel through the production compose's
  `environment:` block — the defect that took production down during the
  cutover.** Coolify MATERIALISES every key that block names: a bare `- FOO`
  becomes `FOO: ''` in the compose it generates, so the form the rest of the repo
  uses — name the variable, omit the value, let the Zod schema's default apply —
  is not merely unnecessary there, it is unavailable, because "unset" cannot be
  expressed. `z.coerce.number("")` is 0, `@appstrate/module-ee`'s own `.min(1)`
  refused it, the module failed to initialize and the platform crash-looped.
  Probing `""` against the real schema of all nineteen bare names the file
  carried found twelve unsafe: seven refuse to boot (`APP_URL`, `TRUST_PROXY`,
  `LOG_LEVEL`, `USERCONTENT_URL`, `FILE_RETENTION_DAYS`, `SMTP_PORT`,
  `EE_RECONCILIATION_BATCH_SIZE`) and four degrade in silence, which is the worse
  half — `EE_RECONCILIATION_INTERVAL_SECONDS` 300 → 0 pauses metering,
  `EE_RECONCILIATION_REPLAY_WINDOW` 200 → 0 disables the scan that exists to
  catch unbilled usage nobody sees, `EE_RECONCILIATION_MAX_GAP_SECONDS` 86400 → 0
  resumes over any gap, and `S3_PUBLIC_ENDPOINT` goes from undefined to `""`.
  That one `.min(1)` floor is the only reason any of it surfaced; without it
  billing would have stopped without a word. The block now carries only what the
  file COMPUTES — a service hostname, an image ref bound to
  `${APPSTRATE_VERSION}`, a mirror of `ports:`/`volumes:`, one variable remapped
  onto another, and the two deliberate overrides (`RUN_ADAPTER`, `MODULES`) whose
  YAML value differs from the code default on purpose. Everything else arrives
  through `env_file`, which Coolify adds to every service and which the file now
  declares itself, so a raw `docker compose` run uses the identical mechanism.

- **A credential delivered through `delivery.files` is readable by the runner
  again.** `docker cp <hostdir> <container>:/` stamps every copied entry with the
  HOST-side ownership — the uid the sidecar runs as — while all four runner
  images declare `USER runner:runner` (uid 1001) and the default mode for
  `delivery.files` is `0400`. A delivered secret therefore landed as
  `-r-------- 1 <sidecar uid> 0` and the runner could not read its own file. It
  hit every owner-only mode on all four runners, including the cert+key pair of
  `mtls`, which is today's only production consumer of `delivery.files`. Chowning
  the staged file is not available (it needs privileges the sidecar does not
  have, and macOS refuses it anyway), so the staged mirror is streamed as an
  in-memory USTAR archive through `docker cp -`, where uid and gid are nothing
  but header fields. **The staged modes are kept exactly as they are** —
  relaxing `0400` to something world-readable would have made the symptom
  disappear by throwing away the protection the mode exists to provide. Staging
  itself is unchanged: path safety checks, parent directories and their modes
  still come from `stageFileMountsOnHost`, and only the transport differs. The
  reason it went unseen is that the existing tests covered staging and never
  exercised CONSUMPTION inside a container.

- **An `mcp-server` whose `entry_point` is written `./server.js` imports again.**
  `checkCompanionFiles` resolved `manifest.server.entry_point` through an exact
  `files.has()`, while MCPB manifests conventionally spell the path explicitly
  relative and zip entries are stored flat — two spellings that never meet. No
  `mcp-server` package of this repository could be installed through
  `POST /api/packages/import`, the shipped reference package
  `@appstrate/bun-toolkit-server` (`"./server.ts"`) included, while the on-disk
  system-package loader accepted the very same archive: the front door was
  deciding the package's validity. Either spelling resolves now, and ONLY a
  leading `./` is normalized — `..` segments and absolute paths stay unresolved,
  so the lookup cannot leave the archive root, and a genuinely absent payload
  still reports `MCP_SERVER_MISSING_ENTRY_POINT` with the declared path.

- **`scripts/migration/0010` ordered its pages by the text cast instead of by the
  key.** A cast keeps the output name, so `ORDER BY` bound to the `::text`
  SELECT-list output while the `WHERE` beside it saw the input column —
  lexicographic ordering against a numeric cursor. Page 1 ended at 9287 and page
  2 asked for the ids numerically above it, so 109 of the 717 billing-ledger rows
  were never selected, and the transaction committed. Found by rehearsing the
  beta.58 window against a `pg_dump` restore of production; the fix qualifies the
  key with its table, which cannot resolve to an output name. **No production
  data was lost** — the legacy database and the platform each hold the same 717
  rows, verified. Re-run on a fresh restore: 717/717, every table matches, and a
  second run still refuses with exit 1 as the runbook requires.

## [1.0.0-beta.58] - 2026-09-17

### Added

- **The per-type package index carries `icon` and `keywords`.** Both are read
  off the same rendered manifest as `name` and `description`, so an index page
  draws its cards and runs its search from that listing alone — which is what
  lets the Integrations page read the index every other type reads instead of a
  wider route of its own. Additive on `GET /api/packages/{skills,mcp-servers,integrations}`.

- **A package now lives in ONE space and reaches every other one through a
  SHARE.** `package_shares` (migration **0065**, a brand-new table with no
  backfill) says a package is OFFERED to a space; `space_packages` says it is
  ACTIVATED there. Two tables, because a package runs with the RECIPIENT's
  credentials: activating one is a consent, and an "offered but not accepted"
  state carried on `space_packages` would have had to be filtered at each of that
  table's every reader, where one miss executes a package nobody agreed to.
  The subject is always a SPACE — "share with Bob" is a share with Bob's personal
  space, resolved server-side from his user id and created if he has none, and
  the sharer never learns that id: the listing renders such a target as its
  owner. A package is readable from exactly TWO placements, its HOME
  (`packages.home_space_id`) and every space it is SHARED into. An INSTALLATION
  is deliberately not a third one: it was the only answer to "why does this space
  see this package" that never consulted `<type>:share`, so a builder of B who
  read A's package from anywhere could switch it on in B and hand B a placement A
  had granted to nobody. Activating is the act of TAKING an offer, and therefore
  a placement's consequence rather than its source.

  Three routes change the audience and are authorized by a THIRD verb on the
  package's home space (`<type>:share`):
  `POST /api/packages/{scope}/{name}/shares` (idempotent, 409
  `share_target_is_home` when the target is the home itself, 404 for a space the
  caller cannot reach — so another member's personal space is not targetable by a
  guessed id), `GET …/shares` and `DELETE …/shares/{target}` (which removes the
  placement behind the share in the SAME transaction — otherwise the package
  keeps running where it may no longer be seen). Offering a package with
  **nothing published** is 409 `package_has_no_version`, for EVERY target and
  checked before the target is resolved so a refused offer provisions no personal
  space: outside its home a package runs its latest published version, so an
  offer of one with nothing published is an offer of nothing. The refusal lands
  on the only principal who can clear it, in the act they are performing, where
  the dialog offers **Publier et partager**.

  **Activating has ONE pair of doors**, `POST /api/spaces/{spaceId}/packages`
  and its `DELETE`, for a personal space exactly as for a team one. The package
  must be homed in the target or shared into it, re-read under the share row's
  lock inside the writing transaction, so a revoke racing an activation makes it
  refuse rather than commit a placement nothing backs; otherwise 404, never a
  403, since a space id can be private. A caller holding `<type>:share` in the
  home may switch on one that is NOT placed there yet — the offer is created
  with the activation, in that one transaction, which is the administrator's
  single click from the library, and it is why reading A's package from B still
  grants nothing about placing it in B. In the caller's OWN personal space the
  type's activation grants are waived entirely: ownership is the authorization,
  and a `guest` holds only the `operator` preset there, which carries none of
  them. An API key never carries `share`, so it activates the already-placed and
  nothing else. `GET /api/spaces/{id}/library` proposes exactly what that call
  would accept, so the listing cannot offer a package the activation would
  refuse.

  **Outside its home, a package runs the latest PUBLISHED version, always.**
  Publishing IS the rollout — the model of Copilot Studio, custom GPTs, n8n and
  Apps Script — so an author ships a fix and every recipient gets it on their
  next launch, with nothing to accept a second time. It is a policy the product
  chose rather than one the field agrees on: Figma hands the consumer a
  review-and-accept step instead, and that flow was weighed and declined. A recipient cannot repair an
  agent they do not own, so freezing one on bytes its author had stopped
  maintaining bought them nothing; the real hazard, a new version demanding an
  access they never granted, is already refused at the right moment by 412
  `missing_integration_connection` and its connection offers. Dependency versions
  are unaffected: an agent's manifest ranges resolve against the published
  catalogue and each run freezes what it resolved.

- **The library is the map of PLACEMENTS, and it is actionable.** Both
  `GET /api/library` (the organization map, owners and admins) and
  `GET /api/spaces/{id}/library` (one space's own page) now return, per package,
  `placements: [{ space_id, via, state, shared_by }]` — one entry per space the
  package is placed in and the caller reads for that type. `via` says WHY it is
  there (`home`, `shared`, `system`), `state` whether that space RUNS it
  (`active` — a row saying `enabled`; `inactive` — a row saying `false`; `none` —
  no row at all), and `shared_by` names the offer's author on `shared` entries,
  `null` there when the offer came from a home move. `state` comes from the ONE
  activation rule the run gate reads, where the placement ROW always wins and
  the deployment's default answers only where there is no row: a shipped
  integration reads `active` in a space nobody has touched rather than as an
  untaken offer, an untaken offer reads `none`, and a system package somebody
  switched off reads `inactive` like any other. A pending offer is therefore a placement with
  `state: "none"` — the same row, the same switch as every other space — and an
  offer and a package somebody switched off stop looking alike. The organization
  map is a surface an administrator ACTS on: move a home, revoke a share from
  its chip, and switch a package on in a space it was never placed in, that last
  one creating the offer with the activation when they hold `<type>:share` in
  the home.

- **The DRAFT belongs to whoever may WRITE the package, and every executable form
  of it now says so — `403 draft_not_writable`.** A head deployment is the
  developer's, the rule Apps Script states. One predicate and one wording gate
  all of it: `?version=draft` on `POST /api/agents/{scope}/{name}/run`, on
  schedule creation and
  update and on `GET /api/agents/{scope}/{name}/connection-readiness`;
  `dependency_overrides: { "@acme/skill": "draft" }` on the run route, the
  remote-run route and both schedule writes, where the authority asked is the one
  over THAT dependency rather than over the agent declaring it; `stage: "draft"`
  on `POST /api/runs/remote`; and `GET /api/agents/{scope}/{name}/bundle?source=draft`,
  because an exported draft is a draft run with the bytes handed over as well.
  **Operators: an API key now needs `agents:write` to export a draft**, which is
  what `appstrate run @scope/agent@draft --local` does — `agents:read` is enough
  for every published export. A schedule is judged when it is WRITTEN and never
  re-judged when it fires, exactly as its frozen `connection_overrides` are. A
  selector left out is still the published `latest` (#636), and still 404
  `no_published_version` when there is none — there is no silent fall-back to the
  draft anywhere.

- **Reading a package is not executing it: a readable package never 404s on its
  detail page.** With no selector named, the page renders the DRAFT for a caller
  who may write the package, the latest PUBLISHED version for everybody else,
  and — when nothing is published at all — the draft in read-only, since hiding
  it would 404 a page the package list had just linked to. `AgentDetail` and
  `OrgPackageItemDetail` both carry the new required field `definition`
  (`"draft" | "published"`) so the reader is told which of the two they are
  looking at instead of inferring it; the SPA renders `definition: "draft"` with
  `home_writable: false` as a read-only banner — the same banner and the same key
  for all four package types — and disables **Lancer** with that reason rather
  than letting the launch fail.
  The readiness badge and the input-settings editor judge the SAME effective
  selector, from the same function, so a badge can no longer contradict the page
  it sits on. `AgentDetail.dependencies.skills[]` gains `home_writable` too, which
  is what decides whether the run and schedule forms offer a per-dependency
  **Brouillon** option at all. The agent and skill hints in `GET /api/me/context`,
  the chat system prompt and the MCP tool descriptions carry the same flag: a
  draft-only package is presented to the model as runnable with `version=draft`
  only when the caller may write it, and as "not yet published, not runnable"
  otherwise.

- **One verb for the whole platform: ACTIVATE and DEACTIVATE, one pair of doors,
  four package types.** `POST /api/spaces/{spaceId}/packages` switches a package
  on in a space and `DELETE /api/spaces/{spaceId}/packages/{scope}/{name}`
  switches it off, for agents, skills, mcp-servers and integrations alike. Both
  are idempotent by construction — the placement row is upserted, so the `POST`
  answers **201** when it put the package on and **200**, with the same body,
  when it was already on. A DEACTIVATION never deletes the row: `enabled = false`, **204**, and the space
  keeps the model, the proxy, the generation settings and the stored input
  values it chose, so switching a package off for a week costs nothing to undo.
  Only revoking the share that placed it removes the row, along with the
  placement. A package that is on with no row at all — a system one, an
  integration the deployment offers — gets one written `false` by the `DELETE`,
  which is what makes that opt-out survive the next run; a package that is not
  on and has no row is a **404** instead, because an offer nobody has taken up
  has nothing to switch off and writing the row would turn a pending offer into
  "switched off", a decision its recipient never made.
  `PUT /api/spaces/{id}/packages/{scope}/{name}` no longer carries `enabled` —
  the body is `.strict()`, so sending it is a 400 — and carries nothing but
  `modelId`, `proxyId` and `generationConfig`, all three under `configure`,
  which is the one grant the personal-space waiver never covers. A guest at home
  therefore switches on and off what was offered to them and never chooses the
  model it runs on: that spends the organization's LLM budget, which is
  precisely what their org role withholds. The permission STRINGS are unchanged
  (`agents:configure`, `integrations:install` / `integrations:uninstall`,
  `<type>:write`): they are rows in `space_roles` and entries in every API key's
  scope list, and renaming a grant is a migration of data, not of code — so no
  role, no key and no custom bundle has to be touched. Audits are
  `package.activated` and `package.deactivated`, for every type.

- **"Active here" has ONE definition, and the placement ROW always wins WHERE
  THE PACKAGE IS PLACED.** A space's row decides — `enabled` or `false` — for a
  package that space HOLDS, homed here or offered here, and the deployment's
  default answers only where there is no row at all: `source = 'system'`,
  narrowed for INTEGRATIONS to the subset `SYSTEM_INTEGRATIONS` names, since a
  deployment ships tens of integration packages and offers only those. The rule
  is written twice and nowhere else (`activeHereSql(spaceId)` for the queries,
  which conjoins the placement filter and states the two LEFT JOINs it expects,
  and `isActiveHere(pkg, row, placed)` for the callers already holding the
  rows), with a table-driven test walking every (type × source × placed × row)
  cell so the twins cannot drift, and every reader asks it: the run gate, the
  caller-context hints, `AgentDetail.active`, the library's `state`, the type
  INDEX pages, the three reads of a space's own placement rows and the
  integration readiness. The placement conjunct rides on
  the ROW branch alone, because the default only ever switches on packages the
  deployment ships and those are placed everywhere by construction, while a row
  is a decision a space made about a package it may since have LOST. So an
  ORPHAN row — no home, no share, the residue `scripts/migration/0016` repairs —
  is active NOWHERE: it is absent from the caller context handed to the model
  and from every type index, the run gate and the scheduler tick refuse it, and
  the space-package listing, detail and resolved run-config read it as no row at
  all rather than handing back the draft manifest of a package the space no
  longer holds. The run gate also carries the organization boundary inside its
  own query rather than leaving it to whatever each caller reads next: a
  boundary held by convention is the one an added caller drops in silence, and
  stating it costs a predicate on an indexed column. **A SYSTEM package is
  switchable per space like any other** —
  `DELETE /api/spaces/{id}/packages/{scope}/{name}` writes it
  a row saying `false` and the space stops running it, sticky across every run
  until somebody switches it back on. An explicit `false` is an operator
  decision the platform must not overrule, and a switch that changes nothing is
  worse than no switch: Figma disables any library, VS Code any extension.

- **A package that is switched off does not run, on every door and in one
  voice.** Deactivating is a real refusal rather than a filter on a listing, so
  the THREE doors that make an agent run mount the activation guard
  (`requireActiveAgent()`) behind the placement one and answer
  `404 agent_not_active_in_space` for an agent placed in this space and switched
  off — `POST /api/agents/{scope}/{name}/run` (a rerun is `rerun_from` in that
  same body, not a route of its own), `POST …/schedules` and `GET …/bundle` —
  with `POST /api/spaces/{id}/packages` named in the detail. `POST /api/runs/remote`
  is the FOURTH door: it reads the same verdict inline, because the resource it
  resolves is a package of any type rather than an agent, and renders the two
  halves apart — its own generic `package_not_active_in_space` for a package the
  space holds and has switched off, and the byte-identical body of a nonexistent
  id for one no placement holds. That route takes a package id straight from the
  request rather than from a path a placement guard has already narrowed, so two
  distinguishable refusals would make it an existence oracle over every package
  the organization owns; the `403 draft_not_writable` of `stage: "draft"` is
  asserted after that verdict for the same reason. An agent this space cannot
  read at all gets the opaque `404 agent_not_found` on the other three, so the
  status is 404 either way and a space holding no placement still learns
  nothing. A SCHEDULE obeys it
  at every FIRE, not only when it was written, and from the SAME executable
  predicate the four execution doors ask (`agentExecutionBlock`: placed here AND
  active here): whether a space runs a package is a property of the space and can
  change after the schedule was authored, so a switched-off agent produces a
  visible failed run naming the switch and the schedule stays ARMED — switching
  the agent back on lets the next tick run it, with nothing to re-enable by
  hand. Without that tick gate, deactivating would have been a filter on the
  pages a human looks at while the agent kept running on the space's credentials
  and the organization's LLM budget. Reading is untouched, deliberately and
  everywhere: every route that says what an agent IS, or how this space has
  configured it, answers 200 with the switch off, and the verdict travels in the
  payload instead — `AgentDetail.active` on the detail, since the index lists the
  ACTIVE set and would answer `true` on every row — which is what lets the SPA
  open a switched-off agent from the library and offer **Activer dans cet
  espace** on its own page instead of letting a call fail.

- **`AgentDetail.active` — the detail answers the execution question itself.**
  Required, the same rule the index filters on, resolved inside the reads the
  handler already performs. A page that has loaded the agent needs no second
  call to learn whether the space runs it, and the page that repairs a
  switched-off agent is exactly the one that must not have to ask twice. The
  readiness answers it too, as data rather than as a status: `GET /api/agents/{scope}/{name}/connection-readiness`
  is a READ, so it answers **200** for a switched-off agent and carries
  `{ field: "agent", code: "agent_not_active" }` FIRST in `errors` with
  `blocks_run: true`, next to `integration_not_active`. Every other entry there
  describes something to configure and none of it can run while the space has
  the agent off, so that one leads — and a 404 would have blanked the very panel
  whose job is to say what blocks the run.

- **Moving a package's home ACTIVATES it in the destination**, through the
  activation DOOR itself and in the same transaction as the move, exactly as
  creating one activates it in the space it was written in. A package lives
  where it is written, and arriving in a space that cannot run it would make the
  move a two-step act with no second button on the page that performed it. Going
  through the door rather than writing the row by hand keeps `space_packages` to
  one writer and gives the act the door's guarantees: an mcp-server whose
  `latest` archive does not parse fails the WHOLE move with the door's `422`
  instead of arriving active and unusable, and the activation is AUDITED like
  any other — `package.activated` with `after: { spaceId, via: "move" }`,
  written only when the destination actually started running the package and
  naming what did it. A destination that had deliberately switched the package
  off keeps that decision, because the move transfers AUTHORITY and decides
  nothing about what a space runs. A home set to `NULL` — the organization
  catalogue — activates nothing.

- **Moving a package's home reconciles the placements it invalidates.**
  `PUT /api/packages/{scope}/{name}/home` now writes, in the same transaction as the
  move, a `package_shares` row for every space that still holds a placement row
  and is not the new home — `shared_by` NULL, because nobody offered
  it; the home did, until this call — and deletes the destination's own share,
  for the mirror image of the reason an offer to the home answers 409
  `share_target_is_home`. Those authorless rows are ordinary shares: `GET …/shares`
  lists them with no author and `DELETE …/shares/{target}` revokes one like any
  other, taking the placement with it. Without this a move left a row nothing
  placed — still running for a schedule, invisible on every page of the space
  running it.

  **One reconciliation, and the offboarding sweeper calls it too.**
  `reconcilePlacementsAfterRehome` is the single function behind every rewrite of
  `packages.home_space_id`, and its second caller is the personal-space sweeper:
  when an orphaned member's space is emptied, a package PLACED in another space
  is re-homed to the organization's DEFAULT space AND offered to each space that
  held a row, in the sweep's own transaction. The default space needs no offer — it
  is the home now — and the package, its draft included, becomes readable there,
  which is what "a package of the organization that belongs to no team" means. Sharing the reconciliation matters most on that
  path precisely because it acts on nobody's request: without it the sweep is the
  one thing in the platform that MAKES the placement rows everything else refuses
  to honour, and a team space keeps running a departed author's agent while
  losing it from every page and failing its cron each tick. The question the
  sweep turns on is PLACED elsewhere — the one placement predicate, so an OFFER
  saves a package exactly as a row does, and only a package no other space was
  ever placed for is deleted with its author's space. Every comparable splits a
  departing member's content on the same axis: Google Workspace transfers the
  SHARED half of a Drive and makes including the unshared files a separate
  opt-in, Figma keeps a draft shared before removal readable by everyone it was
  shared with, n8n makes transfer-or-delete an operator's choice. **No live code
  path creates an orphan placement now**; `scripts/migration/0016` repairs the
  inherited ones.

  Re-importing a bundle whose root is homed elsewhere follows the
  same rule: it activates it WITH an offer when the caller holds `<type>:share`
  in that home, and otherwise reports `root_active: false` and logs the refusal
  at **warn**, because a placement that did not happen is an operator-visible
  fact.

- **New permission `share`** on `agents`, `skills`, `mcp-servers` and
  `integrations` (`@appstrate/core`, additive): held by the `admin` and
  `builder` presets, by no API key (the share decides who runs what with whose
  credentials, so it is session-only like `integrations:configure`), and
  droppable from a custom role by an organization that wants Notion's split of
  authoring from distributing. Every package read now carries a third home field
  beside `home_space_id` / `home_writable`: `home_shareable`, the same predicate
  for `share`, which is what the SPA's "Partager…" action is gated on.

- **Organization setting `restrict_package_copy`** (default `false`). Reading a
  package implies being able to copy it, as in Notion, Drive and Figma. An
  organization may close that: at `true`, `POST …/fork` and
  `GET …/{version}/download` and `GET /api/agents/{scope}/{name}/bundle` require
  `<type>:share` in the SOURCE package's home space (owners and admins when it
  has none) and answer `403 package_copy_restricted` otherwise. Without it,
  personal spaces open "fork it into mine, then share it on" to every reader —
  `share` would protect the link and not the content. **Skills and system
  packages are exempt** on all three: the CLI's skills sync downloads skills
  into a local checkout by design and a skill's audience is already the space it
  is placed in, while a system package is shipped readable in every space of
  every organization and so has no owning space for the setting to protect.
  `/bundle` is the widest of the three and the one to know about: **a
  SERVER-side agent run is unaffected** — it assembles the same bundle and hands
  it to nobody — but `appstrate run @scope/agent --local` downloads one, so
  under a restricted organization it answers `403 package_copy_restricted`. That
  is the flag's meaning rather than a side effect: a copy of the agent leaves
  the platform to perform a local run. Reading a package's files in the file
  explorer stays open in both settings — a screen is not a copy. Toggled from
  the organization's general settings page under `org:settings`.

- **Every member of an organization now has a personal space — "Mon espace".**
  It is created at the moment they join (organization creation, invitation
  accept, SSO auto-provision and first-boot bootstrap all go through one
  `provisionMember` seam, in the same transaction as the membership row, so a
  member without one cannot exist), and `GET /api/spaces` repairs a missing one
  for the caller. It is `private`, holds exactly one member, and is reached by
  its **owner alone** — an organization owner or admin gets a 404 on it, on
  every route: the detail, the members list, the package detail of a draft homed
  there, `PATCH`, `DELETE`, the SSE stream, and a schedule pointed at it. That
  is the whole point: agents, runs, files and chat sessions started there are
  private, and a draft nobody has shared is nobody else's business. The owner's
  own session reaches it, and so does the same person through a CLI device-flow
  or MCP instance token — their own credential by another transport. An **API
  key** and an **end-user** never do: a key is pinned to a space and carries its
  creator's authority, not their privacy, so a key minted into a personal space
  would 404 on every request it made and `POST /api/api-keys` refuses it with a
  409 `personal_space_takes_no_keys` (API keys are team-space only). A role
  preview (`X-View-As`) can neither list nor target one (400). A **guest** who
  owns a personal space holds preset `operator` there rather than `admin`:
  receive and run what is shared with them, not author agents on the
  organization's LLM budget. Only the name is editable: `visibility` or
  `default_role` on it is a 409 `personal_space_immutable`, `DELETE` is a 409
  `personal_space_not_deletable`, and a `space_members` write is a 409
  `personal_space_has_no_members`. Two administrative acts remain — both
  audited, both refused to API keys, and both applying to an **orphaned** space
  only:
  `POST /api/spaces/{id}/convert-to-team` turns one whose owner has LEFT into an
  ordinary team space (it stays `private`), the one way an administrator ever
  reaches inside one, and `POST /api/spaces/{id}/sweep-now` deletes it
  immediately. A live personal space is never convertible, and all three acts —
  those two plus `DELETE` — answer **404 rather than 409** on a live personal
  space that is not the caller's own, an API key included (a key carries its
  creator's authority, not their privacy): a named refusal would confirm that
  the id is somebody's private workspace. Leaving the organization does not delete
  anything: `spaces` gains `orphaned_at`, stamped by the member removal (whose
  audit event now names the spaces it put on the clock), and for 30 days the
  space is listed to owners and admins (`personal: true`, `orphaned_at` set,
  `access: "none"`) so it can be converted, while a re-invite inside the window
  hands it back untouched. During that window a package homed there but
  placed elsewhere is writable by nobody, which is the intended state —
  converting the space ends it early. After 30 days the new hourly
  `personal-space-sweeper` worker empties it — a package it homes moves to the
  organization's default space when another space holds a placement for it, and
  is deleted when it lived only there — and deletes the space with its runs, files and
  sessions. `GET /api/spaces` items carry `personal`, the switcher pins
  "Mon espace" above the team spaces, a personal space's settings hide the
  Members tab and lock the visibility and default-role controls, and the
  organization's Spaces page lists orphaned ones with **Convertir en espace
  d'équipe** / **Supprimer maintenant**. `POST /api/end-users` joins
  `POST /api/api-keys` and the OIDC client registration in refusing a personal
  space (409 `personal_space_takes_no_end_users`): it holds no identity that
  outlives the one member it belongs to. Migration `0064` is shape-only and
  needs no backfill to be correct; provisioning the spaces of members who
  already exist is `scripts/migration/0015-personal-spaces-backfill.sql`, run
  AFTER the deploy is validated — nothing is degraded while it has not run, and
  nothing counts spaces for a quota today, so the count it prints matters only
  to an operator with a per-space ceiling of their own. **This one is a one-way
  deploy**, and from the FIRST BOOT of the new build rather than from `0015`:
  personal spaces exist from the first request served, and an older build's
  resolver reads one as an ordinary `private` space — handing every organization
  owner and admin `admin` inside it, the one thing the feature refuses. Roll
  forward, or restore the coordinated backup; the runbook
  (`scripts/migration/README.md` → "Personal spaces & sharing rollout") states
  the per-file rollback truth.

- **`DELETE /api/spaces/{id}` now refuses a space with runs in progress** —
  409 `space_has_active_runs` while any run in it is `pending` or `running`, for
  every actor including the offboarding sweeper (which logs and retries on the
  next pass). The delete cascade-drops `runs`/`run_logs`, so performing it under
  a live container tore the rows out from under it. Same rule as organization
  deletion, and now literally the same predicate.

- **A package now has a home space, and it alone decides who may write it.**
  `packages.home_space_id` names the space whose `<type>:write` authorizes
  editing, publishing, restoring, renaming and deleting a package; the other
  spaces it is installed in consume it and get no say. A package of the
  organization ALWAYS has one — the CHECK `packages_org_package_has_home`
  (migration **0067**) states it in the database rather than leaving it to every
  writer's memory — and the organization's DEFAULT space is the home of the
  packages that belong to no team: owners and admins reached it already, and a
  builder of the default space gains the write, which is what a default space is
  for. The only rows with no home are the two the constraint names: a SYSTEM
  package (`org_id IS NULL` — a delivery, not a placement) and an inline run's
  `ephemeral` shadow row, which no package route can reach and which a home
  would make blocking for its space's deletion. The home is asked, and
  nothing else: the mutation routes no longer also require the permission in the
  space the request comes from, so an author edits their own package while
  browsing a space where they only read. The routes acting on the _placement_
  — activate, deactivate, configure, per-space settings — keep their current-space
  guard, because that is what they are about. The home is set from the space a
  package is created, imported or forked in — every such path resolves one, an
  org-level MCP bearer landing on the default space — is exposed as
  `home_space_id` on package reads and on `GET /api/library`, and is moved by the
  new `PUT /api/packages/{scope}/{name}/home`, whose `home_space_id` is a REQUIRED
  space id (`null` is a 400) and which requires that permission in both
  the old and the new home (an unreachable destination answers 404). A PERSONAL
  space is never a destination — 409 `home_move_into_personal_space`: a personal
  space homes only what is created or forked in it, and every member but a guest
  holds `write` in their own, so the move would otherwise put a team's package
  beyond every administrator's reach (nobody enters a personal space) for as
  long as its owner stays a member; `POST …/fork` is the private copy. It is a
  read grant too, everywhere: the home is one of the two placements that make a
  package readable (the other is a SHARE), so a draft nobody has been offered —
  or one placed only where its author cannot go — stays visible to them, on the
  detail, in the library and in the file explorer. Reading is still not running:
  that needs an ACTIVE placement in the space it runs in. **Operators:** the
  permission is no longer required in _every_ space where a package is placed,
  which cost an author the edit of their own package the moment someone switched
  it on in a space the author cannot read. A space that
  homes a package can no longer be deleted: `DELETE /api/spaces/{id}` answers
  409 `space_homes_packages` and names them, so moving them stays the caller's
  act — the package page's actions menu carries a **Move to a space…** dialog for
  exactly that, listing the spaces where the caller may author this type.
  Migration **0063** adds the column and **0067** adds the CHECK as `NOT VALID`,
  so it governs every write from the moment it applies while the inherited rows
  are still unbacked: every existing row starts with no home and is therefore
  admin-only until the operator runs
  `scripts/migration/0014-packages-home-space-backfill.sql`, which gives every
  package a home — one installation, the oldest of several, or the default space
  for one installed nowhere — and ends by validating the constraint. It belongs
  between the migrations and bringing the new version up — stop, migrate,
  run 0014 then 0016, start — so nothing serves traffic while non-owner authors
  and API keys are locked out. Rolling 0063 back is safe before 0014; afterwards
  it needs `ALTER TABLE packages DROP CONSTRAINT packages_org_package_has_home`
  and then `UPDATE packages SET home_space_id = NULL`, in that order, because the
  column's `ON DELETE RESTRICT` refuses to delete a space that homes a package
  and an older build has no route that clears a home. The combined
  runbook for 0063-0067 and the scripts is `scripts/migration/README.md` →
  "Personal spaces & sharing rollout".

- **One file editor for agents, skills, integrations and MCP servers.** The
  Files tab stages creation, text editing, upload, replacement, rename and
  deletion until Save. Manifest and files are saved through the existing
  package `PUT`, using one `lock_version`; a stale draft is refused in full
  and local changes remain available. Controls lock during saving.
  Required content files remain protected, and executable file edits validate
  their bundle references. Path checks and file operations are shared by the
  browser and API. Draft saves, restores and imports serialize through the
  same persistence function. Limits: 200 operations, 1 MiB per written file,
  50 MB and 10,000 entries per resulting tree; larger files can be imported
  in an archive.
  Import refuses path collisions without discarding local edits; explicit
  replacement works for text and binary files. Publication captures the row
  and ZIP under the draft lock before validating either, and version overrides
  cannot overwrite a newer draft or reuse an old editor token. Concurrent edits
  remain marked as unpublished; a published version override does not. Buffered S3
  requests have a 30-second deadline, including response-body reads.
  Agent, skill and integration creation forms support the same local file tree.
  New drafts become visible only after their first archive upload succeeds;
  a storage failure leaves the name available for retry. Archive creation shares
  this lifecycle, and an import losing a concurrent creation cannot overwrite it.

- **Two-layer RBAC — an org role, and a role per space.** Organization roles
  gain **`guest`**: an org identity with no implicit reach into any space, for
  outside collaborators. Every space now carries a **visibility** (`open`,
  `closed`, `private`) and a default role, and membership in it is a row of its
  own: a member holds one of four presets (`admin`, `builder`, `operator`,
  `viewer`) or an organization-defined **custom role** — a named bundle of
  space-level permissions, assignable anywhere in the org. An invitation carries
  its **space assignments** with it, so an invitee lands with the access they
  were invited for; an email may hold at most one pending invitation per
  organization, and a second is refused rather than silently replacing the
  first. Every permission is org-level or space-level, so a space-level grant
  can never be satisfied outside a space. Grants hold when they change, not only
  when they are read: a scheduled run rechecks its actor's `agents:run` in the
  space at every fire and disables itself once it is gone, an invitation is
  consumed with the role and assignments current at its atomic claim, and a
  space grant serializes with the removal or promotion of the same member.

- **A fifth space-role preset — `runner`, for people who launch without
  reading.** It holds `agents:run`, its own runs (`runs:read`, `runs:cancel`),
  `files:read`, `persistence:read` and its own integration connections
  (`integrations:read/connect/disconnect`), plus chat and MCP so the friendly
  surfaces work. It does **not** hold `agents:read`, `skills:read`,
  `mcp-servers:read`, `schedules:read`, `end-users:*`, `runs:read-all` or any
  `:write`: a runner starts what someone else built, sees what its own runs
  produced, and never reads the agent's content, its skills or anyone else's
  runs. What makes that usable is that `agents:run` carries a **summary read**
  of the agent: the list, the detail and the resolved model answer a runner with
  what the launch form needs — the parameter schema with its unlocked stored values and
  locked field names, the output shape, the enforced timeout, the caller's own run
  counters, and the integrations the agent talks to, which a runner is the one
  who connects — and omit the manifest, the prompt, the authoring history, and
  the skills and MCP servers the agent is built from. Every other agent route,
  and every skill or MCP-server route, still answers 403. It is a preset and not a custom role on purpose —
  custom roles need the `custom_roles` feature, and this reach has to exist on
  the open-source build as a code constant. Assign it wherever the other four
  are offered, including as a space's default role. In the dashboard, the
  sidebar entries and the routes ask for the permission their page needs — so
  the agent and skill editors now refuse a caller without `agents:write` /
  `skills:write` up front, instead of opening a form whose save would answer 403. The presets stop being a
  single ladder here: `runner` and `viewer` grant things the other does not, so
  neither is "above" the other. Migration **0060** rewrites the three space-role
  CHECK constraints — two widen to admit `runner`, the third narrows
  `space_roles.key` so a custom role cannot shadow the preset — and it carries
  no pre-flight, no guard and no `RAISE`. There is nothing to count: the preset
  and the constraint reserving its key arrive in the same batch, so the only row
  the narrowing could refuse — a custom role keyed `runner`, defined before the
  key was reserved — is structurally impossible, and a guard over it would be a
  `RAISE` no database can reach. Were one ever to exist, it surfaces as a bare
  `23514` naming `space_roles_key_not_preset`, which is the correct failure for
  a state nothing can produce. Applied automatically at boot, no operator step.

  **API consumers**: `dependencies.skills`, `dependencies.mcp_servers` and
  `forked_from` are optional on the agent DTOs from now on — a summary read
  omits a withheld group rather than emptying it, and `skills: []` would say the
  agent declares none, which is false rather than unknown. A loosening like this
  is not a breaking change and `detect:breaking` does not classify it, so it is
  written out here. Without `agents:read`, registered-agent run responses also
  return `input: null` so editor-imposed values remain private even after locks
  change or the agent is reinstalled. Dashboard reruns replay the prior input
  server-side with `rerun_from`, preserving the original version; inline inputs
  remain visible.

- **Role preview — see the product as a role before you assign it.** An owner or
  administrator can have every request answered as a lesser persona (an org role,
  optionally with a role in one space) from Org settings → Roles or Space
  settings → Members. It is enforced by the server, not hidden in the UI: what
  the previewed role cannot reach, the previewing administrator cannot reach
  either, on the API, on the realtime streams and inside a chat turn's tool
  calls. A permanent banner names the persona and carries the only exit, the
  audit trail keeps the real actor beside the persona, and the preview is
  dropped rather than silently ignored the moment it stops being valid.

- **`anthropic-compatible` model provider** — a second custom-endpoint entry in
  `core-providers` next to `openai-compatible`, for any self-hosted or
  third-party endpoint speaking the Anthropic Messages API (LiteLLM proxy, …).

- **`POST /api/model-provider-credentials/discover`** — asks an endpoint for
  its listing (`GET <base_url>/models`), follows the listing's own cursor when
  it declares one (Anthropic `has_more` / `last_id`, Google `nextPageToken`) up
  to 10 pages or 1000 models, and returns the ids it serves,
  each described from the fields the listing publishes (vLLM `max_model_len`,
  Mistral `capabilities`, OpenRouter `context_length` / `architecture` /
  `top_provider` / `supported_parameters`, LM Studio `max_context_length`) and,
  for the rest, from the vendored pricing catalog (the provider's own, then any
  by exact id, then by the id with one leading `<vendor>/` stripped); `source`
  says which described it, `label` is catalog-only, an id in no catalog comes
  back all-null. Takes an existing `credential_id` or an inline `provider_id` +
  `api_key` (+ `base_url_override`), so the model form can list a custom
  endpoint before its credential exists. `truncated` says when a page or model
  cap stopped the read, so a partial view never passes for a whole one. It
  persists no model state — no credential is created, no `available_model_ids`
  is written — while the probe itself IS recorded in the audit trail
  (`model_provider_credential.discovered`: the endpoint reached and what came
  back, never the key), since it spends a key on an operator-supplied URL. It
  never echoes the key, refuses OAuth providers
  (`docs/architecture/SUBSCRIPTION_COMPLIANCE.md`),
  and never returns a per-token cost: an endpoint serving a vendor's model id is
  not billed at the vendor's rate. Rate limited to 6/min behind
  `model-provider-credentials:write`.

- **The runtime container e2e now runs one inference turn through the BUILT
  pi + sidecar pair (#1197).** `runtime-pi/test/inference-container.e2e.test.ts`
  launches both images on a private Docker network — the agent reaching the
  sidecar on its `sidecar` DNS alias, exactly as the platform wires them — and
  drives a single Codex OAuth turn against a stub upstream on the host. It
  asserts what actually arrives there: one `POST /codex/responses`, the real
  subscription bearer swapped in and the container's placeholder JWT present in
  no header, Pi's own `chatgpt-account-id` / `originator` / `OpenAI-Beta` /
  `User-Agent` fingerprint forwarded verbatim, the container→sidecar-only
  `x-appstrate-sidecar-auth` header stripped, and the `content-encoding: zstd`
  body decompressing and parsing — which is the byte-identity witness a
  mismatched pair cannot produce (#1195 was an older sidecar text-decoding that
  frame; both halves were individually correct and every in-process test stayed
  green).

### Changed

- **Custom space roles are open-source.** Defining a bundle, editing one,
  granting one and previewing one no longer ask for the `custom_roles` feature
  flag, which `@appstrate/module-ee` contributed and which the platform's own
  `/api/roles` write routes read. The whole surface was already Apache-2.0 code
  sitting in core; what has been deleted is the licence check over it. A
  deployment running `MODULES=none` now defines, edits, grants and previews
  custom roles, and `apps/api/test/integration/modules/zero-footprint.test.ts`
  — which mounts zero modules — is where that is asserted, because those four
  calls answered `403 feature_unavailable` before.

  The presets (`admin`, `builder`, `operator`, `runner`, `viewer`) are
  unchanged, and so is the authorization: `roles:write` and `roles:delete` are
  owner/admin org permissions, `canGrantSpaceRole` still forbids handing out
  permissions the caller does not hold in that space, and a bundle from another
  organization is still not found. Those are now the WHOLE gate — an org
  `member` is still refused, with `code: "forbidden"`.

  **API:** the `feature_unavailable` refusal is gone from the platform. It had
  exactly one producer, so the `403` of `POST`/`PATCH /api/roles`,
  `POST`/`PATCH /api/spaces/{id}/members` and the two invitation routes is now
  the ordinary `forbidden` response, with no `feature_unavailable` example
  declared. A client branching on that code will never see it again; the
  requests that raised it now succeed. `GET /api/spaces/{id}/roles` is
  filtered by the caller's permissions alone, so it offers bundles on every
  deployment. No migration, no stored state: the flag was computed at boot and
  never persisted, and the change only ever widens what an existing row allows.

  **Operators:** a `MODULES` list naming `@appstrate/module-ee` keeps working
  untouched — the module declares `features: { billing: true }` and nothing
  else. Nothing in an `.env` has to change.

- **BREAKING (API): asking what an agent IS and asking whether it RUNS are two
  guards now, and only the second one refuses.** `requireAgent()` loads an agent
  by the PLACEMENT rule — homed here, offered here, or shipped with the
  deployment — and raises one refusal, the opaque `404 agent_not_found`;
  `requireActiveAgent()` asks the activation and is mounted behind it by the
  three execution doors alone. So a switched-off agent placed in this space now
  answers **200** on `GET …/model`, `/proxy`, `/persistence`, `/runs`,
  `/schedules`, `/connection-readiness` and its detail, and on the writes beside
  them — `PUT …/model`, `/proxy`, `/input-settings`,
  `PUT /api/spaces/{id}/packages/{scope}/{name}`, `DELETE …/runs`,
  `DELETE …/persistence`. Those are the acts of somebody about to switch the
  agent back on, and the single guard that answered the execution question for
  all of them broke the very page carrying the switch: the SPA's detail view
  threw on its own model and readiness calls. The activation gate carries a
  handler marker, so the list of routes that ask the execution question is read
  off the route table by a conformance test rather than asserted in a comment.
  One tightening travels with the split: the placement rule is now the ONLY way
  in, so an ORPHANED `space_packages` row — no home, no share, the state
  `scripts/migration/0016` repairs — no longer opens the agent routes either.
  The detail route already refused it; the two now speak with one voice.

- **BREAKING (CLI): `appstrate skills sync` reads the ACTIVE skills of a space,
  not merely the placed ones.** The plan reads
  `/api/packages/skills`, which IS that active set, so a skill switched off in a
  space is not
  written into the Claude Code plugin, `~/.claude/skills/` or `~/.agents/skills/`
  from it — which is what the switch means everywhere else: activation governs
  what a space OFFERS. Switching one back on brings it back at the next sync,
  since the sync re-reads that list every time.

- **The three doors are the only things that CREATE a `space_packages` row.**
  Activate, deactivate, configure — nothing else inserts it. The row is deleted
  by exactly two callers, neither of which is a door: `revokePackageShare`
  (`services/package-shares.ts`), which drops the share and the row behind it in
  one transaction, and the `keep: false` branch of
  `reconcilePlacementsAfterRehome` (`services/package-placement.ts`), which
  empties the old home a `PUT …/home {"keep_in_previous_home": false}` released.
  And one caller UPDATES a column in place on a row that is already placed —
  `setBlockUserConnections` (`services/integration-pins-service.ts`) writing
  `block_user_connections`. The per-space
  integration settings route (`PATCH /api/integrations/{id}/settings`,
  `block_user_connections`) has to materialise a row for an integration the
  deployment offers with no row yet; materialising one IS activating, so it goes
  through the activation door in its own transaction and inherits that door's
  verdict — a package the door would not activate here rolls the whole call back
  into the 404 it always answered — and writes no audit, because the door
  reports the package was already active and `package.activated` is written only
  when the answer moves. And **configuring never activates**: `PUT …/model` on a
  package merely OFFERED here answers `404 … is not active in this space`, from
  the same function as the `DELETE`'s third branch, instead of creating a row
  that would have meant "on" without the placement rule, without `<type>:share`
  and without a trace.

- **The library never hides a real placement row.** A personal space is still
  never OFFERED the deployment's integrations — an offer into somebody's own
  space is somebody else's act — but that skip now applies only to the
  placement that would have existed by construction alone. Once the space holds
  a `space_packages` row the map renders it like any other (`via: "system"`, and
  `state` from the one activation rule), because a row is a decision its owner
  made, and hiding it hid both that state and the switch that undoes it.

- **BREAKING (API): the three per-space package doors refuse an unreachable id
  in the SAME words.** `POST /api/spaces/{id}/packages`,
  `PUT /api/spaces/{id}/packages/{scope}/{name}` and its `DELETE` all run the
  catalog read before they look at anything else, so a package id the caller
  cannot reach — one homed in another member's personal space — answers exactly
  the 404 an id that does not exist answers, body for body. Two different
  `detail` strings made the doors an existence oracle for packages living in
  spaces a member's privacy says do not exist for the caller.

- **BREAKING (API): `shared_by` names a sharer only while they are still a
  member of the organization.** Both `GET /api/packages/{scope}/{name}/shares`
  and the library's `placements[].shared_by` reach the name THROUGH the
  organization's membership rows rather than through the user table, so a former
  member's name is not something a share listing can hand back. The offer itself
  survives untouched — only the attribution goes `null`, which is already the
  shape a share created by a home move carries.

- **BREAKING (API): readiness judges a declared skill by PLACEMENT, and the
  message names the repair.** `resolveDeclaredSkills`
  (`services/package-catalog.ts`) resolves the skills an agent declares through
  `placementReadFilter` + `placementShareJoin`, anchored on the home of the
  package that DECLARES them — the same placement rule every other read of a
  package obeys. So a skill that is published but homed in another space, and
  never shared with the agent's home, does not resolve, and readiness answers
  `missing_skill`. The wording it replaces asserted an INSTALLATION (`is not
installed`), an act that no longer exists; the message now states both
  repairs, because publishing alone is not one of them:
  `Required skill '…' is not available to this agent — publish it, or share it
with the agent's home space`. What a space's ACTIVATION governs is something
  else entirely — what that space OFFERS: the caller-context hints, the
  integration credentials a run may reach, the type index pages.

- **The AFPS §7.7 warnings are named for when they happen: `import-time`.**
  `services/integration-import-warnings.ts` and
  `services/agent-import-warnings.ts` (both renamed), their OpenAPI descriptions
  and the `warnings` array on `POST /api/packages/import-bundle` all say
  import-time — the moment those checks actually run. Nothing about placing a
  package produces them.

- **BREAKING (API): an index lists what the space can LAUNCH — the ACTIVE set,
  and nothing else.** `GET /api/agents` and
  `GET /api/packages/{agents|skills|mcp-servers|integrations}` read one rule,
  `activeHereSql(spaceId)`: placed here and switched on, or shipped here with no
  row saying otherwise. It is the same expression the run gate and the
  caller-context hints the chat and `get_me` serve read, so a page cannot offer
  a control the doors would refuse, and a launcher is never rendered greyed. Two
  questions, two pages: what is PLACED here and in what state is **Packages de
  cet espace** — the library — which carries the origin, `Proposé` / `Désactivé`
  / `Actif`, and one switch per row. Taking up an offer, switching a package
  back on and switching a shipped integration on all happen there; the index
  never shows a pending offer or a switched-off row, and its empty state names
  the library. A switched-off package is still fully reachable: its detail
  answers 200, opens from the library or from its URL, stays editable by
  whoever holds its home's `write`, and carries a one-line **Désactivé dans cet
  espace** banner with an **Activer** button. `GET /api/agents` is served by
  `listActivePackages` — named for what it returns — and `listOrgItems` answers
  for the other three types from the same predicate.

- **BREAKING: every read of a package answers with ONE definition.** The file
  explorer — `GET /api/packages/{scope}/{name}/files` and `…/files/content` —
  and the detail pages of skills, integrations and mcp-servers —
  `GET /api/packages/{skills,integrations,mcp-servers}/{scope}/{name}` — no
  longer serve the draft to every reader. With no `?version` they answer the
  same effective selector the agent detail page renders
  (`defaultDefinitionSelector`: the draft for a caller who may write the
  package, the latest published version for everybody else, and the draft when
  nothing is published at all), and an explicit `?version=draft` is the author's
  act it is on every other route, refused to everybody else with
  `403 draft_not_writable`.

  The explorer was the last door where the word `draft` bought bytes the run
  route refuses, and the widest one per request: a caller who loops the index
  has the working copy on disk. **For the CLI, the draft sync is the author's
  sync**: `appstrate skills sync --source draft` now needs write authority, and
  the default `--source published` is unchanged for everyone.

  The three detail pages were not an escalation — reading a draft is open to
  every reader of the package by design — but they made the question have two
  answers: the Content tab of a published skill showed the author's working
  copy while its own Files tab, in the same second, showed the published bytes.
  `content`, `manifest` and every field projected from the manifest (`name`,
  `description`, `version`, `manifest_name`) now move together with the new
  required `OrgPackageItemDetail.definition`; these three routes gain the
  `?version` selector the agent detail already had, with the same
  `draft_not_writable` refusal and a `422 version_artifact_unavailable` for a
  published archive whose primary file cannot be read. A mutating call echoes the
  draft it just wrote, and a SYSTEM package reports `definition: "published"` —
  its stored tree IS the definition the platform ships — while still refusing a
  named `draft` like everybody else's.

- **A draft export resolves its dependencies exactly as a draft run does.**
  `GET /api/agents/{scope}/{name}/bundle?source=draft` puts the agent's DRAFT
  at the root — the half `agents:write` gates — and every transitive
  dependency at the PUBLISHED version its manifest range selects, against the
  published catalogue. That is what a server-side `version=draft` run without
  `dependency_overrides` executes, and an export answering anything else
  handed the CLI different bytes from the ones the platform runs: the closure
  used to be walked against draft state, so exporting shipped the working copy
  of a skill the run route refuses in the same request. A dependency no
  published version satisfies now fails the export the way it fails the run —
  the same `422 dependency_unresolved`, naming the dependency — instead of
  falling back. Running a dependency's working
  copy stays the one act that says so, `dependency_overrides`, with its own
  write gate.

- **A `dependency_overrides` key that names no declared dependency is a `400`,
  not a `403`.** Whether the key means anything at all is decided against the
  EFFECTIVE manifest — the definition the launch will execute — before whose
  working copy it would have been, on `POST /api/runs`,
  `POST /api/runs/remote` and both schedule writes. A typo in a dependency id
  otherwise came back as `403 draft_not_writable`, sending its reader after a
  grant they do not need for an act the launch would never have performed.

- **Re-sending a schedule's stored selector is not asking for it again.**
  `PUT /api/schedules/{id}` judges `version_override` and each
  `dependency_overrides` entry only when the body CARRIES the field and its
  value DIFFERS from the one the row holds. A holder of `schedules:write` can
  therefore edit the cron or the input of a draft schedule they did not
  author, and it is MOVING a schedule onto the draft — or onto a dependency's
  draft — that asks for `<type>:write` and can answer
  `403 draft_not_writable`. Creation judges whatever is present, there being
  no stored value to compare against. The schedule form sends
  `version_override` only when it moved, so the refusal that remains is a
  refusal of something the editor actually asked for.

- **A package read no longer publishes its home space's id to callers who
  cannot see that space.** `home_space_id` on `AgentDetail`, `OrgPackageItem`,
  `OrgPackageItemDetail` and `GET /api/library` is now the home's id **only when
  the caller reaches that space**, and `null` otherwise — so a package homed in a
  member's personal space and shared into a team space no longer hands
  everyone in that team the id of a private workspace. Each of those four shapes
  gains **`home_writable: boolean`**, the server's own verdict on whether this
  caller may write the package (the exact predicate the write routes enforce).
  Read `home_writable`, never the id, to decide whether to offer an edit: the
  dashboard now does exactly that, and its client-side derivation of write
  authority is gone.

- **One archive-path rule, everywhere a package's files are written or read
  back.** Importing a ZIP already dropped an entry named with a `..` segment, an
  empty segment (`dir//file`, a leading or trailing `/`), a backslash, a `\0` or
  the `__MACOSX/` prefix; it now also drops one carrying a `.` segment
  (`./notes.md`) or a Windows drive prefix (`C:/notes.md`). Those two were
  already refused by `appstrate skills sync` when it writes the file to disk, so
  a package could hold a path the platform accepted and the CLI called
  malformed — which failed the whole sync, not just that entry. The write route
  refuses the same set outright (`400`), and the CLI reads the rule from the
  platform instead of restating it.

- **`runs:read` now means the runs you launched, and nothing else.** Your manual
  runs and the runs of your own schedules — not a colleague's, not an
  end-user's. The space-wide view is a permission of its own, **`runs:read-all`**,
  held by the `admin` and `builder` presets and grantable to a custom role or an
  API key; the `operator` and `viewer` presets do not hold it, so **an existing
  operator stops seeing other members' runs**. It narrows every surface a run
  reaches — the run list, an agent's run list, run detail, logs, cancel, the
  in-flight counts and `last_run` on the agents pages, a schedule's run list,
  `rerun_from` (replaying a run returns its input), the run outputs in the file
  gallery, and the realtime streams (`run_update`, `run_log` and `run_metric`
  carry only your runs, and the single-run stream refuses one you may not read)
  — and a run you may not read answers `404`, never `403`. Bulk-deleting an
  agent's runs takes `runs:read-all` alongside `runs:delete`: it spans the whole
  space. The three realtime channels now answer one uniform rule: the `run_log`
  and `run_metric` payloads carry the run's actor, which the log channel had no
  way to read before and so could not gate on at all.
  `GET /api/runs?user=me` is now strictly your own runs for every caller,
  end-user and actor-less runs included, whether or not you hold `read-all`,
  and composes with the other filters (`kind`, `status`, dates,
  `chat_session_id`) instead of ignoring them.
  Attaching a file to a chat reads as wide as the gallery you picked it from:
  `ChatAttachmentRequest.permissions` (`@appstrate/core/chat-contract`) carries
  the caller's set, so a `runs:read-all` holder attaches a colleague's run
  output and everyone else attaches only their own.

  **OPERATOR ACTIONS.** The `run_log` gate lives in a trigger body the API
  installs at boot (`createNotifyTriggers`), not in a migration, so a replica
  still running the previous version re-installs the actor-less body and the new
  replicas then drop every `run_log` frame for a subscriber without
  `runs:read-all` — silently, and fail-closed. Deploy every API replica in one
  step; a single-replica deployment is unaffected.

- **The commercial module stores its tables in the platform database.**
  `@appstrate/module-ee` does not run a PostgreSQL database of its own: it reads
  `DATABASE_URL`, opens its own pool on it and migrates its seven `ee_*` tables
  there at `init()`. Two
  journals in one database — it records what it applied in
  `drizzle.ee_migrations` and never writes the platform's
  `drizzle.__drizzle_migrations`, so the Apache-2.0 schema in `packages/db`
  still declares no `ee_*` table and the licence boundary has not moved. One URL
  to back up and one to restore, and no auto-created database whose failure mode
  was a wrong name silently starting every organization on an empty free plan
  while Stripe kept charging them. The module needs PostgreSQL outright: under
  tier 0 (PGlite, no `DATABASE_URL`) it refuses to start, naming `DATABASE_URL`.
  Its remaining variables are the four `STRIPE_*` and the four
  `EE_RECONCILIATION_*` (`INTERVAL_SECONDS`, `BATCH_SIZE`, `REPLAY_WINDOW`,
  `MAX_GAP_SECONDS`).

  **OPERATOR ACTIONS.** None of its own: this entry and the in-tree move below
  ship together, so a deployment coming from `@appstrate/cloud` has ONE upgrade
  path and it is written out under that entry. A new deployment needs nothing.

- **The commercial module moved into this repository as `packages/module-ee`,
  under its own licence.** The `appstrate/cloud` repo no longer holds code: the
  Stripe billing, credit quotas, usage metering and billing managers now live in
  the public tree, source-available under `packages/module-ee/LICENSE` rather
  than Apache-2.0 (`bun run verify:license-boundary` enforces the split file by
  file). It is still opt-in and still inert when absent from `MODULES` — the
  specifier is now `@appstrate/module-ee` — and it ships inside the single
  `ghcr.io/appstrate/appstrate` image, so there is no second image, no separate
  release, and no `@appstrate/core` peer range to keep in lockstep
  (`workspace:*`). `CLOUD_DATABASE_URL` disappears rather than being renamed —
  the module reads `DATABASE_URL` (the entry above) — while
  `CLOUD_RECONCILIATION_{INTERVAL_SECONDS,REPLAY_WINDOW,BATCH_SIZE}` become
  `EE_RECONCILIATION_*`. The module's own migration `0005_rename_ee_tables`
  renames its seven tables off the `cloud_` prefix for a database that runs the
  chain — a fresh install — with every index and constraint Postgres had named
  after them; an existing deployment's rows reach the `ee_*` names through the
  move below instead, which is why that move accepts a `cloud_*` source.

  **OPERATOR ACTIONS.** One path, for a deployment coming from
  `@appstrate/cloud`; a new one needs none of it. Rehearse all of it on a
  restored copy of both databases and note the per-table counts. Stop the
  platform (let the running runs drain) and `pg_dump` the billing database as
  the safety net. **Do not touch `MODULES` yet**: the build still in service
  does not carry `packages/module-ee`, so naming it is fatal to that build
  exactly as `@appstrate/cloud` is fatal to the new one — every declared module
  is required, the loader throws, and the container crash-loops without binding
  a port. It is swapped at the END, with the new image, and
  `scripts/migration/README.md` step 5a is where the runbook puts it.
  Move its rows into the platform database with
  `bun scripts/migration/0010-ee-tables-into-platform-db.ts --apply`,
  `EE_SOURCE_DATABASE_URL` = the EXACT value `CLOUD_DATABASE_URL` held and
  `DATABASE_URL` = the platform database; without `--apply` it only counts, and
  a dry run first is the point. A `cloud_*` source at migration level `0003` is
  the expected shape — it detects the prefix, copies the columns both sides
  share (`billing_email` and `billing_cc` take their defaults, `ee_billing_managers`
  copies nothing), migrates the target and copies in one transaction, then
  prints a per-table source/target count that must be the rehearsal's. It
  refuses (exit `1`, nothing written) a source mixing both prefixes, an
  `ee_`/`cloud_` table it does not move, a source column the target does not
  declare, or a target already holding `ee_*` rows — so a second `--apply`
  refuses rather than double-counting; a missing variable exits `2`. Then delete
  `CLOUD_DATABASE_URL` and, if they were set, re-spell the three
  `CLOUD_RECONCILIATION_*` keys `EE_RECONCILIATION_*` or they silently revert to
  the defaults (`300`, `200`, `100`); the four `STRIPE_*` keys are unchanged.
  `EE_DATABASE_URL` never existed in a release — do not set it, nothing reads
  it. The cutover is verified by the script's own per-table count table, which
  must read source = target on every row. Deploy, then check the boot log for
  `Module loaded` with `"id":"ee"` and `billing sweeper started`, and that
  `select count(*) from drizzle.ee_migrations` on the platform database counts
  as many entries as `packages/module-ee/drizzle/migrations/meta/_journal.json`
  holds — read the journal rather than a number written here; it is eight today
  (`0000_init` … `0007_bigint_cost_credits`). Keep the old database read-only
  (`REVOKE`) for a week, then `DROP DATABASE`; until
  that drop the rollback is the previous image with `CLOUD_DATABASE_URL`
  restored, losing only writes made on the platform copy after the cutover.

- **A key is renamed through its edit dialog only.** The inline click-to-edit
  label in the credentials table is gone (`InlineEditableLabel` deleted).

- **A custom-endpoint credential is named after its host.**
  `POST /api/model-provider-credentials` without a `label` defaults to
  `<host> · <provider display name>` (`localhost:11434 · OpenAI-compatible
(custom)`) when a `baseUrlOverride` is supplied; deduplication unchanged.

- **The model form is one arrangement for every provider: pick the provider,
  describe the endpoint, then pick or type the model.** `baseUrlOverridable`
  puts the "Type d'API" and base URL on screen (every such entry collapses
  into one "Endpoint personnalisé" picker row); `authMode` decides key or
  connection. The endpoint block is shared with the credentials tab. The model
  step is one searchable checkbox list for every provider — `catalogue` /
  `endpoint` badge, "Tout sélectionner", "Ajouter N modèles" — fed by the
  vendored catalog ("Recommandés" / "Tous les modèles"; filtered by what the
  plan serves for a subscription), the OpenRouter live search, or "Détecter
  les modèles" for a custom endpoint. A catalog pick is created from its id
  alone, so the weekly catalog refresh keeps reaching it; a detected or
  searched row ships what described it (OpenRouter rate included).
  "Configurer manuellement" types the id in (not for a subscription). An edit
  is always the typed-in arrangement, provider locked, credential as a chip.
  The `__custom__` model sentinel and the OpenRouter combobox are removed.

- **Several models at a time.** One `POST /api/models` per checked row against
  the one key they share (created first when typed inline). A refused model
  keeps the dialog open with the failed ids checked; a retry binds to the key
  already created. The "Mes clés" picker of an overridable provider lists every
  key saved for it, whatever URL is typed, and picking one fills and pins the
  base URL. The credentials list's `providerId` is documented as always set for
  a `custom` credential.

- **Limits and capabilities behind one toggle, "Définir moi-même les limites
  et capacités".** Off, a sentence states the two ends of the fallback chain the
  server actually walks — the catalog entry when the model is known, the runtime
  defaults otherwise (128k context, 16k output tokens, text only, no reasoning).
  The row override in front of them is not spelled out, because a row with an
  override is exactly the row that opens the toggle ON. On, every field ships,
  an unticked box included. On an edit, toggle off or a blanked limit sends
  `null` and drops the stored override. The
  toggle opens on only when the row differs from its catalog entry, so a
  catalogued model never gets the catalog's numbers frozen as overrides. The
  "Avancé" fold and its "détection automatique du SDK" copy are removed.

- **Model discovery lists the provider's models in one guarded pass.**
  `discoverAvailableModels` sends a guarded `GET <base_url>/models`
  (`listServedModels`) and follows that listing's own cursor for as long as it
  declares one — at most 10 pages or 1000 models, and `truncated` when either
  cap cut the read short. Each page is parsed per
  `apiShape` (`{ data: [{ id }] }`, or `{ models: [{ name: "models/<id>" }] }`
  for the Google shapes), and it persists the discovery candidates present in it
  as `available_model_ids`. An auth failure, an unreadable listing, a 429 that
  survives one retry, a listing a page or model cap cut short, or an empty
  intersection leave the previous list untouched — intersecting against a
  partial view would drop the candidates sitting past the cut.

- **Wire change** — `POST /api/model-provider-credentials/{id}/refresh-models`
  answers `candidate_count` in place of `probed_count` (the candidates
  considered; static providers report theirs instead of 0).

- **`appstrate self-update`, `scripts/bootstrap.sh` and `scripts/bootstrap-runner.sh`
  resolve "latest" by listing GitHub Releases and picking the newest platform
  `v<semver>` one, never through `releases/latest`.** GitHub's "latest" is
  whichever non-prerelease Release was created last, whatever its tag; the
  `make_latest: false` on the npm workflows (`cli@`, `core@`, `afps-shared@`)
  keeps it correct only as long as every future workflow and every hand-made
  Release remembers the flag. The consumers now filter by tag themselves
  (drafts and prereleases skipped, as before), so a stray Release can no
  longer point an update at assets that do not exist. The two halves walk the
  list differently, on purpose. The shell scripts read pages of 30 (5 at most)
  and stop at the FIRST page holding a `v*` Release, taking it in creation
  order — no `sort -V` on macOS, and the rendered installer pins its version
  anyway. The CLI reads pages of 100 (2 at most) and does not stop at the first
  page carrying a candidate: it collects every page, then takes the HIGHEST
  version across all of them, because creation order and version order diverge
  whenever a hotfix is cut for an older line — so the first page holding a
  candidate can hold the lower one, and such a hotfix is not "latest". The CLI
  names the releases it skipped when no `v*` one is found; `releaseUrls` no
  longer has a `latest/download`
  branch because nothing reaches it any more.

- **BREAKING (API keys): `GET /api/schedules/{id}/runs` asks for a run-read
  permission on top of `schedules:read`.** The response names schedules but
  every field of a row is a run — input, result, checkpoint, error, context
  snapshot, cost — and `schedules:read` alone is a legal, grantable scope set,
  so a credential holding only it read the full enriched run projection. Without
  `runs:read-all` a colleague's schedule now lists nothing, the same predicate
  every other run list follows.

- **BREAKING (API keys): `POST /api/profiles/batch` asks for `members:read`.**
  Resolving user ids to display names IS the org directory, read one page at a
  time, so it carries the permission the member list carries. A `guest` — the
  org role defined as "member reads minus `members:read`" — put names on ids and
  learned membership from which ids came back empty. Re-mint a key that needs
  the lookup with `members:read`.

- **BREAKING: the per-space SMTP and social-provider routes ask for membership
  of the space they name.** They address one space by path param but sit outside
  the space-scoped prefixes, so no space context ran for them and a token
  holding only `spaces:read`/`spaces:write` reached any space in the
  organization. They now enter the named space through the core seam (404
  outside the org, 403 `not_a_space_member`, 404 for a `private` space) and take
  the space-level `space-settings:write`, the same permission
  `PATCH /api/spaces/{id}` takes. A space-pinned API key is held to its own
  space first, since its membership resolves from its creator.

- **BREAKING: a creator's own `keep` / `delete` right over a file is capped by
  the credential the request arrives on.** Ownership is not a role grant, so
  `permissions` never bounded it and a key minted without `files:delete`
  inherited its creator's whole file lifecycle. A cookie session stays
  unbounded; an API key or token keeps the right only while its scopes name
  `files:delete` — which the `operator`, `runner` and `viewer` presets do not
  carry, and which the end-user JWT scope set no longer admits, so an end user
  no longer deletes its own upload. The file DTO's `capabilities` reports the
  same ceiling the two enforcement points apply.

- **Eleven agent routes prove the permission before they resolve the agent.**
  `requireAgent()` answers 404 on an unknown agent, so running it first told a
  caller with no `agents:read` at all whether a given agent exists — a
  403-vs-404 oracle over a space's private catalog. The permission middleware is
  registered first on every one of them now, so such a caller gets 403 whatever
  name it asks for. Pinned by
  `test/integration/middleware/agent-lookup-permission-order.test.ts`.

- **Operators: count duplicate `org_models` bindings BEFORE the drizzle batch,
  and run `scripts/migration/0013` if there are any.**
  `0062_org_models_unique_binding` adds a partial unique index over
  `(org_id, credential_id, model_id)` for un-aliased rows, so a database already
  holding a duplicate cannot take the batch — the `CREATE UNIQUE INDEX` raises
  23505 and rolls every pending migration back. `0013` keeps the oldest row of
  each binding and repoints the org default, the space package, the schedule
  override and `llm_usage.model` at it in one transaction. Most installations
  count zero and never run it; the count query is in
  `scripts/migration/README.md`. From this release the two model writes answer
  `409 model_already_added` (carrying `existing_model_id`) instead of minting a
  second row. Aliased rows stay exempt — several aliases over one backing model
  is the alias pattern working, and their spend is meant to report apart.

- **Operators: the two billing-sweep knobs share one read budget, and the module
  refuses to boot above it (`@appstrate/module-ee`).**
  `EE_RECONCILIATION_BATCH_SIZE + EE_RECONCILIATION_REPLAY_WINDOW` must not
  exceed 1000, the platform's `usage.list` ceiling: a pass reads the replay
  window ON TOP of the batch, so a larger sum does not read more — it shrinks
  the forward slice below the batch size, which makes raising the batch to clear
  a backlog lower throughput with nothing saying so. Refused at boot rather than
  clamped for exactly that reason. New optional
  `EE_RECONCILIATION_MAX_GAP_SECONDS` (default 86400, `0` disables) bounds how
  long the sweep may have been absent before it refuses to resume over the gap
  it left, rather than billing a whole disabled window against today's quotas.

- **`appstrate logout` ends non-zero when the OS keyring keeps its copy of the
  token.** Every cleanup step still runs — the credentials file is cleared, the
  profile deleted, the synced skills taken off the disk — and the keyring
  refusal is printed with its remedies; the exit code is what lets a script
  chaining on `appstrate logout` tell a completed sign-out from one that left a
  usable token in the store. An operator who opted into
  `APPSTRATE_ALLOW_PLAINTEXT_TOKENS=1` never had a keyring entry and still
  exits 0.

- **`EE_RECONCILIATION_INTERVAL_SECONDS=0` pauses metering only.** The
  module's `init()` always arms its maintenance tick (300 s), so the two things
  that tick does — the fleet-wide storage-entitlement resync and the retry of
  Stripe cancellations left unconfirmed — keep running while the sweep itself is
  paused; the value is no longer a way to run the module with no timer at all.
  What the maintenance tick does NOT do is touch `ee_billing_cursor`: every
  writer of that watermark sits on the paused path, so the watermark freezes for
  the whole pause. Consequence to plan for: un-pausing is a resume over a gap,
  and `assertCursorResumable` refuses to boot past
  `EE_RECONCILIATION_MAX_GAP_SECONDS` of it. (#1326)

- **`appstrate skills sync` treats a revoked organization as an empty source.**
  When `GET /api/spaces` answers 403, every skill the sync materialized from that
  organization is removed and the run exits 0 with a note on stderr; a
  `--space` flag typed on that run fails instead, because you typed it just
  now. (#1362)

- **Operators: every enabled Stripe webhook endpoint must pin the API version
  the module pins** (`STRIPE_API_VERSION` in `packages/module-ee/src/stripe/client.ts`).
  The live contract suite fails on an endpoint left at the account default or
  at an older version, because webhook payloads are rendered at the endpoint's
  version, not the SDK's. (#1332)

- **Operators: `scripts/migration/0010` tolerates a target the module has
  already booted against.** The watermark `init()` seeds in `ee_billing_cursor`
  is replaced by the source's; any other billing row on the target still
  refuses the copy. (#1318)

- **Entering a role preview reports the server's own refusal.** A refused
  `X-View-As` surfaced as one generic "could not start" message; the dialog now
  reads the refusal code (`invalid_view_as`, `view_as_unsupported`,
  `view_as_forbidden`, `view_as_not_found`) and shows the copy written for it,
  keeping "try again" for a failure the server named nothing for. The shared
  wording is "Preview unavailable" / "Prévisualisation indisponible".

- **Every rate limit keeps a per-process budget behind Redis.** Each limiter the
  platform builds — auth, OIDC, run, proxy — now carries a `RateLimiterMemory`
  insurance limiter of the same points and duration
  (`apps/api/src/infra/rate-limit/redis-rate-limit.ts`). While Redis is
  unreachable the store rejects with an `Error` rather than a decision, which
  Better Auth's limiter turns into a 500 on every `/api/auth/**` route; the
  insurance budget answers instead, so a Redis outage degrades each limit from
  per cluster to per process for its length rather than removing it or refusing
  the call. A rejection that still reaches a caller means both backends failed.

### Fixed

- **Restore MinIO image pulls for CI, development and self-hosting.** Compose
  files use the official `quay.io/minio` repositories after Docker Hub stopped
  serving the referenced images. Existing release tags are preserved and all
  references pin verified multi-platform digests. The test fixture replaces
  `latest` with the server release already used by the Tier 3 example.

- **Typing fast into a Monaco pane no longer drops characters.** The agent
  prompt editor, the package JSON tab and the new file editor fed Monaco a
  controlled `value` from React state, and `@monaco-editor/react` applies a
  controlled value as an after-commit effect that rewrites the whole model when
  it differs from the editor's text. Under React's batching, a keystroke that
  landed between `onChange` and the render carrying it was overwritten by the
  older string, silently and with `onChange` suppressed — `print(1)` typed on a
  loaded machine arrived as `prin1)`. Every authoring pane now seeds Monaco once
  (`defaultValue`) and receives text it did not type as a remount, keyed by
  what changed it (another file, a discarded draft, a re-read server copy).

- **Idempotent run retries enforce current permissions and input visibility.**
  The request fingerprint includes its method, URL and body; using the same key
  for a different route or version returns `422 idempotency_conflict` without
  executing again. Existing cache entries without a request fingerprint also
  return 422 until their 24-hour TTL expires. On deployment, reconcile the
  original resource before issuing a new key for such a retry.

- **Stripe deliveries use the current subscription for plan and quota.** Late
  updates and checkout completions preserve the current entitlement and billed
  consumption. Subscription creation refuses an unknown live price; notifications
  continue to describe the historical transition, after commit.

- **Pricing refresh refuses missing rates before writing catalog files.**
  `refresh-pricing-catalog.ts --apply` stops if an existing model or token rate
  disappears upstream. Resolve the catalog entry explicitly before applying;
  missing prices cannot silently replace existing prices during a refresh.

- **The hosted connect portal stops burning a link over a refusal that cost
  nothing upstream.** A package whose auth strategy cannot begin an OAuth flow
  was answered 500 with the link's `jti` already consumed, so the retry the page
  offers was a dead end; that branch releases the `jti` now, like the scope
  resolution beside it. The 403 advice follows the same fork: a link whose OAuth
  client is auto-provisioned stays burned — releasing it would let one
  ten-minute link replay an upstream registration on every click — and its
  message asks for a new connection link instead of telling the caller to reopen
  the one that will answer 410.

- **A Plus subscriber is no longer handed a Pro-only Codex model (#1357).**
  `gpt-6-astra` is recommended by the vendor only from Pro plans up, but it sat
  in the Codex `featuredModels` list — which is not merely a picker section:
  the platform auto-seeds every featured id into `org_models` on first
  connection and promotes the first inserted row to the org default. A Plus
  subscriber was therefore given a model their plan refuses, and found out at
  the first run. The two documented Pro-only ids (`gpt-6-astra`,
  `gpt-5.3-codex-spark`) are now named in one place — `PRO_PLAN_MODEL_IDS` in
  `@appstrate/module-codex`, with the vendor page that says so — and are kept
  in `modelDiscoveryCandidates`, where a Pro subscriber selects them
  deliberately, and out of `featuredModels`, which the platform applies on
  everyone's behalf. A test pins both halves, so featuring a plan-gated id
  fails CI rather than reaching a picker. Plan tiers appear in no vendored feed
  and `SUBSCRIPTION_COMPLIANCE.md` forbids asking the vendor, so the
  hand-written list is the whole mechanism.

- **The hosted connect portal names the missing OAuth client instead of a
  generic "please try again" 502 (#1263).** Opening a `connect_url` for an
  oauth2 auth in a space with no registered client — and no system client or
  auto-provisioning to fall back to — rendered "Could not start the connection.
  Please try again." with a 502, although the condition is a configuration gap
  that no retry can clear. The programmatic `POST …/connect/oauth2` already
  answered the same case with a 403 naming the action ("Administrator must
  register OAuth client credentials…"); the catch around the hosted dispatch
  swallowed that error, and the auto-provisioning failure written to be shown
  verbatim with it. A client-side (4xx) refusal from the OAuth strategy now
  reaches the popup with its own STATUS — and generic wording, not the
  `ApiError`'s own detail, which names operator artefacts (a client row id,
  `CONNECTION_ENCRYPTION_KEY`, an upstream AS's prose) on a route that carries
  no session; the detail stays on the log line. The single-use link is
  handed back rather than burned — nothing was minted on its strength — so a
  retry once the client is registered works from the very same link instead of
  the previous second misleading "This connect link has already been used."
  Transient and unknown failures differ in what is left: they keep the 502 and
  the burn, since one of them may have gone half way.

- **Deleting an organization reserves the deletion before any module tears
  anything down (migration `0058`).** `DELETE /api/orgs/:orgId` checked
  deletability without a lock, emitted `onOrgDelete` — where modules cancel a
  Stripe subscription and drop rows of their own — and only then opened the
  transaction that re-checks in-progress runs and refuses when it finds any. A
  run admitted in that window turned the refusal into a surviving organization
  stripped of what the handlers had already destroyed, with no repair path. The
  check and a `organizations.deleting_at` stamp now commit together under the
  per-org advisory key run admission takes, and `createRun` refuses a reserved
  organization (409 `org_deleting`), so the decision cannot be invalidated
  behind the modules' back. Chat admission and `/api/llm-proxy` refuse a reserved
  organization with the same 409, because a chat turn is not a `runs` row and
  the deletability count never saw it — usage admitted there would be
  cascade-deleted unbilled. A DELETE that fails after the reservation leaves it
  standing and can simply be retried; module `onOrgDelete` handlers must
  therefore tolerate a second call for the same organization. The reservation is
  visible: `deleting_at` is on the organization wire object (`GET
/api/orgs/{orgId}` and the listing), null on every organization not being
  deleted. The migration is one nullable column and rewrites no row.

  **OPERATOR ACTIONS.** None, unless a DELETE was abandoned. The platform never
  lifts a reservation — retrying the DELETE is the recovery, and it is the only
  one, because module handlers that already ran cannot be undone. An operator
  who decides to abandon a deletion instead can clear the stamp with
  `UPDATE organizations SET deleting_at = NULL WHERE id = '<org-uuid>';`. That
  is safe ONLY when no `onOrgDelete` handler ran — i.e. the DELETE failed at the
  reservation itself, which answers `400 delete_failed` with `runs are in
progress` and emits nothing. Once a handler has run the organization is
  already gutted (the subscription is cancelled, the billing rows are gone) and
  clearing the stamp returns a broken organization to service; finish the
  deletion instead.

- **Revoking an API key requires `api-keys:revoke` in the key's own space.**
  The guard answered for the space the request carried and the service then
  updated org-wide, so a delegated administrator of one space could revoke a
  key of a private sibling space, given only its id. A key whose space the
  caller cannot reach now answers with that space's own wall (404 for a private
  one, 403 `not_a_space_member` otherwise). An API key still revokes only inside
  the space it is pinned to. The request re-enters the key's space before it
  writes, so the audit row names the KEY's space, not the space the request came
  in through.

- **Integration OAuth clients are `integrations:configure`, not
  `integrations:install`.** Registering, rotating, deleting a BYO OAuth client
  and choosing the default one are governance (RBAC spec §3.4), and `install`
  is API-key-grantable — so a key could swap the OAuth application a whole
  space authenticates through. The four routes now require the session-only
  permission the SPA already gated them on. **OPERATOR ACTION: an API key that
  registered, rotated or deleted a BYO OAuth client, or set the default one, now
  gets 403 on those four routes — do that work from a session.**

- **The realtime streams resolve the same org half as HTTP.** SSE runs outside
  the auth pipeline and rebuilt the caller's org permissions without the grants a
  module makes to one named principal, so an ee billing manager reached every
  HTTP route their grant opens and none of the streams. The stream now reads
  `principalGrants` exactly as the pipeline does, and its audit rows name the
  session transport rather than the credential the query parameter carried.

- **A malformed `space_id` in a space assignment answers 400, not 404.**
  `space_assignments[].space_id` on an invitation and on an OAuth signup policy
  is shape-checked (`spc_` + a UUID); anything else is `400 Malformed space id`
  instead of a 404 that reads as "that space was deleted".

- **Billing: deleting an org with no billing account still clears its billing
  state (`@appstrate/module-ee`).** The handler returned as soon as it found no
  account row, leaving the org's usage buckets and its billing managers behind —
  rows naming an organization that no longer exists. The cleanup now runs for
  every org, and the account row is only what decides whether Stripe is called.

- **Billing: `POST /api/billing/checkout` and `/plan` answer 404 for an org with
  no billing account (`@appstrate/module-ee`).** They answered 503, which tells a
  client to retry something no retry can fix.

- **A disabled activation checkbox in the library says why.** The row names the
  reason — a system package, the permission the caller lacks in that space, or a
  home they may not share out of — and shows nothing at all while permissions
  are still loading, rather than a bare disabled box that reads as a broken
  control.

- **The billing managers card no longer clears itself when the member roster
  fails to load.** Without the roster every saved manager read as "no longer a
  member", which made the list dirty and turned Save into a `PUT` of the empty
  set. The card stops at an error state instead.

- **The models page stops asking for credentials a member cannot read.** The
  credentials list and the provider registry are both behind
  `model-provider-credentials:read`; they are now fetched only when the caller
  holds it, instead of collecting two guaranteed 403s per visit.

- **A role can be repaired after a module is unloaded.** The role editor
  rendered only the permissions it could name, kept the rest selected
  invisibly, and resent them on every save, which the server refused with a 400
  no control could clear. Permissions the platform no longer knows are now
  listed as unavailable, with a way to remove them.

- **Billing: a Stripe cancellation that fails on org deletion is now retried
  instead of forgotten (`@appstrate/module-ee`).** `onOrgDelete` logged the
  failure and deleted the billing account anyway, so the subscription id died
  with the row: a Stripe blip left a subscription charging a customer every month
  for an organization that no longer existed, with nothing able to name it. The
  intent is now stamped on `ee_billing_accounts.cancel_requested_at` before the
  call, the rows survive an unconfirmed cancellation, and every billing tick
  retries them until Stripe confirms — a subscription Stripe no longer has counts
  as confirmed, and a second `onOrgDelete` for the same org is a no-op.

- **Billing: the shutdown drain no longer closes the database under a running
  storage reconcile (`@appstrate/module-ee`).** It snapshotted the in-flight
  sweep and reconcile once, at entry, but the tick starts the reconcile from
  inside the very promise that snapshot awaits — so a shutdown entered mid-sweep
  returned the moment the sweep ended and `closeEeDb()` ran underneath a
  reconcile that had begun in between. It now re-reads both handles after every
  wait, and its timeout is a constant rather than a parameter no caller passed.

- **Billing: upgrading a paying organization no longer creates a second
  subscription (`@appstrate/module-ee`).** The plan picker always opened Stripe
  Checkout, and Checkout only ever CREATES — so an org that already subscribed
  came out of an upgrade with two live subscriptions and two charges.
  `POST /api/billing/checkout` now refuses an account whose subscription is one
  Stripe still HOLDS — `active`, `trialing`, `past_due`, `unpaid`, `paused` or
  `incomplete` (`409 subscription_exists`) — because Checkout only creates, and
  Stripe holds all six. The new `POST /api/billing/plan` (`billing:manage`,
  5/min) moves the existing subscription's price item onto the chosen plan with
  proration. Which door a plan click opens is the server's answer, not the
  dashboard's guess: `GET /api/billing` carries a `plan_action` field
  (`checkout` | `plan-change` | `portal`) and the SPA follows it. Downgrading to
  free is unchanged — it is a cancellation, taken through the Customer Portal.

- **Billing: an old subscription's events no longer destroy the active one
  (`@appstrate/module-ee`).** Every subscription-scoped Stripe webhook matched on
  `metadata.orgId` alone, which says which org OWNS a subscription and not that
  the org is still on it — so a `customer.subscription.deleted` for a replaced
  `sub_old` downgraded the live `sub_new` account to free with zero credits while
  Stripe kept charging it. Reversed order and late delivery did the same through
  `customer.subscription.updated` and `invoice.paid`, and a superseded
  subscription's dunning notice reached the customer as if their current plan
  were failing. Each handler now writes only to the account carrying that exact
  subscription id, and an event about any other subscription is logged and
  ignored. The three handlers whose job includes ATTACHING one — checkout
  completion, subscription creation and the first paid invoice — also accept an
  account with no subscription, and one whose id names a subscription Stripe no
  longer HOLDS: only `customer.subscription.deleted` nulls the column, so an org
  sitting at `canceled` (or one whose `deleted` event was lost) still carries a
  dead id, and pinning on the id alone dropped its next paid checkout as
  "superseded" — charged, with no plan and no quota.
  `customer.subscription.created` additionally never rewrites an account already
  on that subscription: a creation event delivered late carries creation-time
  status and plan, and replaying it over a subscription that has since moved
  puts the account back where it started.

- **Billing: the usage the cutover excluded is no longer billed on the second
  sweep (`@appstrate/module-ee`).** The cursor was seeded at the platform's
  settled frontier and the first pass billed nothing — as documented — but every
  later pass reads `EE_RECONCILIATION_REPLAY_WINDOW` ids BELOW the watermark to
  catch rows that commit late, and that read walked straight back under the seed
  and debited the whole history. `ee_billing_cursor.floor_id` records the seeded
  frontier once and never moves, and both the sweep and the org-deletion drain
  now select from `max(floor_id, watermark − replay window)` through one shared
  rule. `floor_id` defaults to `0` for a cursor that predates it: its original
  frontier was never recorded, and 0 is exactly the behaviour those deployments
  already had.

- **Billing: a ledger row the platform could not price is no longer settled as
  free (`@appstrate/module-ee`).** The sweep summed `cost_usd` blind, so a row
  whose `pricing_status` is `unpriced` (cost 0 because no rates were available —
  not because the call was free) was claimed as zero spend and could never be
  recovered. Rows are now claimed with their status stamped on
  `ee_billed_llm_usage.pricing_status`: `priced` is billed, `partial` is billed
  on its floor and counted, and `unpriced` or an absent status is claimed for 0
  credits so it is never double-billed and stays auditable. Each sweep pass and
  each org drain emits one `error` line with the counts and the affected orgs,
  and the counts ride the per-tick heartbeat.

- **Billing: the final drain on org deletion no longer misses a late-committed
  row (`@appstrate/module-ee`).** It started strictly above the global watermark,
  so a row of the org that took a low serial id and committed after the watermark
  passed it was debited 0 — and unlike the periodic sweep, the drain has no
  second chance: the org's ledger rows cascade away moments later. It now uses
  the same selection rule as the sweep.

- **Unit tests green again after the 2026-09-07 LiteLLM catalog refresh
  (#1277).** The refresh brought `gpt-6-astra` into `openai.json`, which
  `curated-model-drift` rightly flagged as unreviewed for Codex: the vendor
  page (https://learn.chatgpt.com/docs/models) lists it as recommended for
  ChatGPT sign-in (Pro plans and above) — from Pro plans only, so it joins the
  Codex `modelDiscoveryCandidates`, where a Pro subscriber picks it
  deliberately, and stays OUT of `featuredModels`, which the platform seeds into
  `org_models` on everyone's behalf (see "A Plus subscriber is no longer handed
  a Pro-only Codex model" above; `PRO_PLAN_MODEL_IDS` names both such ids and a
  test pins both halves). The same refresh marks the whole 5.6 family
  `temperature: "unsupported"` on the
  OpenAI API, so the `resolveCatalogDefaults` test that proves the Codex
  override rejects temperature now reads `gpt-5.4`, an id the API still
  supports it on.

- **A custom endpoint's key and models show a neutral icon.** Rows resolve
  their registry entry by `providerId` (`resolveProviderEntry`), falling back
  to the `(apiShape, baseUrl)` match only where the binding is hidden; the
  custom-endpoint entries' `iconUrl` is `custom-endpoint`, a server glyph, not
  the vendor logo of the API they speak.

- **Editing an OpenRouter key opens on its provider.** The credential form's
  picker no longer filters `openrouter` out.

- **Deleting a key a model still runs on says so.** The dialog counts the
  models on the key and disables Confirm until they are gone; a delete the
  server refuses (409 `credential_in_use`) or otherwise fails, models
  included, is reported as a toast.

- **The Playwright suite keeps its own `data/e2e/{pglite,storage}`** instead
  of inheriting `PGLITE_DATA_DIR` / `FS_STORAGE_PATH`, which pointed a second
  process at the developer's `data/pglite` (PGlite aborts with
  `RuntimeError: Aborted()` and can corrupt the first process's catalog).

- **A custom (OpenAI-compatible) model can be created from the model form
  again.** The picker submitted a client-only `__custom__` sentinel as the
  credential's `providerId` (`400 Unknown providerId`); the custom entry is now
  the registry's own `openai-compatible` provider, whose credential carries the
  shape and base URL the server reads.

- **A Dynamic Client Registration body without `scope` now yields the full
  self-service scope set (#1267).** An MCP client registering without `scope`
  got the identity scopes alone, so authorizing for `mcp:read` / `mcp:invoke`
  was bounced with `invalid_scope`. A declared `scope` is VALIDATED against that
  ceiling and then discarded: `persistOAuthClientRegistration` writes the whole
  ceiling to the row either way, so a registration declaring less is advisory,
  not a narrowing. Intersecting it back in would buy no confinement — the
  declaration is client-controlled, a registrant wanting the ceiling re-registers
  or edits its metadata document — while breaking every MCP client that
  publishes a minimal `scope` and then requests what the protected resource
  advertises. What actually bounds such a client is the ceiling itself, the
  single-audience rule at `/oauth2/token`, the consent screen and the caller's
  live org role. An already-registered client whose row predates this still
  carries the identity scopes alone, so it must re-register.

### Removed

- **BREAKING (API): the `?active=true` query parameter is gone from
  `GET /api/packages/{agents|skills|mcp-servers|integrations}`.** An index IS the
  active set now, so the parameter said nothing the bare URL does not: it is no
  longer declared in OpenAPI and no longer read by the route, and a caller still
  sending it receives exactly the body it receives without it. What used to be
  the wider listing — everything placed here, switched on or not, plus the offers
  nobody has taken up — is the space's LIBRARY, `GET /api/spaces/{id}/library`,
  which answers with `placements[]` and a `state` per space.

- **The Integrations page's Actives / Installed tabs are gone**, with their
  `integrations.tabs.*` and `integrations.empty.all` strings. The page is an
  index, so it lists the integrations the space can use; the "Installed" tab was
  a second, poorer copy of **Packages de cet espace**, which carries the origin,
  `Proposé` / `Désactivé` / `Actif` and the switch that changes it. The empty
  state of each index names that page instead.

- **The SPA's `not_installed_or_invalid_manifest` mapping is gone.** It rendered
  a message for an error code the platform has never emitted, so the branch was
  unreachable and the string it showed described a state no response could
  report. The connections modal reads the code the readiness actually writes,
  `integration_invalid_manifest`, and nothing else.

- **BREAKING (operators): the `integration_dropped` reason `not_installed` is
  gone; the value is `not_active`.** It is the marker written on a run whose
  declared integration could not be spawned, and it names the space's switch —
  the same word the routes, the audits and the library use for that act. The
  markers already written on past runs keep the old string: rewriting them would
  be a data migration, not a code change.

- **BREAKING (operators): the `package.unshared` audit field `uninstalled` is
  gone; the field is `placementRemoved`.** A revoke deletes the share and the
  `space_packages` row behind it in one transaction, and the entry says which of
  the two it actually removed — under the name the platform now gives that row.

- **A system package is no longer force-active in every space.** There is no
  "always active, immutable" lock left in the API or in the library UI: a space
  switches a shipped agent, skill or mcp-server off exactly as it switches an
  org-authored one off, and the row saying `false` survives every run. The
  deployment's default still decides where no row exists — `source = 'system'`,
  and for integrations the `SYSTEM_INTEGRATIONS` subset — so nothing changes for
  a space that has never touched the switch.

- **Three internal seams that each answered "is this package usable here" their
  own way are gone**: `getPackageWithAccess` (the loader that folded
  "not found" and "not active" into one `null`, which is why the run doors could
  not tell a caller which refusal they had hit), `getCatalogPackageType` (a
  second catalog read beside the authorization one) and `listInstalledSkills`
  (now `listActiveSkills`, reading the active set it always meant). The one
  definition of "active here" lives in `services/package-activation.ts` and
  every reader asks it.

- **BREAKING (API): `POST /api/packages/{scope}/{name}/shares/accept` is gone.**
  Taking up an offer IS activating it, and activating has one pair of doors —
  `POST /api/spaces/{spaceId}/packages` and its `DELETE` — for a personal space
  exactly as for a team one, with ownership standing in for the activation grant
  there. The accept route existed only because the activation route could not
  say "the offer is enough"; now it can, so a second door with its own authorization rule, its own
  response shape and its own audit event (`package.share_accepted`) is a
  duplicate of the happy path rather than a feature. The path is absent, so a
  caller still posting to it gets a 404 from the router. `GET …/shares` renders
  the audience as before; nothing about offering or revoking changed.

- **BREAKING (API): a placement no longer carries a version.** Migration
  **0066** drops `space_packages.version_id` and its foreign key, and everything
  that spelled it goes with it: `version_id` on
  `PATCH /api/spaces/{id}/packages/{scope}/{name}` (the body schema is `.strict()`,
  so sending it is now a 400), `version_pin` on
  `GET …/packages/{scope}/{name}/run-config`, on `AgentDetail` and on the
  space-package object in `@appstrate/shared-types`, the `409 version_in_use`
  refusal that stopped a pinned version from being deleted, the
  `update_available` flag on `LibraryPackage` with the "Mise à jour disponible"
  badge and button it fed, the re-accept update path, and the CLI's inheritance
  of the pin from `run-config` (`appstrate run` with no `@spec` runs the latest
  published version, `@draft` runs the working copy), and the launch form's
  inherit option, which is now simply **Dernière version publiée** — there is no
  pin left to inherit, and an explicit choice stays explicit. Outside its home a
  package runs the latest published version, always, so a column selecting a
  definition had nothing left to select and the guards that protected it had
  nothing left to protect. **`0066` is one-way**: a previous build reads the column at launch, on
  the detail page and in the export, and writes it through the space-package
  configuration route. Whatever it held is discarded with it — a pinned
  placement becomes a `latest` one, which is the rule from this release on.
  The window also needs `scripts/migration/0016-package-shares-backfill.sql`,
  right after `0014`: it gives every placement row sitting outside its package's
  home the `package_shares` row that now places it there, without which those
  packages vanish from the spaces running them at the first request. The runbook
  is `scripts/migration/README.md` → "Personal spaces & sharing rollout".

- **BREAKING (API): neither library shape has a `shared` section, and
  `LibraryPackage.installed_in` is gone.** Both were the old reading of the
  library as a matrix of package × space whose cell meant "there is a
  `space_packages` row here", with a lobby beside it for the offers that had no
  row yet. That shape hid the two axes that actually decide anything — the HOME
  and the SHARE — gave a package's move no representation at all, and made a
  pending offer and a package somebody had switched off the same empty cell.
  `placements` replaces both (see **Added**): an offer is a placement with
  `state: "none"`, on the package's own row and behind the same switch as every
  other space. The keys are absent from the responses rather than empty, and the
  SPA has no "Partagés avec moi" section in either view — the row itself carries
  a **Proposé** badge until somebody switches it on.

- **BREAKING (API): `POST /api/integrations/{packageId}/activate` and
  `DELETE /api/integrations/{packageId}/deactivate` are gone**, with their audit
  events `integration.activated` and `integration.deactivated`. An integration is
  activated in a space exactly as an agent, a skill and an mcp-server are —
  `POST /api/spaces/{spaceId}/packages` and its `DELETE` (see **Added**) — and a
  second family of routes for one type meant the placement rule, the offer that
  may have to be created with it and the personal-space waiver were all stated
  twice, in two authorization paths a reader had to compare. The paths are
  absent, so a caller still posting to them gets a 404 from the router. The
  permissions are untouched: `integrations:install` and `integrations:uninstall`
  are what the spaces doors ask for an integration. Audits for all four types
  are now `package.activated` and `package.deactivated`.

- **BREAKING (API): `enabled` left
  `PUT /api/spaces/{id}/packages/{scope}/{name}`.** The body is `.strict()`, so a
  request still sending it is a 400 rather than a silent no-op. Activation is its
  own act with its own pair of doors; carrying it on the configuration route as
  well meant one act had two spellings, each with its own gate, and the `PUT`
  had to classify its body to know which one it was performing. What is left on
  that route is `modelId`, `proxyId` and `generationConfig`, all three under
  `configure`.

- **BREAKING (API): `409 already_installed` is gone**, and so is
  `agent_not_installed_in_space`. Activating a package that is already active is
  the state the caller asked for, so `POST /api/spaces/{spaceId}/packages`
  answers **200** with the same body instead of a conflict — 201 stays for the
  call that actually switched it on. The run-gate refusals are renamed for what
  they now mean: `agent_not_active_in_space` (`GET …/bundle`),
  `package_not_active_in_space` (`POST /api/runs/remote`) and
  `package_not_placed` (the per-space package routes and `run-config`), since a
  space can hold a placement and still not run it. `POST /api/packages/import-bundle`
  reports `root_active` where it reported `root_installed`. The renamed
  `operationId`s on the space-package routes follow the same act:
  `listSpacePackages`, `activatePackage`, `getSpacePackage`, `updateSpacePackage`,
  `deactivatePackage`.

- **BREAKING (operators): the organization role `viewer` is retired; `guest`
  replaces it, and moving the rows is two migrations plus three scripts in ONE
  maintenance window.** A `viewer` was read-only everywhere; that is a space concern now, so
  a former viewer becomes an org `guest` plus an explicit `viewer` role in every
  space that exists at migration time — the same reach, and it does not widen
  onto spaces created later. Mapping them to `member` instead would have handed
  them every open space's default preset, which is `operator`: write access they
  never had.

  **The five files, in this order.** `packages/db/drizzle/0056_space_roles.sql`
  adds `guest` to `org_role` and creates the space-role tables;
  `packages/db/drizzle/0059_drop_org_viewer.sql` recreates `org_role` WITHOUT
  `viewer`. Both ride the same pending batch, which is applied by a ONE-SHOT
  MIGRATOR — deliberately not by starting the application — so a bad migration
  fails with its own exit code before anything binds a port. Then, after that
  batch and before the new version serves traffic, three scripts run BY HAND:
  `scripts/migration/0008-org-viewer-to-guest.sql`,
  `scripts/migration/0012-org-invitation-history-viewer-to-guest.sql` and
  `scripts/migration/0017-restore-handmoved-viewers.sql`. Between the batch and
  the scripts a row still reading `viewer` resolves no permission set at all and
  every request from that user fails, so the window covers all of it — this is
  not two deploys. **Rollback is one-way from `0056`**: it promotes
  `chat_sessions.space_id` to NOT NULL and the previous build inserts without
  it, and `0059` is one-way for the same reason. Roll forward.

  **That order only works on a database with no `viewer` rows left, which is
  what this one is.** `0059` section A raises rather than run while
  `org_members` or `org_invitations` still carry `viewer`, and drizzle applies
  the whole batch in one transaction — so on a database that still holds such
  rows the batch rolls back before `0008` (which has to READ them, and cannot
  run before `0056` creates `space_members`) ever gets its turn. Unwinding that
  sandwich needs a release carrying `0056` without `0059`, and nobody has cut
  one: since beta.57 the twelve migrations are all unapplied and ship together.
  Here the four `viewer` counts read zero, so the question is moot and `0008`
  and `0012` run as witnesses rather than as repairs.

  **`0017` is the one with real work on this database**, and the four-zero
  pre-flight is blind to it: on 2026-09-09 the two `viewer` members were moved
  off the value BY HAND, to `member`, because `guest` did not exist in the type
  yet. `member` is strictly wider than what they had — with
  `spaces.default_role = 'operator'` it is write access in every open space —
  and `0008` selects `WHERE role::text = 'viewer'`, which is now empty, so it
  runs green straight over them. `0017` gives those two pairs the shape `0008`
  would have, and only while the row still reads `member`. `0012` takes what
  `0008` deliberately leaves — the accepted, expired and cancelled invitations,
  pure history — which `0059` needs because it cannot cast them.

  `0008` is idempotent, runs in one transaction, and verifies by coverage
  rather than by a count that reads the same whether it worked or not: it
  aborts unless every pre-flip (user, space) pair carries a `space_members` row
  and every pending invitation carries its space snapshot. It is run-once by
  construction rather than by convention: the one step whose predicate does not
  remove its own condition — the OAuth signup snapshot, which after the deploy
  also matches a client an admin deliberately left with no assignments — is
  skipped on every run past the first, off a marker the script writes in
  `drizzle.migration_scripts`, and names the clients it declined to widen.

  **A sixth file can be needed BEFORE the batch.** `0056` also creates the
  partial unique index behind "one pending invitation per (organization,
  email)", and a duplicate pair left by a race under earlier code fails that
  statement and rolls the whole migration back. Count the pairs before the
  deploy and run `scripts/migration/0009-org-invitations-dedupe-pending.sql` if
  there are any — it is the one file of the six that runs ahead of the batch.
  **The executable order, including every query above, is
  `scripts/migration/README.md` → "Detail — RBAC rollout"**, which is what to
  follow; this entry is the reasoning, not the runbook. Rehearse the whole
  sequence against a restored `pg_dump` copy first.

  Two more consequences an operator should know about. **An API key pinned to a
  space cannot mutate a package installed in more than one space**, whatever its
  scopes: a package's draft, versions and identity are shared across its
  installations, so a mutation needs authority in every one of them, and a key
  delegates authority in exactly one. Re-run such a mutation from a session, or
  uninstall the package from the spaces the key does not cover. And the audience
  of billing mail moved: `ModuleInitContext.getOrgAdminEmails` is gone from the
  module contract, replaced by `getOrgOwnerEmails` and `getOrgMembers` (see
  `packages/core/CHANGELOG.md`), so an unset billing contact now falls back to
  the org's OWNERS rather than fanning out to every administrator.

### Security

- **`GET /api/integrations` and its detail obey PLACEMENT, so an integration
  homed in somebody's personal space stops being org-wide readable.** Both
  routes filtered on "does this organization own the row?" and on nothing else:
  no home, no share, no space at all entered the query. An integration drafted
  in a member's PERSONAL space and offered to nobody therefore came back in
  full — its name, its description, its `auths` with their `authorized_uris`,
  its tool catalog — to every caller holding `integrations:read`, organization
  owners and admins included, while `GET /api/packages/integrations` omitted
  that very row and its detail answered 404 for the same caller. The Integrations
  page hid it by filtering `active` in the browser, which is not a boundary: the
  HTTP response carried it, so a network tab, an API key, the CLI or `curl` read
  it whole. RBAC spec §3.6 states the rule the routes were missing — owners and
  admins neither read nor write a personal space, and the home is the only
  authority there is. Both now conjoin `placementReadFilter`, the SAME rule the
  per-type index and the space library read, rather than a third formulation of
  it: an integration is listed and readable when the current space HOMES it, was
  OFFERED it, or when the deployment ships it. Placement is not activation — an
  offer not taken up and an integration switched off both stay listed, with
  `active: false`. Resolving a DECLARED dependency stays org-wide (§6.9), where
  the run resolves it, through a reader that says so by name.

- **A forwarded chain shorter than `TRUST_PROXY` no longer picks the client's
  own address.** `lib/client-ip.ts` reads `X-Forwarded-For` from the RIGHT,
  which is unspoofable while each trusted hop appends its entry. When the chain
  carried FEWER entries than the hop count it used to clamp to the LEFTMOST
  one — an entry no proxy wrote — so any caller could name its own IP under any
  `TRUST_PROXY >= 1` and mint a fresh bucket per request. Every per-IP control
  keyed on that answer, including the rate limit that is the stated defence
  against `AUTH_BOOTSTRAP_TOKEN` brute force, the Better Auth production limiter
  and the address recorded on sessions and audit events. A short chain now fails
  closed: the whole forwarded set is distrusted (`X-Real-IP` included, or
  stripping the chain would just move the hole) and the socket peer answers.

  The resolved value must also **be** an IP address now. Port suffixes and
  bracketed IPv6 normalize to the address they name; anything else is dropped.
  That closes a one-caller denial of service: an unparseable address made
  Better Auth's `getIP` drop _every_ caller into one shared rate-limit bucket.

  **Operators:** the hop count must match the topology. `TRUST_PROXY=1` behind a
  single reverse proxy that appends `X-Forwarded-For`; a TLS-terminating L4 load
  balancer (AWS NLB TLS listener, GCP TCP proxy) appends nothing and is not a
  hop. Verify too that the origin port is not reachable around the proxy — the
  shipped compose publishes it on all host interfaces, and Docker's rules bypass
  host firewalls.

- **`TRUST_PROXY=false` refuses to boot in production behind a non-loopback
  `APP_URL`.** The platform terminates no TLS, so that pair means a proxy is in
  front by construction, and ignoring `X-Forwarded-For` there hands every caller
  the proxy's own address — collapsing every per-IP rate limit and every audit
  record into one bucket. `@appstrate/env` now rejects the combination at boot
  instead of running degraded.

  **Operators: name the hop count.** `TRUST_PROXY=1` behind a single reverse
  proxy, `N` behind N hops you control. The self-hosting example ships `1` and
  passes the variable through in all four of its compose files.

- **A token request that identifies no client is held to the self-service
  confinement.** `/oauth2/token` confines a self-registered (DCR / CIMD) client
  to exactly one protected-resource audience; a request naming no client now
  falls under the same rule rather than past it, so dropping `client_id` is not
  a way to mint a token for the broad platform audience. `private_key_jwt` keeps
  working: the client id is read from the `client_assertion`'s `sub` (RFC 7523
  §3, `iss` must agree when present), unverified — the provider then verifies
  the assertion against the row that id names, so a forged assertion naming an
  operator-provisioned client dies on the signature check and one naming a
  self-service client stays confined.

- **Operators: run `scripts/migration/0011` after the drizzle batch carrying
  `0057`, on any deployment that has ever accepted a self-registered client —
  the API refuses to boot in between, and that is the intended sequence.**
  `0057` adds `oauth_clients.self_service` and leaves it `false` on every row;
  `0011` fills it from the `selfService` key already in `metadata`. Until it
  runs, a self-registered client reads as operator-provisioned and its tokens
  are not confined, so the deployment comes up only far enough to apply `0057`,
  counts the rows still unfolded and exits naming the script; under a supervisor
  it restarts into the same refusal. The order is therefore: deploy → the API
  applies `0057` and exits → run `0011` against the database → restart. A
  deployment that never accepted a self-registered client counts zero and never
  sees the refusal. The script is idempotent, runs in one transaction, and never
  flips a `true` back.

## [1.0.0-beta.57] - 2026-09-03

### Fixed

- **A killed `appstrate skills sync` no longer locks the next ten minutes of
  sessions out.** Closing a Claude Code session seconds after opening it kills
  the background sync it spawned, and the `mkdir` lock only expired by age —
  every session in the following ten minutes reported `Another appstrate
skills sync is running` and kept the stale plugin. The lock is now
  `flock(2)` on `skills-sync/sync.lock` (through `bun:ffi` — Bun is the
  runtime on every channel): the kernel releases it when the holder ends,
  however it ends, so there is no pid to trust, no age to guess and nothing
  left behind.

- **`appstrate self-update`, `bootstrap.sh` and `bootstrap-runner.sh` no longer
  break for the days between an npm release and the next platform tag.** The
  `cli@`, `core@` and `afps-shared@` publish workflows each create a GitHub
  Release, and GitHub made the newest one "latest" — so `releases/latest`
  answered `cli@1.0.0-beta.56`, the CLI prefixed it with `v` and asked for
  `vcli@1.0.0-beta.56/checksums.txt.minisig` (404). Every one of the 15
  non-`v*` releases to date opened such a window. Those workflows now pass
  `make_latest: false`, and the CLI names a non-platform `latest` tag instead
  of building a URL from it.

## [1.0.0-beta.56] - 2026-09-03

### Added

- **`@appstrate/core/map-with-concurrency`** — the bounded worker pool moved
  out of `apps/api/src/lib/map-with-concurrency.ts` into core, unchanged, and
  re-imported by `lib/boot.ts`, `services/input-parser.ts` and
  `services/system-packages.ts`. `appstrate skills sync` needs the same pool
  against the rate-limited package routes; a copy in the CLI would have been
  the third in the repo, and the first two had already diverged on
  abort-on-rejection.

- **`appstrate skills sync` — the org's skills in Claude Code and Codex,
  refreshed without a manual step.** Materializes every skill placed in the
  profile's pinned space as an [Agent Skills](https://agentskills.io/specification)
  directory, into `claude-plugin` (a complete Claude Code plugin under
  `$XDG_DATA_HOME/appstrate/claude-plugin/`, the default), `codex`
  (`~/.agents/skills/`) or `claude-user` (`~/.claude/skills/`). The auto-sync is
  a Claude Code marketplace `command` source re-running the CLI once per
  session — no server change, no hook, no daemon — so `--print-path` prints the
  plugin directory as the only stdout line and the output is byte-deterministic.
  Published `latest` by default (integrity-verified), `--source draft` for
  authors. Exactly one thing is rewritten in `SKILL.md`, the frontmatter `name`,
  so it matches the directory; an artifact published before the platform's
  frontmatter gate is synced as authored and named once on stderr. An ownership
  ledger keyed by target and `HOME` root makes the shared roots safe (nothing it
  does not own is written or removed), a `mkdir` lock serializes concurrent
  sessions, and per-skill failures never cost the plugin under `--print-path`.
  On a fresh machine the plugin install still succeeds before the CLI is
  connected: it gets a single `/appstrate:setup` skill naming the missing step
  and a `SessionStart` hook that surfaces it at every session start, both
  replaced by the organization's skills on the first connected sync.
  Full behaviour: `apps/cli/README.md` → `appstrate skills`.

### Changed

- **BREAKING (wire): WRITING a skill whose `SKILL.md` frontmatter has no
  `description`, or a `name` that breaks the Agent Skills naming rule, is now a 400.** The platform only required the `name` KEY to be present, so a skill
  created with the editor's default skeleton — `name:` and `description:` both
  blank — was accepted, published, and produced an artifact Codex rejects and
  Claude Code never auto-invokes. AFPS §3.3 spells both fields SHOULD; the
  platform is a PRODUCER of these artifacts and holds itself to MUST.

  A `SKILL.md` is accepted only when its frontmatter declares a `name` of 1-64
  characters of lowercase `a-z`, `0-9` and `-` with no leading, trailing or
  consecutive hyphen ([Agent Skills
  specification](https://agentskills.io/specification)) and a non-empty
  `description` of at most 1024 characters — both counted in Unicode code
  points. That `name` is the BARE skill slug (`triage`), a different namespace
  from the `@scope/name` package id, and must be written **inline on one line**:
  `name:\n  triage` and `name : triage` are valid YAML the platform's package
  loader cannot read, so writing one is refused rather than frozen into a
  version no run could load.

  The frontmatter is parsed with the **`yaml` library, at the same major the
  skill runtime uses** (`@earendil-works/pi-coding-agent` parses `SKILL.md`
  with `yaml` 2.9), mirroring its delimiters and newline handling, so the
  platform cannot accept a document the agent then fails to PARSE. Block
  scalars, folded scalars, next-line values, quoted escapes, inline
  `# comments` and CRLF all read correctly; what YAML refuses, the platform
  refuses (`description: a: b`, `name:x`, a duplicate key, a non-mapping block,
  a non-string field); and a leading **BOM is rejected** rather than stripped,
  because the runtime tests `startsWith("---")` and silently drops the skill.
  The RULES are deliberately stricter than the runtime's, which only warns on a
  spec violation and counts UTF-16 units — being stricter costs an author one
  edit, being looser mints an immutable artifact no agent will load. A parity
  test (`packages/runner-pi/test/skill-frontmatter-parity.test.ts`) runs the
  real runtime loader and asserts the asymmetry only ever points that way.

  The rule lives once, in `@appstrate/afps-shared`'s `checkSkillMarkdown`,
  declared as the `skill` entry's `validateContent` on the shared package-type
  config and applied by every path that WRITES skill content: `POST
/api/packages/skills`, `PUT /api/packages/skills/{scope}/{name}`, `POST
.../versions`, `POST .../versions/{version}/restore`, `POST
/api/packages/import` (both the AFPS and the bare-skill-ZIP fallback),
  `/import-bundle`, `/import-github`, and the MCP module's
  `validate_package_file` / `import_package_file`. The 400 is an ordinary
  problem+json whose first field error carries the machine-readable reason —
  `skill_invalid_frontmatter`, `skill_missing_frontmatter_name`,
  `skill_invalid_frontmatter_name`, `skill_missing_frontmatter_description` or
  `skill_invalid_frontmatter_description` — so a client can tell "no
  description" from "bad name" without parsing prose.

  **READING and RE-IMPORTING existing artifacts are deliberately untouched, and
  that is the load-bearing half.** Published versions are immutable: a skill
  published without a description cannot be repaired in place, so gating the
  read side would have failed every RUN of every agent depending on one.
  `checkCompanionFiles` — which `extractRootFromAfps` and the run launcher's
  package catalog call — therefore still asks only for a frontmatter `name`,
  through the exact same permissive probe as before. And the rule applies to
  the ROOT of an import only, never to a dependency copy a bundle carries.

  What changes for existing data is the DRAFT — every write, and only writes. A
  stored skill draft whose `SKILL.md` does not conform must be completed before
  its next save or publish. **Operator step, after deploying this release:**
  `bun scripts/migration/0007-skill-frontmatter-quote-descriptions.ts` (dry-run;
  `--apply` to write) quotes the `description:` lines `yaml` cannot parse — 17
  of production's 66 skills carry an unquoted `description: … : …`, which the
  agent runtime already fails to load — and names the rest for a manual edit.
  **Restoring a legacy published version is refused** for the same reason: a restore writes a draft. Forking is NOT gated
  — it byte-copies an already-published artifact, so nothing new enters the
  world. The skill editor, the publish modal and the version-restore
  confirmation translate the server's reason codes, so the author sees the
  missing field rather than an English `detail` — or, as the restore dialog did
  before, nothing at all.

- **Chat turns shed their fixed per-hop costs** (#1243). The preamble reads
  (models, default space, caller context, session) run in parallel; the
  resumable recording is coalesced (50 ms / 16 KiB) instead of one store
  append per SSE chunk and is released ten seconds after persistence settles;
  the final assistant message is extracted in a single pass; session
  bookkeeping is one UPDATE per persisted message; the MCP operation index is
  memoised per permission set; the package hints query is bounded in SQL. The
  chat UI throttles message re-renders and polls the session list every 10 s
  while a turn is generating (60 s idle), and the resume route clears a
  marker whose producer died. MCP `invoke_operation` audit inserts are no
  longer awaited on the response path: they are tracked in-process and
  drained (5 s cap) by graceful shutdown before the DB closes. Every
  process-local TTL cache in the platform is now an instance of
  `@appstrate/core/cache`, whose `invalidate`/`clear` broadcast to every
  replica over the Postgres NOTIFY channel `cache_invalidate`.

## [1.0.0-beta.55] - 2026-09-01

No entries were recorded for this release. `CHANGELOG.md` is byte-identical at
`v1.0.0-beta.54` and `v1.0.0-beta.55`, so everything below shipped in beta.54
or earlier.

## [1.0.0-beta.54] - 2026-08-28

### Added

- **Two release gates joined `bun run check`: `verify:release-version` and
  `verify:env-docs`.** Both close a hole that a green check had been reporting
  as fine.

  `verify:release-version` (`scripts/verify-release-version.ts`) compares the
  hardcoded `${APPSTRATE_VERSION:-<version>}` fallback in every shipped compose
  file and `.env.example` against the git tag namespace. That fallback is what a
  self-hoster gets from the documented `docker compose up -d` without exporting
  the variable, and nothing checked it: measured at `v1.0.0-beta.53` all five
  compose files still said `1.0.0-beta.41` — 79 sites, twelve releases stale —
  while `.env.example` said `1.0.0-beta.51`, a third value again. The #1201
  image-trio guard structurally cannot see this: it compares the platform, the
  `PI_IMAGE` and the `SIDECAR_IMAGE` refs to EACH OTHER, and all three read the
  same stale fallback, so the trio is perfectly coherent — coherently twelve
  releases old. The gate has two arms: a FLOOR (not behind the newest `v*` tag)
  run by `check.yml` on every PR, and an EXACT match run by the `verify-version`
  preflight in `release.yml` that every publishing job `needs:`. The floor is
  deliberately not an equality, so the bump PR — during which the fallback is
  one release ahead of every tag that exists — is not the thing it fails.

  `verify:env-docs` (`scripts/verify-env-docs.ts`) turns `docs/ENV.md`'s
  "superset of the schema" claim from an assertion into a check:
  `keys(envSchema) ⊆ rows(ENV.md)` and `keys(*.env.example) ⊆ rows(ENV.md) ∪
INFRA_ALLOWLIST`. It had been asserted and false — at `v1.0.0-beta.53` the
  table was missing two schema keys and seven `.env.example` keys. It is a
  completeness check only and never writes the file: the Notes column carries
  cross-field boot rules and failure behaviour no Zod schema encodes. Three
  vacuity floors fail the run rather than pass it when a population parses
  empty. It cannot reach variables read straight from `process.env` — they are
  in no schema and in no example file — which `docs/ENV.md`'s own header now
  says out loud.

### Changed

- **BREAKING: the `application` entity is now `space`, everywhere, with no
  compatibility layer** (#1227). The org-scoped container that delimits agents,
  skills and integrations is renamed across 619 files — wire, database, headers,
  routes, CLI, SPA and telemetry. `docs/NO_TRANSITIONAL_CODE.md` §1 forbids
  aliases and dual-read paths, so this breaks the contract ON PURPOSE: a caller
  still sending `X-Application-Id` or calling `/api/applications` now fails
  loudly rather than being quietly accommodated. Verified: no `/api/applications`
  route survives anywhere in `apps/`.
  `app_`-prefixed ids become `spc_`; the header is `X-Space-Id`; the OTel
  attribute is `appstrate.space.id` (the old series goes to zero without
  erroring, so dashboards must be repointed rather than debugged).
  `@appstrate/core` and `@appstrate/afps-runtime` both change public surface —
  each needs a major release, and `cloud` needs a CODE change, not just a
  version bump.

  **Deploying this is a maintenance window, not a rolling deploy**, and the
  operator steps are not optional:
  - One replica, port closed, migrations at boot. §1 forbids the
    expand-migrate-contract that would make a rolling deploy possible.
  - `pg_dump -Fc` immediately before. **There is no down migration**, and
    rolling the image back does not roll the schema back: the watermark is
    compared by timestamp, so a reverted deploy finds nothing to apply and runs
    old code against a renamed schema.
  - **Two artifacts, both required.** `0053_applications_to_spaces.sql` applies
    at boot and renames the catalog;
    `scripts/migration/0003-application-ids-to-space-ids.sql` is run BY HAND and
    rewrites the values. Neither is sufficient alone.
  - Then `VALIDATE CONSTRAINT` on `webhooks_level_values`,
    `webhooks_level_check` and `oauth_clients_level_check` — `0053` adds them
    `NOT VALID` because the rows still hold the old value at that point.
  - **Do NOT rewrite storage keys.** `files.storage_key`,
    `uploads.storage_key` and `storage_deletion_jobs.storage_key` keep their
    `app_` path segment deliberately: `0003` moves no bytes, so rewriting the
    keys would point every row at an object that does not exist. Nothing
    compares a storage key to a space id. New objects are written under `spc_`;
    old ones stay where they are.
  - Do not run `audit:storage-orphans` until verification is complete.
  - Announce the CLI break: nothing gates an installed CLI to a version, and §1
    forbids building such a mechanism, so users run `npm i -g appstrate@latest`
    on the day. Open dashboard tabs must hard-refresh, and OAuth connect flows
    in flight will fail (short Redis TTL, drainable).

  Untouched, because the word means something else there: `appfile://` (it
  encodes a `file_` id and never carried a space id), `APP_URL`, `--app-url`,
  the turborepo `apps/` directory, the Hono `app` variable, the ~3,100
  `application/*` MIME literals, `appp_`, and every use meaning the platform
  itself or a third-party OAuth app registered at Google, GitHub or Discord.

- **BREAKING: every remaining JSON request body is `.strict()` too — an unknown
  key is a `400` instead of a silent strip.** The entry above closed the package
  JSON bodies; this closes the rest of the API. `apps/api/src/routes/*.ts` went
  from 23 `.strict()` schemas to 68 — **45 more request bodies across 16 route
  files**: `integrations` (10), `models` (5), `organizations` and `spaces` (4
  each), `model-provider-credentials`, `packages`, `profile` and `proxies` (3
  each), `model-providers-oauth` (2), and one each in `agents`, `api-keys`,
  `auth-bootstrap`, `me`, `uploads`, `user-agents` and `welcome`. All 45 are
  top-level body schemas reached through `readJsonBody`; not one is a nested
  object tightened by accident.

  **This is a wire-contract change, not a validation tidy-up.** A client sending
  a property the body does not model used to get its `2xx` and have the property
  dropped on the floor. It now gets `400` `validation_failed`. The shape that
  breaks is read-modify-write — `GET` a resource, edit one field, `PUT` the
  whole object back — because every property of the response the update body
  does not model is now refused BY NAME, exactly as described for the package
  bodies above.

  The OpenAPI spec follows with no second edit: `z.toJSONSchema()` emits
  `additionalProperties: false` for a `.strict()` object, so every body wired
  through `apps/api/src/openapi/zod-schema-registry.ts` — which is nearly all of
  them — now advertises the refusal it enforces.

- **BREAKING (API keys): five more `GET` routes enforce a read permission.**
  Same class as the eight run and schedule reads gated in `1.0.0-beta.52`, and
  the same reasoning: each was gated on org membership alone and enforced
  nothing about what the caller may do.

  - `GET /api/agents` → `agents:read`
  - `GET /api/agents/{scope}/{name}/proxy` → `agents:read`
  - `GET /api/agents/{scope}/{name}/model` → `agents:read`
  - `GET /api/spaces/{spaceId}/packages` → `spaces:read`
  - `GET /api/spaces/{spaceId}/packages/{scope}/{name}` → `spaces:read`

  On the two agent detail routes the permission check is registered BEFORE
  `requireAgent()` on purpose: that middleware `404`s on an unknown agent, so
  the reverse order would answer "does this agent exist?" for a caller not
  allowed to read agents at all.

  **No dashboard user loses anything.** Every org role down to `guest` already
  holds `agents:read` and `spaces:read` (`apps/api/src/lib/permissions.ts`), so
  the SPA is unaffected. What changes is an ALREADY-MINTED API key scoped
  without the matching permission: it reached these five reads through org
  membership and now gets `403`. Both scopes are grantable to API keys — re-mint
  the key with them.

- **BREAKING: the package JSON bodies are `.strict()` — an unknown key is a
  `400` instead of a silent strip.** `source_code` was dropped from the package
  contract when its last reader died with the `tool` package type, and the
  schemas were left open, so a client still sending it got a `201` and a package
  without it with nothing anywhere saying the field had gone. A retired name
  must fail loudly (`docs/NO_TRANSITIONAL_CODE.md` §1) — the rule that closed
  the four launch surfaces in #1187, and this surface was left out of it. The
  barrier is generic and names no field: it refuses any key the body does not
  model. Seven request bodies carry `additionalProperties: false` in the spec to
  match — `POST /api/packages/{skills,agents,integrations}` and
  `PUT /api/packages/{skills,agents,integrations,mcp-servers}/{scope}/{name}`.
  Refusals answer `400` `validation_failed` blaming the field `body`.

  **Why this is BREAKING and not a fix: `.strict()` makes read-modify-write a
  `400`.** `packageJsonUpdateSchema` accepts four keys — `manifest`, `content`,
  `lock_version` and `operations` — and the rule for everything else is stated
  once, as a rule rather than a list, because a list goes stale the first time a
  response grows a field: **every property of the object the matching `GET`
  hands back, other than those four, is refused BY NAME.**

  For agents, `GET /api/packages/agents/{scope}/{name}` answers with the
  `AgentDetail` component's 24 properties, of which the update body accepts
  exactly two — `manifest` and `lock_version` (`content` is not among them: an
  agent's content comes back as `prompt`). The other 22 are refused.

  For skills, integrations and mcp-servers the `GET` answers with
  `OrgPackageItemDetail`, 22 properties, of which the update body accepts three
  — `manifest`, `content` and `lock_version`. The other 19 are refused.

  A third-party client that does the obvious thing — `GET` the package, edit
  `manifest`, `PUT` the object back — previously had those keys stripped and got
  a `200`; it now gets a `400` on `id`. **Send only `manifest`, `content`,
  `lock_version` and, where you mean it, `operations`.** In-repo callers are
  unaffected: the three `toWireBody`
  implementations already send exactly that, and `useCreatePackage`'s body type
  declared an `id?: string` no caller ever passed, removed here — a key declared
  against a now-strict body is a `400` waiting for its first caller.

  `detect:breaking` reports this as non-breaking, and that is correct about the
  OpenAPI _document_: it does not model a request body tightening
  `additionalProperties`, which is invisible to both it and the generated SPA
  types. This entry is the only signal a consumer gets. Same reasoning as the
  schedule-body entry further down, which enumerates its 15 refused fields for
  the same reason.

- **BREAKING: an AFPS integration declaring a bare auth-scheme `prefix` is
  refused at install time.** AFPS §7.6 defines `delivery.http.prefix` as a
  literal prepended to the rendered value — every spec example writes the
  trailing space. Appstrate additionally accepted the bare scheme (`"Bearer"`)
  in `Authorization` position and spliced the separator in at request time; its
  own comment called it "this compatibility rule". The injector now concatenates
  verbatim and inspects nothing, and validator rule (1d) rejects the bare form
  where the manifest author can act on it, naming the replacement
  (`Write "Bearer ".`).

  **51 in-repo system integrations wrote the bare form** — 44 `Bearer`,
  6 `Basic`, 1 `Zoho-oauthtoken` — and every one is fixed here with a patch
  bump and a rebuilt archive, per the immutable-published-version precedent of
  #928.
  Without the bump the fix stays inert in production. No exact-version pin
  references any of them.

  **Operators: an org-imported or org-published integration stored before this
  change stops resolving.** System packages are unexposed (`resolvePublishedManifest`
  short-circuits on the in-memory registry the rebuilt archives replaced), but
  `packages.draft_manifest` and `package_versions.manifest` hold the author's
  bytes verbatim and are never revalidated on read, so a stored bare prefix now
  fails `invalid_manifest` at the first read — which the route maps onto `404`,
  presenting as a missing integration rather than a bad prefix. Apply
  `scripts/migration/0005-afps-bare-auth-scheme-prefix.sql`; its `WHERE` is
  exactly the condition it removes (RFC 9110 token grammar, under
  `Authorization` or `Proxy-Authorization`, case-insensitive) and it is
  idempotent. It deliberately does not rewrite the uploaded archive bytes, so
  `package_versions.integrity` is untouched and the boot sync's refuse-overwrite
  guard still holds — the archive keeps the author's original spelling, and
  re-importing it now fails loudly at the install gate.

- **Run logs: an untagged `appstrate.progress` row renders as runtime output,
  not as model prose.** `assistant_message` is the only marker of
  model-authored text; the run-detail log view additionally treated a data-less
  `debug`-level progress row as agent text, "compatibility with runs emitted
  before `assistant_message` was stamped". No in-tree emitter produces that
  shape as agent text, and the one shape still producible from outside the tree
  is a runner lifecycle breadcrumb by definition — so the fallback was
  attributing a container-lifecycle line to the model. Bounded and cosmetic: for
  runs predating the stamp, such rows now carry the runtime dot instead of the
  speech-bubble icon. Text, ordering, level colour and grouping are unchanged.

### Removed

- **BREAKING (operators): migration `0055` drops `org_invitations.accepted_by`
  and `accepted_at` — and THE RELEASE CARRYING IT CANNOT BE ROLLED BACK.**
  Nothing read either column: `markInvitationAccepted`
  (`apps/api/src/services/invitations.ts`) wrote both beside the
  `status = 'accepted'` flip and no query anywhere read them back. This release
  is the one that stops writing them.

  The forward pin is the part an operator has to plan for. Migrations are
  applied AT BOOT, before the health gate (`apps/api/src/lib/boot.ts`), so the
  two columns are gone from the shared database the moment a container of this
  release starts — before anything has decided the deploy is good. Redeploying
  the previous image, which is the documented recovery path, then brings back a
  binary whose accept-invitation `UPDATE` names a column that no longer exists:
  Postgres `42703`, and every invitation acceptance `500`s until the image is
  rolled forward. Drizzle's runner has no down step and this migration has no
  inverse, so nothing restores them on the way back.

  **Roll FORWARD.** Redeploy this release or a later one rather than the
  previous image. If this release genuinely has to be abandoned, the previous
  image needs the two columns back first — the migration header ships the exact
  `ADD COLUMN` statements for that case. The other three sections of `0055` are
  rollback-safe; this one is what pins the release.

- **The `/applications` and `/app-settings` dashboard redirects are gone.** Both
  shipped through `v1.0.0-beta.53` as `<Navigate>` routes into
  `/org-settings/…`. The application → space rename moved them to `/spaces` and
  `/space-settings`, and this release removes them rather than renaming them
  again. A bookmark on any of the four spellings does not `404`: the
  authenticated shell's catch-all (`<Route path="*">` in `apps/web/src/app.tsx`)
  sends the visitor to the dashboard. What is lost is the deep link, not the
  session — the destinations themselves, `/org-settings/spaces` and
  `/org-settings/space/general`, are unchanged and reachable from the nav.

- **BREAKING (chat): `parent_id` and `format` are gone from the chat history
  response, and from the table behind it.** `GET /api/chat/sessions/{id}`
  returned each message as `{ id, parent_id, format, content }`, with all four
  `required` on the `ChatMessage` component; it now returns `{ id, content }`,
  in `seq` order. Both columns are dropped by migration `0054` in the same
  change — a column still echoed to the client cannot be dropped from one side.

  Neither had a reader. Every read of the table sorts by `seq`; nothing branched
  on `format`, nothing walked `parent_id` (no FK, no uniqueness), and the SPA's
  decoder already destructured `{ id, content }`. The transcript is a flat list.
  `parent_id` is a `DROP COLUMN`, so its values are discarded permanently — the
  migration header records what a row could have held and ships the pre-flight
  queries to measure it before applying.

  `detect:breaking` reports `0 breaking` here and always will:
  `scripts/detect-breaking-changes.ts` strips module-owned paths and schemas
  from both sides before comparing, so `ChatMessage` is absent from
  `apps/api/src/openapi/baseline.json` entirely. The gate is structurally blind
  to every chat wire change; this entry is the only signal. The first-party
  reader is safe by construction — the SPA is baked into the platform image, so
  a served build cannot be older than the platform serving it — but the route is
  a public one, and **a third-party client reading either field must stop.**

- **BREAKING (operators): the boot-time self-heal for the RFC 8707 oauth
  `resources` columns is gone — a database whose `__drizzle_migrations`
  watermark is ahead of its real schema now REFUSES TO BOOT.** Until now
  `reconcileOAuthResourceColumns()` re-ran migration `0006`'s DDL on every boot
  of every deployment, forever, so a drifted database silently worked. Nothing
  recorded when that repair could stop shipping.

  **If the check fires, the API will not start.** Apply
  `scripts/migration/0004-oauth-resources-watermark-drift.sql` to the database
  and restart; the boot error names the file. The repair is idempotent and a
  few seconds of additive DDL.

  **Most upgrades will not see it, and that is not reassurance.** The self-heal
  ran on every boot of every release up to this one, so a database that drifted
  earlier already had these columns restored and will pass the check with its
  watermark still corrupt. The check is a signature for one migration, not a
  drift detector: it catches a drift that first appears from here on, or a
  restore of a backup taken before the heal. Run the ledger diagnostic in the
  script's header to see the real extent on any database you suspect.

  Refusing rather than warning is deliberate: drizzle's postgres-js migrator
  applies by `max(created_at)`, so a corrupted watermark skipped **every**
  migration below it, not just `0006`. A process that kept running would serve
  from a schema nobody can enumerate and fail later at unrelated queries naming
  none of this. The check is a signature, not a proof — a watermark corrupted
  _after_ `0006` applied leaves these columns present and passes — so the script
  also ships the diagnostic query for the true extent of the drift. It
  deliberately does not touch the ledger: lowering a watermark makes the
  migrator replay migrations that did apply, and most are not idempotent.

  Tier 0 (PGlite) cannot reach this state — `applyCorePGliteMigrations` keys on
  the journal tag, not on a watermark.

- **BREAKING (internal API): `GET /internal/mcp-server-bundle/{scope}/{name}`
  now returns `400` when `?version=` is absent on a non-system mcp-server**,
  where it used to serve the latest non-yanked version. That fallback existed
  for pre-#588 sidecars: the platform, `PI_IMAGE` and `SIDECAR_IMAGE` are a
  version contract, and `@appstrate/env` fails boot on a disagreeing trio, so a
  sidecar that old cannot be paired with this platform by tag. It silently
  reintroduced the exact manifest/bytes skew #588 closed.

  This is a container-to-host route; no external client calls it, and the
  sidecar in the matching image sends the parameter for every package that has
  a version to send. System mcp-servers have none — they are served from the
  in-memory boot registry by id alone — and still omit it, which is why the
  parameter stays optional in the spec rather than becoming `required`.

  The guard is not airtight, and this entry does not lean on it. Digest pinning
  is supported, and `findRuntimeImageTagMismatch` skips a digest-pinned ref
  outright; the guard also says nothing about containers already running when
  the platform restarts, which is why the release notes carry a drain step. So
  a pre-#588 sidecar CAN reach this platform, and it now 400s on every
  local-source integration instead of silently running skewed bytes. The load-
  bearing argument is the other one: nothing in a matching image omits the
  parameter, because the resolver only leaves it unset for system mcp-servers,
  which the route answers before it reads the query at all.

- **BREAKING (installer): `APPSTRATE_AUTO_INSTALL` is retired.**
  `scripts/bootstrap.sh` does not read it at all — nothing in the repository
  does. It was a fourth trigger for a decision three live signals already make
  (`--yes`, `CI=true|1|yes`, stdout is not a TTY), and its only justification
  was preserving the pre-two-step "always auto-install" default for IaC written
  against it.

  **OPERATOR ACTION: replace `APPSTRATE_AUTO_INSTALL=1` with `--yes`**
  (`curl -fsSL https://get.appstrate.dev | bash -s -- --yes`). An Ansible /
  cloud-init run that still exports it takes the two-step path and exits 0
  having dropped the binary and installed nothing, with no message naming the
  variable — so fix the caller rather than waiting for one. CI runners and
  non-TTY contexts already select unattended mode on their own and need no
  change. `APPSTRATE_NO_LAUNCH=1` is untouched.

### Fixed

- **Migration `0055` repairs three shapes the declared schema and the database
  disagreed on.** All three were found by diffing the declared schema against a
  catalog built by replaying the migration journal
  (`migration-schema-parity.test.ts`); none is a query bug, and none rewrites a
  row value.

  - **`audit_events.space_id` no longer carries a foreign key.** It had
    `REFERENCES spaces(id) ON DELETE SET NULL`, twelve lines below the table's
    own comment arguing that `org_id` is deliberately NOT a foreign key because
    "an audit log is an immutable historical record: it must outlive the
    entities it describes". `DELETE /api/spaces/:id` is a live route, so every
    historical audit row for a deleted space lost its attribution the moment it
    ran, irreversibly — `action` is a verb and `resource_id` names the resource,
    not its container. The column is now a denormalised `text`, same posture as
    `org_id`: a `space_id` may name a space that no longer exists, which is the
    intent.
  - **Two indexes for the space-deletion cascade.** Deleting a space CASCADEs
    into `notifications` and `package_persistence`, and neither had an index
    whose LEADING column is `space_id` — Postgres indexes only the REFERENCED
    side of a foreign key. Both cascades seq-scanned under a held row lock.
    Added: `idx_notifications_space` and `pkp_space`, single-column and
    non-partial. The third cascade target, `audit_events`, needs no index — the
    change above removed the scan instead.
  - **Two foreign-key names past Postgres' 63-byte identifier limit.** Drizzle
    derived `integration_org_defaults_connection_id_integration_connections_id_fk`
    (68 bytes) and
    `model_provider_pairings_credential_id_model_provider_credentials_id_fk`
    (70), and Postgres silently truncates at creation — so the catalog had only
    ever held the short forms while the TypeScript schema claimed the long ones.
    They are renamed to what the catalog holds.

  Every constraint the migration touches is located through `pg_constraint` by
  its COLUMNS and its TARGET, never by its name. That is not stylistic:
  production's `audit_events` predates drizzle's `_fk` convention and carries
  Postgres' own `_fkey` spelling, and a `DROP CONSTRAINT "<declared name>"` is
  exactly what failed the beta.24 deploy with `42704`, aborting the whole batch.

- **The weekly system-package conformance monitor can fail again.** The job
  captured the harness's exit code into a step output, used it only to decide
  whether to file a tracking issue, and never re-raised it — so
  `.github/workflows/conformance-monitor.yml` reported success while the
  harness reported `4 fail`, and issue #1206 sat open and uncommented for
  three days behind a green run. The code is now re-raised by a final step
  that runs _after_ the issue is filed, keeping the ordering that made the
  capture necessary in the first place: a job that dies on the harness never
  reaches the reporting step, so a red run would otherwise destroy its own
  diagnostics.

- **`@appstrate/clickup-mcp` 1.2.1 → 1.2.2 and `@appstrate/gmail-mcp`
  2.3.1 → 2.3.2 declare the tools their servers actually expose.** ClickUp
  advertises `clickup_create_task_comment`, `clickup_merge_document` and
  `clickup_merge_document_page` (all three named as deferred follow-up in
  #1172 and confirmed by the monitor since); Gmail has added
  `update_message_labels` (`gmail.modify`, like the other label mutations)
  and `get_draft` (`gmail.readonly`, like `list_drafts`) upstream. Both
  packages are version-bumped and their archives rebuilt — a published
  version is immutable, so an unbumped manifest fix never reaches production
  (#928).

- **The `refresh-strategy` waiver list is a ratchet instead of a wall.**
  `UNVERIFIED_CEILING` was an upper bound, so it caught a growing backlog but
  waved through a shrinking one — verify a provider, remove its entry, and the
  ceiling silently kept the free seat for the next waiver. It is now an
  equality: the backlog cannot grow, and it cannot shrink without the ceiling
  being lowered in the same commit. The burn-down procedure — what "verifying
  one entry" actually means, and which four things to edit — is documented on
  the list itself.

### Security

- **The sidecar's HTTP control surface is authenticated, deny-by-default.**
  Every route on the sidecar app now sits behind an `app.use("*")` middleware
  (`runtime-pi/sidecar/app.ts`) that refuses any request not presenting the
  run's sidecar token on the `x-appstrate-sidecar-auth` header
  (`SIDECAR_AUTH_HEADER`, `packages/core/src/sidecar-types.ts`). The comparison
  is constant-time and fails closed on both halves — an absent header AND an
  unconfigured sidecar are each a refusal, so a sidecar with no token answers
  nobody. The refusal is a bare `401 { "error": "unauthorized" }`: no
  `WWW-Authenticate` challenge and no hint about which half failed. `GET /health`
  is the single exemption, because the orchestrator probes it before the run
  exists and it discloses one bit.

  **The per-run Docker network had stopped being the boundary.**
  `integration-runtime-adapter-docker.ts` attaches every third-party integration
  runner to the same bridge and hands it `http://sidecar:<port>`, so "on the
  network" no longer meant "is the agent": without a token, a
  `source.kind: "local"` integration reached the LLM reverse proxy with one
  `curl` and spent the organization's provider credential unattributed. `/llm/*`,
  `/mcp`, `/integrations/boot-report` and `/runtime-events` had each ended up
  open one at a time, which is why the gate is deny-by-default rather than
  per-route opt-in — a route added later is protected without anyone remembering
  to say so.

  **The token is NOT the run token and carries none of its authority.** It is
  256 bits minted per run by the launcher (`randomBytes(32)`,
  `apps/api/src/services/run-launcher/pi.ts`) and handed to both sides of the
  pair — the sidecar's `SIDECAR_AUTH_TOKEN` and, via `buildRuntimePiEnv`, the
  agent container's. It asserts "I am the agent container talking to my own
  sidecar" and nothing more; the zero-knowledge boundary is unchanged, the agent
  still holds no token that can call the platform back, and this one cannot be
  used to derive one. It gets its own header rather than `Authorization` because
  on `/llm/*` that slot already carries the vendor credential placeholder the
  sidecar swaps for the real key, and both `/llm/*` forwarding paths strip it
  (and its `x-appstrate-pi-sdk` sibling) so it never rides on to a vendor.

  `runtime-pi/entrypoint.ts` now deletes `SIDECAR_AUTH_TOKEN` alongside
  `SIDECAR_URL` once the MCP client, the runtime-event drainer and the Pi model
  record each hold their own copy — together they are the capability to spend
  the org's provider credential, and the agent loop runs model-chosen shell
  commands over attacker-influenced input.

  **Operators: the platform and both runtime images must move together.** A
  sidecar image predating this change ignores the header and stays open; an
  agent image predating it presents nothing and gets `401` on every call. The
  #1201 image-trio boot guard already refuses a deployment whose platform,
  `PI_IMAGE` and `SIDECAR_IMAGE` versions disagree, so a correctly pinned
  compose file cannot land in either state.

## [1.0.0-beta.53] - 2026-08-26

No entries were recorded for this release. `CHANGELOG.md` is byte-identical at
`v1.0.0-beta.52` and `v1.0.0-beta.53`, so everything below shipped in beta.52
or earlier.

## [1.0.0-beta.52] - 2026-08-25

### Added

- **The `check` chain now fails on dead exports** (`bun run verify:dead-code`,
  backed by [knip](https://knip.dev) and `knip.config.ts`). `no-unused-vars`
  only sees locals — an exported symbol is "used" by construction — so nothing
  in the gate could answer "does this exported symbol still have a reader".
  That blind spot is what let the dead weight removed in the previous audit
  accumulate for months. The same pass also reports dead files and unused
  dependencies. Entries and ignores in `knip.config.ts` each carry a
  justification: an entry says _what reaches the file_, an ignore says _why
  knip is structurally blind_.

  Published packages are deliberately out of scope for public-export death:
  `@appstrate/core`, `@appstrate/afps-runtime` and the `@appstrate/module-*`
  packages are consumed out of tree, so "no in-repo reader" is not evidence.
  That exemption is obtained by hand, not inherited: knip derives no entry
  from a package manifest — it reads neither `exports` nor `bin`, `main` or
  `module` — and declaring an `entry` array for a workspace replaces even its
  filename defaults. So each published workspace must re-declare every target
  of its export map in `knip.config.ts`, or its whole public surface reads as
  dead. Letting that drift is what produced a ~161-finding false red.

- **`integration_dropped` — a run that starts without an integration it
  declared now says so, in the run log** — "run with what you have" is a
  supported product mode: an agent whose integrations are only partly connected
  still starts, with the subset that resolved. It started SILENTLY, though. A
  run missing its Gmail tools looked exactly like a run whose agent simply
  chose not to call them, and the only trace was a `logger.warn` on the
  server, which the person reading the run page cannot see. The most common
  report was "the agent is ignoring my instructions", for a run that never had
  the tools those instructions name. `resolveIntegrationSpawns` now returns
  every drop alongside the specs, and the pipeline writes one `warn` `run_logs`
  row per dropped integration at kickoff — event `integration_dropped`, ordered
  before the container's own output, carrying `integrationId` and a
  machine-readable `reason` (`not_found`, `not_integration`,
  `invalid_manifest`, `not_installed`, `remote_url_missing`,
  `local_server_ref_missing`, `mcp_server_unresolved`,
  `mcp_server_not_runnable`, `no_delivery`, `resolve_error`) plus an optional
  `detail` when the reason alone is not actionable. It rides the same
  `pg_notify` → SSE path as the container's breadcrumbs, so it shows up live.
  Nothing about which runs start changes: a healthy run writes zero rows, and
  the marker swallows its own write failures so it can neither slow down nor
  fail a kickoff that is otherwise ready.

### Changed

- **BREAKING: run and schedule `GET` routes now enforce a read permission.**
  Eight reads were gated on org membership alone and enforced nothing about
  what the caller may do, so any credential that could reach the org could
  list runs, read a run, stream its logs, and read every schedule. Each now
  requires the scope it was always documented to require:

  | Route                                      | Scope            |
  | ------------------------------------------ | ---------------- |
  | `GET /api/runs`                            | `runs:read`      |
  | `GET /api/runs/{id}`                       | `runs:read`      |
  | `GET /api/runs/{id}/logs`                  | `runs:read`      |
  | `GET /api/agents/{scope}/{name}/runs`      | `runs:read`      |
  | `GET /api/schedules`                       | `schedules:read` |
  | `GET /api/schedules/{id}`                  | `schedules:read` |
  | `GET /api/schedules/{id}/runs`             | `schedules:read` |
  | `GET /api/agents/{scope}/{name}/schedules` | `schedules:read` |

  **No org role loses access.** Every role down to `viewer` holds both scopes,
  and session auth derives permissions from the role, so the dashboard and any
  cookie-authenticated client are unaffected.

  **The change is breaking for API keys and OIDC clients**, which carry exactly
  the scopes they were minted with, intersected with the creator's role — there
  is no "narrow scope implies the rest" fallback. **Audit issued key scopes
  before upgrading.**

  Two callers are affected in a way worth naming, because both LAUNCH before
  they read and so leave a billed run behind rather than failing cleanly:

  - `appstrate run --remote` and `appstrate/github-action` trigger with
    `agents:run`, then poll `GET /api/runs/{id}` and `…/logs`. A key narrowed
    to `agents:run` now starts the run and 403s on every poll. The CLI's own
    failure hint used to name `agents:run` alone and now names both scopes.
  - `run_and_wait` over MCP dispatches the launch in-process with the caller's
    own auth and then polls the same route; its tool description tells the
    model not to fall back to `getRun`, so there was no recovery path. It now
    pre-checks `runs:read` alongside `mcp:invoke` and refuses BEFORE launching.

  `detect:breaking` reports these as non-breaking additions, and that is
  correct about the OpenAPI _document_ — adding a `403` response is schema-
  additive. It says nothing about runtime behaviour, which is why this entry
  exists.

- **BREAKING: `document` is now `file`, everywhere the concept is named
  (#1177) — and the compatibility layer the rename shipped with is gone.**
  `publish_document` accepted Markdown, HTML, source code, a PDF, an image —
  anything on the agent's filesystem — but "document" promises a Word or a PDF
  to whoever reads the tool description, the model included. The word was a
  false friend, so the concept is renamed from the schema to the wire.

  The rename first shipped a READ alias on every wire-visible spelling, each
  one justified by a single sentence: "the runtime image and the platform
  deploy independently". `v1.0.0-beta.51` is precisely the artifact on the
  other side of that sentence, and it speaks every retired shape: it registers
  `/api/runs/{runId}/documents` and `/api/runs/{runId}/documents/{name}` and
  not one `/files` route; `runtime-pi/publish.ts` posts each deliverable to
  `…/documents` under `X-Document-Name`; `runtime-pi/provision.ts` fetches its
  input manifest from `…/documents`; `packages/afps-runtime/src/events/cloudevents.ts`
  stamps `dataschema` on every canonical event; and its row ids are `doc_`. So
  the argument for deleting the layer is NOT that nobody ever spoke the old
  shapes — the last release did. It is that the PAIRING of such an artifact
  with this platform is now refused at boot: the environment schema will not
  start unless the platform's own `APP_VERSION` and both runtime image tags
  agree (see the entry below), so an old image cannot be _configured_ against
  a new platform.

  **That rule has blind spots, and they are the whole residual risk.** They
  come in two kinds. The comparison carves itself out wherever a tag cannot
  answer the question — a runtime ref pinned by digest alone silences it
  outright (`findRuntimeImageTagMismatch` returns `null` the moment either ref
  parses to no tag), and a platform with no release identity drops out of the
  trio, degrading the rule to the image-pair rule it grew from; the
  authoritative list of those carve-outs lives with the comparison in
  `@appstrate/core/image-ref`. And then there is the one that is not a carve-out
  at all: this is an env-schema check evaluated at BOOT, so it says nothing
  whatsoever about containers **already running** when the platform restarts.
  (Same-tag-two-builds drift — `:latest` rebuilt on one side — is invisible to
  tag comparison by construction; `runtime-image-pair.ts` catches it from the
  OCI revision labels after the pre-pull, and only WARNS.)

  That second kind is the operational one, and it needs a step in the upgrade
  rather than a paragraph. A run container started by the PREVIOUS
  platform process survives a `compose up -d`: the boot sweep finalizes only
  runs whose heartbeat has already gone stale (`listOrphanRunIds`, cutoff
  `RUN_STALL_THRESHOLD_SECONDS`), and the container sweep preserves anything in
  state `running` (`isReclaimableContainer`); a container still executing a run
  satisfies neither reap condition. It keeps posting to the new API, and its
  `POST …/documents` now
  404s. In the uploader a 404 is a non-retryable 4xx, so the deliverable is
  abandoned and the outputs sweep reports `artifacts.status: "partial"`. That
  field is not an input to the run's status — `mapTerminalStatus` reads only
  `result.status` / `result.error` — so **a run whose work succeeded still
  settles `success`, with its deliverable simply missing**, which is the exact
  silent failure the aliases existed to prevent. **Drain in-flight runs before
  restarting the platform**; see OPERATOR ACTIONS below.

  What is verified about released consumers is narrower, and holds: the
  released CLI never called the retired paths, neither `cloud` nor
  `connect-helper` contains any retired wire shape, and the SPA is baked into
  the platform image, so a served build cannot be older than the platform
  serving it. The layer is deleted, not deprecated.

  | Surface             | Before                                                                                    | After                                                                     |
  | ------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
  | Runtime tool        | `publish_document`                                                                        | `publish_file`                                                            |
  | URI scheme          | `document://<id>`                                                                         | `appfile://<id>`                                                          |
  | REST                | `/api/documents/*`, `/api/runs/{id}/documents[/{name}]`, `/preview/documents/{id}`        | `/api/files/*`, `/api/runs/{id}/files[/{name}]`, `/preview/files/{id}`    |
  | MCP tools           | `list_documents`, `read_document`, `import_package_document`, `validate_package_document` | `list_files`, `read_file`, `import_package_file`, `validate_package_file` |
  | Run event / run log | `document.published`, `event: "document"`                                                 | `file.published`, `event: "file"`                                         |
  | Run DTO             | `document_counts`                                                                         | `file_counts`                                                             |
  | Inline launch body  | `context_documents`                                                                       | `context_files`                                                           |
  | Upload header       | `X-Document-Name`                                                                         | `X-File-Name`                                                             |
  | Permission resource | `documents:read`, `documents:delete`                                                      | `files:read`, `files:delete`                                              |
  | Problem code        | `document_count_exceeded`                                                                 | `file_count_exceeded`                                                     |
  | Tables              | `documents`, `document_links`                                                             | `files`, `file_links`                                                     |
  | French UI           | « Documents »                                                                             | « Fichiers »                                                              |

  `appfile://` rather than `file://`: the latter already means the local
  filesystem and is what MCP uses for local resources, so an opaque platform id
  under it is ambiguous to the model and to every MCP client.

  **The rename now reaches the physical layer too**, and none of it has an
  alias. The row-id prefix is `file_` (`prefixedId("file")`, validated by
  `FILE_ID_RE`); the durable storage bucket and its `storage_key` prefix are
  `files`, and the run-workspace input prefix is `{runId}/files/`; the
  `storage_deletion_jobs.reason` labels are `file_deleted` / `file_expired`;
  and the four file-limit environment variables are renamed:

  | Before                     | After                       |
  | -------------------------- | --------------------------- |
  | `DOCUMENT_MAX_FILE_BYTES`  | `FILE_MAX_BYTES`            |
  | `DOCUMENT_RETENTION_DAYS`  | `FILE_RETENTION_DAYS`       |
  | `RUN_MAX_DOCUMENTS`        | `RUN_MAX_FILES`             |
  | `WORKSPACE_MAX_DOCS_BYTES` | `WORKSPACE_MAX_FILES_BYTES` |

  An `.env` still carrying an old variable name is not read — the schema
  ignores it and the limit silently reverts to its default — so grep for the
  left column above. See `docs/ENV.md` and `docs/architecture/FILES.md`.

  **What is gone, and what a caller gets instead:**

  1. **The nine `/documents` route registrations — six on the file routes,
     three run-scoped — are gone. They 404.** Eight operations drop out of the
     OpenAPI document, along with both alias generators in the spec (the second
     of which was a divergent copy that hand-rolled an unanchored
     `replace("/files", "/documents")`). The baseline is regenerated in the same
     commit, as `detect:breaking` requires, so CI reports no change and this
     list is the record. Use `/api/files/*` and
     `/api/runs/{id}/files[/{name}]`.
  2. **`X-Document-Name` is gone, and `X-File-Name` is now properly
     `required`** — the alias was the only reason it was not. An upload
     arriving without `X-File-Name` is an explicit `400`.
  3. **`context_documents` on both inline-run bodies, and the `dataschema`
     CloudEvents attribute on the run-events ingestion route, are `400`s.**
     Each of those bodies is `.strict()`, so the retired field is refused by
     name rather than stripped. The `run_and_wait` TOOL ARGUMENT of the same
     name used to be canonicalized to `context_files` by the shared launch
     client; it is now refused by name there too. Refused rather than merely
     unread, because that client builds the launch body from an allowlist —
     an argument nobody names is invisible, and the run would start with
     nothing mounted while every layer reported success.
  4. **`document.published` is no longer accepted as a runtime-tool event**, at
     either acceptor — and the two are safe for different reasons. Inside the
     container the reason is structural: the only producer of that name is
     core's own `filePublishedEvent`, bundled into the SAME artifact as the
     trust-boundary acceptor `reEmitRuntimeToolEvents`, so there is no version
     boundary between them and the retired name can only arrive forged, which
     is what the acceptor's drop is for. The platform-side sink
     (`persistRunEvent`) is a DIFFERENT artifact reached over HTTP, so that
     argument does not reach it; what does is the image-tag rule above — plus
     the fact that the event's own precondition went with it, since a
     pre-`#1177` container emits `document.published` only after a SUCCESSFUL
     `POST …/documents`, and that route now 404s.
  5. **`workspace/documents/` and the `documents` twin key in the run-input
     manifest are gone from both sides.** `runtime-pi/provision.ts` no longer
     probes `/documents` after a `404` on `/files` (that `404` is the ordinary
     "this run carries no input files" case, so the fallback cost a second
     signed round-trip on the common boot path to reach a route no platform
     serves), no longer reads `manifest.files ?? manifest.documents`, and no
     longer symlinks `documents -> files` in the workspace. The manifest's
     `documents` key was in `required`, which made the deprecated spelling
     contractually mandatory. A pre-rename manifest object now fails loudly at
     both consumers: the serve path `500`s and the container dies with
     `Failed to fetch files manifest` rather than starting with an empty
     workspace, and the deletion path throws and dead-letters.
  6. **`document://` no longer parses.** It survived to read historical rows,
     but every URI ever written under it addresses a `doc_` id and `FILE_ID_RE`
     stopped accepting those, so the only form the accept path could still have
     matched was `document://file_…` — which no build has ever emitted. A
     `document://` value now fails at `parseFileUri` instead of one line later
     on the id, in the same `400`.
  7. **`documents:read` / `documents:delete` are refused, and this is the one
     retirement with a real caller behind it.** The read-time alias layer is
     gone: `LEGACY_PERMISSION_RESOURCE_ALIASES`, `canonicalPermission`,
     `canonicalPermissions`, `acceptedPermissionSpellings`, the second-chance
     branch inside `makePermissionGuard` (which backs all three permission
     guards), and the scope canonicalizers across the OIDC module. The alias
     itself never shipped — but `documents:*` **is** the spelling every
     released Appstrate advertised, so a third-party OAuth client integrated
     against `v1.0.0-beta.51` holds it in config and now gets `invalid_scope`
     at `/oauth2/authorize` instead of being silently rewritten. That is a
     deliberate trade: for a beta with no production data, a loud refusal is
     the right failure and a silently under-granted scope is not. The live
     windows are bounded by their own TTLs — an access token expires in 15
     minutes, a pending authorization code in 10 — and an
     `OIDC_INSTANCE_CLIENTS` value still naming `documents:read` fails boot
     with a message that prints the offending string rather than rewriting it.
     What the caller SENDS is refused; what is already STORED is migrated —
     `0046` rewrites every persisted spelling, so no existing credential is
     silently narrowed. See "Migrations" below.

     The API-key write path now refuses on the same principle. `POST
/api/api-keys` with a scope that is not grantable at all — an unknown
     string, a retired spelling like `documents:read`, or a session-only
     permission — is a `400` naming the offender, where it previously filtered
     the value out and answered `201` with a key that then 403'd on
     everything. A scope that is valid but above the creator's own role is
     still narrowed silently: that is a real rule ("you cannot delegate more
     than you hold"), not a swallowed typo, and the scopes-omitted default
     branch relies on it.

     Three tests were passing only because of the alias, which justifies the
     removal on its own: `enduser-token-auth` minted tokens carrying
     `documents:read` and asserted `/api/files/*` answered `200`. #1193 renamed
     the routes and left the scopes on the old spelling; the alias hid the gap.

  **Nothing reads an old spelling any more.** The rename shipped with a read
  alias on every wire-visible spelling. The last five were kept on the
  strongest ground available — a value a RELEASED build wrote into a place the
  current build still reads, or a vocabulary a protocol had told a client was
  stable — and they are gone too, because no such value and no such client
  exists:

  - `run_logs` rows tagged `event: "document"` are no longer rendered
    (`PUBLISHED_FILE_LOG_EVENTS` is now just `["file"]`). Such a row would show
    without its attachment — an absence, not an error.
  - The `documents` key of a persisted `run_and_wait` result, and items keyed
    `document_id`, are no longer read. Only `files` / `id` / `file_id` are.
  - `publish_document` in `manifest.runtime_tools` is no longer canonicalized.
    Author input naming it is REFUSED; a stored manifest has it DROPPED and the
    drop REPORTED to the caller — never silently reinterpreted as `publish_file`.
  - The four retired MCP tool names are no longer registered. A client holding
    a cached tool list gets `-32602 Unknown tool` and re-lists; that was the one
    alias with a live protocol argument behind it (`tools.listChanged: false`),
    and the cost is transient where the second dispatch path was permanent.
  - `context_documents` as a `run_and_wait` tool argument is REFUSED BY NAME.
    That distinction is the whole point: the launch body is built from an
    allowlist, so merely not reading it would make it invisible — the run would
    start with nothing mounted and every layer would report success.

  Two more went with them: the `setDocumentStorageLimit` platform-services
  alias (`@appstrate/cloud` now binds `setFileStorageLimit`; see the ship order
  below) and every retired run-detail tab hash. The `result.text` /
  `result.text_truncated` fields of the removed `report` tool left the run
  resource at the same time.

  **Ship order, and it is not optional — the platform goes FIRST.**
  `@appstrate/cloud` binds the storage capability off the LIVE services object
  this platform injects, not off its pinned types, so the rename does not reach
  its read. The instinct is to ship cloud first; the build topology says
  otherwise. The cloud image is built
  `FROM ghcr.io/appstrate/appstrate:${APPSTRATE_VERSION}` and resolves
  `@appstrate/core` out of that image, so the two are ONE deployed artifact and
  never meet each other's old version at runtime. What gates cloud is its CI,
  which typechecks inside the newest PUBLISHED release: `v1.0.0-beta.51` has
  only `setDocumentStorageLimit`, so appstrate/cloud#52 is red until a release
  carries the new name. Sequence: merge and release this → re-run cloud's
  checks → merge cloud. Publishing core `8.0.0` to npm is NOT on that critical
  path; cloud never resolves core from the registry.

  **What a consumer has to do:**

  1. **The run resource field `document_counts` is now `file_counts`, and
     `primary_document_id` is gone.** There is NO response-side alias for
     either: an out-of-tree API consumer still reading them gets `undefined`,
     silently, with a `200`. This repo has already broken a consumer exactly
     this way (`github-action` sending a removed field), so it is spelled out
     rather than left to the diff. Read `file_counts.{input,output}`; for "which
     file to show", see the derived rule under Removed.
  2. **Five RFC 9457 problem codes are renamed, and NONE of them has a read
     alias.** The code is a string a client branches on; an unrecognised value
     falls to whatever the client's default arm does, silently.

     | Before                    | After                 | Raised by                                                                                       |
     | ------------------------- | --------------------- | ----------------------------------------------------------------------------------------------- |
     | `document_count_exceeded` | `file_count_exceeded` | `413`, `RUN_MAX_FILES` over-cap (`@appstrate/core/api-errors`)                                  |
     | `document_in_use`         | `file_in_use`         | `409`, `DELETE /api/files/{id}` on a file a live run still links (`services/files.ts`)          |
     | `document_unavailable`    | `file_unavailable`    | `409`, an input file deleted between resolve and run creation (`services/state/runs.ts`)        |
     | `duplicate_document_name` | `duplicate_file_name` | `400`, colliding workspace names in a run's input manifest (`services/run-file-naming.ts`)      |
     | `document_uri_in_prompt`  | `file_uri_in_prompt`  | field-level code inside the `400 validation_failed` on an inline run (`services/inline-run.ts`) |

     The limits and the statuses are unchanged; only the strings moved.

  3. **`publish_document` is now `publish_file` and no longer accepts
     `presentation`.** The retired id is not aliased: author input naming it is
     refused, and a stored manifest has it DROPPED with the drop REPORTED to
     the caller. That report is the part that matters —
     `dropRetiredRuntimeTools()` removes ids it does not recognise, so a silent
     drop would strip the tool from an agent that had selected it with nothing
     in any log. A caller that still sends `presentation` has it ignored, not
     rejected.
  4. **The four MCP tools are renamed, and the old names are gone.**
     `list_documents`, `read_document`, `import_package_document` and
     `validate_package_document` are no longer registered, hidden or otherwise,
     and the `document_uri` argument is no longer renamed on the way in. The
     server advertises `tools: { listChanged: false }`, so a client that listed
     before the upgrade and calls an old name after it gets `-32602 Unknown
tool` and re-lists. That is the one alias here with a live protocol
     argument behind it; the cost of dropping it is transient, where a second
     dispatch path for four capabilities was permanent.

     One MCP break is NOT covered by any alias, and it is client-facing: a
     dynamically-registering client whose published Client ID Metadata Document
     still declares `documents:read` / `documents:write` now fails registration
     with `invalid_scope`. `@better-auth/cimd` lists `scope` in
     `ALLOWED_METADATA_FIELDS` and feeds it into
     `createOAuthClientEndpoint(..., { isRegister: true })`, which validates
     every requested scope against the server's set and throws on anything
     outside it. Nothing is silently mis-granted — registration is refused
     outright — but the client's own metadata has to be updated to the `files:`
     spelling. Tell any partner registering through CIMD before you deploy.

  5. **The four OpenTelemetry metric series are renamed:
     `appstrate.documents.created`, `.deleted`, `.storage_limit_rejections` and
     `.partial_publications` are now `appstrate.files.*`.** Nothing errors —
     dashboards, alerts and recording rules built on the old series simply go to
     zero and stay there. Repoint them, and check any alert whose condition is
     "below threshold": those fire, and the ones that are "above threshold" go
     quiet without ever telling you why.
  6. **`@appstrate/core`: the `./document-uri` subpath is now `./file-uri`**,
     with `DOCUMENT_URI_PREFIX` → `FILE_URI_PREFIX`, `isDocumentUri` →
     `isFileUri`, `parseDocumentUri` → `parseFileUri`, `documentUri()` →
     `fileUri()`, `extractDocumentIds[FromText]` → `extractFileIds[FromText]`,
     plus renames on `./permissions`, `./telemetry`, `./api-errors`, `./module`
     and `./run-and-wait-client`. **Core is NOT published from this branch** —
     but this build cannot ship before it is. `cloud` binds
     `services.setFileStorageLimit` off the LIVE services object this platform
     injects at boot, and the deprecated `setDocumentStorageLimit` alias that
     used to cover that seam is gone. A type-level pin never protected it: a
     property read at boot does not typecheck. Ship order is this platform
     release → `cloud` (appstrate/cloud#52, whose CI cannot go green until such
     a release exists) → npm publication of core `8.0.0` when it suits other
     consumers. Cloud's range is raised to `>=8.0.0` as a truthful declaration
     — the published `7.0.0` exposes only the old name — not as a resolution
     constraint, since core is an optional peer it takes from the image.
     `connect-helper` reads none of this surface. See
     `packages/core/CHANGELOG.md`.

  **OPERATOR ACTIONS, and SQL cannot perform them.** Migration
  `0044_finish_file_rename` carries the data half — it rewrites every
  `files.storage_key` from `documents/…` to `files/…`, the outbox's copy of the
  bucket name, the run-workspace keys the outbox holds, and the two deletion
  reasons. **It moves no bytes.** Until the objects follow, a download `404`s on
  a file that physically exists. In the same window:

  - **drain in-flight runs BEFORE the platform restarts**, and do not launch
    new ones until the window closes. A container the previous platform process
    started is not stopped by the upgrade and is not reaped at boot while it is
    still heartbeating, so it survives into the new platform and its
    `POST …/documents` 404s — losing the deliverable while the run finalizes
    green. This is the same drain the run-workspace rename below needs, so one
    drain covers both;
  - copy the `documents` bucket onto `files` and drop the old one
    (`aws s3 sync s3://documents s3://files`, or `mc mirror`); on filesystem
    storage (tier ≤ 2) it is a directory rename under
    `./data/storage/`, `documents` → `files`;
  - rewrite the second key segment of every `{runId}/documents/<name>`
    run-workspace object to `{runId}/files/<name>`. **In-flight runs do not
    survive that rename — drain them first.**

  **A database holding `doc_` ids should be reset, not migrated.** Existing
  `files.id` values are deliberately NOT re-minted, and `FILE_ID_RE` now
  accepts only `file_`, so those rows are unaddressable: the id fails
  validation before any query reaches them. Re-minting is not a two-table
  `UPDATE` — the id is quoted inside `runs.input`, `runs.result`, `run_logs`,
  chat payloads and append-only `audit_events.after` — and a partial rewrite
  would silently break every rerun, which is worse than none.

  **Stored permission scopes are the opposite case — they ARE migrated.** The
  verdict above does not extend to them: `0046_legacy_permission_scope_strings`
  rewrites every persisted `documents:*` spelling to `files:*` at migration
  time, across all seven columns that carry the vocabulary — the five `text[]`
  ones (`api_keys.scopes`, `oauth_clients.scopes`, `oauth_consents.scopes`,
  `oauth_refresh_tokens.scopes`, `oauth_access_tokens.scopes`) and the two
  space-delimited `text` ones (`cli_refresh_tokens.scope`, `device_codes.scope`).
  A credential issued under the old spelling therefore keeps exactly the grant
  it was issued with. That rewrite is load-bearing, not cosmetic: with the read
  alias gone, `resolveApiKeyPermissions` intersects a key's stored scope set
  with its creator's role permissions and DROPS what it does not recognise, so
  an un-migrated `documents:read` would leave the key authenticating and
  silently granting less — the same silent under-grant on every CLI refresh
  rotation (`narrowScopeToClient`) and every live bearer token
  (`scopesToPermissions`).

  **The read path stays canonical-only, by design.** Nothing translates
  `documents:*` at read time any more, and nothing should: an OAuth client that
  still SENDS the old spelling is refused outright with `invalid_scope` at
  `/oauth2/authorize`. That is the deliberate trade — a loud refusal a caller
  can see and fix, rather than a rewrite that hides the drift. The migration
  fixes what is already STORED; it does not make the old spelling acceptable on
  the wire.

  **Migrations.** `0042` drops the `presentation` column with its partial unique
  index and CHECK. `0043` is a pure `ALTER … RENAME` of the tables, columns,
  enum type, indexes and constraints — catalog-only, no table rewrite, no data
  movement, no window where a constraint is absent. The previous `0044` and
  `0045`, which rewrote persisted `documents:*` scope strings, are **deleted**
  along with their journal entries and snapshots, and their numbers reused:
  `0044_finish_file_rename` is the physical-layer migration described above,
  and `0045_drop_integration_refresh_failure_timestamp` drops one more
  write-only column. Their scope rewrite is not lost — it lands at
  `0046_legacy_permission_scope_strings`, which carries both column shapes in
  one file. All of them are idempotent and converge from a partially applied
  state.

  A database that already applied the OLD `0044`/`0045` carries a
  `drizzle.__drizzle_migrations` watermark that now matches no journal entry.
  Drizzle compares timestamps rather than tags, so nothing errors and the new
  `0044`, `0045` and `0046` all still run; the bookkeeping table simply records
  two migrations this folder can no longer explain, and the forward-only scope
  rewrite they performed produced exactly the strings `0046` produces, so it
  finds nothing left to do.

  **`0043` is irreversible, and the rollback is a hard outage, not a degraded
  mode.** There is no down migration in the repo and `0043` creates no
  compatibility view. Once boot has applied it, the previous release's code
  queries `documents`, `document_links` and `organizations.documents_bytes_*` —
  none of which exist under those names any more. **Take a database snapshot
  immediately before the deploy**; it is the only fast way back. To reverse by
  hand:

  ```sql
  ALTER TABLE "files" RENAME TO "documents";
  ALTER TABLE "file_links" RENAME TO "document_links";
  ALTER TABLE "document_links" RENAME COLUMN "file_id" TO "document_id";
  ALTER TABLE "organizations" RENAME COLUMN "files_bytes_used" TO "documents_bytes_used";
  ALTER TABLE "organizations" RENAME COLUMN "files_bytes_limit" TO "documents_bytes_limit";
  ALTER TYPE "public"."file_purpose" RENAME TO "document_purpose";
  ```

  Constraint and index names are cosmetic to the old code and can be left
  alone. `0042` is not reversible at all — the `presentation` column and its
  data are dropped, and only the snapshot brings them back. Neither is the
  physical `0044`: the object move it requires is yours to undo too.

  **Deploy order is now enforced rather than documented — for the pairings the
  check can see.** Rolling the platform and the runtime images out of step used
  to be a live hazard — a new image against an old platform posted every
  `publish_file` to a `/files` route that did not exist, so the run finished
  with no deliverable and nothing in the platform log said why. The version
  contract below refuses to boot on that pairing, so for a configured mismatch
  the failure moved from "silent, at run time" to "loud, at start". It stays
  silent wherever that check is blind — its own carve-outs (`image-ref.ts`),
  and above all a container already running when the platform restarts, which
  no boot-time check can see — which is why the drain step above is part of
  this upgrade. Ship the platform and both images from one version, which is what
  all four shipped compose paths already do.

- **BREAKING: the runtime images must now agree with the PLATFORM's version,
  not just with each other — and a disagreement fails boot.** #1201 turned
  `PI_IMAGE` / `SIDECAR_IMAGE` into a version contract, but the check compared
  the pair to itself: a platform at version X with both runtime images at X−1
  booted happily and then failed runs with the opaque upstream error the
  contract exists to prevent. That is exactly the skew half a dozen
  compatibility shims in this codebase were justified by, including the
  `document` aliases removed above.

  The comparison now includes `APP_VERSION`, which already existed — baked by
  the Dockerfile, fed by `release.yml` as the git ref, surfaced on `/health`
  and in the SPA footer. No new variable, no file read at boot.

  The two halves are deliberately not symmetric. `PI_IMAGE` and `SIDECAR_IMAGE`
  are always compared to each other literally, as they were under the pair
  rule: every compose file sets both from one `${APPSTRATE_VERSION}`, so any
  difference between them is a half-done edit whatever tag family it is in. The
  platform joins the comparison only when **all three values are release
  versions**. `APP_VERSION` is a git ref name, so it can equal an image tag only
  in the one family (`{{version}}`) the two namespaces share; `release.yml`
  publishes three others for the very same image (`latest` — documented as the
  compat fallback for consumers that skip the CLI —, `{{major}}.{{minor}}`, and
  `sha-<sha>`). Comparing against those, or against a non-release build stamp
  (`dev`, the Dockerfile default and source-run fallback; `health-container-e2e`,
  what the container health job builds with against `:local` images), does not
  detect skew — it makes the rule unsatisfiable, since no legitimately-built
  image tag can ever equal such a value and the only escape would be pinning
  digests. Any of those drops the platform out and the rule degrades to the pair
  rule, which is what keeps dev boxes, preview deployments, that CI job and
  `:latest` consumers booting. A digest-pinned ref on either image is exempt
  outright: a digest identifies an image by content, so there is no version to
  compare, and an operator pinning digests has taken explicit control of image
  identity.

  **What this deliberately does not catch.** Both runtime refs floating on
  `:latest` under a released platform is accepted. That is not a gap left open
  by choice of predicate — tag comparison cannot see it at all: `APP_VERSION` is
  baked at build time and reads identically whether the platform image was
  pulled by its version tag or by `:latest`, so `{platform 1.0.0-beta.52, pi
latest, sidecar latest}` is byte-for-byte the same input as the supported
  all-`:latest` deployment. Only something reading the images actually present
  on the host can separate them. `runtime-image-pair.ts` is untouched and stays
  complementary for exactly that reason: it compares OCI revision labels after
  the pre-pull — the same-tag-two-builds case — and it warns rather than
  refusing. Promoting that guard to a refusal, not re-tightening the tag rule,
  is the way to close this.

- **Long Anthropic cache retention is refused on the model record, not by
  convention — and `cacheRetention` is no longer forwarded from the
  container.** Both doorways to 1-hour cache creation were open:
  `FORWARDED_OPTION_KEYS` carried `cacheRetention` and `projectRequestOptions`
  relayed it verbatim from the container's own request body, and pi-ai also
  resolves the option from `process.env` at request time, so agent code inside
  the container could set `PI_CACHE_RETENTION` directly. Either way Anthropic
  bills those cache-creation tokens at 2× the input rate while
  `computeTokenCost` has no term for them, so the platform's authoritative
  price came out low with nothing to notice.

  Both model builders now set `compat.supportsLongCacheRetention: false`, which
  pi-ai honours on every API shape it drives (`anthropic-messages`,
  `openai-responses`, `openai-completions`); the sidecar's `compat` is no
  longer conditional on adaptive reasoning, with the existing
  `forceAdaptiveThinking` folded in. `cacheRetention` also leaves the forwarded
  option set on boundary-hygiene grounds — `"none"` steers caching too, and the
  sidecar has no business honouring a container-chosen knob whose semantics
  differ per vendor. It is logged as discarded by the existing set difference.
  Caching itself is unaffected; only the 1-hour TTL is.

- **The run page is four fixed tabs: Outcome, Fichiers, Exécution,
  Configuration.** The previous set (Résultat / Deliverable / logs / memory /
  files / info) grew by accretion, mixed three unrelated questions across five
  panes, and made two of them appear and disappear per run — so the strip had a
  different shape depending on which run you opened. Now every pane renders for
  every run: **Outcome** is what the run produced (the `output` tool's value,
  the files it produced, the memory it wrote), **Fichiers** is every file
  attached to the run — imported and produced, **Exécution** is how it ran
  (logs, execution details, usage, per-turn breakdown, input payload,
  identifiers), **Configuration** is how it was set up (agent, version, trigger,
  connections).

  « Résultat » is now « Output »: the section is literally what the `output`
  tool emitted, not a verdict on the run. The top bar states whether a run is an
  inline run or an agent run.

  **The retired tab hashes no longer resolve.** `#deliverable`, `#result`,
  `#memory`, `#documents`, `#logs` and `#info` were each mapped onto the pane
  that absorbed them and rewritten in the address bar; the whole table, its
  mapping function and the rewrite effect are gone. A bookmark, a back-history
  entry or a link pasted into an old chat message now opens the default pane,
  silently — the page cannot tell that anchor apart from any other it does not
  know. Accepted so these anchors have one vocabulary rather than two.

- **BREAKING: the schedule launch bodies are validated too — it was the fourth
  launch surface, and the one where a bad value is permanent.** #1189 made every
  agent-launch body `.strict()` and value-checked, and covered three surfaces.
  `POST /api/agents/{scope}/{name}/schedules` and `PUT /api/schedules/{id}`
  freeze exactly these fields onto `package_schedules` and replay them at every
  fire, so a defect there is not one mis-executed run, it is a wrong run forever
  with a `201` as the only receipt. Three gaps, all closed against the run
  route's existing rules: `connection_overrides` values lacked `.min(1)`, and
  the pin is applied with a truthy check, so an empty id was skipped without a
  trace and every fire fell through to actor-fallback or died with
  `412 must_choose_connection`; neither schema was `.strict()`, so an unknown
  field was silently stripped; and `dependency_overrides` values were never
  checked, because a schedule resolves through `resolveEffectiveInput` +
  `validateInput` and never calls the parser the agent route gets that gate from
  — so an unresolvable value froze onto the row and failed at every fire instead
  of at the write. `minLength: 1` on `connection_overrides` is now documented at
  the three run surfaces as well: the Zod has always enforced it, and the spec
  said plain `{ "type": "string" }`.

  **Why this is BREAKING and not a fix: `.strict()` makes read-modify-write a
  `400`.** The spec's `Schedule` response component has 26 properties;
  `updateScheduleSchema` accepts 11 of them (`name`, `cron_expression`,
  `timezone`, `input`, `enabled`, the four `*_override` fields,
  `connection_overrides`, `dependency_overrides` — plus `actor`, which is not a
  response field). The other 15 are now refused BY NAME: `id`, `packageId`,
  `userId`, `endUserId`, `orgId`, `applicationId`, `last_run_at`, `next_run_at`,
  `createdAt`, `updatedAt`, `actor_name`, `actor_type`, `running_runs`,
  `unread_count`, `last_run_number`. A third-party client that does the obvious
  thing — `GET /api/schedules/{id}`, flip `enabled`, `PUT` the object back —
  previously had those keys stripped and got a `200`; it now gets a `400` on
  `id`. In-repo callers are unaffected: `useUpdateSchedule`
  (`apps/web/src/hooks/use-schedules.ts`) destructures `id` into the path and
  sends only the remaining fields as the body. Send only the fields you mean to
  change.

- **BREAKING: the launch body is validated. An unknown field is a `400`, not a
  silent drop.** The three launch surfaces handled an undeclared field three
  different ways: `POST /api/runs/remote` refused it (`.strict()`),
  `POST /api/runs/inline` stripped it (a non-strict `z.object`), and
  `POST /api/agents/{scope}/{name}/run` — which had no schema at all, only a
  `c.req.json<T>()` cast — ignored it and answered `201`. The last one is the
  failure that matters: the release above removed `config` from that body with
  no alias and no deprecation window, so a CLI, SDK or CI job still sending it
  got an accepted run executing with parameters nobody asked for, with no
  error, no log and no echoed field. Silently dropping a value the caller sent
  is how a run does something other than what was asked — the rule
  `assertFieldsUnlocked` already states, and the one `run_and_wait` was fixed
  on in the same release. Each surface now owns a `.strict()` schema for its
  own fields, and `parseRequestInput` receives an already-validated body
  instead of re-reading the request.

  Three observable changes, all on the way in:

  - an unknown field, or a declared field of the wrong type, is `400`
    `validation_failed` on all three surfaces;
  - a malformed JSON body is `400` instead of being swallowed into `{}` and
    launched as an input-less run (the `c.req.json().catch(() => ({}))`
    dialect `readJsonBody` was written to replace — the launch body was its
    last user in the API);
  - `dependency_overrides` on `POST /api/runs/inline` is `400`. It was
    accepted there and then dropped: `triggerInlineRun` never forwarded it, so
    a caller pinning a dependency got a run that ignored the pin.

  An empty body is still a valid launch (a run whose input resolves entirely
  from stored values sends none), and every documented field is unchanged.

- **`generation` is documented on the inline launch surfaces.** It was accepted
  and honoured by `POST /api/runs/inline` and `/inline/validate` but absent
  from the spec, so no generated client could reach it. The agent-run body is
  now registered in the Zod<>OpenAPI comparison, which is what turns that kind
  of drift into a failing check.

- **An agent declares ONE parameter schema, `input`. `config` is gone.** An
  AFPS manifest used to carry two — `input`, asked on every run, and `config`,
  set once at setup. Whether a value is asked every time or stored once is a
  deployment policy, not a property of the package, so it moved out of the
  portable format and into the platform: stored values plus per-field locks on
  `application_packages.input_settings`. AFPS 0.3 removes the field
  (afps-spec#16); `schema_version` still accepts any `0.x`, so a manifest that
  still carries `config` keeps validating — the platform simply ignores it.

  Input now resolves in four layers, last wins: author `default` keywords ->
  the application's stored values -> a schedule's frozen values -> the caller's
  input. A LOCKED field is refused from the last two with 400
  `locked_input_field` rather than silently dropped.

  This closes a real gap. `POST /runs` is gated by
  `requirePermission("agents", "run")` and nothing else, and the body accepted
  `config_override` with NO per-key check — so anyone who could run an agent
  could overwrite any stored value. Delegating an agent with fixed parameters,
  an admin pinning `days = 30` before handing it to their team, was not
  actually possible.

- **The platform prompt loses its `## Configuration` section.** Those values now
  render under `## User Input`. This changes the prompt sent to every agent.

- **The "configuration required" badge is gone.** With a single schema, an
  unfilled required field is simply asked at launch.

- **Migration `0040` folds every dropped column into its `input` counterpart
  before dropping it**, so no row loses a parameter: `application_packages.config`
  becomes `input_settings.values`, and `package_schedules.config_override` and
  `runs.config` merge into the respective `input`. On a key collision `input`
  wins, the same rule the manifest merge applies.

  **The manifest half was a separate, manual pass.** The DDL runs automatically
  at boot; rewriting manifests and `{{config.x}}` prompt references was done by
  `scripts/migrate-config-to-input.ts --apply`, which could only run afterwards
  because it read the renamed column. Until it had run, published agents still
  carried `{{config.x}}`, which the renderer resolves to the empty string with
  no error. That script was single-use and has since been deleted; nothing in
  the tree declares a manifest `config` section any more.

- **Three endpoints now report malformed JSON as `validation_failed` instead of
  `invalid_request`.** Two on `runs-events.ts` and one on `runs.ts`, as a side
  effect of routing their bodies through `readJsonBody`. The HTTP status is
  unchanged and no first-party client branches on the code, but `runs-events` is
  runtime-facing wire surface, so a third party matching on the string will see
  the new value.
- **`LOG_LEVEL` now reaches sidecar containers.** It was missing from
  `SIDECAR_OPERATOR_ENV_KEYS`, which made every `logger.debug` in the sidecar
  permanently unreachable under `RUN_ADAPTER=docker` and `firecracker`. Turning
  those diagnostics on is the point of the fix, so note the flip side: a host
  already running `LOG_LEVEL=debug` will now get debug output from sidecar
  containers where it previously got none. The default is `info` in both
  `.env.example` and `docker-compose.yml`.

- **A malformed `SYSTEM_INTEGRATIONS` entry now aborts boot instead of being
  skipped** — `initSystemIntegrations` logged an error and `continue`d past an
  invalid entry, a duplicate integration id, or a duplicate client id. The
  platform then came up looking healthy while serving a silently reduced
  offering, and the consequence surfaced somewhere else entirely: a dropped
  membership reads as "Integration 'X' is not installed in this application", a
  dropped client as "Administrator must register OAuth client credentials
  for …". Both blame application state for what is a typo in an env var, and
  both are found by whoever tries to connect — not by whoever deployed. A
  duplicate client id is worse than a drop: client ids are one global keyspace
  (a connection's `client_ref`), so the loser's connections would pin a ref
  that resolves to another integration's credentials, and there is no safe
  winner to pick. All three now throw at boot.

  **Operators: an upgrade against a pre-existing bad `SYSTEM_INTEGRATIONS`
  refuses to start.** That is the point — the deployment was already broken,
  just not where it was visible — but it means the fix belongs before the
  rollout, not after. The error names the entry's position in the array
  (`entry #2`), its `id` when the value survived far enough to be readable, the
  exact failing path (`clients[1].auth_key: …`) and, for a nested failure, the
  offending client by its own id, so a one-line env var does not have to be
  read by counting braces. Client secrets and system `client_id`s are redacted
  from the message, so it is safe to paste into a ticket.

### Removed

- **Three columns that were written and never read**, with their writers
  (migrations `0044` and `0045`). The `last_refresh_failure_at` columns on
  `model_provider_credentials` and on `integration_connections` were stamped
  beside `refresh_failure_count` on
  every transient refresh failure; it is the COUNTER that drives the
  `needs_reconnection` escalation, and the timestamp was never a term in that
  predicate, appeared in no DTO and in no query, and was read only by the
  integration tests asserting its own write.
  `model_provider_pairings.consumed_from_ip` was written by `consumePairing`
  and read by nothing — its "for audit" justification never held, because
  `cleanupExpiredPairings` DELETEs the row an hour past expiry and the audit
  entry written at redeem time omits the IP, so the trail it was meant to leave
  was erased and the record that survives never carried it. All three had been
  kept on the premise that they held real data already collected. Forward-only
  and cheaply so: none was an input to any decision.

- **`presentation: "primary"`, and everything behind it.** The
  `publish_document` argument, the `documents.presentation` column, its partial
  unique index `uq_documents_run_primary`, its CHECK constraint, the
  `X-Document-Presentation` ingestion header, and the derived run-DTO field
  `primary_document_id` are all gone (migration `0042`).

  It conflated two different questions — how important a file is, and whether
  the UI opens it — and forced at most one per run, which made the producing
  agent arbitrate a presentation decision that was never its call: an agent that
  wrote three peer files had to crown one or leave the run looking empty.

  What replaced it is derived from what the run produced, computed client-side
  and applied identically on the run page and in the chat: **0 produced files →
  nothing is featured; exactly 1 → it is shown by default; N → all listed, none
  opened, the user picks.** Only files with `purpose = 'agent_output'` whose own
  `run_id` is this run count — never an input, and never a file chained in from
  an earlier run via `appfile://` (which is listed in the run's container while
  still carrying `purpose: 'agent_output'`, because an earlier run produced it).
  Nothing server-side stores or computes it, which is why the dropped column
  needed no replacement pointer: there is no second place left to go stale when
  a file is deleted, expires, or is detached. In the chat the rule additionally
  waits for a settled run, because a run publishing three files emits them one
  at a time and a mid-stream count of 1 is not the final count.

  A `presentation` argument sent by a stale caller is ignored rather than
  rejected — losing a real deliverable over a dead argument would be the worse
  failure — and a runtime image older than the platform may still send
  `X-Document-Presentation`, which the ingestion route reads as nothing and
  never answers `400` to.

- **Dead declarations the new gate surfaced.** ~500 superfluous `export`
  keywords (types and values used only inside their own file), plus a handful
  of declarations that had no reader at all once the re-export was dropped —
  `createTestSession`, `parseSSEStream`, `patchProcessExit`, `seedOrgProxy`,
  `connectLoginBlock`, `getSystemPackagesByType`, `hasExternalDb`, `hasS3`,
  `itRequiresRedis`/`Docker`/`S3`/`Postgres`. No runtime behaviour changes.

- **Dependencies no source file imports.** `apps/web` declared 14
  `@radix-ui/*` packages plus `ajv`, `ajv-formats`, `class-variance-authority`,
  `clsx`, `cmdk` and `tailwind-merge` that belong to (and are declared by)
  `@appstrate/ui`; `apps/api` declared `ajv-formats`, `semver` and the
  deprecated `@types/ioredis` stub; the root manifest duplicated `ajv`,
  `@types/json-schema` and `@types/semver` already declared by
  `@appstrate/core`; `packages/db` declared `@better-auth/drizzle-adapter`
  and `@appstrate/runner-pi` declared `ajv`. Only `@appstrate/runner-pi` is
  published, and it never imported `ajv`, so installs get one fewer transitive
  package.

- **Every `config` wire field, with no alias and no deprecation window.**
  `config` on the run / inline-run / remote-run bodies; `config` and
  `config_override` on the Run resource; `config_override` on schedules;
  `config` on the installed-package listing and on `GET .../run-config`;
  `--config` on the CLI; and the error code `invalid_config`, replaced by
  `invalid_input` and joined by `locked_input_field` and
  `locked_required_field_empty`. `PUT /api/agents/{scope}/{name}/config` is now
  `PUT /api/agents/{scope}/{name}/input-settings`.

  `detect:breaking` reports "no changes" for all of it because the OpenAPI
  baseline was regenerated in the same commit. CI will not flag any of the
  above — this list is the record.

- **Twelve unscoped package endpoints are gone.** `GET`, `PUT` and `DELETE` on
  each of `/api/packages/agents/{id}`, `/api/packages/skills/{id}`,
  `/api/packages/integrations/{id}` and `/api/packages/mcp-servers/{id}`. Use
  the scoped forms instead — `/api/packages/agents/{scope}/{name}`, and so on
  for the other three types.

  Every package identifier Appstrate produces is `@scope/name`
  (`buildPackageId()` returns that unconditionally, and `0000_init.sql` is
  squashed), so no unscoped id has ever existed to address. But "unreachable"
  is too strong and is why this is a release note rather than only a source
  comment: the routes took a single-segment path parameter, so a client that
  percent-encoded a scoped id — `encodeURIComponent("@scope/name")` →
  `%40scope%2Fname` — got a working request. No in-repo or first-party consumer
  did this (`apps/cli`, `apps/web`, `e2e`, `runtime-pi`, `docs`, the GitHub
  Action, `cloud` and `connect-helper` all return zero hits), so the exposure is
  third-party integrations only. These are API-key-authenticated public routes
  removed without a deprecation window; if you call them, switch to the scoped
  form.

### Fixed

- **`appstrate run` validates the resolved input against the agent's schema
  again.** The `config` → `input` collapse (#1179) deleted the CLI's validation
  and replaced it with nothing: at `v1.0.0-beta.51` the site read
  `validateConfig(config, configSchema)` and exited with a field summary, and
  afterwards it was a bare `resolveLocalInput(...)` with no validator at all.
  The docstring claimed "the bundle's own `required` check sees the truth";
  there is no such check — the runtime reads `input.schema.required` only to
  print the word "required" beside the field. So a required field answered
  nowhere reached the model as an empty render, and a wrong-typed or
  out-of-enum value launched the container and burned tokens instead of failing
  fast, which is exactly the local/remote parity #1179 set out to deliver.
  `validateLocalInput` calls the same `validateAgainstSchema` the server's
  `validateInput` wraps, so the same (input, schema) pair reaches the same
  verdict on both sides. An agent declaring no `input.schema` accepts anything,
  so the gate is a no-op there rather than a rejection.

- **A `charset` parameter no longer routes a binary download through the text
  decoder.** `isTextLikeMimeType` tested for `;charset=` BEFORE looking at the
  media type, so an OOXML spreadsheet type answered with a `charset=utf-8`
  parameter appended took the lossy `fatal:false` text decode — the OOXML
  corruption class this resolver was rewritten to prevent.
  The docblock defended the order with "an OOXML container carries no charset",
  which is an assumption about upstream servers rather than an invariant: one
  that blanket-appends a charset defeats it. The charset rule now applies only
  when the base media type is ambiguous. A third local MIME parser in the same
  file goes with it: it did not lowercase, and its output fed an exact-literal
  comparison against `application/octet-stream`, so an upstream answering
  `Application/Octet-Stream` was treated as unambiguous — magic-byte sniffing
  was skipped and the stored file kept the mixed-case string as its `mime`.

- **A graceful shutdown is no longer pinned to its full 10s cap by a job that
  is only counting down.** `LocalQueue.shutdown()` waits for `activeJobs` to
  reach zero, and a job sleeping between retry attempts counted as active — its
  `run()` awaits its own retry timer. So a single permanently-failing job (a
  ledger replay whose org was deleted, say) held the count above zero for its
  entire retry schedule and delayed every restart by the full cap. `shutdown()`
  now abandons jobs with nothing in flight, and the retry path refuses to
  schedule or resume once shutting down — abandoning is this queue's documented
  semantics, since in-memory jobs do not survive the process and a retry that
  has not started has nothing to lose. Retry timers are `unref`'d, matching the
  existing rationale for the drain and cron intervals. Found by diagnosing a
  test flake rather than by raising its deadline: no test deadline changed.

- **CLI output redirected to a file no longer contains terminal escape codes.**
  `@clack` gates only an extra newline on CI and writes `cursor.up` /
  `erase.down` unconditionally, so `appstrate install > install.log` wrote
  control sequences into the file. The spinner now branches on `isTTY`, like
  the CLI's own colour policy, and emits plain lines otherwise. In the same
  pass, five more command modules (`doctor`, `models`, `internal`, `logout`,
  `self-update`) take the `CommandIO` sink instead of writing to the process
  globals, every direct `clack.*` call outside `lib/ui.ts` is gone, and
  `no-console` is an ESLint rule over `apps/*/src` and `packages/*/src` rather
  than a convention enforced by review — it was enabled nowhere, and one real
  offender had survived in `lib/self-update.ts`.

- **Sixteen endpoints' documented request bodies did not match the Zod that
  validates them.** The OpenAPI gate locked ~42 documented request bodies to the Zod
  that validates them and checked none of the rest, so a launch surface could
  drift from its published body with every gate green. `verify-openapi.ts` §4b
  now fails when a documented request body is neither registered against its
  Zod nor exempt with a stated reason (16 are, each with one), mirroring what
  §7b already did for responses. The drift it surfaced: the package `PUT`
  bodies required `manifest` + `content` although the handler explicitly
  supports content-only and manifest-only saves; `POST /api/packages/agents`
  required `content` where its skill and integration siblings do not; six
  documented fields were missing their length constraints; fields carrying a
  `default:` were marked `required` (Zod's default output view marks a
  `.default()` field required, which is wrong for a request body — the
  conversion now uses `io: "input"`); and two module routes (`webhooks` rotate,
  `smtp-config/test`) had no spec entry at all. The generated document is
  otherwise byte-identical: the header-block and `{values, locked_fields}`
  de-duplication in the same pass changed no wire shape.

- **One Ajv instance, so the per-run validator cache behaves.** `apps/api` stood
  up a second instance with its own `compileCached`, and the two had diverged:
  core wraps `compile` in `try/finally` with `removeSchema` and evicts FIFO,
  while the `apps/api` copy did neither — so its registry grew unbounded in a
  long-lived process, and a schema carrying `$id` compiled twice from two
  objects would throw. This is the per-run hot path. Both behaviours are now
  pinned by tests from either caller.

- **A file attached in the chat now becomes an input of the inline run it
  triggers.** It did not, for two independent reasons that had to be fixed
  together: the chat system prompt never told the model that a top-level
  `context_files` argument existed, so it had no way to pass the attachment on;
  and the shared `run_and_wait` launch client
  (`packages/core/src/run-and-wait-client.ts`) read only the canonical
  `context_files` name and dropped the legacy `context_documents` spelling
  before the HTTP call — an allowlist builds the launch body, so a model that
  reached for the argument under its pre-#1177 name, from an earlier turn or a
  stale tool listing, watched it disappear with no `400` from anywhere. The run
  started anyway, with no error and no file — the agent simply worked without
  the attachment the user had just given it. The client now canonicalizes the
  retired argument name to `context_files`; the HTTP route itself no longer
  knows the old spelling at all, and answers `400` to it.

- **Two indexes the schema declared but production never had** (#1182) —
  `idx_runs_package_started` and `idx_runs_schedule_id` were absent from the
  production database. They were the only two missing of the 132 indexes the
  schema declared when production was audited — 0039 has since dropped 18,
  leaving 114 — so every query planned around them had been running without
  them. Migration `0041_restore_squash_indexes.sql` creates both, guarded with
  `IF NOT EXISTS` because every database created FROM the squash already has
  them and the whole pending batch runs in one transaction — an unguarded
  `already exists` would abort the deploy for nearly every install.

  **Why nothing looked wrong.** `0000_init.sql` is a SQUASH and production
  predates it. Drizzle replays only the entries past a database's watermark,
  so for a database older than the squash `0000_init` is history, never
  pending work: anything the squash introduced by itself — rather than through
  a forward migration production also ran — silently never arrived. The
  bookkeeping was healthy throughout (39 rows, no gap), which is exactly why
  this went unnoticed; no migration was skipped and no record was wrong, only
  DDL was missing. The class is structural, not a one-off: the next squash
  reopens it for every index, constraint and default it introduces.

  **New operator check.** `DATABASE_URL=… bun scripts/check-index-drift.ts`
  reports every index the schema declares that a live database lacks and exits
  non-zero; `DATABASE_URL` is its only input, so it runs from a jump host with
  nothing but a production connection string. It diffs against the snapshot
  matching that database's OWN migration watermark, not the newest on disk (a
  database with migrations pending legitimately lacks the indexes they add),
  and refuses rather than guess when the watermark matches no journal entry.
  NAMES only — an index present under the expected name with lost uniqueness
  or a lost partial predicate reads as present. Run it against production
  after a squash. `apps/api/test/unit/migration-index-parity.test.ts`
  pins the rest in CI: it replays the journal into a throwaway PGlite and fails
  if the latest snapshot declares an index no SQL in the journal creates, then
  drops these two to model the production population and re-runs 0041 against
  it — both must come back, and the partial one must come back partial.

  **The rule this leaves behind:** a `DROP INDEX` must verify the SURVIVING
  index against the live database before dropping anything. Neither the TS
  schema nor `0000_init.sql` is evidence that an index exists in production —
  migration 0039 dropped `idx_runs_package_id` on the grounds that
  `idx_runs_package_started` covers it, and that cover was itself absent from
  production at the time.

- **An absent `client_secret` registered a PUBLIC OAuth client nobody asked
  for, and put `client_secret=` on the wire** — `POST /api/integrations/{packageId}/auths/{authKey}/oauth-clients`
  declared `client_secret: z.string().default("")`, and the storage encoder
  read that emptiness back as "this is a public client". So an admin who
  selected `client_secret_basic` and forgot to paste the secret got `201` and a
  registered public client, and the failure arrived much later, from the
  provider: the token request went out carrying `client_secret=` — the
  parameter PRESENT but empty, which is not the same thing as absent — and
  Dropbox answers that with `invalid_client`. This was a real customer
  incident, and every layer of it was an inference nobody had written down.
  A public client is now DECLARED, never inferred — sending
  `token_endpoint_auth_method` as `"none"` says the app has no secret at the
  provider, which is a statement the platform cannot make on the admin's
  behalf. Both directions of the pair are guarded — `"none"` with a secret is
  refused (the caller resolved a credential and then said it would not be
  used), and a secret-based method, or no method at all (which means "the
  manifest's method applies"), without a secret is refused too. The same rule
  now governs the env-sourced half of the
  surface: a `SYSTEM_INTEGRATIONS` client is declarable in exactly the same
  terms, and refusing there is a boot crash rather than a `400`.

  **Breaking for anything that registers a public client the old way.** A
  request that omitted `client_secret`, or sent `""`, and relied on the
  platform inferring a public client now gets `400` instead of `201`; add
  `"token_endpoint_auth_method": "none"` and drop the secret. On the update
  route the rules differ deliberately, because absence there means PRESERVE:
  omitting `client_secret` still leaves the stored secret untouched (the rotate
  form submits an empty input whenever only the redirect URI changed, so the
  two must stay distinguishable), while an EXPLICIT empty string clears the
  stored ciphertext and is accepted only together with
  `token_endpoint_auth_method: "none"`.

- **A refresh that answered `200` with no `access_token` was recorded as a
  success — and disarmed every later check** — `performRefreshTokenExchange`
  substituted the caller's CURRENT access token when the response body carried
  none (`access_token: raw.access_token ?? opts.accessTokenFallback`). The
  refresh then "succeeded": it re-persisted the very token it existed to
  replace, cleared `needsReconnection`, and reset the failure streak. Worse,
  such a body carries no `expires_in` either, so the row lost its `expiresAt`
  — after which neither the proactive refresh lead window nor the streak
  escalation could ever fire again. A dead credential stayed marked healthy,
  indefinitely, and the only symptom was the agent's own upstream `401`s.
  Producers of that body are real: IdPs that answer `200 {"error":"invalid_grant"}`,
  captive-portal JSON, a bare `{}`. The fallback is gone; such a response now
  fails and increments the streak like any other refresh failure.

  **New failure class for operators**: connections against a provider with that
  behaviour will start reporting refresh failures and flip to
  `needsReconnection` where they previously reported nothing. They were already
  broken — this is the first release in which that is visible. The RFC 6749 §6
  case is untouched and deliberately so: an omitted `refresh_token` still means
  "keep the one you have", which non-rotating providers (Google, Slack, GitHub)
  depend on.

- **A run whose pinned version was deleted mid-flight silently executed the
  mutable draft** — `getRunEffectiveAgent` fell back to the live draft when the
  `package_versions` snapshot named by `runs.version_ref` was gone, with a
  `logger.warn` as the only trace. That fallback decided two things it had no
  business deciding: the run token's authorization set (what the sidecar may
  reach) and the run's output contract (what counts as success), both
  re-derived from a definition the run never agreed to. The internal run-token
  guards now answer `409 run_definition_gone` and name the deleted version and
  the remedy — re-publish it, or start a new run against the current
  definition — and finalize fails a run that would otherwise have landed on
  `success` against a contract nobody could read. A run that already terminated
  non-success keeps its own, more specific cause.

  Deleting the AGENT mid-run is a different state and stays benign: `runs.package_id`
  is `ON DELETE SET NULL` precisely so the run row survives for observability
  and billing, so such a run still finalizes on whatever status the runner
  declared, with output validation skipped because there is no contract left to
  validate against. The internal guards report it as `409 run_agent_deleted`,
  with a remedy that does not pretend re-publishing a version would help. The
  two states are distinct values in the result type so they cannot be collapsed
  by accident — collapsing them would mark every in-flight run of a deleted
  agent `failed`, a fabricated verdict about work that may have completed fine.

- **Every connect-run failure collapsed into one opaque `500`** — the hosted
  connect form returned `internal_error` whether the login tool had rejected
  the user's own password, the deployment could not run a connect-run at all,
  or the login simply took too long. Nothing in that response told the user
  whether to retype something, wait, or call an administrator. Failures are now
  typed by audience: a rejection the LOGIN TOOL itself reported ("wrong
  password", "MFA required", "captcha") comes back as `400` carrying the tool's
  own diagnostic, clipped so a runaway upstream body cannot be pasted wholesale
  into an API response; a backend that cannot host a sidecar-only workload
  comes back as `503 connect_unavailable`; a login that outlives the timeout
  comes back as `504 timeout`. Everything else on that channel stays an opaque
  `500` on purpose — `POST /api/integrations/connect/submit` is reachable by
  someone who is not a member of the organization, and sidecar-internal
  messages can carry host paths, namespaces and env-var names. For the same
  reason the `503` says "contact your administrator" rather than naming
  `RUN_ADAPTER`; the operator-facing remedy is logged at the throw site
  instead, where the operator is the one reading.

- **`GET /internal/integration-credentials` answered `200` with an empty
  payload for three states where a credential was expected** — the sidecar
  reads an empty payload as "this integration declares no `delivery.http`
  auths, skip the MITM listener entirely" and boots the run anyway. So a
  connection that had been deleted or unshared since kickoff, an `auth_key` the
  run's pinned manifest version no longer declares, or credentials that no
  longer decrypt all produced a run that started with zero credentials and an
  agent reporting a phantom upstream outage against a fleet of uncredentialed
  `401`s. An empty payload now means one thing only: the integration declares
  no auth. The three broken states fail instead — `404` when there is no
  connection to resolve (nothing exists to flag, so deliberately not a `410`),
  `409 integration_auth_undeclared` when the frozen manifest version does not
  declare the connection's auth (the credential is intact and may be valid
  under another version, so it is deliberately NOT flagged `needsReconnection`
  — a `410` there would destroy a working connection over a manifest edit), and
  `410` when the credential is genuinely dead. A `410` from either endpoint now
  also stamps the run's `metadata.degraded_integrations[]`, so the finished run
  shows a reconnect banner instead of the gap living only in the agent's
  transcript.

## Released before v1.0.0-beta.52

The changes below shipped in `v1.0.0-beta.51` or an earlier release. Most were
already recorded here at that tag, accumulated under a single `[Unreleased]`
heading across several releases; a few were reconstructed from the code
afterwards because they had shipped with no entry at all. Either way this file
cannot attribute them to individual versions;
`git log v1.0.0-beta.N-1..v1.0.0-beta.N -- CHANGELOG.md` is the authority for
any given release.

### Security

- **The agent bundle export now requires each dependency type's read scope** —
  `GET /api/agents/{scope}/{name}/bundle` gated on `agents:read` alone. That
  covers the root agent, whose files the export narrows to `manifest.json` +
  `prompt.md`, but a dependency goes into the archive as its ENTIRE stored file
  map: a bundle carrying a skill hands out exactly the bytes
  `GET /api/packages/skills/{id}/files[/content]` serves, which #1123/#1124
  settled need `skills:read`. This route was the last looser door to the same
  content — a credential `403`'d on the file explorer was served the identical
  bytes here. The guard now runs against the ASSEMBLED bundle rather than the
  root manifest, so transitive dependencies are covered by construction and an
  unrecognised type fails closed. It gates on SCOPE, not visibility:
  dependency resolution stays org-scoped, so a bundle can still reach a skill
  that is not installed in the calling application, exactly like the run it
  mirrors.

  **Behaviour change for scoped credentials.** A credential holding
  `agents:read` but NOT `skills:read` now gets `403` where it used to get
  `200`, on both `?source=draft` and the published export, whenever the agent
  declares a skill dependency. In practice that is a scoped API key or OIDC
  token — every org role (owner, admin, member, viewer) carries both scopes, so
  no dashboard user is affected. An agent with no skill dependency is still
  exported to an `agents:read`-only key. Audit the scopes of any key that
  exports bundles from CI before upgrading.

- **Package file responses are never served from a fresh browser cache** —
  `Cache-Control: private, max-age=300` on the file explorer routes let a
  browser serve authenticated, tenant-scoped, RBAC-gated artifact bytes for
  five minutes with zero server contact. A revoked `<type>:read`, a member
  removed from the org, or a package uninstalled from the application all left
  the cached `200` being handed out until it expired, and `Vary` cannot rescue
  that — revocation changes no request header. Every response on both routes is
  now `private, no-cache`, which was already the behaviour for drafts,
  dist-tags, semver ranges and yanked versions. `no-cache` still permits the
  304 round-trip; it only forbids serving without one, and forcing that
  round-trip re-runs `hasPackageAccess` and the read-permission guard on every
  hit. **The trade**: a repeat view of the same file now pays a conditional
  request instead of reading the local cache. That revalidation answers a
  version's 304 from one DB read, with no storage GET and no unzip.

- **Package `GET` routes now enforce a read permission (#1123)** — every
  `GET` under `/api/packages` was gated on `hasPackageAccess` alone, which
  answers "is this package installed in this application, or a system
  package?" and nothing about what the caller may do. An API key scoped
  **without** `skills:read` could read a skill's manifest and its full
  `SKILL.md` (the detail route serves the authored `content`), and pull the
  published ZIP through `/{scope}/{name}/{version}/download`. Every `GET`
  on the router now requires the matching `agents:read` / `skills:read` /
  `integrations:read` / `mcp-servers:read`, and `/{version}/download`
  additionally goes through `hasPackageAccess` like the rest of the surface —
  it previously served artifact bytes for packages not installed in the
  calling application.

  **The read-permission change is breaking for API keys.** No org role loses
  access through the new RBAC guard (every role, down to `viewer`, holds all
  four read scopes), but a key minted without the matching `*:read` scope now
  gets `403` where it used to get `200`. Separately, the download visibility
  fix affects every caller: a package not installed in the calling application
  now returns `404`, including for org-role sessions. Audit issued key scopes
  before upgrading.

### Added

- **Opt-in observability module (#847)** — OpenTelemetry moves out of core
  behind the `@appstrate/core/telemetry` façade into a workspace module
  `@appstrate/module-observability`. Core ships zero OTel footprint; add the
  module to `MODULES` and set `OTEL_ENABLED` to activate tracing/metrics.

### Changed

- **The schedule worker runs schedules in parallel** — `concurrency: 1` with a
  `max: 5/min` limiter made every schedule in every organization queue behind
  one worker, so a single long run stalled everyone else's due schedules and the
  five-per-minute cap was reached by five tenants firing on the hour. It is now
  `{ concurrency: 10, limiter: { max: 30, duration: 60_000 } }`
  (`apps/api/src/services/scheduler.ts`), where the limiter is a global abuse
  backstop rather than a serialization mechanism. Recorded here after the fact:
  this shipped with no changelog entry, and `git log` places it before
  `v1.0.0-beta.49`.

- **`@appstrate/core` released as 6.2.0** — 6.1.0 was already published to npm,
  so the four export subpaths added since (`./package-files` and
  `./mcp-server-meta` from #1118, `./model-generation` from #1099, `./url` from
  #1122) could not be resolved by out-of-tree consumers installing from npm,
  even though the code ships in the tarball. Additive only, so a minor;
  `CORE_VERSION` moves with it. **Maintainers**: bump `cloud` and
  `connect-helper` to `^6.2.0` right after the `core@6.2.0` tag is pushed —
  leaving them at 6.1.0 makes the next core release compute a delta of 2 and
  hard-fail the lockstep gate.

- **Inline `run_and_wait` manifests are concise without becoming limited** —
  callers may omit AFPS boilerplate and provide only a task-specific
  `display_name`; the shared client derives the canonical name and fills
  runtime/output defaults before the existing full validation boundary. Any
  supplied field remains an exact override, including `runtime_tools: []` and
  complete deterministic schemas. The chat prompt prefers `run_and_wait` for
  launch-and-wait flows while keeping the fire-and-forget `runInline` and
  `runAgent` operations fully discoverable and invokable.

### Removed

- **`source_code` from the package create/update contract** — the
  `sourceFileName` plumbing behind it has been unreachable since the `tool`
  package type was dropped: no route config declared it, so `source_code` was
  never on the wire and sending one in a request body did nothing. The
  published OpenAPI spec stops advertising a field that never existed at
  runtime, which `detect:breaking` reports as 27 response-field removals.

  **Sending one is now a `400`, not a silent strip.** This entry originally
  said the body was still accepted and the key stripped by non-strict Zod, and
  that no runtime behaviour changed; both stopped being true when the three
  package JSON body schemas were made `.strict()`. A retired name must fail
  loudly (`docs/NO_TRANSITIONAL_CODE.md` §1). See **BREAKING: the package JSON
  bodies are `.strict()`** under _Unreleased_ → _Changed_ for the refusal and
  what else it refuses.

### Fixed

- **Saving an integration destroyed its `INTEGRATION.md`** — `draft_content` is
  overloaded for integrations: the importer stores the bundle's
  `INTEGRATION.md` when it ships one and the manifest text when it does not,
  with nothing on the row saying which. The package editor authors a manifest
  and has no documentation field, so it always wrote the manifest form —
  opening a documented integration and pressing Save, with no edit, replaced
  its documentation with its own manifest JSON. The integration then stopped
  contributing its agent-facing docs to every agent's platform prompt, and the
  file explorer served that manifest under the name `INTEGRATION.md`, the entry
  it pre-selects. Version restore and package fork produced the same corruption
  by other routes. All four write paths now agree on which entry the column
  mirrors, and the explorer declines to show a manifest copy over a real
  stored file.

  **Operators: existing rows are not repaired automatically.** The file
  explorer is fixed at read time — the real `INTEGRATION.md` is still intact in
  object storage and is served again immediately. The platform prompt is not:
  an integration whose column was already clobbered keeps contributing no
  documentation to agent runs until its row is repaired. Re-importing the
  integration's AFPS archive, or restoring a published version that ships the
  doc, rewrites the column correctly. No backfill migration ships with this
  release.

- **`POST /api/packages/import-bundle` skipped agent integration validation
  entirely** — bytes `POST /api/packages/import` refused imported cleanly
  through it and froze a broken selection into an immutable version. The same
  checks now run there as a pure-read preflight before the first write: one
  invalid agent aborts the whole bundle, and each field error names the
  offending `@scope/name@version`.

- **The publish-time integration check read the integration author's draft
  manifest, not the version the agent pinned** — an agent pinned to `^1.0.0`
  was refused at publish the moment that integration's author dropped
  `default_tools` from their _draft_, even though the run would have resolved v1
  and worked. The check now judges the manifest at the version the pin resolves
  to. A pin that resolves to nothing is left unjudged rather than rejected — that
  run already fails upstream with `dependency_unresolved` (422).

- **The publish-time check read a local integration's mcp-server catalog from
  that package's draft** — a `source.kind: "local"` integration takes its tool
  catalog from a separate `mcp-server` package, and the spawn resolver reads it
  at the version `source.server.version` resolves to. The validator called
  `fetchMcpServerManifest`, which reads `packages.draft_manifest`. Both
  directions were wrong: a tool the mcp-server author had only in their draft
  passed publish and then registered nothing at boot, and a tool present only in
  the published version was refused. Freeze points now call
  `resolveMcpServerForSpawn` — the resolver the spawn path itself uses.

- **An integration entry that was both empty and mis-scoped reported one error
  at a time** — `{ tools: [], scopes: ["bogus"] }` returned `no_tools_selected`
  alone, hiding `scope_not_in_catalog` until the next republish. Both are
  reported in one pass.

- **A model provider credential could become impossible to delete** —
  `GET /api/models` dropped every model whose credential could no longer serve
  inference (a revoked OAuth refresh token, or a stored secret that no longer
  decrypts). Since `org_models.credential_id` is `ON DELETE RESTRICT`, that
  produced a deadlock seen in production: the model was invisible in the UI, so
  it could not be detached, so its credential answered 409 `credential_in_use`
  forever. Such a model is now LISTED with a new `needs_reconnection` field on
  `OrgModel`, marked in the models table and in every picker, and still
  deletable — detaching it is what frees the credential. The write and runtime
  paths stay fail-closed: it cannot be selected in a picker, cannot become the
  organization default (409 `model_needs_reconnection`), is refused by the chat
  model resolver, and still resolves to null for inference. The `metadata_only`
  query parameter on `GET /api/models` is removed: a row must be decrypted to
  know its liveness, so the parameter no longer skipped any work.

- **A raw credential starting with a scheme name was silently corrupted before
  it reached the upstream (#988)** — `normalizeAuthScheme` ran on the RESOLVED
  `Authorization` value, after credential injection, so its
  `/^(Bearer|Basic|Token)(?=[^\s])/i` matched any secret whose first bytes spell
  a scheme name and injected a space mid-token: `basically_a_key_123` went out
  as `basic ally_a_key_123`, `tokenlive_sk_123` as `token live_sk_123`. The
  upstream answered 401 and nothing logged the rewrite, so a platform-side
  mutation looked like the user's credential being invalid. Two live paths could
  put a bare secret there: an integration declaring `credential_header_name:
"Authorization"` with no prefix, and a model writing `Authorization:
"{{api_key}}"` through the free-form `api_call` headers surface. The repair
  now runs on the caller TEMPLATE before substitution, anchored on `{{`
  (`Bearer{{access_token}}` → `Bearer {{access_token}}`), which covers the
  authoring defect it exists for with no false positives — a template is never a
  secret. The post-injection pass is gone from both entrypoints; it could never
  have repaired the declarative path anyway, since
  `buildInjectedCredentialHeader` builds `${prefix} ${token}` itself and so
  always had its space. There, the pass could only ever corrupt.

- **63 system packages shipped fixes production never served (#928)** —
  production logged 63 `level:50` "System package content changed without a
  version bump" errors at every boot since beta.39. The guard is correct — it
  refuses to overwrite a published, immutable version — and the consequence was
  that source changes to those packages were inert in production, including
  #907 (clickup/gmail/github MCP tool-policy sync) and #927
  (`clickup_download_task_attachment`): both shipped, neither ever live. Which
  packages drifted was measured, not inferred: `zipArtifact` is deterministic
  (sorted keys, fixed mtime), so each committed archive must still equal its
  bytes at the commit that minted its version. Byte-comparing all 66 gives 63
  drifted and 3 clean, and the 3 clean ones are exactly the 3 production does
  not report. Each of the 63 gets a patch bump, so `syncCanonical` (highest
  semver) makes the corrected content canonical on the next boot. Nothing is
  destroyed: the immutable `1.0.0` rows stay for anything pinned to them, and
  the sync prunes no versions. **Note for operators**: an install that pinned an
  explicit `version_id` keeps resolving the old row until re-pinned; installs
  that never pinned (`version_id` NULL, the default) pick up the new version
  automatically.

- **The test harness ran two post-incident guards as no-ops (#989)** — the
  harness called `mod.createRouter?.()` straight off each discovered module, so
  `init(ctx)` never ran and modules with a no-context fallback served every test
  request against a degraded baseline. For chat that meant the #968/#971
  admission gate answering `null` (fail-open) and the #965 document teardown
  resolving to a no-op, so any test that believed it exercised either guard
  exercised nothing and would have stayed green if the guard were deleted.
  Production was never affected — `_modules.set(...)` runs only after
  `await mod.init(ctx)` returns, and `registerModuleRoutes` iterates `_modules`
  exclusively. The preload now runs the same topo-sorted init pipeline as
  production, and with the harness at parity the chat fallback has no remaining
  consumer: `buildChatPlatformDeps(ctx)` takes a required context and
  `createRouter()` throws instead of serving a baseline that looks like it
  works.

- **`POST /api/packages/mcp-servers` published manifests no schema had ever
  accepted (#987)** — mcp-server is the only package type whose create reaches
  the `parsePackageUpload` branch, and that branch skipped validation two ways:
  a `manifest.json` missing or malformed inside the uploaded archive was
  swallowed into `undefined` by a non-throwing parser, and `manifest` was
  optional in the JSON body. Either way `createOrgItem` synthesized a
  `{version, name, $schema, type}` stub and `createVersionSafe` snapshotted it
  into `package_versions.manifest` — a published, immutable row failing
  `mcpServerManifestSchema` on `manifest_version` and `server`. The same
  corruption was reachable with a perfectly valid manifest of the WRONG type:
  `validateManifest` dispatches on the manifest's own root `type`, so a `skill`
  manifest posted to the mcp-server route validated happily and `createOrgItem`
  then rewrote `type` to the route's type AFTER validation. Manifest validation
  on create is now unconditional, and one direction-aware gate
  (`validateManifestForRoute`) rejects a route/manifest type mismatch with a
  `manifest.type` field error on create and on `PUT` supplying a manifest — the
  stored direction (`PUT` carry-forward, publishing an existing draft) keeps
  tolerating drift, because #983 settled that already-persisted artifacts are
  tolerated on read and a gate there would make a legacy drifted draft
  permanently un-publishable. The `type` stamping left `createOrgItem` for a
  pure `buildStoredManifest` that throws on divergence; `forkPackage` — the one
  caller whose sources can legitimately disagree, reading an immutable
  published snapshot — keeps the repair, now explicit and logged.
  **Behavior change for integrators**: an archive without a valid
  `manifest.json`, or a JSON body without `manifest`, is now a `400` instead of
  a silently stubbed package, and the JSON body's `version` field is gone (it
  was only ever read by the fallback that fired when `manifest` was absent).

- **Two contract holes: forks minted un-normalised manifests, stale modules
  booted silently (#974, #973)** — a fork is a READ that MINTS: it copies an
  already-published (immutable, therefore unrepairable) manifest into a brand
  new draft row, draft files, version row and ZIP. It copied verbatim, so a
  `runtime_tools` id the platform has since retired was regraved into an
  artifact minted today. The manifest is now normalised ONCE, before the draft
  row is written, so the four sinks can never disagree; the drop is structural
  (no Zod re-parse), so a source with nothing to drop keeps its key order and
  materialises no defaults, leaving publish dedup (#896) untouched. A source
  invalid for any OTHER reason is logged, never rejected: manifests today's
  validator refuses do sit in the catalog — the provider→integration migration
  (#481) left `type: "provider"` rows behind (the write direction that could
  still mint new ones is closed in #987) — and a gate would make them
  permanently un-forkable.

  The module→platform half of the contract is invisible to `tsc` for an
  out-of-tree module, and it fails silently: core 6.0.0 made
  `checkUsageAllowed`'s `subscription` flag required, and a 5.x caller omitting
  it reports a subscription turn as platform-funded. The loader now reads the
  `@appstrate/core` range from a module's own `package.json` and checks it
  against the platform's `CORE_VERSION` at boot. **Operator-facing**: the new `MODULE_CONTRACT_ENFORCE`
  var defaults to `warn` (log the mismatch, boot anyway) — only because this
  build ships core 6.0.0 while npm still serves 5.0.0, so no out-of-tree module
  can declare `^6.0.0` yet. The intended end state is `fail`; set
  `MODULE_CONTRACT_ENFORCE=fail` once every module you load has been
  republished against the published major.

- **Self-host: hosted connect portal broken out of the box (#905)** — no
  distribution path ever provisioned `CONNECT_SESSION_SECRET`: the installer
  didn't generate it and no compose template forwarded it, so the integration
  "Connect" button 503'd on every `appstrate install` deployment (dev, which
  reads `.env.example` directly, kept working). The installer now generates the
  secret on every tier, upgrades backfill it into existing `.env` files via the
  standard merge, all five compose templates forward it with a `:?` loud-fail,
  and a lockstep guard test (`install-secret-lockstep.test.ts`) fails the build
  if a generated secret is ever missing from a template again (both drift
  directions). **BREAKING for hand-managed deployments**: the env schema now
  requires `CONNECT_SESSION_SECRET` (boot fails without it — the hosted portal
  is the primary connect surface, not an optional feature). CLI-managed
  installs are migrated automatically on upgrade; operators who manage `.env`
  by hand must add `CONNECT_SESSION_SECRET=$(openssl rand -hex 32)` before
  deploying this version. The now-unreachable 503 response is removed from the
  `initiateIntegrationConnect` OpenAPI contract.

- **`api_upload` never exposed on `@appstrate/google-drive` (#881)** — the
  integration tool catalog listed only `api_call`, so the agent editor's tool
  picker never offered `api_upload` and importing an agent that selected it
  failed with `unknown_tool`, even though the sidecar advertises the tool at
  runtime for every auth declaring `upload_protocols`. The catalog now surfaces
  the companion, and the spawn resolver grants the `api_call`/`api_upload` pair
  from either name (upload chunks are dispatched through the sibling api_call
  tool, so a half-selection is never valid). No manifest change was required —
  `upload_protocols` was already in its documented `_meta` location.

- **Multi-auth `api_call` tools collided on one name (#881)** — an integration
  opting several auths into `_meta["dev.appstrate/api"]` exposes one tool per
  auth (`api_call__{authToken}`), but the sidecar collapsed every def onto the
  bare `api_call` name. The two registrations collided and `McpHost` silently
  disambiguated the second to `{ns}__api_call_2` — a name no catalog advertises
  and no agent can select. Trusted defs now keep the auth suffix through
  `McpHost`, and every auth of a serverless integration shares its allocated
  namespace. The agent-side upload extension pairs an `api_upload` tool with
  its `api_call` sibling by marker key scoped to that namespace, instead of a
  globally ambiguous key or a tool-name rewrite. Privileged api capability
  markers are stripped from non-trusted MCP descriptors so a third-party server
  cannot impersonate the sibling and receive upload chunks. Long AFPS auth keys
  now use one shared bounded token across the platform and portable runtime;
  persisted raw long-key selections/defaults/hidden names remain accepted and
  are canonicalised at the boundary. Declared synthetic names also take
  canonical precedence over same-named native MCP tools, avoiding `_2`
  runtime-only names that the catalog cannot select.

- **`hidden_tools` bypassed synthetic API tools (#881)** — the in-process
  `api_call`/`api_upload` registration now applies the same runtime
  `hidden_tools` filter as local and remote MCP integrations. Hiding
  `api_upload` therefore removes it from both the platform catalog and the
  final agent-facing MCP surface; hiding `api_call` also removes its dependent
  upload companion so no orphan capability is advertised.

- **Digit-leading integration scopes aborted the run (#881)** — a package
  published under a scope starting with a digit (`@1password/connect` is a
  valid AFPS id) produced a `1password_connect__api_call` name that the MCP
  tool-name pattern rejected, so the trusted registration path failed the
  integration and killed the run. The namespace half of the pattern now
  matches the slug alphabet (digit-leading allowed); the tool half is
  unchanged.

- **Phantom "selected tool unavailable" warning (#881)** — the sidecar's
  no-silent-degradation guard compared the agent's full tool allowlist against
  the count of the integration's own MCP tools that survived registration. The
  synthetic `api_call`/`api_upload` tools are served by a separate in-process
  server and were never counted, so any agent selecting them alongside a native
  tool got a spurious warn breadcrumb. They are now discounted from the
  requested set.

- **Transparent egress for `delivery.env` integrations (#850, #779)** — the
  sidecar no longer drops egress for integrations that inject credentials via
  `delivery.env`; the per-run proxy path is applied transparently.
- **OIDC cross-context PKCE resume (#852)** — the end-user OAuth flow survives
  a cross-context resume (invite-signup state mismatch) instead of failing the
  PKCE exchange.
- **`PUT /api/models/:id` enforces the model-alias invariants (#875)** — the
  update route now runs the same alias checks as create on the effective
  post-update state (explicit label, body-`model` protocol, no
  oauth-subscription credential), closing a bypass where a row could be
  flipped to `aliased` — or re-pointed to an oauth credential — into a state
  creation rejects. The subscription chat resolver also fail-closes on a
  legacy aliased oauth row instead of executing its hidden binding.
- **`maxTokens < contextWindow` enforced on the effective model state (#875)**
  — `POST`/`PUT /api/models` used to check the token-budget invariant only
  when both fields rode in the same payload; a lone `maxTokens` override could
  exceed the catalog (or stored) `contextWindow`, or a `modelId`/credential
  change could swap the catalog defaults under a kept override. Both routes
  now validate the effective pairing (payload → stored override → live
  catalog) before writing.

### Security

- **The agent runtime image ships only the bundled entrypoint, not the platform
  sources** — the image copied its own build inputs into the runtime stage
  (every `@appstrate/*` workspace `src/` tree, `runtime-pi/mcp/`, the
  `runtime-pi/*.ts` bootstrap files), all of which `bun build` had already
  inlined into `dist/entrypoint.js`, the ENTRYPOINT. They were dead weight that
  happened to be readable, and a confused agent read them and acted on what it
  found. No secret was exposed and the zero-knowledge boundary held. **This is
  not a confidentiality boundary** — the public `SECURITY.md` documents the same
  design in more detail. What changes is what the sandbox can read _without
  egress_. The bundle is deliberately NOT minified: `--minify-whitespace`
  was tried and reverted, because collapsing 1023 lines to 2 destroys the line
  and column of every production stack trace, and all it bought was hiding the
  per-module `// packages/core/src/…` banners. Concealment is not what this
  change is for.

- **Full-codebase security review remediation (#855, #863)** — 9 P0 + 15 P1 +
  12 systemic findings closed (SSRF `guarded-fetch` + bounded unzip hardening
  in `@appstrate/afps-shared`, among others), followed by a DRY/KISS/YAGNI
  audit-follow-up pass.

### CLI

- **Runner download progress + `runner uninstall` (#845)** — the CLI streams
  the daemon binary download with progress and adds a `runner uninstall`
  command.

### Documentation

- **Firecracker execution backend (#844)** — surfaced across the user-facing
  docs.

### Changed

- **A declared integration that exposes no callable tool now fails, instead of
  degrading silently** — BREAKING for agents in that state. Declaring
  `dependencies.integrations["@scope/x"]` while selecting no tool used to boot
  the run with nothing callable from it, announced only by a `warn` in the
  platform run log that never reached the model's context — leaving the agent to
  improvise unauthenticated HTTP from bash. The state is now refused in two
  places, with two different shapes.

  **Publishing and importing** — `POST /api/packages/agents/{scope}/{name}/versions`,
  `POST /api/packages/import`, `POST /api/packages/import-bundle` — answer
  `400 validation_failed` naming `integrations_configuration.<id>.tools`. That
  is the one moment the artifact is still editable, since a published version
  is immutable.

  **Creating** — `POST /api/packages/agents` — still answers `201`. The empty
  state is legal as a draft and the editor's flow passes through it; what
  changed is that the route no longer takes its usual initial version snapshot
  from a manifest publishing would refuse (a skip that `createVersionSafe` has
  always performed for a missing or invalid `version`). The draft is created,
  the author ticks a tool, and the first version is cut on publish.

  **At run boot** it aborts the run as a backstop. Draft `PUT`s are not gated
  at all.

  A **self-contained** bundle is judged too. Its integrations are not in the
  registry yet, so a DB-only validator hit "not installed → skip silently" and
  waved the agent into an immutable version; the catalog is now
  `incoming ∪ already-installed`, and the agent's `dependencies.integrations`
  spec is resolved against the catalog that will exist after import — including
  forward-only version creation, yanks, dist-tags and `latest` movement. Keying
  by package id alone, or preferring any carried match over a newer installed
  one, would judge a manifest the runtime will never use. The same lookup covers
  the mcp-servers a local integration references; system packages remain
  canonical even when a bundle carries a same-named manifest.

  The gate also tests CALLABILITY, not selection length. `default_tools: ["x"]`
  where `x` sits in `hidden_tools`, or is absent from the resolved mcp-server, is
  a non-empty selection that registers nothing; the effective selection is
  intersected with the same `resolveIntegrationToolCatalog` result the subset
  check uses. When the surface is genuinely unknown at publish time — a remote
  integration that enumerates nothing — the intersection is skipped rather than
  guessed.

  The runtime backstop stays necessary regardless: versions published before
  this gate existed are still runnable, and a draft can be run straight from
  the editor without ever being published.

  Blast radius: an absent `tools` key still inherits the integration's
  `default_tools`, which 59 of the 65 system integrations declare — for those,
  only an explicit `[]` is affected. The six that declare **no** `default_tools`
  are the exception, and they are widely used, so an absent `tools` key is
  enough to trip the gate there: `@appstrate/gmail-mcp`,
  `@appstrate/github-mcp`, `@appstrate/notion-mcp`, `@appstrate/clickup-mcp`,
  `@appstrate/canva-mcp`, `@appstrate/github-git`. Every one of them ships a
  populated `tools_policy` (7–91 tools), so the gate is always satisfiable from
  the editor — there is no manifest it can refuse without offering a fix. An
  agent in this state was already non-functional against that integration; it
  now fails loudly instead of silently.

  **Before deploying**, run `bun scripts/audit-empty-integration-selections.ts`.
  It lists every affected artifact and distinguishes active targets from
  explicitly selectable drafts/history. The exit code is 1 only when a normal
  application default or an enabled schedule targets the broken artifact;
  selector-only findings remain warnings, so an in-progress draft or immutable
  historical version cannot permanently jam the rollout gate. It calls the
  runtime's own resolvers rather than approximating them in SQL — a SQL version
  shipped first and was wrong three ways: it read the integration's draft
  `default_tools` instead of resolving the agent's pin, it ignored mutable drafts
  even though an installed package makes every artifact selector-runnable (and
  the editor explicitly runs the draft), and it ignored `dependency_overrides`.
  The audit now calls the same callability validator as publish/import, including
  the resolved nested mcp-server catalog and `hidden_tools`.

  This also corrects a documented falsehood — `tools` absent and `tools: []`
  were described as equivalent in the docs, the `ManifestIntegrationEntry`
  TSDoc and the LLM-facing MCP tool instructions. They never were: absent
  inherits, `[]` overrides.

- **Single Pi execution engine (#875)** — agent runs AND oauth-subscription
  chat (Claude Pro/Max via `claude-code`, ChatGPT via `codex`) all execute on
  the one Pi engine (`@mariozechner/pi-coding-agent`); the per-provider
  "official binary" run path and the Claude Agent SDK chat engine are removed.
  Pi's SDK emits each provider's subscription request shape natively — the
  platform forges nothing; the sidecar's oauth `/llm` mode is a pure
  bearer-swap (model aliases are rejected for oauth-subscription providers).
  Codex becomes chat-usable. The `#849` Claude-engine structured-output fix is
  superseded (that engine no longer exists; structured output flows through
  the Pi `output` runtime tool).
- CI action bumps: `docker/setup-buildx-action` 4.1.0→4.2.0 (#857),
  `actions/cache/restore` 4.2.4→6.1.0 (#858),
  `github/codeql-action/upload-sarif` 4.36.2→4.36.3 (#859),
  `actions/github-script` 7.0.1→9.0.0 (#861).

<!-- prior unreleased entries -->

### Added

- **Proxy-upload mode for S3 storage (#829)** — with `S3_PUBLIC_ENDPOINT`
  unset, upload URLs are now signed against `APP_URL`
  (`PUT /api/uploads/_content`) and the platform streams the body to the
  bucket server-side, so S3/MinIO can stay fully private (no published S3
  port, no second public FQDN). The installer's Docker-aware default tier
  moves from Tier 3 (bundled MinIO) to Tier 2 (filesystem storage) — MinIO
  adds no capability on a single node once serving is app-domain. The proxy
  sink now also binds the token's **exact declared size** (a completed body
  shorter than declared is rejected and rolled back, parity with the signed
  `Content-Length` of direct presign) and re-checks the **token expiry while
  the body streams** (a slow-trickled body can no longer hold the socket
  past the token window).

  **⚠ Behavior change for existing S3 deployments with `S3_PUBLIC_ENDPOINT`
  unset**: presigned URLs no longer fall back to `S3_ENDPOINT` — uploads
  route through `APP_URL` instead. Bytes now transit the platform (and your
  reverse proxy: check its body-size limit, see
  `examples/self-hosting/README.md` → Production Considerations), and
  `APP_URL` must be the instance's real public URL. To keep the previous
  direct-presign behavior, set `S3_PUBLIC_ENDPOINT` to your public S3
  endpoint. The platform warns at boot when proxy mode is active in
  production with a loopback `APP_URL`.

- **Inline file inputs on `runAgent` (#630)** — file-typed input fields now
  also accept RFC 2397 `data:<mime>;name=<filename>;base64,<payload>` URIs
  (≤4 MiB decoded) alongside `upload://` references. The bytes are written to
  the run workspace as a document with the same magic-byte MIME validation as
  staged uploads, and the payload is stripped from the persisted run input
  (compact `data:<mime>;name=<doc>;base64,` marker). JSON-only clients (MCP
  `invoke_operation`) can run an agent with a small file in a single call —
  no `createUpload` + signed PUT round-trips.

- **Unified memory surface (Letta-style `pin` / `note`, #273, ADR-011/012/013)** —
  `runs.state` + `package_memories` merged into a single `package_persistence`
  table with first-class `(actor_type, actor_id)` scope (`member` / `end_user`
  / `shared`). Two orthogonal attributes `(key, pinned)` collapse the previous
  `kind` enum into 3 quadrants (archive / pinned memo / pinned named slot).
  - System tools `@appstrate/note@1.0.0` (append archive) and
    `@appstrate/pin@1.0.0` (upsert named slot — `key="checkpoint"` is just
    one slot among `persona`, `goals`, `user_preferences`, …) replace the
    retired `@appstrate/add-memory` and `@appstrate/set-checkpoint`.
  - Always-on MCP tool `recall_memory` registered on the sidecar alongside
    `provider_call` / `run_history` / `llm_complete`.
  - REST API: `GET /api/agents/{scope}/{name}/persistence?kind=pinned|memory`
    plus targeted `DELETE` variants. Legacy `/memories` routes and the
    `memories:read|delete` permission are removed.
  - `RunResult.pinned: Record<string, PinnedSlot>` is the single wire-format
    surface; the temporary `RunResult.checkpoint` / `checkpointScope`
    top-level mirrors were dropped in #288.
  - Frontend: a single Memory tab on agent + run detail with two collapsibles
    (Pinned / Archive) and a scope filter (`All` / `Shared` / `Mine`).
- **AFPS Runtime extracted as `@appstrate/afps-runtime` (#227)** — portable,
  open-source bundle runner shipped as a workspace package (64 TS files):
  bundle loading + validation + SRI integrity, Ed25519 detached signing
  with trust-chain verification, conformance suite (L1–L4), event sinks
  (Console / File / HTTP / Composite) with Standard Webhooks HMAC and
  CloudEvents, Mustache rendering, credential providers (env / file /
  appstrate-backed), and a portable `afps` CLI (`run`, `test`, `sign`,
  `verify`, `keygen`, `inspect`, `render`).
  - New multi-package `.afps-bundle` format (`docs/architecture/BUNDLE_FORMAT_SPEC.md`):
    bundles an agent + its skills/tools/providers in a single artefact with
    Merkle-root integrity (per-file `RECORD` SRI → per-package SRI →
    bundle-level SRI on the canonical map). Endpoints:
    `GET /api/agents/:scope/:name/bundle` (export with `X-Bundle-Integrity`,
    `application/zip`) and `POST /api/packages/import-bundle` (accepts both
    `.afps-bundle` multi-package and legacy single-package `.afps`).
  - `apps/api/src/services/adapters/` shrinks ~1676 → ~1080 LOC (−35%) by
    delegating prompt assembly, stream parsing, lifecycle, reducer, runtime
    env contract, and signature policy to `@appstrate/afps-runtime`.
  - `tool-output@2.0.0` (breaking) — schema injected into `parameters.data`
    for constrained decoding, `replace-on-emit` semantics replace the prior
    deep-merge, run-level mismatch fails the run instead of warning.
- **Unified runtime protocol — single ingestion surface (#227 Parts 7–14)** —
  every run (platform container, remote CLI, GitHub Action) now POSTs
  HMAC-signed CloudEvents to `POST /api/runs/:runId/events` and
  `/events/finalize`. `AppstrateEventSink` is the sole writer.
  - DB migration 0006 — new columns on `runs` (`run_origin`,
    `sink_secret_encrypted`, `sink_expires_at`, `sink_closed_at`,
    `last_event_sequence`, `context_snapshot`) plus the new
    `credential_proxy_usage` table.
  - `POST /api/runs/remote` mints sink credentials (one-time secret,
    AES-256-GCM, 32-byte base64url); `PATCH /api/runs/:runId/sink/extend`
    refreshes the TTL.
  - LLM cost ledger renamed `llm_proxy_usage` → `llm_usage` with `source`
    enum (`proxy` | `runner`) and partial unique indexes per source.
    `aggregateRunCost` → `computeRunCost`; `finalizeRun` is the sole writer
    of `runs.cost`.
- **Runtime-pi on official MCP SDK (#281)** — agent tooling is **MCP-only**.
  Three canonical first-party tools (`provider_call`, `run_history`,
  `llm_complete`) replace the legacy `appstrate_<slug>_call` family. New
  `@appstrate/mcp-transport` workspace package adapts the MCP SDK to the
  AFPS tool format (`createMcpServer`, `createInProcessPair`,
  `createMcpHttpClient`).
  - Sidecar mounts `/mcp` (Streamable HTTP, stateless) alongside `/health`
    and `ALL /llm/*` (kept for in-container Pi SDK chat completion
    streaming). Tool descriptor poisoning hardening (Unicode strip,
    schema-property recursion) per CyberArk / Invariant Labs advisories.
  - Zero-knowledge enforcement: after MCP bootstrap, `runtime-pi` deletes
    `process.env.SIDECAR_URL` so even the bash extension cannot discover
    the sidecar. The legacy `/proxy` and `/run-history` HTTP routes are
    fully retired — runners 1.x are not compatible with this branch.
  - `SIDECAR_MAX_REQUEST_BODY_BYTES` (default 10 MB) and
    `SIDECAR_MAX_MCP_ENVELOPE_BYTES` (default 16 MB) configurable; loud-fail
    at boot on invalid values; structured 413 errors carry
    `{ reason, scope, limit, actual, envVar, hint }`.
- **Authorized devices for CLI (#269)** — full lifecycle for `cli_refresh_tokens`.
  - Phase 1: head-of-family metadata (`device_name`, `user_agent`,
    `created_ip`, `last_used_ip`, `last_used_at`) — UA / device_name never
    re-captured at refresh (immutability of identity).
  - Phase 2: cookie-only user-facing endpoints `/api/auth/cli/sessions`,
    `/sessions/revoke`, `/sessions/revoke-all` (backing
    `appstrate logout --all`) plus a Devices preferences page.
  - Phase 3: org-scoped admin routes
    `GET/DELETE /api/orgs/:orgId/cli-sessions[/:familyId]` gated by the new
    module-owned RBAC resource `cli-sessions: read | delete` (owner +
    admin grants). Audit-log reasons distinguish `user_revoked`,
    `user_revoked_all`, `org_admin_revoked`.
- **Channel-aware CLI install + self-update (#270, closes #249)** —
  build-time `__APPSTRATE_INSTALL_SOURCE__` stamp lets the CLI dispatch
  upgrades correctly per channel.
  - `appstrate self-update [--release X] [-f|--force]` — curl channel does
    in-place upgrade with minisign + SHA-256, bun channel hints toward
    `bun update -g`.
  - `appstrate doctor [--json]` — detects every `appstrate` on `$PATH`,
    dedupes by realpath, displays the channel each was stamped with.
    Hidden subcommand `__install-source` exposes a stable JSON contract
    (`{ version, source, schema: 1 }`).
  - Bootstrap script + Commander `preAction` hook warn on dual install,
    persist ack at `~/.config/appstrate/dual-install-ack.json` keyed on
    sorted realpaths (re-arms when the set changes).
  - Channel matrix and recipes in `docs/cli/upgrades.md`.
- **Connect — OAuth/credentials hardening (#279)** — three findings closed.
  - Symmetric revocation handling: shared `parseTokenErrorResponse`
    between `handleOAuthCallback` and `forceRefresh`, RFC 6749 §5.2
    `invalid_grant` classification, typed `OAuthCallbackError`.
  - Scope validation: `parseTokenResponse` returns `scopeShortfall`
    (granted ⊊ requested) and `scopeCreep` (granted ⊋ requested) — short-
    fall flags `needsReconnection`, creep is logged without blocking.
  - Versioned encryption envelope: credentials now stored as
    `v1:<kid>:<base64(iv|authTag|ciphertext)>` with multi-key keyring
    (`CONNECTION_ENCRYPTION_KEY_ID` + `CONNECTION_ENCRYPTION_KEYS`). Legacy
    v0 raw-base64 envelope is fully retired.
- **OpenAPI coverage holes closed (#285, closes #284)** — `GET /api/library`
  added, all 5 verbs on `/api/credential-proxy/proxy` documented, and
  `verify-openapi` gains a static Code ⊆ Spec analyser that parses
  `apps/api/src/index.ts` to enforce ADR-004 ("OpenAPI = source of truth").
- **API surface polish (#280)** — `x-mutually-exclusive` extension on
  cursor-paginated endpoints, SSE `id:` field per HTML SSE spec for
  `Last-Event-ID` resume, additive `RunError` shape (`code`, `context`,
  `timestamp`) aligned with JSON-RPC 2.0 §5.1, 5 new
  `CanonicalRunEvent` variants (`run.started`, `run.succeeded`,
  `run.failed`, `run.timedout`, `run.cancelled`), credential-proxy
  response headers documented (`X-Stream-Request`, `X-Run-Id`,
  `X-Truncated`, `X-Truncated-Size`).
- **Self-hosting closed mode (#228)** — env-driven invitation-only deployments.
  - `AUTH_DISABLE_SIGNUP=true` blocks new account creation; pending
    invitations and platform admins still pass through (resolves the
    Infisical-style "invitation breaks when signup is disabled" pitfall).
  - `AUTH_DISABLE_ORG_CREATION=true` restricts `POST /api/orgs` to
    platform admins; org-less users see a "Waiting for invitation" page.
  - `AUTH_PLATFORM_ADMIN_EMAILS` declarative allowlist (no UI, no
    migration, IaC-friendly).
  - `AUTH_ALLOWED_SIGNUP_DOMAINS` email-domain allowlist with invitation
    override for external contractors.
  - `AUTH_BOOTSTRAP_OWNER_EMAIL` (+ `AUTH_BOOTSTRAP_ORG_NAME`) auto-creates
    the root organization on first signup of the configured email.
  - `bun apps/api/scripts/bootstrap-org.ts --owner=… --name=…` for explicit
    ops bootstrap with idempotent JSON output.
  - `appstrate install` integration: interactive prompt asks for the
    bootstrap admin email (Tier ≥ 1, fresh installs only); non-interactive
    via `APPSTRATE_BOOTSTRAP_OWNER_EMAIL=… curl|bash` for IaC. When set,
    the closed-mode trio is written into the generated `.env`.
  - Post-install action note: when bootstrap is configured, the installer
    prints the exact `<APP_URL>/register` link the operator must open.
  - `RegisterPage` reads `AUTH_BOOTSTRAP_OWNER_EMAIL` from `__APP_CONFIG__`
    and pre-fills + locks the email field, plus a banner explaining why,
    so the operator only has to pick a password (typo-proof bootstrap).
  - After signup, the bootstrap owner is routed through the rest of
    onboarding (`/onboarding/create` auto-skips since the org already
    exists, landing on the model-config step) so they can configure
    their first model, providers, and invite teammates.
  - The display-name field is also pre-filled (still editable) by
    deriving a sensible name from the locked email
    (`john.doe@acme.com` → "John Doe"), so the operator only has to
    type a password to complete signup.
  - Full guide in `examples/self-hosting/AUTH_MODES.md`.
- Health check for main application container in Docker Compose
- Named Docker networks with data tier isolation (`appstrate-data`, `appstrate-public`)
- Shared `tsconfig.base.json` with strict settings across all packages
- `test` and `lint` tasks in Turborepo pipeline
- Root `bun test` script
- Explicit `exports` field in `@appstrate/connect` and `@appstrate/shared-types`
- RFC 9457 `errors[]` array populated on every 400 validation response so a
  single round-trip lists every problem (manifest, config, input, providers)
  instead of surfacing them one at a time.
- `POST /api/runs/inline/validate` runs preflight in `accumulate` mode,
  returning the full list of validation errors in one response.

### Fixed

- **Presigned upload URLs rejected plain PUTs (#630)** — `createUpload`'s
  signed S3 URL embedded a placeholder `x-amz-checksum-crc32=AAAAAA==`
  (AWS SDK ≥3.729 default checksum behaviour signing the empty presign body),
  so S3 refused the upload unless the client reverse-engineered the real
  base64 CRC32 header. Presigning now opts out of request-checksum
  calculation: a plain PUT with the returned headers works. Integrity is
  unchanged — size and magic-byte MIME are still enforced at consume. The
  `createUpload` / `runAgent` OpenAPI descriptions now document the full
  upload→run recipe (and the stale `multipart/form-data` body on `runAgent`
  was removed — the endpoint is JSON-only).

### Changed — AFPS 2.0 conformance pass (2026-05-26)

- **System-package manifests** migrated to AFPS 2.0.2 canonical vocabulary: 6 manifests renamed `tools` → `tools_policy` per §7.8 (`integration-clickup-mcp`, `integration-github-mcp`, `integration-gmail-mcp@2.0.0`, plus three local-test fixtures); 6 manifests migrated from `{{credential.<field>}}` to Arazzo-canonical `{$credential.<field>}` placeholder grammar per §7.6/§7.7 (`integration-freshdesk`, `-teamwork`, `-twilio`, `-woocommerce`, `-wordpress`, `-zendesk`).
- **Integration credential wire** (`/internal/integration-credentials/*`) dual-emits AFPS 2.0 canonical snake_case (`auth_key`, `auth_type`, `authorized_uris`, `scopes_granted`, `delivery_plans`, `expires_at_epoch_ms`, `header_name`, `header_prefix`, `allow_server_override`) alongside deprecated camelCase aliases for one release window.
- **`IntegrationSpawnSpec`** carries a `sourceKind: "local" | "remote" | "api"` peer discriminant (replaces the synthetic `server.type: "http"` sentinel that collided with AFPS `mcpServerTypeEnum`).
- **OpenAPI** `AgentDetail.dependencies` gained the `mcp_servers` group; `library.packages` gained the `mcp-server` group.
- **Frontend**: `mtls` (AFPS 2.0.1 §7.2) handled by `FieldsConnectModal` via new `client_cert` / `client_key` fallback + multi-line textarea heuristic for PEM paste + new i18n labels (fr/en).
- **`required_identity_claims`** (§7.4) now enforced in both `oauth2-strategy` and `login-strategy`; missing required claims abort the connection before persistence.
- **OAuth discovery** (`packages/connect/src/oauth-discovery.ts`) now projects `code_challenge_methods_supported` and `userinfo_endpoint` from the discovery document; precedence is manifest > discovery > default `["S256"]` for PKCE methods.
- **New `mcp-server` runtime image** `appstrate-mcp-runner-uv` for AFPS 2.0.2 / MCPB 0.4 `server.type: "uv"`.
- **`INTEGRATION.md`** content surfaced to the agent at runtime via the platform-prompt's `### API Documentation` subsection (§3.5).
- **Bundle metadata** `BundleMetadata` dropped the `x-${string}` index signature (AFPS 2.0 §10.1 removes `x-*` in favor of `_meta` reverse-DNS namespacing).

### Documentation

- New ADR-015 (AFPS 2.0 sidecar MCP surface) supersedes ADR-003 + ADR-014; banner warnings on ADR-007 + ADR-013.
- New `docs/architecture/AFPS_2_0_INTEGRATIONS.md` covers `auths` multi-method, `mtls`, OAuth discovery, `identity_claims`, `scope_catalog`+`implies`, `delivery.{http,env,files}`, `source.kind`, `tools_policy`+`hidden_tools`, `_meta`, Arazzo `connect.login`, migration from 1.x.
- `README.md`, `AGENTS.md`, `CLAUDE.md`, `docs/guides/writing-an-integration-with-connect.md` rewritten / updated for AFPS 2.0 vocabulary.

### Changed

- Pinned Docker images to specific versions (postgres:16.8, redis:7.4, minio RELEASE.2025-03-12)
- Main Dockerfile now runs as non-root `bun` user in production
- ESLint `no-unused-vars` upgraded from `warn` to `error`
- All workspace packages extend shared `tsconfig.base.json`
- Enabled TypeScript type-checking on `runtime-pi` (previously disabled via `noCheck: true`)
- **BREAKING (API contract)**: `parseBody` helper — used by ~80 call sites
  across ~22 route files (core routes + `webhooks` and `oidc` modules) — now
  emits `code: "validation_failed"` instead of `code: "invalid_request"` on
  body-validation failures, and populates `errors[]` with every Zod issue
  instead of setting the top-level `param` field on the first one. Clients
  that branch on `code === "invalid_request"` or read `body.param` for
  body-validation errors must be updated to handle
  `code === "validation_failed"` and read the per-field `errors[]` array.
  Non-body validation errors (auth, app context, rate limits) continue to
  use their existing codes unchanged.
- **BREAKING (API contract)**: `validateAgentReadiness` now emits
  `code: "invalid_config"` for config-schema failures instead of the legacy
  `config_incomplete`, aligning with the inline-preflight stage that already
  used `invalid_config`. The field name and message are unchanged. Clients
  branching on `code === "config_incomplete"` must be updated.
- `validateAgentDependencies` parallelises provider checks via `Promise.all`
  across `isProviderEnabled`, `getProviderCredentialId`, and
  `getConnectionStatus`. The pre-existing check-type precedence (enabled →
  profile → credential → status → scope) is preserved; within each check
  type, the thrown error still follows `providers` iteration order. Happy-
  path latency is reduced.
- `ValidationFieldError` entries now carry an optional `title` (human-
  readable). Throwing wrappers (`validateAgentReadiness`,
  `validateAgentDependencies`, inline-preflight fail-fast) use it so the
  `Problem.title` field keeps its historical wording (e.g. "Empty Prompt")
  instead of surfacing the machine code.

### Removed

- **Sidecar pre-warming pool** — empirical measurement after #406 (parallel
  agent+sidecar boot with MCP retry) showed the agent's own Bun cold start
  fully masks warm-image sidecar boot, so pre-warming bought no user-visible
  latency. Cold-pull protection (20–45 s on first run after deploy) is now
  handled by `DockerOrchestrator.initialize()` calling `ensureImage()` for
  both images at API boot. Removed: `apps/api/src/services/sidecar-pool.ts`
  (~280 LoC), `POST /configure` endpoint, `CONFIG_SECRET` auth, standby
  network (`appstrate-sidecar-pool`), replenish loop, `preConfigured` flag,
  `SIDECAR_POOL_SIZE` env var, and host-port bindings on the sidecar
  container (agents reach the sidecar via the `sidecar` DNS alias on the
  run network — no host port needed). Sidecars are now spawned per-run with
  all runtime config injected via env vars at container start.
- **Pre-prod legacy purge (#288)** — five surgical removals exploiting the
  absence of production data on this branch (net −312 LOC, 36 files):
  - v0 credential-encryption envelope (raw-base64 fallback) — only the v1
    versioned envelope remains.
  - `RunResult.checkpoint` / `checkpointScope` top-level mirrors —
    `RunResult.pinned: Record<string, PinnedSlot>` is the single surface.
    The DB column `runs.checkpoint` is preserved for the per-run snapshot
    consumed by the `run_history` MCP tool.
  - CLI `LEGACY_PROJECT_NAME` install fallback (#167 pre-fix shim).
  - `legacyHashRedirects` prop and its 4 consumers.
  - `normalizeProviderInitialState` legacy draft repair.
- **Architectural redundancies collapsed (#290)** — net −90 LOC across
  10 files, zero behaviour change: `enrichOneSchedule()` removed (single
  Promise.all path via `enrichSchedules`), `proxyLlmCall()` returns
  `Response` directly (drop `ProxyCallResult` indirection), package
  config is sourced exclusively from `CONFIG_BY_TYPE` (drop standalone
  `SKILL_CONFIG` / `TOOL_CONFIG` / `AGENT_CONFIG` / `PROVIDER_CONFIG` and
  duplicate `TYPE_TO_CONFIG`).
- **Modernization audit cleanup (#291)** — 5 findings.
- Legacy run reducer + `LoadedBundle` mono-package surface (#247) —
  hot-path resolvers (`ToolResolver` / `SkillResolver` / `ProviderResolver`)
  natively consume `Bundle` multi-package; one canonical digest API
  (`canonicalBundleDigest(bundle)`).
- Legacy `/proxy` and `/run-history` HTTP routes from the sidecar — agents
  reach those capabilities exclusively via MCP `tools/call` now (hard
  break, no soft-deprecation).
- Invalid `preserve-caught-error` ESLint rule

### Security

- Non-root container execution for main application image
- Network isolation between data services and public-facing services
- **Versioned credential encryption envelope (#279)** — credentials stored
  as `v1:<kid>:<base64(iv|authTag|ciphertext)>` with multi-key keyring
  enabling rotation windows (active key embeds the kid, retired keys held
  for decrypt-only). Legacy v0 envelope retired.
- **MCP tool descriptor poisoning hardening (#281)** — `sanitiseTextField`
  strips Unicode hidden characters (zero-width, RTL/bidi, BOM,
  Hangul/Khmer fillers, C0 controls); `sanitiseToolDescriptor` recurses
  through `inputSchema.properties` to mitigate Full-Schema Poisoning
  (CyberArk / Invariant Labs advisories). Limits enforced: tool desc
  ≤ 2048 B, param desc ≤ 512 B, schema ≤ 8192 B.
- **Pi image hardening (#227 Part 14)** — image size 877 MB → 313 MB
  (−64%); `unzip` apk dropped (fflate in-process), explicit UID/GID
  (`pi`=1001, sidecar `nobody:nobody`), `COPY --chown` instead of bulk
  recursive chown.
