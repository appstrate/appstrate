# @appstrate/shared-types

Shared TypeScript type definitions used by both frontend (`apps/web`) and backend (`apps/api`).

## What it provides

- **DB model re-exports**: `UserProfile`
- **Enums**: `RunStatus`, `OrgRole`
- **Wire DTOs**: `RunWireDto` (+ `EnrichedRun`), `ScheduleWireDto` (+ `EnrichedSchedule`), `ListEnvelope<T>`
- **API response types**: `AgentListItem`, `AgentDetail`, `OrgPackageItem`, `AppConfig`, `AppConfigFeatures`
- **Integration types**: `IntegrationSummary`, `IntegrationConnection`, `IntegrationCandidate`, `IntegrationPin`
- **Headless types**: `SpaceInfo`, `EndUserInfo`, `ApiKeyInfo`
- **Policy helpers**: `assignableRolesForMember()`, `canRemoveMember()` (`ASSIGNABLE_ORG_ROLES`)

## Usage

```typescript
import type { AgentDetail, RunStatus } from "@appstrate/shared-types";
```

## Dependencies

- `@appstrate/db` — Schema type imports (Drizzle `InferSelectModel`)
- `@appstrate/core` — Validation types (`PackageType`, `IntegrationManifest`)
