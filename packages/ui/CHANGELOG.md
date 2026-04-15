# Changelog

All notable changes to `@appstrate/ui` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-04-15

### Added

- Initial release. Extracted from `apps/web/src/components/schema-form/`.
- `./schema-form` export — `SchemaForm` RJSF wrapper, Tailwind-styled templates, custom widgets (text, textarea, select, multi-select, checkbox, file).
- `FileWidget` with drag-and-drop upload via the `upload://` direct-upload protocol.
- i18n-agnostic contract: consumers inject translated strings via the `labels` prop and the upload endpoint via `uploadPath`.
