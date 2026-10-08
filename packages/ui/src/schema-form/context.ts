// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import type { FileWidgetLabels } from "./file-widget.tsx";
import type { UploadFn } from "./upload-client.ts";

/**
 * Shape of `formContext` that `SchemaForm` feeds to RJSF templates and
 * widgets. Templates should read it via `registry.formContext as SchemaFormContext`
 * rather than re-declaring ad-hoc types.
 */
export interface SchemaFormLabels extends FileWidgetLabels {
  addItem?: string;
  removeItem?: string;
  moveItemUp?: string;
  moveItemDown?: string;
  /** Sentence for a failed JSON Schema keyword and its Ajv `params`; `undefined` keeps Ajv's. */
  validationError?: (keyword: string, params: Record<string, unknown>) => string | undefined;
}

export interface SchemaFormContext {
  upload?: UploadFn;
  labels?: SchemaFormLabels;
}
