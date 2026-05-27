// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `{$credential.<field>}` value-template renderer, re-exported from
 * the shared zero-dependency `@appstrate/afps-shared` package. The
 * `@appstrate/core/credential-template` public surface is preserved verbatim.
 *
 * See `@appstrate/afps-shared/credential-template` for the full contract.
 */

export {
  CREDENTIAL_REF,
  type RenderCredentialTemplateOptions,
  renderCredentialTemplate,
} from "@appstrate/afps-shared/credential-template";
