-- `model_provider_credentials.available_model_ids` is gone. Its one writer,
-- `POST /api/model-provider-credentials/{id}/refresh-models`, is removed, and
-- nothing gated on it: the model catalog is Pi's registry (#1549).
--
-- SHAPE ONLY (`docs/NO_TRANSITIONAL_CODE.md` §2). The listed ids it held are
-- discarded with it.
--
-- ROLLBACK: one-way. A previous build selects the column on every credential
-- read. Restore the coordinated backup, or roll forward.

ALTER TABLE "model_provider_credentials" DROP COLUMN "available_model_ids";
