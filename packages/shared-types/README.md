# @appstrate/shared-types

Shared TypeScript type definitions used by both frontend (`apps/web`) and backend (`apps/api`).

## What it provides

- **DB model re-exports**: `UserProfile`
- **Enums**: `RunStatus`, `OrgRole`
- **Wire DTOs**: `RunWireDto` (+ `EnrichedRun`), `ScheduleWireDto` (+ `EnrichedSchedule`), `ListEnvelope<T>`
- **API response types**: `AgentListItem`, `AgentDetail`, `OrgPackageItem`, `AppConfig`, `AppConfigFeatures`
- **Integration types**: `IntegrationSummary`, `IntegrationConnection`, `IntegrationCandidate`, `IntegrationPin`
- **Headless types**: `SpaceInfo`, `EndUserInfo`, `ApiKeyInfo`
- **Policy helpers**: `assignableRolesForMember()`, `canRemoveMember()`, `canLeaveOrg()`. `ASSIGNABLE_ORG_ROLES` (guest/member/admin) is what an invitation or OIDC `signupRole` may grant; a role change may target every role of `ORG_ROLES` (`@appstrate/core/permissions`), `owner` included — only an owner assigns, demotes or removes an owner, and nobody manages themselves

## Usage

```typescript
import type { AgentDetail, RunStatus } from "@appstrate/shared-types";
```

## Dependencies

- `@appstrate/db` — Schema type imports (Drizzle `InferSelectModel`)
- `@appstrate/core` — Validation types (`PackageType`, `IntegrationManifest`)
