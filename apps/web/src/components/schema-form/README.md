# schema-form

Thin Tailwind-styled wrapper around `@rjsf/core` that renders an AFPS `SchemaWrapper` (input / config / output) as a dark-themed form.

## Usage

```tsx
import { SchemaForm } from "@/components/schema-form";

<SchemaForm
  wrapper={manifest.input}
  formData={values}
  onChange={(e) => setValues(e.formData)}
  onSubmit={(e) => runAgent(e.formData as Record<string, unknown>)}
/>;
```

The default `SchemaForm` renders no submit button — the caller provides its own (e.g. an `InputModal` footer that calls `formRef.current?.submit()`). Pass `showSubmitButton` to render the built-in button instead.

## Files

| File               | Purpose                                                                                                                                                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.tsx`        | `SchemaForm` wrapper component, widgets + templates registry wiring.                                                                                                                                                                                                                                                   |
| `validator.ts`     | Shared `customizeValidator` configured with Ajv2020 + ajv-formats — mirrors the backend AJV config so client- and server-side validation agree. Split out of `index.tsx` to keep the component file Fast-Refresh-friendly.                                                                                             |
| `templates.tsx`    | Tailwind overrides for RJSF templates: `BaseInputTemplate`, `FieldTemplate`, `TitleFieldTemplate`, `DescriptionFieldTemplate`, `ArrayFieldTemplate`, `ArrayFieldItemTemplate`, `SubmitButton`. Only templates we actively restyle are overridden; RJSF defaults cover the rest (ObjectField, OneOf multiplexer, etc.). |
| `widgets.tsx`      | Custom widgets: `TextareaWidget`, `CheckboxWidget`, `SelectWidget` (shadcn `Select`), `MultiSelectWidget` (react-select). Also re-exports `FileWidget`.                                                                                                                                                                |
| `file-widget.tsx`  | Drag-and-drop file picker + upload client integration. Handles both single-file and `multiple` modes.                                                                                                                                                                                                                  |
| `upload-client.ts` | Tiny client for the `upload://` protocol (see `docs/architecture/UPLOAD_PROTOCOL.md`): POST `/api/uploads` → PUT binary → return `upload://upl_xxx` URI.                                                                                                                                                               |

## How AFPS maps to RJSF

`@appstrate/core/form#mapAfpsToRjsf` does the translation:

| AFPS input                                                              | RJSF output                                                                                                                                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `propertyOrder: [...]`                                                  | `uiSchema["ui:order"] = [...keys, "*"]`                                                                                                                                                            |
| `uiHints[k].placeholder`                                                | `uiSchema[k]["ui:placeholder"]`                                                                                                                                                                    |
| File field (`format:"uri"` + `contentMediaType`) + `fileConstraints[k]` | `uiSchema[k]["ui:widget"] = "file"` + `ui:options` with `accept`, `maxSize`, `maxFiles`, `multiple`                                                                                                |
| `string` with `maxLength > 500`                                         | `uiSchema[k]["ui:widget"] = "textarea"`                                                                                                                                                            |
| Property with `const`                                                   | `uiSchema[k]["ui:readonly"] = true` (top-level). Nested `const` (e.g. inside `oneOf`) is handled by `BaseInputTemplate` which forces `readOnly` whenever `schema.const` is set.                    |
| Array of enum                                                           | `uiSchema[k]["ui:widget"] = "multiselect"` + `uniqueItems: true` injected into a shallow-cloned copy of the schema (RJSF's multi-select routing requires it). The original wrapper is not mutated. |

The mapping is pure — `mapAfpsToRjsf(wrapper)` is deterministic, has no side effects on `wrapper`, and is unit-tested in `packages/core/test/form.test.ts`.

## Adding a widget

1. Write a `WidgetProps` component in `widgets.tsx`.
2. Add it to the `widgets` map in `index.tsx` under a stable key.
3. Reference that key from `mapAfpsToRjsf` (or via user `uiSchema` overrides).

## Adding a template

1. Write the component in `templates.tsx` with the RJSF template props type from `@rjsf/utils`.
2. Register it in the `templates` object in `index.tsx`. For `ButtonTemplates.SubmitButton` specifically, nest under `ButtonTemplates`.

## Validation

`schemaFormValidator` uses `Ajv2020` + `ajv-formats`, configured identically to `apps/api/src/services/schema.ts`. JSON Schema 2020-12 keywords (`if`/`then`/`else`, `oneOf`, `allOf`, `dependentRequired`, `const`, `$defs`) all work without extra plumbing.

Client-side validation is a UX hint — the backend re-validates with the same AJV config against the untouched manifest schema. Never trust client-side form output.

## File uploads

`FileWidget` uploads via the protocol documented in `docs/architecture/UPLOAD_PROTOCOL.md`. In short:

1. User picks a file.
2. Widget calls `POST /api/uploads` → gets `{ id, uri, url, method, headers, expiresAt }`.
3. Widget PUTs the binary to `url`.
4. Widget writes `uri` (`upload://upl_xxx`) into the form data.
5. Form data is submitted as normal JSON; the backend consumes the upload at run time.

No `multipart/form-data` anywhere.
