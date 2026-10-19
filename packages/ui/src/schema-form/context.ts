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
  /** Shown in an open select when what was typed matches no option. */
  noOptions?: string;
  /** BCP 47 tag the date echo is written in; `undefined` uses the browser's. */
  locale?: string;
  /** Soft warning under a date whose year is below 1000 (`year` is zero-padded to four digits). */
  unusualYear?: (year: string) => string;
  /** Sentence for a failed JSON Schema keyword and its Ajv `params`; `undefined` keeps Ajv's. */
  validationError?: (keyword: string, params: Record<string, unknown>) => string | undefined;
}

export interface SchemaFormContext {
  upload?: UploadFn;
  labels?: SchemaFormLabels;
}
