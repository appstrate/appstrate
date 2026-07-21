// SPDX-License-Identifier: Apache-2.0

/**
 * `connect` — unified credential acquisition primitive (spec §4.1).
 *
 * Pure types shared by every acquisition strategy (OAuth2, Fields,
 * Login, Orchestrated). This module is import-cost-free: no DB, no Redis,
 * no sidecar — only the data contract that orchestration (apps/api) and the
 * sidecar executor consume.
 *
 * Persistence: `persistCredentialBundle` writes the v2 structured envelope
 * (`{ outputs, inputs }`, spec §4.6). The gating rule is single-shape: only
 * `outputs` is referenceable by `delivery.*`.
 */

/**
 * The terminal product of an acquisition (`complete`) or re-acquisition
 * (`reacquire`). The single convergence point: every strategy returns one of
 * these, and `persistCredentialBundle` is the only writer of the credential
 * columns it maps to.
 */
export interface CredentialBundle {
  /**
   * INJECTABLE material — access tokens, cookies, session ids. Only these
   * fields are referenceable by `delivery.{http,env,files}` (spec §4.6).
   * Maps to `credentials_encrypted.outputs` in the v2 envelope.
   */
  outputs: Record<string, string>;
  /**
   * Bootstrap secrets that are NOT injectable (e.g. the login password used to
   * re-bootstrap an expired session). Persisted only when
   * `connect.persistLoginSecret` is set; never readable by the injection path
   * nor the agent. Maps to `credentials_encrypted.inputs` (v2 envelope).
   */
  inputs?: Record<string, string>;
  /** Identity claims extracted from the acquisition → `identity_claims`. */
  identityClaims?: Record<string, string>;
  /** Scopes the upstream authoritatively granted → `scopes_granted`. */
  scopesGranted?: string[];
  /** Expiry of the acquired material → `expires_at`. `null` = durable. */
  expiresAt?: string | null;
}

export interface BrowserAcquisitionProof {
  readonly kind: string;
  readonly succeeded: true;
}

/** Secret-aware browser acquisition output before persistence. */
export interface BrowserAcquisitionResult extends CredentialBundle {
  readonly proof: BrowserAcquisitionProof;
}

export interface BrowserInteractionRequired {
  readonly kind: "otp" | "consent" | "captcha" | "manual";
  readonly interactionId: string;
  readonly expiresAt: string;
}
