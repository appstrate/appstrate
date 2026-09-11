# @appstrate/ui

The Appstrate React design system — shadcn/Radix components, schema-driven forms, upload widget, RJSF templates. Single source of truth for the UI shared across the monorepo.

## Install

Private workspace package — not published to npm. Consumed within the monorepo via the workspace protocol:

```jsonc
// package.json
"dependencies": { "@appstrate/ui": "workspace:*" }
```

Peer deps: `react` 19, `react-dom` 19, `@rjsf/core` ^6, `@rjsf/utils` ^6, `@rjsf/validator-ajv8` ^6, `lucide-react`, `react-select` ^5, `@appstrate/core` (workspace), `typescript` ^5.

The package ships raw `.tsx`/`.ts` sources (no build step) — consumers transpile via their bundler (Vite, etc.). Same convention as `@appstrate/core`.

Consumed by `apps/web`; any in-monorepo surface (module UIs, internal dashboards) can import it so components render identically everywhere. Components are locale-agnostic — user-facing copy is injected via `labels` props (see `SchemaForm`), never baked in.

## Usage

```tsx
import { SchemaForm } from "@appstrate/ui/schema-form";

<SchemaForm
  wrapper={manifest.input}
  formData={values}
  labels={labels}
  onChange={(e) => setValues(e.formData)}
  onSubmit={(e) => submit(e.formData)}
/>;
```

The widget is i18n-agnostic — pass translated strings via `labels`. See `apps/web/src/hooks/use-schema-form-labels.ts` for the i18next bridge used by the Appstrate platform.

## Exports

- `./components/*` — shadcn/Radix primitives, one per file (e.g. `@appstrate/ui/components/button`, `dialog`, `select`, `sidebar`, `sonner`, …). CVA variants + `cn()` styling. `ls packages/ui/src/components/` is the authoritative list.
- `./components/sidebar-context` — the `.ts`-only escape hatch for the sidebar context (the wildcard above resolves `.tsx`).
- `./cn` — the canonical `cn(...)` class-merge helper (`clsx` + `tailwind-merge`). The single implementation used by every component and the web app.
- `./use-mobile` — `useIsMobile()` hook (breakpoint-based).
- `./schema-form` — `SchemaForm` component, `FileWidgetLabels` type, RJSF widgets/templates.

> The `./components/*` wildcard is unguarded: a subpath naming a file that does
> not exist (e.g. a component that was removed) resolves to a missing path and
> fails at bundle time rather than with Node's `ERR_PACKAGE_PATH_NOT_EXPORTED`.
> Check the directory listing, not this README, when an import 404s.

## License

Apache-2.0
