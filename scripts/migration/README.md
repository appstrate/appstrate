# `scripts/migration/` — one-off data tasks

Operational scripts that rewrite row **contents** once, against the deployments
that need it, and are then finished. They are **not** replayed, **not** part of
boot, and **never** live in `packages/db/drizzle/`.

See `docs/NO_TRANSITIONAL_CODE.md` for why the split exists — both halves of the
`documents` → `files` rename were botched by ignoring it, each costing a
production incident.

## The split

`packages/db/drizzle/*.sql` describes schema shape, is replayed on every
database at boot forever, and is reviewed as a permanent contract; a script
here fixes data once, on the deployments that need it, and is reviewed as an
operational task. The two legitimate overlaps — a backfill that is the
**precondition** of a `SET NOT NULL` promotion, a `CHECK`, or a
`VALIDATE CONSTRAINT`, and a fold whose source column the same file `DROP`s —
each an `UPDATE` landing on the **same table** (an `INSERT`, a `DELETE` or a `TRUNCATE` is never licenced), are stated in full,
with their limits, in `docs/NO_TRANSITIONAL_CODE.md` §2, which is the
authority; `bun run verify:no-migration-dml` enforces it.

## Writing one

`<NNNN>-<slug>.sql` (or `.ts` when it needs logic beyond SQL). Requirements:

1. **Idempotent** — every `WHERE` is exactly the condition it removes, so a
   second run matches zero rows.
2. **One transaction** — `BEGIN` / `COMMIT`, so a failure leaves nothing half-done.
3. **Fenced** — `SET LOCAL lock_timeout` and `statement_timeout`.
4. **Rehearsed** — `pg_dump` production → throwaway `postgres:16-alpine` →
   apply → verify. Record the row counts in the header. When the script repairs
   a state no reachable database is in — `0004` — say so in the header and mark
   the counts UNMEASURED, so a reader never mistakes a required value for an
   observed one.
5. **Verifiable** — ship the "before" and "after" queries alongside it.

## Running one

```sh
# 0. ALWAYS dump first
docker exec <pg> pg_dump -U appstrate -d appstrate --no-owner --no-privileges \
  -Fc -f /tmp/pre.dump

# 1. rehearse against a restored copy, never straight at production
# 2. then, and only then:
docker exec -i <pg> psql -U appstrate -d appstrate -v ON_ERROR_STOP=1 \
  -f - < scripts/migration/<NNNN>-<slug>.sql
```

## RBAC rollout (`0056` + `0008`)

Apply both during the same maintenance window with application traffic stopped:

1. Restore a production dump into a throwaway database and rehearse both steps. Record the before/after counts; production volume remains unmeasured until this is done. Verify every org with chat sessions has a default space before `0056` promotes `chat_sessions.space_id` to NOT NULL.
2. Apply pending Drizzle migrations, including `0056_space_roles.sql`. It also snapshots existing org spaces for legacy OAuth viewer signup clients before changing them to guest.
3. Run `0008-org-viewer-to-guest.sql` before starting the new application. It snapshots memberships and pending viewer invitations into explicit viewer grants, preserving any existing explicit role choices. Reruns do not add later spaces.
4. Check zero remaining org-member viewers, zero pending viewer invitations and zero OAuth `signup_role = 'viewer'`. `0008` additionally aborts if any captured membership or invitation space is missing. Inspect the legacy OAuth snapshots against the rehearsal's pre-migration client/space inventory.
5. Start the new application. Rolling back only the application is unsupported: the older build omits the now-required chat-session space. Roll forward or restore the coordinated backup.

Deleted spaces/custom roles in OAuth signup assignments require updating the client's configuration before new users can join; signup fails without creating partial org/space memberships. Existing members remain able to authenticate. Invitation acceptance retains its existing skip-and-log behavior for deleted targets.

## Log

| #    | date        | what                                                                                                                                                                                                                                                             | rows                                                                                                                                   |
| ---- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | 2026-08-26  | `files.id` `doc_` → `file_` and every reference                                                                                                                                                                                                                  | 521 / 25 / 64 / 59                                                                                                                     |
| 0002 | 2026-08-26  | `chat_messages`: `document://file_` → `appfile://file_`, finishing 0001's write 4                                                                                                                                                                                | 59                                                                                                                                     |
| 0003 | 2026-08-28  | `app_` → `spc_` space ids (+18 FK columns), `applications:*` scopes, `end_user:` realms, `level` vocabulary                                                                                                                                                      | 10750 id rows (33 `spaces` + 10717 across the 18 columns) / 32 scopes / 1+1 realms / 16 reasons / 1 `level`; 17 FKs dropped + restored |
| 0004 | not applied | oauth `resources` columns (0006) on a watermark-drifted DB — not rehearsed                                                                                                                                                                                       | unmeasured                                                                                                                             |
| 0005 | 2026-08-28  | AFPS `delivery.http.prefix`: bare auth scheme → separator-carrying (`"Bearer"` → `"Bearer "`), both manifest stores — **one deploy with the `integrationManifestSchema` (1d) gate**; run it FIRST, both spellings render alike under the old code                | 126 `package_versions` / 77 `packages.draft_manifest`                                                                                  |
| 0007 | not applied | skills: quote the `description:` lines `yaml` cannot parse, so their drafts are savable again under the SKILL.md frontmatter gate — **run after deploying the gate**; `.ts`, dry-run by default, `--apply` to write                                              | 17 of 66 skills fixable, 3 need a manual edit (2 `name`, 1 over-long description) — counted on production, NOT rehearsed               |
| 0008 | not applied | org role `viewer` → `guest` + an explicit `viewer` `space_members` row in every space that exists, pending invitations carry the same current-space snapshot — **run between drizzle `0056` and bringing the new version up**; viewers are locked out in between | unmeasured — the script prints before/after counts and aborts if any survives                                                          |
