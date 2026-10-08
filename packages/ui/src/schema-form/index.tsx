// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin RJSF wrapper integrated with the Appstrate dark theme. Ships in
 * `@appstrate/ui/schema-form` so every Appstrate surface renders AFPS
 * input/config/output schemas identically.
 *
 *   <SchemaForm
 *     wrapper={manifest.input}
 *     formData={…}
 *     onChange={…}
 *     onSubmit={…}
 *     upload={uploadClient}
 *   >
 *     {/* custom footer, or leave empty to let RJSF render a submit button *\/}
 *   </SchemaForm>
 *
 * The AFPS `SchemaWrapper` (schema + file_constraints + ui_hints + property_order)
 * is mapped to RJSF's `schema` + `uiSchema` by `@appstrate/core/form`. JSON
 * Schema 2020-12 is used via `customizeValidator({ AjvClass: Ajv2020 })`.
 */

import { forwardRef, useMemo } from "react";
import type { FormProps as RjsfFormProps } from "@rjsf/core";
import RjsfForm from "@rjsf/core";
import { mapAfpsToRjsf, type SchemaWrapper } from "@appstrate/core/form";
import { schemaFormValidator } from "./validator.ts";
import {
  BaseInputTemplate,
  FieldTemplate,
  TitleFieldTemplate,
  DescriptionFieldTemplate,
  ArrayFieldTemplate,
  ArrayFieldItemTemplate,
  ObjectFieldTemplate,
  MultiSchemaFieldTemplate,
  SubmitButton,
} from "./templates.tsx";
import {
  FileWidget,
  TextareaWidget,
  CheckboxWidget,
  SelectWidget,
  MultiSelectWidget,
} from "./widgets.tsx";
import type { UploadFn } from "./upload-client.ts";

import type { SchemaFormContext, SchemaFormLabels } from "./context.ts";

export type { SchemaWrapper } from "@appstrate/core/form";
export type { SchemaFormLabels } from "./context.ts";
export type { UploadFn } from "./upload-client.ts";

const widgets = {
  file: FileWidget,
  TextareaWidget,
  CheckboxWidget,
  SelectWidget,
  multiselect: MultiSelectWidget,
};

const templates = {
  BaseInputTemplate,
  FieldTemplate,
  TitleFieldTemplate,
  DescriptionFieldTemplate,
  ArrayFieldTemplate,
  ArrayFieldItemTemplate,
  ObjectFieldTemplate,
  MultiSchemaFieldTemplate,
  ButtonTemplates: { SubmitButton },
};

export interface SchemaFormProps extends Omit<
  RjsfFormProps,
  "schema" | "uiSchema" | "validator" | "widgets" | "templates" | "children" | "formContext"
> {
  wrapper: SchemaWrapper;
  /** Extra uiSchema merged on top of the AFPS-derived one. */
  uiSchema?: Record<string, unknown>;
  /**
   * Uploader the `FileWidget` calls for direct uploads. Omit to disable
   * uploads (the widget shows an error if the user tries to attach a file).
   */
  upload?: UploadFn;
  /** Translated strings for the form's chrome and validation messages. Defaults are English. */
  labels?: SchemaFormLabels;
}

/**
 * The submit button never renders: `ui:submitButtonOptions.norender` is set
 * unconditionally. Every caller drives submission from its own chrome via the
 * forwarded ref, so RJSF's built-in button would only ever be a duplicate.
 */
export const SchemaForm = forwardRef<RjsfForm, SchemaFormProps>(function SchemaForm(
  { wrapper, uiSchema: extraUi, upload, labels, ...rest },
  ref,
) {
  const mapped = mapAfpsToRjsf(wrapper);
  const uiSchema = {
    ...mapped.uiSchema,
    ...(extraUi ?? {}),
    "ui:submitButtonOptions": { norender: true },
  };

  // Stable identity so downstream `useMemo`s in FileWidget actually memoize.
  const ctx = useMemo(
    () => ({ upload, labels }) as SchemaFormContext & Record<string, unknown>,
    [upload, labels],
  );

  const validationError = labels?.validationError;
  const transformErrors = useMemo<RjsfFormProps["transformErrors"]>(
    () =>
      validationError &&
      ((errors) =>
        errors.map((error) => {
          const message = error.name && validationError(error.name, error.params ?? {});
          return message ? { ...error, message } : error;
        })),
    [validationError],
  );

  return (
    <RjsfForm
      ref={ref}
      schema={mapped.schema as unknown as Record<string, unknown>}
      uiSchema={uiSchema}
      validator={schemaFormValidator}
      widgets={widgets}
      templates={templates}
      formContext={ctx}
      // Each message already renders under its field; the top list repeats them in English.
      showErrorList={false}
      transformErrors={transformErrors}
      {...rest}
    />
  );
});
