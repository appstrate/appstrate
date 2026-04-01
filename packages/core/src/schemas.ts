// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Re-export generated JSON Schema files for each AFPS package type.
 *
 * These are auto-generated from the Zod definitions in @afps-spec/schema
 * via `bun run generate:schemas`. Consumers should import from
 * `@appstrate/core/schemas` instead of maintaining local copies.
 */

import flowSchema from "../schema/flow.schema.json";
import skillSchema from "../schema/skill.schema.json";
import toolSchema from "../schema/tool.schema.json";
import providerSchema from "../schema/provider.schema.json";

export { flowSchema, skillSchema, toolSchema, providerSchema };
