// SPDX-License-Identifier: Apache-2.0

/**
 * The Arazzo runtime expressions (§5.9) of an AFPS `connect.login` block, and
 * {@link loginBlockIssues}: the one evaluability rule of the login engine
 * (`@appstrate/connect`) and of import validation (`@appstrate/core/integration`).
 */

import { parseCredentialRef, templateExpressions } from "./credential-template.ts";
import { JsonPathSyntaxError, parseJsonPath } from "./jsonpath.ts";
import { parseUrlTemplate } from "./connection-variables.ts";

export type ResponseExpression =
  { kind: "status" } | { kind: "body"; pointer?: string } | { kind: "header"; name: string };

/** RFC 9110 `token` — a header field name. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** An RFC 6901 JSON pointer: empty (the whole document), or `/`-prefixed tokens escaping `~`. */
const JSON_POINTER = /^(\/([^~/]|~[01])*)*$/;
const isJsonPointer = (pointer: string) => JSON_POINTER.test(pointer);

export function parseResponseExpression(expression: string): ResponseExpression | null {
  if (expression === "$statusCode") return { kind: "status" };
  if (expression === "$response.body") return { kind: "body" };
  if (expression.startsWith("$response.body#")) {
    const pointer = expression.slice("$response.body#".length);
    return isJsonPointer(pointer) ? { kind: "body", pointer } : null;
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

/** One side of a `simple` criterion: a response expression, or the literal it is compared with. */
export type SimpleOperand =
  | { kind: "expression"; expression: ResponseExpression }
  | { kind: "literal"; value: string | number | boolean | null };

/** Arazzo's single-quoted string (`''` is a quote), and a double-quoted one holding none. */
const SINGLE_QUOTED = "'(?:[^']|'')*'";
const DOUBLE_QUOTED = '"[^"]*"';
const QUOTED_LITERAL = new RegExp(`${SINGLE_QUOTED}|${DOUBLE_QUOTED}`, "g");
/** Outside a quoted literal: any `=` but the one `==`, and `!`, `<`, `>`, `&&`, `||`, `(`, `)`. */
const OTHER_OPERATOR = /[=!<>()]|&&|\|\|/;
const JSON_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;

/** Whether `text` is a JSON number (RFC 8259 §6): no `+`, leading zero, bare `.` or hex. */
export const isJsonNumber = (text: string): boolean => JSON_NUMBER.test(text);

function parseSimpleOperand(text: string): SimpleOperand | null {
  const literal = (value: string | number | boolean | null): SimpleOperand => ({
    kind: "literal",
    value,
  });
  if (text.startsWith("$")) {
    // A quote inside an expression would hide operator characters from the mask.
    if (/['"]/.test(text)) return null;
    const expression = parseResponseExpression(text);
    return expression && { kind: "expression", expression };
  }
  if (isJsonNumber(text)) return literal(Number(text));
  if (text === "true" || text === "false") return literal(text === "true");
  if (text === "null") return literal(null);
  if (new RegExp(`^${SINGLE_QUOTED}$`).test(text)) {
    return literal(text.slice(1, -1).replace(/''/g, "'"));
  }
  return new RegExp(`^${DOUBLE_QUOTED}$`).test(text) ? literal(text.slice(1, -1)) : null;
}

/**
 * The two operands of a `simple` success criterion in the one form the login engine evaluates:
 * `<expr> == <operand>` — exactly one `==`; no other `=`, `!`, `<`, `>`, `&&`, `||`, `(`, `)`
 * outside a quoted literal; each side a response expression or a literal (a JSON number, `true`,
 * `false`, `null`, a quoted string), at least one an expression. `null` for any other condition.
 */
export function simpleCriterionOperands(condition: string): [SimpleOperand, SimpleOperand] | null {
  const bare = condition.replace(QUOTED_LITERAL, (quoted) => " ".repeat(quoted.length));
  const eq = bare.indexOf("==");
  if (eq === -1) return null;
  const sides = [bare.slice(0, eq), bare.slice(eq + 2)];
  if (sides.some((side) => OTHER_OPERATOR.test(side))) return null;
  const lhs = parseSimpleOperand(condition.slice(0, eq).trim());
  const rhs = parseSimpleOperand(condition.slice(eq + 2).trim());
  if (!lhs || !rhs || (lhs.kind === "literal" && rhs.kind === "literal")) return null;
  return [lhs, rhs];
}

/** The SyntaxError message of a pattern JS cannot compile, or its number of capture groups. */
function regexCaptureGroups(pattern: string): number | string {
  let source: string;
  try {
    source = new RegExp(pattern).source;
  } catch (err) {
    return (err as Error).message;
  }
  // An empty alternative matches "", so the match holds one slot per capture group.
  return new RegExp(`(?:${source})|`).exec("")!.length - 1;
}

/**
 * Whether a `connect.login` output is an Arazzo Selector Object: a non-string output with no
 * `from`. The one classification of the import rule and the login engine.
 */
export function isSelectorOutput<T>(output: T): output is Exclude<T, string | { from: unknown }> {
  return typeof output !== "string" && (output as { from?: unknown } | null)?.from === undefined;
}

/** Whether a `connect.login` output is the `jwt` extractor. */
export const isJwtOutput = (output: unknown): boolean =>
  (output as { from?: unknown } | null)?.from === "jwt";

/** The Selector Object fields an extractor (an output with `from`) must not carry. */
const SELECTOR_FIELDS = ["context", "selector", "type"] as const;

/** The subset of an AFPS `connect.login` block {@link loginBlockIssues} reads. */
export interface LoginBlockView {
  request?: { url?: string; body?: string; headers?: Record<string, string> };
  outputs?: Record<string, unknown>;
  success_criteria?: readonly { condition?: string; type?: string; context?: string }[];
}

type IssuePath = (string | number)[];

export interface LoginBlockIssue {
  message: string;
  /** Path inside the `connect.login` block. */
  path: IssuePath;
}

/**
 * Every form of a `connect.login` block, as `integrationManifestSchema` accepts it, the login
 * engine cannot evaluate, or would only find wrong once the login request has been sent.
 */
export function loginBlockIssues(login: LoginBlockView): LoginBlockIssue[] {
  const issues: LoginBlockIssue[] = [];
  const report = (message: string, path: IssuePath) => issues.push({ message, path });
  const checkJsonPath = (query: string, path: IssuePath) => {
    try {
      parseJsonPath(query);
    } catch (err) {
      if (!(err instanceof JsonPathSyntaxError)) throw err;
      report(`${err.message} — supported: $, .name, ['name'], [0], [-1]`, path);
    }
  };

  const request = login.request ?? {};
  const requestTemplates: [string | undefined, IssuePath][] = [
    [request.url, ["request", "url"]],
    [request.body, ["request", "body"]],
    ...Object.entries(request.headers ?? {}).map(([k, v]): [string, IssuePath] => [
      v,
      ["request", "headers", k],
    ]),
  ];
  for (const [template, path] of requestTemplates) {
    // A login URL may be a URL template (§7.12): its variable is rendered before the login.
    if (template === request.url && template !== undefined && parseUrlTemplate(template)) continue;
    for (const expr of templateExpressions(template ?? "")) {
      report(`'${expr}' is not evaluated in a login request; login inputs are {{name}}`, path);
    }
  }

  const outputs = login.outputs ?? {};
  for (const [name, raw] of Object.entries(outputs)) {
    const at: IssuePath = ["outputs", name];
    // The engine collects outputs in plain objects, where this key would be dropped.
    if (name === "__proto__") report("an output cannot be named __proto__", at);
    const out = (raw ?? {}) as {
      from?: string;
      context?: string;
      type?: string;
      selector?: string;
      token?: string;
      path?: string;
      source?: string;
      pattern?: string;
      group?: number;
    };
    if (typeof raw === "string") {
      if (!parseResponseExpression(raw)) report(`unsupported runtime expression '${raw}'`, at);
    } else if (isSelectorOutput(raw)) {
      if (out.context !== "$response.body") {
        report(`selector context '${out.context}' is not supported (only $response.body)`, [
          ...at,
          "context",
        ]);
      }
      const selector = out.selector ?? "";
      if (out.type === "jsonpath") {
        checkJsonPath(selector, [...at, "selector"]);
      } else if (out.type !== "jsonpointer") {
        report(`selector type '${out.type}' is not supported (jsonpath or jsonpointer)`, [
          ...at,
          "type",
        ]);
      } else if (!isJsonPointer(selector)) {
        report(`jsonpointer selector '${selector}' is not a JSON pointer (/a/0, ~0 and ~1)`, [
          ...at,
          "selector",
        ]);
      }
    } else if (SELECTOR_FIELDS.some((field) => out[field] !== undefined)) {
      report("an output is a selector or an extractor: drop context/selector/type beside from", at);
    } else if (out.from === "jwt") {
      const ref = parseCredentialRef(out.token ?? "");
      if (
        ref === null ||
        !Object.prototype.hasOwnProperty.call(outputs, ref) ||
        isJwtOutput(outputs[ref])
      ) {
        report(`jwt token '${out.token}' must be {$credential.<output>} naming a non-jwt output`, [
          ...at,
          "token",
        ]);
      }
      if (!isJsonPointer(out.path ?? "")) {
        report(`jwt path '${out.path}' is not a JSON pointer (/a/0, ~0 and ~1)`, [...at, "path"]);
      }
    } else if (out.from === "regex") {
      if (!isResponseTextExpression(out.source ?? "")) {
        report(`regex source '${out.source}' must be $response.body or $response.header.<name>`, [
          ...at,
          "source",
        ]);
      }
      const groups = regexCaptureGroups(out.pattern ?? "");
      const group = out.group ?? 1;
      if (typeof groups === "string") {
        report(`regex pattern does not compile: ${groups}`, [...at, "pattern"]);
      } else if (group > groups) {
        report(`regex pattern has ${groups} capture group(s); group ${group} is never set`, [
          ...at,
          "pattern",
        ]);
      }
    }
  }

  (login.success_criteria ?? []).forEach((criterion, index) => {
    const path: IssuePath = ["success_criteria", index];
    const condition = criterion.condition ?? "";
    const context = criterion.context ?? "$response.body";
    const type = criterion.type ?? "simple";
    if (type === "jsonpath") {
      if (context !== "$response.body") {
        report(`jsonpath context '${context}' is not supported`, path);
      }
      checkJsonPath(condition, path);
    } else if (type === "regex") {
      if (!isResponseTextExpression(context)) {
        report(`regex context '${context}' is not supported`, path);
      }
      const groups = regexCaptureGroups(condition);
      if (typeof groups === "string") report(`regex condition does not compile: ${groups}`, path);
    } else if (type === "simple") {
      if (!simpleCriterionOperands(condition)) {
        const pointer = condition
          .match(/\$response\.body#[^\s=!<>()'"]*/g)
          ?.find((expr) => !parseResponseExpression(expr));
        report(
          pointer
            ? `'${pointer}' is not an RFC 6901 pointer (escape ~ as ~0, / as ~1)`
            : `simple criterion '${condition}' must be one '<expr> == <operand>' comparison, each side a runtime expression or a literal, at least one an expression; quote string literals ('ok')`,
          path,
        );
      }
    } else {
      report(`criterion type '${type}' is not supported`, [...path, "type"]);
    }
  });
  return issues;
}
