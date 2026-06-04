# @appstrate/shared-types

Shared TypeScript type definitions used by both frontend (`apps/web`) and backend (`apps/api`).

## What it provides

- **DB model re-exports**: `UserProfile`, `Run`, `RunLog`, `Schedule`
- **Enums**: `RunStatus`, `OrgRole`
- **API response types**: `AgentListItem`, `AgentDetail`, `OrgPackageItem`, `AppConfig`, `Features`
- **Integration types**: `IntegrationSummary`, `IntegrationDetail`, `IntegrationConnection`, `IntegrationCandidate`, `IntegrationPin`
- **Headless types**: `ApplicationInfo`, `EndUserInfo`, `ApiKeyInfo`
- **Utility functions**: `isPromptEmpty()`, `findMissingDependencies()`

## Usage

```typescript
import type { AgentDetail, RunStatus } from "@appstrate/shared-types";
```

## Dependencies

- `@appstrate/db` — Schema type imports (Drizzle `InferSelectModel`)
- `@appstrate/core` — Validation types (`PackageType`, `IntegrationManifest`)
