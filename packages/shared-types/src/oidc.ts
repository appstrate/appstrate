// SPDX-License-Identifier: Apache-2.0

/**
 * Public wire types for the OIDC module's per-space auth config —
 * shared between the API service layer, OpenAPI schemas, and the frontend.
 * Defined here (not in `apps/api/src/modules/oidc`) because the frontend
 * cannot cross the module boundary to import from the API.
 *
 * Wire shape for `/api/spaces/:id/smtp-config` and
 * `/api/spaces/:id/social-providers/:provider`.
 */

export type SocialProviderId = "google" | "github";

export interface SmtpConfigView {
  spaceId: string;
  host: string;
  port: number;
  username: string;
  fromAddress: string;
  fromName: string | null;
  secureMode: "auto" | "tls" | "starttls" | "none";
  createdAt: string;
  updatedAt: string;
}

export interface SocialProviderView {
  spaceId: string;
  provider: SocialProviderId;
  clientId: string;
  scopes: string[] | null;
  createdAt: string;
  updatedAt: string;
}
