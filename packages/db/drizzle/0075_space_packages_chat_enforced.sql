-- Space-enforced chat skills (#1586): a placement flag, skills only. Shape only.
-- ROLLBACK: nothing to undo — a previous build never reads the column. Do not
-- drop it: 0075 stays in the journal, so a later redeploy would not re-add it.
ALTER TABLE "space_packages" ADD COLUMN "chat_enforced" boolean DEFAULT false NOT NULL;
