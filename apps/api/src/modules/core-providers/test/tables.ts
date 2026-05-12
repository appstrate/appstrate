/**
 * core-providers contributes no tables — all state lives in core's
 * `model_provider_credentials` table. Default-export the empty tuple so
 * the root test preload's auto-discovery treats this module identically
 * to the table-owning ones.
 */
export default [] as const;
