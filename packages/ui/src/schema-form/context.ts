// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import type { FileWidgetLabels } from "./file-widget.tsx";
import type { UploadFn } from "./upload-client.ts";

/**
 * Shape of `formContext` that `SchemaForm` feeds to RJSF templates and
 * widgets. Templates should read it via `registry.formContext as SchemaFormContext`
 * rather than re-declaring ad-hoc types.
 */
/** Translated strings for the form's own chrome. Defaults are English. */
export interface SchemaFormLabels extends FileWidgetLabels {
  addItem?: string;
  removeItem?: string;
  moveItemUp?: string;
  moveItemDown?: string;
  /**
   * The sentence for a failed JSON Schema keyword (`type`, `minLength`, …) and
   * its Ajv `params`. Returning `undefined` keeps Ajv's English message.
   */
  validationError?: (keyword: string, params: Record<string, unknown>) => string | undefined;
}

export interface SchemaFormContext {
  upload?: UploadFn;
  labels?: SchemaFormLabels;
}
