// SPDX-License-Identifier: Apache-2.0

/**
 * Typed accessor for the Better Auth singleton's oauth-provider + jwt
 * endpoints. Better Auth does not export a public type for `auth.api`, so
 * the `as unknown as` cast lives here — localized, explicit about the
 * surface this module actually calls (4 methods), and easy to update if
 * Better Auth changes its shape.
 *
 * Consumers (`plugins.ts`, `routes.ts`) import `getOidcAuthApi()` and stay
 * strict on their own types — no ad-hoc casts elsewhere in the module.
 */

import type * as jose from "jose";
import { getAuth } from "@appstrate/db/auth";

interface SignInEmailArgs {
  body: { email: string; password: string; rememberMe?: boolean };
  headers: Headers;
  request?: Request;
  asResponse?: boolean;
}

interface SignUpEmailArgs {
  body: { email: string; password: string; name: string };
  headers: Headers;
  request?: Request;
  asResponse?: boolean;
}

interface OAuth2ConsentArgs {
  body: { accept: boolean; scope?: string; oauth_query?: string };
  headers: Headers;
  request?: Request;
  asResponse?: boolean;
}

interface SignInMagicLinkArgs {
  body: {
    email: string;
    callbackURL?: string;
    newUserCallbackURL?: string;
    errorCallbackURL?: string;
    name?: string;
  };
  headers: Headers;
  request?: Request;
  asResponse?: boolean;
}

interface RequestPasswordResetArgs {
  body: { email: string; redirectTo?: string };
  headers: Headers;
  request?: Request;
  asResponse?: boolean;
}

interface ResetPasswordArgs {
  body: { newPassword: string; token: string };
  headers: Headers;
  request?: Request;
  asResponse?: boolean;
}

interface DiscoveryArgs {
  headers: Headers;
}

interface JwksArgs {
  headers: Headers;
}

interface SignOutArgs {
  headers: Headers;
  request?: Request;
  asResponse?: boolean;
}

interface DeviceApproveDenyArgs {
  body: { userCode: string };
  headers: Headers;
  request?: Request;
  asResponse?: boolean;
}

interface DeviceVerifyArgs {
  query: { user_code: string };
  headers: Headers;
  request?: Request;
  asResponse?: boolean;
}

export interface OidcAuthApi {
  signInEmail(args: SignInEmailArgs): Promise<Response | unknown>;
  signUpEmail(args: SignUpEmailArgs): Promise<Response | unknown>;
  signInMagicLink(args: SignInMagicLinkArgs): Promise<Response | unknown>;
  requestPasswordReset(args: RequestPasswordResetArgs): Promise<Response | unknown>;
  resetPassword(args: ResetPasswordArgs): Promise<Response | unknown>;
  oauth2Consent(args: OAuth2ConsentArgs): Promise<Response | unknown>;
  signOut(args: SignOutArgs): Promise<Response | unknown>;
  getOpenIdConfig(args: DiscoveryArgs): Promise<unknown>;
  getOAuthServerConfig(args: DiscoveryArgs): Promise<unknown>;
  getJwks(args: JwksArgs): Promise<{ keys?: jose.JWK[] } | null>;
  deviceApprove(args: DeviceApproveDenyArgs): Promise<Response | unknown>;
  deviceDeny(args: DeviceApproveDenyArgs): Promise<Response | unknown>;
  deviceVerify(args: DeviceVerifyArgs): Promise<Response | unknown>;
}

export function getOidcAuthApi(): OidcAuthApi {
  const auth = getAuth() as unknown as { api: OidcAuthApi };
  return auth.api;
}
