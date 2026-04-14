// SPDX-License-Identifier: Apache-2.0

// Shared Ajv2020 + ajv-formats validator for RJSF, matching the backend.
// Split into its own module so the SchemaForm component file only exports
// React components (satisfies react-refresh/only-export-components).

import { customizeValidator } from "@rjsf/validator-ajv8";
import Ajv2020 from "ajv/dist/2020.js";

// @rjsf/validator-ajv8 types AjvClass as the draft-07 Ajv constructor. Ajv2020
// is wire-compatible at runtime but needs a cast at the boundary.
export const schemaFormValidator = customizeValidator({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  AjvClass: Ajv2020 as unknown as any,
  ajvOptionsOverrides: { strict: false },
  ajvFormatOptions: {},
});
