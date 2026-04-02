// SPDX-License-Identifier: Apache-2.0

/** Map provider authMode to the uppercase label exposed in API responses. */
export function authModeLabel(authMode: string | undefined): string {
  switch (authMode) {
    case "api_key":
      return "API_KEY";
    case "oauth1":
      return "OAUTH1";
    default:
      return "OAUTH2";
  }
}
