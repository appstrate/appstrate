-- Runner attribution on the runs table.
--
-- Two denormalized text columns capturing WHO ran the agent, stamped at
-- INSERT time and never updated thereafter:
--
--   runner_name — human-friendly label rendered in the dashboard's run list
--                 next to the agent name. Sourced (in priority order) from
--                 the `X-Appstrate-Runner-Name` header, then the CLI's JWT
--                 `cli_family_id` claim joined to `cli_refresh_tokens.
--                 device_name`, then NULL.
--
--   runner_kind — free-form classifier driving the icon shown alongside the
--                 label (`cli`, `github-action`, …). Sourced from `X-
--                 Appstrate-Runner-Kind` or inferred from auth context.
--
-- Both columns are nullable: pre-existing runs and runs from clients that
-- don't send the headers leave them blank, in which case the UI falls back
-- to the existing `runOrigin === "remote"` "Distant" badge with no name.
--
-- Denormalized rather than FK'd: `cli_refresh_tokens` is owned by the OIDC
-- module and core → module forward references are forbidden by the module
-- contract (see CLAUDE.md "FK direction rule"). The label also has to
-- survive session revocation and device rename, which a JOIN-at-read would
-- not preserve.

ALTER TABLE "runs"
  ADD COLUMN "runner_name" text;
--> statement-breakpoint
ALTER TABLE "runs"
  ADD COLUMN "runner_kind" text;
