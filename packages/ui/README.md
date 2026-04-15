# @appstrate/ui

Shared React UI components for Appstrate surfaces — schema-driven forms, upload widget, RJSF templates.

## Install

```sh
bun add @appstrate/ui
```

Peer deps: `react` 19, `react-dom` 19, `@rjsf/core` ^6, `@rjsf/utils` ^6, `@rjsf/validator-ajv8` ^6, `lucide-react`, `react-select` ^5, `@appstrate/core` ^2.10.

## Usage

```tsx
import { SchemaForm } from "@appstrate/ui/schema-form";

<SchemaForm
  schema={schema}
  formData={values}
  uploadPath="/api/uploads"
  labels={labels}
  onChange={(e) => setValues(e.formData)}
  onSubmit={(e) => submit(e.formData)}
/>;
```

The widget is i18n-agnostic — pass translated strings via `labels`. See `apps/web/src/hooks/use-schema-form-labels.ts` for the i18next bridge used by the Appstrate platform.

## Exports

- `./schema-form` — `SchemaForm` component, `FileWidgetLabels` type, RJSF widgets/templates.

## License

Apache-2.0
