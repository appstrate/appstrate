// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Thin RJSF wrapper integrated with the Appstrate dark theme. Ships in
 * `@appstrate/ui/schema-form` so every Appstrate frontend (main app,
 * portal, future surfaces) renders AFPS input/config/output schemas
 * identically.
 *
 *   <SchemaForm
 *     wrapper={manifest.input}
 *     formData={…}
 *     onChange={…}
 *     onSubmit={…}
 *     uploadPath="/api/uploads"
 *   >
 *     {/* custom footer, or leave empty to let RJSF render a submit button *\/}
 *   </SchemaForm>
 *
 * The AFPS `SchemaWrapper` (schema + fileConstraints + uiHints + propertyOrder)
 * is mapped to RJSF's `schema` + `uiSchema` by `@appstrate/core/form`. JSON
 * Schema 2020-12 is used via `customizeValidator({ AjvClass: Ajv2020 })`.
 */

import { forwardRef, useMemo, type ReactNode } from "react";
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
import type { FileWidgetLabels } from "./file-widget.tsx";
import type { UploadFn } from "./upload-client.ts";

import type { SchemaFormContext } from "./context.ts";

export type { SchemaWrapper } from "@appstrate/core/form";
export type { FileWidgetLabels } from "./file-widget.tsx";
export type { UploadFn } from "./upload-client.ts";
export type { SchemaFormContext } from "./context.ts";

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
  /** When true, render the default RJSF submit button. Default: false. */
  showSubmitButton?: boolean;
  /**
   * Endpoint the `FileWidget` POSTs to for direct uploads. Must return an
   * `UploadDescriptor`. Omit to disable uploads (the widget shows an error
   * if the user tries to attach a file).
   */
  uploadPath?: string;
  /** Escape hatch: provide your own uploader instead of the default fetch client. */
  upload?: UploadFn;
  /** Translated strings for the FileWidget. Defaults are English. */
  labels?: FileWidgetLabels & { addItem?: string };
  /** Extra formContext keys merged into what SchemaForm builds internally. */
  formContext?: Record<string, unknown>;
  children?: ReactNode;
}

/**
 * Submit-button rendering is controlled by a single signal:
 * `ui:submitButtonOptions.norender`. When `showSubmitButton` is false (default)
 * we set `norender: true` and let RJSF render whatever `children` the caller
 * passes as a footer (or nothing).
 */
export const SchemaForm = forwardRef<RjsfForm, SchemaFormProps>(function SchemaForm(
  {
    wrapper,
    showSubmitButton = false,
    children,
    uiSchema: extraUi,
    uploadPath,
    upload,
    labels,
    formContext,
    ...rest
  },
  ref,
) {
  const mapped = mapAfpsToRjsf(wrapper);
  const uiSchema = {
    ...mapped.uiSchema,
    ...(extraUi ?? {}),
    ...(showSubmitButton ? {} : { "ui:submitButtonOptions": { norender: true } }),
  };

  // Stable identity so downstream `useMemo`s in FileWidget actually memoize.
  const ctx = useMemo(
    () =>
      ({ ...(formContext ?? {}), uploadPath, upload, labels }) as SchemaFormContext &
        Record<string, unknown>,
    [formContext, uploadPath, upload, labels],
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
      {...rest}
    >
      {children}
    </RjsfForm>
  );
});
