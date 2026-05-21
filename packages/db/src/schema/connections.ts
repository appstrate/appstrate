// SPDX-License-Identifier: Apache-2.0

// The legacy connection-profile / app-profile cascade was removed — integrations
// now use a flat connections + pins model (see
// `apps/api/src/services/integration-connection-resolver.ts`). This module is
// intentionally empty; the `connection_profiles` and `user_application_profiles`
// tables are dropped by migration 0032.

export {};
