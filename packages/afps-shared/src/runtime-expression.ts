// SPDX-License-Identifier: Apache-2.0

/**
 * The Arazzo runtime expressions (Arazzo §5.9) an AFPS `connect.login` block
 * names a part of the login response with: `$statusCode`, `$response.body`,
 * `$response.body#<json-pointer>` (RFC 6901) and `$response.header.<name>`.
 * The login engine (`@appstrate/connect`) and import validation
 * (`@appstrate/core/integration`) both parse through here, so a manifest is
 * refused at import exactly when the engine could not evaluate it.
 */

export type ResponseExpression =
  { kind: "status" } | { kind: "body"; pointer?: string } | { kind: "header"; name: string };

/** RFC 9110 `token` — a header field name. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function parseResponseExpression(expression: string): ResponseExpression | null {
  if (expression === "$statusCode") return { kind: "status" };
  if (expression === "$response.body") return { kind: "body" };
  if (expression.startsWith("$response.body#")) {
    const pointer = expression.slice("$response.body#".length);
    return pointer === "" || pointer.startsWith("/") ? { kind: "body", pointer } : null;
  }
  if (expression.startsWith("$response.header.")) {
    const name = expression.slice("$response.header.".length);
    return HEADER_NAME.test(name) ? { kind: "header", name } : null;
  }
  return null;
}

/** Whether `expression` names response text a regex runs on: the whole body or one header. */
export function isResponseTextExpression(expression: string): boolean {
  const parsed = parseResponseExpression(expression);
  return parsed?.kind === "header" || (parsed?.kind === "body" && parsed.pointer === undefined);
}
