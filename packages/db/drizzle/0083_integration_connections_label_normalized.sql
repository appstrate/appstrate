-- A connection label reaches the model verbatim (the tools' `connection` enum), so the database
-- holds it to what `connectionLabelProblem` and `CONNECTION_LABEL_MAX` accept
-- (`apps/api/src/lib/connection-label.ts`, #1786): not empty, no edge whitespace in the JS `trim()`
-- sense, no C0/DEL/C1, U+2028/2029 or `isHiddenCodePoint` code point, at most 80 UTF-16 units (a
-- code point above U+FFFF counts two). It subsumes `integration_connections_label_not_empty`.
--
-- The repair renames rows beyond the one it normalizes (a normalized label may collide under
-- `idx_integration_conn_label`), which §2 of `docs/NO_TRANSITIONAL_CODE.md` does not licence:
-- that is `scripts/migration/0038-normalize-connection-labels.sql`. The read-only DO block
-- refuses the batch while a label violates the CHECK, naming that script, instead of a bare 23514.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "integration_connections" WHERE NOT (label <> '' AND label !~ '^[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]|[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]$' AND label !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\U000E0000-\U000E007F]' AND char_length(label) + regexp_count(label, '[\U00010000-\U0010FFFF]') <= 80))
  THEN
    RAISE EXCEPTION 'An integration connection label is empty, starts or ends with whitespace, holds a control, invisible or bidirectional character, or exceeds 80 UTF-16 units. Stop the app, run scripts/migration/0038-normalize-connection-labels.sql, then redeploy.';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "integration_connections" DROP CONSTRAINT "integration_connections_label_not_empty";--> statement-breakpoint
ALTER TABLE "integration_connections" ADD CONSTRAINT "integration_connections_label_normalized" CHECK (label <> '' AND label !~ '^[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]|[ \u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]$' AND label !~ '[\u0001-\u001F\u007F-\u009F\u00AD\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\U000E0000-\U000E007F]' AND char_length(label) + regexp_count(label, '[\U00010000-\U0010FFFF]') <= 80);
