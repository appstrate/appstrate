// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

// Shared Ajv2020 + ajv-formats validator for RJSF, matching the backend via
// the single factory in `@appstrate/core/ajv`. The awkward `unknown` cast at
// the ajv-formats / ajv/dist/2020 boundary lives there, not here.
// The format options come from the same constant as the backend's factory, so both
// sides register the same formats and neither the non-standard `formatMinimum` family.

import { customizeValidator } from "@rjsf/validator-ajv8";
import { AjvClass, AJV_FORMATS_OPTIONS } from "@appstrate/core/ajv";

export const schemaFormValidator = customizeValidator({
  AjvClass,
  ajvOptionsOverrides: { strict: false },
  ajvFormatOptions: AJV_FORMATS_OPTIONS,
});
