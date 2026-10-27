// SPDX-License-Identifier: Apache-2.0

import type { JSONSchema7 } from "@appstrate/core/form";

export type { ResourceEntry } from "@appstrate/shared-types";

export interface SchemaField {
  key: string;
  required: boolean;
  /** The JSON-Schema property itself: the single source of truth for every keyword. */
  prop: JSONSchema7;
  /** AFPS `file_constraints.accept` (file fields). */
  accept?: string;
  /** AFPS `file_constraints.max_size` (file fields). */
  maxSize?: number;
  /** AFPS `ui_hints.placeholder` (non-file input fields). */
  placeholder?: string;
}
