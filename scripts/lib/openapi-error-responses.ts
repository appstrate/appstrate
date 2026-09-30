// SPDX-License-Identifier: Apache-2.0

/**
 * The error-body rule of `scripts/verify-openapi.ts` §6b (here so a test reaches it):
 * every 4xx/5xx/`default` response declares `application/problem+json` → `ProblemDetail`
 * (directly or as an `allOf` member, `$ref`s resolved), further media types allowed; an
 * exempted response declares its exemption's media type instead.
 */

const PROBLEM_MEDIA_TYPE = "application/problem+json";
const PROBLEM_DETAIL_REF = "#/components/schemas/ProblemDetail";
const OPERATION_VERBS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];
const ERROR_STATUS = /^([45](\d\d|XX)|default)$/;

type Node = Record<string, unknown>;

/**
 * Keyed `"VERB /path STATUS"` (one response) or `"VERB /path"` (every error
 * response of the operation), valued with the media type those responses
 * declare instead of `application/problem+json`.
 */
export type ErrorBodyExemptions = Readonly<Record<string, string>>;

export interface ErrorBodyReport {
  /** Error responses considered, exempted or not. */
  checked: number;
  /** `"VERB /path STATUS — reason"`, sorted. */
  gaps: string[];
  /** Exemption keys that excused no response, sorted. */
  stale: string[];
}

function resolveLocalRef(spec: Node, ref: string): Node | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = spec;
  for (const part of ref.slice(2).split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Node)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return current !== null && typeof current === "object" ? (current as Node) : undefined;
}

function isProblemDetail(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  const node = schema as Node;
  if (node.$ref === PROBLEM_DETAIL_REF) return true;
  return Array.isArray(node.allOf) && node.allOf.some((member) => isProblemDetail(member));
}

export function checkErrorResponseBodies(
  spec: unknown,
  exemptions: ErrorBodyExemptions,
): ErrorBodyReport {
  const root = spec as Node;
  const used = new Set<string>();
  const gaps: string[] = [];
  let checked = 0;

  for (const [path, pathItem] of Object.entries((root.paths ?? {}) as Record<string, Node>)) {
    for (const verb of OPERATION_VERBS) {
      const op = pathItem?.[verb] as Node | undefined;
      if (!op || typeof op !== "object") continue;
      const operationKey = `${verb.toUpperCase()} ${path}`;
      for (const [status, raw] of Object.entries((op.responses ?? {}) as Record<string, Node>)) {
        if (!ERROR_STATUS.test(status)) continue;
        checked++;
        const key = `${operationKey} ${status}`;
        const response = typeof raw?.$ref === "string" ? resolveLocalRef(root, raw.$ref) : raw;
        if (!response) {
          gaps.push(`${key} — unresolvable $ref ${String(raw?.$ref)}`);
          continue;
        }
        const content = (response.content ?? {}) as Record<string, Node | undefined>;
        const problem = content[PROBLEM_MEDIA_TYPE];
        if (problem && isProblemDetail(problem.schema)) continue;

        const exemptKey =
          key in exemptions ? key : operationKey in exemptions ? operationKey : null;
        if (exemptKey !== null && exemptions[exemptKey]! in content) {
          used.add(exemptKey);
          continue;
        }
        const declared = Object.keys(content);
        gaps.push(
          `${key} — ` +
            (problem
              ? `${PROBLEM_MEDIA_TYPE} schema is not ProblemDetail`
              : declared.length === 0
                ? "declares no body"
                : `declares ${declared.join(", ")}`) +
            (exemptKey !== null ? ` (exempted as ${exemptions[exemptKey]})` : ""),
        );
      }
    }
  }

  const stale = Object.keys(exemptions)
    .filter((key) => !used.has(key))
    .sort();
  return { checked, gaps: gaps.sort(), stale };
}
