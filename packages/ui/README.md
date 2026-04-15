# @appstrate/ui

Shared React UI components for Appstrate surfaces — schema-driven forms, upload widget, RJSF templates.

## Install

```sh
bun add @appstrate/ui
```

Peer deps: `react` 19, `react-dom` 19, `@rjsf/core` ^6, `@rjsf/utils` ^6, `@rjsf/validator-ajv8` ^6, `lucide-react`, `react-select` ^5, `@appstrate/core` ^2.10, `typescript` ^5.

The package ships raw `.tsx` sources (no build step) — consumers are expected to transpile via their bundler (Vite, Next.js, etc.). Same convention as `@appstrate/core`.

Designed to be consumed by any Appstrate surface (main app, portal, future dashboards) so schema forms render identically everywhere.

## Usage

```tsx
import { SchemaForm } from "@appstrate/ui/schema-form";

<SchemaForm
  wrapper={manifest.input}
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
