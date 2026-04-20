# ADR-008: OCI Artifacts as Primary Distribution for AFPS Bundles

## Status

Accepted (target state; concrete implementation sequenced in Phase 11 of the runtime extraction plan)

## Context

AFPS bundles are ZIP archives containing a manifest, prompt, resolved dependencies, and (once signing lands) a detached signature. Today they live in S3, keyed by `{packageId}/{version}.afps`, and are served via Appstrate's internal HTTP endpoints. An open-source runtime (`@appstrate/afps-runtime`) that executes bundles anywhere needs a distribution scheme that does not require consumers to stand up a custom registry.

Requirements:

- Content-addressable (pull a bundle by digest, not by name-and-trust)
- Mirroring / caching available out of the box
- Signature verification primitives (cosign, SLSA provenance)
- Enterprise-grade access control and rate limiting
- Usable without an Appstrate account

Alternatives considered:

- **Appstrate-hosted HTTP (status quo)**: works today but ties external consumers to Appstrate infrastructure; no mirroring, no air-gap story, no shared tooling with the OCI ecosystem
- **Custom AFPS registry**: forces us to rebuild authentication, quotas, CDN, mirroring, auditing — all solved problems in the OCI ecosystem
- **npm registry**: doesn't support arbitrary binary artifacts well; publish/signing tooling is tied to the JavaScript ecosystem
- **Plain files on S3**: no signing/provenance primitives, no mirroring without custom tooling

## Decision

Adopt **OCI artifacts (via [ORAS](https://oras.land/))** as the primary distribution channel for AFPS bundles. An AFPS bundle is a standard OCI artifact with a single layer carrying the `.afps` archive plus optional companion layers for signatures and provenance.

- Tag format: `{registry-host}/{scope}/{name}:{version}` — maps directly to the npm-style naming in ADR-007 (e.g. `ghcr.io/appstrate/add-memory:1.0.0`)
- Any OCI-compliant registry works: GitHub Container Registry, Docker Hub, Harbor, Artifactory, AWS ECR, Google Artifact Registry, Quay
- `cosign` (ADR-009) attaches Ed25519 or Sigstore keyless signatures as additional OCI artifacts referencing the bundle digest
- SLSA provenance attestations attach the same way
- Plain `.afps` files remain a supported distribution mode for offline, air-gapped, or filesystem-only use cases

Appstrate's existing S3 storage becomes a **secondary channel** for the runtime and is not removed — bundles can be pulled either from S3 (for backwards-compatible Appstrate consumers) or from OCI registries (for new consumers). A custom Appstrate registry is **not** built as part of the OSS runtime — if value-added features (discovery, ratings, org scoping) are needed, they are layered on top of OCI rather than replacing it.

## Consequences

**Positive:**

- Zero new registry infrastructure to build or operate
- Free mirroring, caching, and rate limiting on every OCI-compliant host
- Native `cosign` signing and verification (bridges cleanly to ADR-009)
- SLSA L3 attestations attachable with standard tooling
- Content-addressable pulls via digest — consumers can pin bundles they trust
- Enterprise customers can self-host on Harbor / Artifactory without any Appstrate code
- Interop with the rest of the container ecosystem (Kubernetes, Argo, Tekton)

**Negative:**

- Consumers need `oras` or equivalent tooling (mitigated — the runtime ships an `afps pull` command that wraps ORAS under the hood)
- OCI registries have quirks across implementations (rate limits on Docker Hub, Harbor vs ECR auth differences); documentation must call out the major ones
- Publishing a bundle becomes a two-step flow (build → push) instead of a single S3 upload — acceptable trade-off for what we gain

**Neutral:**

- The decision is a primary-channel decision, not a mono-channel decision: the AFPS runtime accepts bundles from local files, HTTP URLs, and OCI registries uniformly
- Migrating Appstrate's current S3-backed bundles to OCI is a non-trivial but mechanical job scheduled for Phase 11; nothing in Phases 0–10 depends on it
