// SPDX-License-Identifier: Apache-2.0

/**
 * Thin RJSF wrapper integrated with the Appstrate dark theme.
 *
 *   <SchemaForm wrapper={manifest.input} formData={…} onChange={…} onSubmit={…}>
 *     {/* custom footer, or leave empty to let RJSF render a submit button *\/}
 *   </SchemaForm>
 *
 * The AFPS `SchemaWrapper` (schema + fileConstraints + uiHints + propertyOrder)
 * is mapped to RJSF's `schema` + `uiSchema` by `@appstrate/core/form`. JSON
 * Schema 2020-12 is used via `customizeValidator({ AjvClass: Ajv2020 })`.
 */

import { forwardRef, type ReactNode } from "react";
import type { FormProps as RjsfFormProps } from "@rjsf/core";
import RjsfForm from "@rjsf/core";
import { mapAfpsToRjsf, type SchemaWrapper } from "@appstrate/core/form";
import { schemaFormValidator } from "./validator";
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
} from "./templates";
import {
  FileWidget,
  TextareaWidget,
  CheckboxWidget,
  SelectWidget,
  MultiSelectWidget,
} from "./widgets";

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
  "schema" | "uiSchema" | "validator" | "widgets" | "templates" | "children"
> {
  wrapper: SchemaWrapper;
  /** Extra uiSchema merged on top of the AFPS-derived one. */
  uiSchema?: Record<string, unknown>;
  /** When true, render the default RJSF submit button. Default: false. */
  showSubmitButton?: boolean;
  children?: ReactNode;
}

export const SchemaForm = forwardRef<RjsfForm, SchemaFormProps>(function SchemaForm(
  { wrapper, showSubmitButton, children, uiSchema: extraUi, ...rest },
  ref,
) {
  const mapped = mapAfpsToRjsf(wrapper);
  const uiSchema = {
    ...mapped.uiSchema,
    ...(extraUi ?? {}),
    ...(showSubmitButton ? {} : { "ui:submitButtonOptions": { norender: true } }),
  };

  return (
    <RjsfForm
      ref={ref}
      schema={mapped.schema as unknown as Record<string, unknown>}
      uiSchema={uiSchema}
      validator={schemaFormValidator}
      widgets={widgets}
      templates={templates}
      {...rest}
    >
      {children ?? (showSubmitButton ? undefined : <></>)}
    </RjsfForm>
  );
});
