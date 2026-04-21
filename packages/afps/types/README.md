# @afps/types

TypeScript bindings for AFPS 1.3+ contracts.

This package is the canonical TS projection of the language-agnostic
AFPS specification (see [`afps-spec/spec.md`](https://github.com/appstrate/afps-spec/blob/main/spec.md)).
It declares types only — no runtime behavior — so any AFPS-compliant
TypeScript tool, runtime, or runner can depend on it to share
vocabulary without coupling to a specific implementation.

## What's in

- **Manifest refs** (`DependencyRef`, `ToolRef`, `ProviderRef`, `SkillRef`, `JSONSchema`) — parallel to the Zod schemas in `@afps-spec/schema`.
- **Tool protocol** (`Tool`, `ToolContext`, `ToolResult`) — the shape every AFPS tool implementation MUST satisfy.
- **Wire envelope** (`RunEvent`) — open event shape flowing from tools to sinks.

## What's out

Runtime-internal interfaces (bundle loader APIs, resolver interfaces,
sink interfaces, aggregated run state) live in the runtime package
that owns the implementation — e.g. `@appstrate/afps-runtime`. They
describe how a specific TypeScript runtime wires itself up
internally, not contracts shared across the ecosystem.
