-- `space_packages.chat_enforced` is gone: a space imposes no skill on the chat. A
-- conversation spans several spaces, so a per-space imposition has no single space to read
-- from; the skills a turn injects are the ones the user chose.
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2). Whatever the column held is discarded with
-- it.
--
-- ROLLBACK: one-way. A previous build selects the column on every placement read and writes
-- it through `PATCH /api/spaces/{spaceId}/packages/{scope}/{name}`. Restore the coordinated
-- backup, or roll forward.

ALTER TABLE "space_packages" DROP COLUMN "chat_enforced";
