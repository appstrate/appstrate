/**
 * Portkey owns no database tables — the gateway is stateless and credentials
 * stay in core's `model_provider_credentials`. Default-export the empty
 * tuple so the root test preload's auto-discovery treats this module
 * identically to the table-owning ones.
 */
export default [] as const;
