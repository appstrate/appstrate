# ADR-009: AFPS Bundle Signing — Ed25519 First, Sigstore Keyless Target

## Status

Accepted

## Context

Once an AFPS bundle can be downloaded and executed anywhere (see the runtime extraction plan), consumers need a way to verify who produced it and that it has not been tampered with in transit. Two distinct trust domains are at play:

1. **Artifact trust** — the bundle itself: did `@appstrate` (or `@some-publisher`) produce this specific bundle? Has any file been modified after publishing?
2. **Transport trust** — events streamed from a running agent back to a receiver: is this event from the legitimate run? (Covered separately by the runtime event protocol, not this ADR.)

This ADR addresses artifact trust only.

Requirements:

- Detached signature, verifiable offline with only a public key or a well-known trust root
- Fast enough that verification is acceptable at bundle load time (one-off, not hot path)
- Supportable without a centralized PKI run by Appstrate long-term
- Compatible with OCI-based distribution (ADR-008)

Alternatives considered:

- **Ed25519 with a centralized Appstrate PKI** (Appstrate root key → publisher keys → bundles): simple, immediate, but ties the trust root to a single organization and requires key lifecycle tooling we do not want to own long-term
- **PGP / GPG signatures**: established but considered legacy by the modern supply-chain community; the ecosystem has moved on
- **Sigstore keyless** (Fulcio-issued ephemeral certs bound to OIDC identity + Rekor transparency log): the industry direction, but currently still evolving in tooling; requires OIDC issuers for publishers
- **X.509 code signing certificates**: CA-bound, expensive, not aligned with the open-source supply-chain ecosystem

## Decision

Ship signing in **two phases**:

**Phase v1 (immediate, ships with first runtime release):**

- Ed25519 detached signatures, one `signature.sig` file at the root of each bundle
- Format: `{ alg: "ed25519", keyId, signature: base64, chain?: [...] }`
- Trust hierarchy: a single Appstrate root public key is embedded in the runtime; publisher keys are signed by the root; bundles are signed by the publisher key
- Verification: fail-closed by default, `--trust-root file.json` for self-hosted publishers that do not chain to Appstrate

**Phase v2 (target, ships in Phase 11 of the runtime plan):**

- [Sigstore keyless](https://www.sigstore.dev/) via Fulcio (ephemeral cert bound to OIDC identity: GitHub Actions, email, org identities) + Rekor transparency log
- `cosign`-compatible signatures attached to OCI artifacts (ADR-008)
- Precedents: [npm provenance](https://docs.npmjs.com/generating-provenance-statements), [GitHub Actions attestations](https://docs.github.com/en/actions/security-guides/using-artifact-attestations-to-establish-provenance-for-builds), widespread container-ecosystem adoption
- Fallback: `--trust-root file.json` in [Sigstore TUF](https://docs.sigstore.dev/root-signing/) format for air-gapped environments

The runtime accepts **both** signature formats during the transition — the v1 → v2 migration is additive, not breaking. Once Sigstore adoption is stable for AFPS, the Appstrate root-signed Ed25519 mode becomes a maintenance / air-gap option.

## Consequences

**Positive:**

- Immediate L2 (signed artifact) conformance via Ed25519 — unblocks the first public runtime release without waiting for full Sigstore tooling
- Clear long-term direction (Sigstore) — no Appstrate-owned PKI ends up as a permanent dependency of the AFPS ecosystem
- Two-phase plan lets us ship now and migrate without a breaking change to bundle format
- Aligns with industry peers (cosign, npm, GitHub) that have all converged on keyless for supply-chain signing

**Negative:**

- Phase v1 requires us to operate a small PKI (Appstrate root key + publisher key signing) for the interim period
- Phase v2 depends on Sigstore infrastructure availability; the Sigstore community-run services have had past outages, and self-hosted Fulcio is non-trivial to run
- Verification code paths need to understand both formats during the transition

**Neutral:**

- Both primitives stay orthogonal to the runtime event protocol signing (HMAC Standard Webhooks, different trust model, different rotation cadence — see the architecture doc §10)
- This ADR does not mandate which publishing tools (CLI vs CI) a publisher must use — only the signature formats the runtime accepts
