-- Agent-output dedup guard on `documents`.
--
-- RE-RUNNABLE (same discipline as 0020/0021/0023/0024): this database has a
-- history of hand-repaired migration state, and the recovery is to replay a
-- migration — an unguarded `CREATE UNIQUE INDEX` would then crash-loop the boot
-- on `already exists`.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_documents_run_output_dedup" ON "documents" USING btree ("run_id","sha256","name") WHERE "documents"."purpose" = 'agent_output';
