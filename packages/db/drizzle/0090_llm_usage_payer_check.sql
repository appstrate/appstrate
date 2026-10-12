-- 0090 — a ledger row names a payer iff a member's own credential paid the call. Compared as
-- text: the enum label 'user' (0088) is unusable in the transaction that adds it, and drizzle
-- applies every pending migration in one.
ALTER TABLE "llm_usage" ADD CONSTRAINT "llm_usage_payer_iff_user_source" CHECK ((credential_source::text IS NOT DISTINCT FROM 'user') = (payer_user_id IS NOT NULL));
