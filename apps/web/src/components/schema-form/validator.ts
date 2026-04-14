// SPDX-License-Identifier: Apache-2.0

// Shared Ajv2020 + ajv-formats validator for RJSF, matching the backend via
// the single factory in `@appstrate/core/ajv`. The awkward `unknown` cast at
// the ajv-formats / ajv/dist/2020 boundary lives there, not here.

import { customizeValidator } from "@rjsf/validator-ajv8";
import { AjvClass } from "@appstrate/core/ajv";

export const schemaFormValidator = customizeValidator({
  AjvClass,
  ajvOptionsOverrides: { strict: false },
  ajvFormatOptions: {},
});
