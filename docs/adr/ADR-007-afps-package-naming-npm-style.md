# ADR-007: npm-style Naming for AFPS Packages

## Status

Accepted

## Context

AFPS packages (agents, skills, tools, providers) need a stable naming scheme that:

- Scales beyond Appstrate's current `system-packages/` directory into a future package registry
- Scopes ownership to prevent name squatting and identify publishers
- Is already familiar to the developer ecosystem we target
- Works uniformly across distribution channels (filesystem, HTTP, OCI registries)

Today the AFPS schema (`@afps-spec/schema` v1.3.1) already enforces a scoped pattern: `^@[a-z0-9]([a-z0-9-]*[a-z0-9])?\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$` — identical to npm's scoped package regex. System packages inside `appstrate/system-packages/` follow a legacy flat naming (`tool-add-memory-1.0.0.afps`) that does not encode a scope in the identifier itself.

A registry — whether Appstrate-hosted or an OCI-based distribution (see ADR-008) — will require scoped identifiers to avoid collisions across organizations. Deferring this decision risks a second migration once third-party publishers appear.

Alternatives considered:

- **Flat unscoped names** (`add-memory`, `output`): no collision protection, incompatible with registry-style ecosystems
- **Reverse DNS** (`dev.appstrate.add-memory`): unfamiliar to the JS/npm developer audience, verbose
- **URL-based identity** (`https://packages.appstrate.dev/add-memory`): couples identity to hosting, breaks on mirroring

## Decision

Adopt **npm-style `@scope/name` identifiers** for every AFPS package type — agents, skills, tools, providers. The scope identifies the publisher (`@appstrate`, `@myorg`, `@acme-corp`); the name is unique within the scope.

- **Platform packages** (today in `system-packages/`): renamed to `@appstrate/add-memory`, `@appstrate/output`, `@appstrate/report`, `@appstrate/set-state`, `@appstrate/log`, etc.
- **Archive file naming**: `{scope}-{name}-{version}.afps` (e.g. `appstrate-add-memory-1.0.0.afps`) — filesystem-safe, derivable from the identifier
- **Manifest identifier**: `name: "@scope/name"` (already enforced by the schema)
- **Dependency declarations**: `dependencies.tools: { "@appstrate/add-memory": "^1.0.0" }` (already in spec)

Migration is opt-in per package at the next version bump. Legacy unscoped names (e.g. `tool-add-memory-1.0.0.afps` as a file) remain parseable by the bundler until the `system-packages/` rename completes.

## Consequences

**Positive:**

- One identifier shape across filesystem bundles, HTTP distribution, OCI registries, and a future AFPS registry
- Scope signals publisher identity at read time
- Aligns with an ecosystem (npm, cargo, helm) developers already understand
- Single migration moment — avoids migrating again when the registry ships
- Schema already enforces the regex; no breaking change to `@afps-spec/schema`

**Negative:**

- `system-packages/` directory contents need to be renamed at some point (work item for Phase 6–8 of the runtime extraction plan)
- Consumers that hard-coded legacy unscoped names will need updates — mitigated by the fact that all current usage is inside Appstrate

**Neutral:**

- Choice of `@appstrate` as the scope for platform packages follows the existing npm conventions (`@appstrate/core`, `@appstrate/ui`, `@appstrate/afps-runtime`)
- Third-party publishers register their own npm scope (or equivalent) and are responsible for its governance
