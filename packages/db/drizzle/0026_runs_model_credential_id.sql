-- Per-run binding for OAuth model provider credentials.
--
-- Snapshotted at run creation: the `runs` row records which
-- `model_provider_credentials` entry the run is allowed to fetch fresh
-- tokens for via `/internal/oauth-token/:credentialId`. The token
-- resolver checks this match in addition to the existing org-level
-- assertion. Without this binding, a leaked run token could be used to
-- enumerate ALL OAuth credentials in the run's org — with it, the
-- resolver rejects any credentialId not pinned at run start.
--
-- Nullable + ON DELETE SET NULL: existing runs predate the column, and
-- credential deletion must not cascade-delete historical run rows.
ALTER TABLE "runs" ADD COLUMN "model_credential_id" uuid;
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_credential_id_model_provider_credentials_id_fk"
  FOREIGN KEY ("model_credential_id")
  REFERENCES "model_provider_credentials"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;
