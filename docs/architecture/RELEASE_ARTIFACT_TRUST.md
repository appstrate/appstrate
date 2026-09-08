# Release Artifact Trust — what is signed, attested and scanned

Status: active. Covers the artifacts `.github/workflows/release.yml` publishes on
a `v*` tag: eight container images on GHCR, four CLI binaries, two runner-daemon
binaries and the Firecracker guest artifacts.

Companion document, different question: `SUPPLY_CHAIN.md` is about the risk of a
single-vendor **source dependency** (the Pi SDK) and how it would be swapped out.
This one is about the **released artifacts** — how a consumer establishes that a
given image or binary came from this repository, what it is made of, and what is
known to be wrong with it.

## 1. The release matrix

`release.yml` publishes, from one tag:

| Artifact family    | What                                                                                | Platforms                     |
| ------------------ | ----------------------------------------------------------------------------------- | ----------------------------- |
| Container images   | `appstrate`, `appstrate-pi`, `appstrate-sidecar`, and five `appstrate-mcp-runner-*` | `linux/amd64` + `linux/arm64` |
| CLI binaries       | `appstrate-{darwin,linux}-{arm64,x64}`                                              | four native builds            |
| Runner daemon      | `appstrate-runner-{x86_64,aarch64}`                                                 | two native builds             |
| Firecracker guests | `vmlinux-<arch>`, `rootfs-<arch>.ext4.zst` + signed manifest                        | two arches                    |

The images are the part that runs customer workloads. Until 2026-09 they were
also the only family with no supply-chain controls at all: the binaries had
minisign-signed checksums and a SLSA attestation, the images had neither, no SBOM
and no vulnerability scan.

## 2. What each artifact carries

| Artifact           | Signed provenance                                                                     | SBOM                                       | Vulnerability scan                                                        | Checksums                          |
| ------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------- |
| Container images   | ✅ `actions/attest-build-provenance` over the index digest, pushed as an OCI referrer | ✅ BuildKit `sbom: true`, one per platform | ✅ Trivy, every release, SARIF to the Security tab                        | n/a (content-addressed)            |
| CLI binaries       | ✅ `actions/attest-build-provenance`                                                  | ❌                                         | ❌ (their dependency tree is covered by `bun run audit:deps` on every PR) | ✅ minisign-signed `checksums.txt` |
| Runner daemon      | ✅ folded into the CLI attestation + the same signed `checksums.txt`                  | ❌                                         | ❌                                                                        | ✅ same manifest                   |
| Firecracker guests | ✅ Ed25519-signed artifact manifest (`sign-firecracker-manifest.ts`)                  | ❌                                         | ❌                                                                        | ✅ sha256 in the manifest          |

The images additionally carry BuildKit's own SLSA provenance attestation
(`mode=max`, the default for a public repository), which `build-push-action` has
been attaching all along. It is useful build metadata — it names the resolved
base image — but it is **unsigned**: nothing cryptographically binds it to this
repository, and `gh attestation verify` does not read it. The signed statement is
the one from `actions/attest-build-provenance`.

## 3. Verifying an image

All three commands need to be able to pull from GHCR:

```sh
docker login ghcr.io          # any GitHub account; the packages are public
VER=1.0.0-beta.57             # the release you are checking, without the leading v
REF=ghcr.io/appstrate/appstrate:$VER
```

### Provenance — did this come from this repository's release workflow?

```sh
gh attestation verify "oci://$REF" --repo appstrate/appstrate
```

`--repo` is the minimum identity check. Tighten it to the exact workflow, which
is what you actually want to assert — that the image was built by the release
pipeline and not by some other workflow in the same repository:

```sh
gh attestation verify "oci://$REF" \
  --repo appstrate/appstrate \
  --signer-workflow appstrate/appstrate/.github/workflows/release.yml
```

By default `gh` fetches the attestation from the GitHub API. The bundle is also
pushed to GHCR as an OCI referrer, so a consumer with registry access but no
GitHub API access can use that copy instead:

```sh
gh attestation verify "oci://$REF" --repo appstrate/appstrate --bundle-from-oci
```

The attestation subject is the **image index** digest, so one verification covers
both platforms; there is no per-architecture attestation to check separately.

> Not cosign. Nothing in this workflow cosign-signs anything, so there is no
> cosign signature to verify. The attestation is a Sigstore bundle and cosign can
> be made to read it, but `gh attestation verify` is the supported path and the
> only one this repository tests against.

### SBOM — what is in it?

```sh
docker buildx imagetools inspect "$REF" --format '{{ json .SBOM }}'
```

