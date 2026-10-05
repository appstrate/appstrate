// SPDX-License-Identifier: Apache-2.0

/**
 * The Arazzo runtime expressions (§5.9) of an AFPS `connect.login` block, and
 * {@link loginBlockIssues}: the one evaluability rule of the login engine
 * (`@appstrate/connect`) and of import validation (`@appstrate/core/integration`).
 */

import { parseCredentialRef, templateExpressions } from "./credential-template.ts";

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
function isResponseTextExpression(expression: string): boolean {
  const parsed = parseResponseExpression(expression);
  return parsed?.kind === "header" || (parsed?.kind === "body" && parsed.pointer === undefined);
}

/** The two operands a `simple` success criterion compares: the sides of its first `==`. */
export function simpleCriterionOperands(condition: string): [string, string] | null {
  const eq = condition.indexOf("==");
  return eq === -1 ? null : [condition.slice(0, eq).trim(), condition.slice(eq + 2).trim()];
}

/** The subset of an AFPS `connect.login` block {@link loginBlockIssues} reads. */
export interface LoginBlockView {
  request?: { url?: string; body?: string; headers?: Record<string, string> };
  outputs?: Record<string, unknown>;
  success_criteria?: readonly { condition?: string; type?: string; context?: string }[];
}

export interface LoginBlockIssue {
  message: string;
  /** Path inside the `connect.login` block. */
  path: (string | number)[];
}

const isJwtOutput = (o: unknown) => (o as { from?: unknown } | null)?.from === "jwt";

/** Every expression of a `connect.login` block the login engine cannot evaluate. */
export function loginBlockIssues(login: LoginBlockView): LoginBlockIssue[] {
  const issues: LoginBlockIssue[] = [];
  const request = login.request ?? {};
  const requestTemplates: [string | undefined, (string | number)[]][] = [
    [request.url, ["request", "url"]],
    [request.body, ["request", "body"]],
    ...Object.entries(request.headers ?? {}).map(([k, v]): [string, (string | number)[]] => [
      v,
      ["request", "headers", k],
    ]),
  ];
  for (const [template, path] of requestTemplates) {
    for (const expr of templateExpressions(template ?? "")) {
      issues.push({
        message: `'${expr}' is not evaluated in a login request; login inputs are {{name}}`,
        path,
      });
    }
  }

  const outputs = login.outputs ?? {};
  for (const [name, raw] of Object.entries(outputs)) {
    const at = ["outputs", name];
    const out = (raw ?? {}) as { from?: string; context?: string; token?: string; source?: string };
    if (typeof raw === "string") {
      if (!parseResponseExpression(raw)) {
        issues.push({ message: `unsupported runtime expression '${raw}'`, path: at });
      }
    } else if (out.from === undefined) {
      if (out.context !== "$response.body") {
        issues.push({
          message: `selector context '${out.context}' is not supported (only $response.body)`,
          path: [...at, "context"],
        });
      }
    } else if (out.from === "jwt") {
      const ref = parseCredentialRef(out.token ?? "");
      if (
        ref === null ||
        !Object.prototype.hasOwnProperty.call(outputs, ref) ||
        isJwtOutput(outputs[ref])
      ) {
        issues.push({
          message: `jwt token '${out.token}' must be {$credential.<output>} naming a non-jwt output`,
          path: [...at, "token"],
        });
      }
    } else if (out.from === "regex" && !isResponseTextExpression(out.source ?? "")) {
      issues.push({
        message: `regex source '${out.source}' must be $response.body or $response.header.<name>`,
        path: [...at, "source"],
      });
    }
  }

  (login.success_criteria ?? []).forEach((criterion, index) => {
    const path = ["success_criteria", index];
    const context = criterion.context ?? "$response.body";
    const type = criterion.type ?? "simple";
    if (type === "jsonpath" && context !== "$response.body") {
      issues.push({ message: `jsonpath context '${context}' is not supported`, path });
    } else if (type === "regex" && !isResponseTextExpression(context)) {
      issues.push({ message: `regex context '${context}' is not supported`, path });
    } else if (type === "simple") {
      for (const operand of simpleCriterionOperands(criterion.condition ?? "") ?? []) {
        if (operand.startsWith("$") && !parseResponseExpression(operand)) {
          issues.push({ message: `unsupported runtime expression '${operand}'`, path });
        }
      }
    }
  });
  return issues;
}
