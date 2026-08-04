/**
 * agent-map contributes no tables — the projection is computed from core state
 * (packages, application_packages, package_schedules, connections). Default-export
 * the empty tuple so the root test preload's auto-discovery treats this module
 * identically to the table-owning ones.
 */
export default [] as const;