Returns one SPDX document per platform (`linux/amd64`, `linux/arm64`), produced
inside the build by BuildKit's scanner. Before this was enabled the same command
printed `{}` — that is the check for whether a given release predates it.

For the raw manifests, including the `unknown/unknown` entries that hold the
attestations:

```sh
docker manifest inspect "$REF" | jq '.manifests[] | {platform, digest}'
```

The `unknown/unknown` entries are normal and expected — they are BuildKit
attestation manifests, not broken platforms. Releases before the SBOM was enabled
carry two (one provenance attestation per platform); releases after it carry four
(provenance + SBOM, per platform).

### Vulnerabilities — what is known to be wrong with it?

The per-release scan results are uploaded as SARIF, one analysis per image
(`trivy-image/<image>/`), and appear in this repository's **Security → Code
scanning** tab under the release tag's ref — filter by ref if the default branch
view looks empty. To reproduce locally:

```sh
trivy image --scanners vuln "$REF"
```

Note that trivy resolves a multi-arch index to the platform of the host it runs
on. The release scan runs on `ubuntu-latest`, so it reports `linux/amd64`; run the
command above on an arm64 host to see the other half.

## 4. Where the release is blocked, and where it is not

The scan runs in the `scan-images` job, after the images are pushed, and gates the
`release` job. Stated plainly, because it matters:

- A failing scan **blocks the GitHub Release** — the CLI binaries, the signed
  `checksums.txt`, the Firecracker manifest, and the release notes. Everything
  `bootstrap.sh` and `appstrate runner install` read.
- It does **not** un-publish the images. They are in GHCR by then, `:latest`
  included. Recovering means bumping the base image and cutting a new tag; this
  workflow has no `workflow_dispatch`, so there is no re-run path.

Scanning before the push would mean building every image twice inside the job
whose 90-minute ceiling already exists because a cold multi-arch build overran and
burnt a release tag. That trade was made deliberately in favour of the post-push
scan.

The failing set is narrow, and the reasoning is recorded next to the job in
`release.yml`: **OS-package CRITICALs that have a fixed version**. Everything else
Trivy finds — every severity, both package types, fixed and unfixed — is reported
as SARIF and does not block. The short version:

- The language layer inside the images (`node_modules`, Python) is already gated
  on every pull request by `bun run audit:deps` against `bun.lock`, which has the
  dated, bidirectionally-checked allowlist that a tag-triggered workflow cannot
  have.
- Vendored binaries are the residual gap: statically linked Go in the prebuilt
  `@esbuild/linux-x64` binaries carries stdlib CVEs that no npm advisory covers
  and no change in this repository fixes. Those are reported, never blocking.
- Unfixed findings cannot be acted on by anyone, so blocking a release on one
  would only mean waiting on a third party with no override.

Measured on 1.0.0-beta.57 (trivy 0.74.0, 2026-09-08): `appstrate` and
`appstrate-pi` carry 50 OS-package findings each with **0 critical** — worst case
four HIGH openssl CVEs, reported and not blocking. The node, python and binary MCP
runners carry **one fixable OS critical** (CVE-2026-31789, libcrypto3/libssl3
3.3.3-r0 → 3.3.7-r0), because `runtime-pi/runners/{node,python,binary}/Dockerfile`
still pin `alpine:3.21.3` while every other image moved to alpine 3.22.4. That is
the gate doing its job on its first real run, and the remedy is one line per file.

## 5. What is still not covered

- **`:latest` moves before the scan.** See §4.
- **Only `linux/amd64` is scanned.** Both halves come from the same base-image
  tag, so the OS package set — the only thing that can fail a release — is the
  same on either. What goes unreported is anything arch-specific in the language
  layer, chiefly the `@esbuild/linux-arm64` binary.
- **The CLI and daemon binaries are not scanned.** Their npm dependency tree is
  covered by `audit:deps`; the compiled Bun runtime inside them is not scanned by
  anything.
- **No SBOM for the binaries.** `actions/attest-build-provenance` records how they
  were built, not what is inside them.
- **The scan reads the image, not the running container.** Anything mounted or
  downloaded at run time is outside its view.
- **No image signature.** Provenance answers "who built this"; there is no
  separate cosign/notation signature, and adding one would need a key and a
  rotation story that this repository does not have today.

---

Supply-chain risk of the Pi SDK dependency → [`SUPPLY_CHAIN.md`](./SUPPLY_CHAIN.md) ·
Runtime security architecture → [`../../SECURITY.md`](../../SECURITY.md) ·
All architecture docs → [`README.md`](./README.md)
