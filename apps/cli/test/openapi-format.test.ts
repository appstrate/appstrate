// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for `lib/openapi-format.ts` — pure (no I/O, no process,
 * no keyring). Exercises every filter predicate against the shared
 * fixture (`test/fixtures/openapi-fixture.json`) plus the text /
 * JSON formatters.
 *
 * The fixture covers:
 *   - multiple tags (runs, agents, legacy)
 *   - every HTTP method we care about
 *   - nested path params (`/api/runs/{id}`)
 *   - a deprecated op
 *   - $ref'd request / response schemas
 *
 * Tests are deterministic — we never run against the network. The
 * cache + command tests own integration coverage.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  collectOperations,
  filterOperations,
  findOperation,
  formatList,
  formatShow,
  matchesMethod,
  matchesPath,
  matchesSearch,
  matchesTag,
  toListJson,
} from "../src/lib/openapi-format.ts";
import type { OpenApiDocument } from "../src/lib/openapi-cache.ts";

const FIXTURE: OpenApiDocument = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures", "openapi-fixture.json"), "utf-8"),
) as OpenApiDocument;

describe("collectOperations", () => {
  it("flattens every path x method into a sorted list", () => {
    const ops = collectOperations(FIXTURE);
    const ids = ops.map((o) => `${o.method.toUpperCase()} ${o.path}`);
    expect(ids).toEqual([
      "GET /api/agents",
      "GET /api/agents/{id}",
      "PUT /api/agents/{id}",
      "GET /api/deprecated",
      "GET /api/runs",
      "POST /api/runs",
      "GET /api/runs/{id}",
      "DELETE /api/runs/{id}",
    ]);
  });

  it("returns an empty list when paths is missing or empty", () => {
    expect(collectOperations({} as OpenApiDocument)).toEqual([]);
    expect(collectOperations({ paths: {} } as OpenApiDocument)).toEqual([]);
  });

  it("ignores non-method siblings under a path (parameters, summary, servers)", () => {
    // Deliberately malformed path item: parameters / summary sit next
    // to a real `get` operation. collectOperations must yield only the
    // `get` entry.
    const doc = {
      paths: {
        "/x": {
          parameters: [{ name: "p", in: "query" }],
          summary: "path-level",
          get: { operationId: "gx", responses: { "200": { description: "OK" } } },
        },
      },
    } as unknown as OpenApiDocument;
    const ops = collectOperations(doc);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.method).toBe("get");
  });
});

describe("matchesTag", () => {
  const [run] = collectOperations(FIXTURE).filter((o) => o.op.operationId === "listRuns");
  if (!run) throw new Error("fixture drift: listRuns missing");

  it("matches exactly (case-insensitive)", () => {
    expect(matchesTag(run, "runs")).toBe(true);
    expect(matchesTag(run, "RUNS")).toBe(true);
    expect(matchesTag(run, "Runs")).toBe(true);
  });

  it("rejects unrelated tags", () => {
    expect(matchesTag(run, "agents")).toBe(false);
    expect(matchesTag(run, "")).toBe(true); // empty = no filter
  });

  it("treats undefined filter as no-op (matches all)", () => {
    expect(matchesTag(run, undefined)).toBe(true);
  });

  it("rejects operations without the tag array", () => {
    const noTags = { ...run, op: { ...run.op, tags: undefined } };
    expect(matchesTag(noTags, "runs")).toBe(false);
  });
});

describe("matchesMethod", () => {
  const [run] = collectOperations(FIXTURE).filter((o) => o.op.operationId === "listRuns");
  if (!run) throw new Error("fixture drift: listRuns missing");

  it("case-insensitive", () => {
    expect(matchesMethod(run, "get")).toBe(true);
    expect(matchesMethod(run, "GET")).toBe(true);
  });

  it("rejects non-matching methods", () => {
    expect(matchesMethod(run, "post")).toBe(false);
  });

  it("no filter matches all", () => {
    expect(matchesMethod(run, undefined)).toBe(true);
  });
});

describe("matchesPath (glob)", () => {
  const [listRuns] = collectOperations(FIXTURE).filter((o) => o.op.operationId === "listRuns");
  const [getRun] = collectOperations(FIXTURE).filter((o) => o.op.operationId === "getRun");
  if (!listRuns || !getRun) throw new Error("fixture drift");

  it("exact match only when no glob", () => {
    expect(matchesPath(listRuns, "/api/runs")).toBe(true);
    expect(matchesPath(getRun, "/api/runs")).toBe(false);
  });

  it("single-segment * match", () => {
    // /api/* matches /api/runs but not /api/runs/{id} (two segments deep)
    expect(matchesPath(listRuns, "/api/*")).toBe(true);
    expect(matchesPath(getRun, "/api/*")).toBe(false);
  });

  it("multi-segment ** match", () => {
    expect(matchesPath(getRun, "/api/**")).toBe(true);
    expect(matchesPath(listRuns, "/api/**")).toBe(true);
  });

  it("escapes regex metacharacters in the path", () => {
    // The `{id}` contains braces — must be treated literally, not as regex
    expect(matchesPath(getRun, "/api/runs/{id}")).toBe(true);
    expect(matchesPath(getRun, "/api/runs/*")).toBe(true);
  });

  it("no filter matches all", () => {
    expect(matchesPath(listRuns, undefined)).toBe(true);
  });
});

describe("matchesSearch", () => {
  const [listRuns] = collectOperations(FIXTURE).filter((o) => o.op.operationId === "listRuns");
  if (!listRuns) throw new Error("fixture drift");

  it("matches on operationId, case-insensitive", () => {
    expect(matchesSearch(listRuns, "listruns")).toBe(true);
    expect(matchesSearch(listRuns, "LISTRUNS")).toBe(true);
  });

  it("matches on summary", () => {
    expect(matchesSearch(listRuns, "list")).toBe(true);
  });

  it("matches on description", () => {
    expect(matchesSearch(listRuns, "current org")).toBe(true);
  });

  it("matches on path", () => {
    expect(matchesSearch(listRuns, "/api/runs")).toBe(true);
  });

  it("rejects non-matching queries", () => {
    expect(matchesSearch(listRuns, "agentx")).toBe(false);
  });

  it("no filter matches all", () => {
    expect(matchesSearch(listRuns, undefined)).toBe(true);
  });
});

describe("filterOperations", () => {
  it("composes all filters (AND semantics)", () => {
    const entries = collectOperations(FIXTURE);
    const out = filterOperations(entries, { tag: "runs", method: "post" });
    expect(out).toHaveLength(1);
    expect(out[0]!.op.operationId).toBe("createRun");
  });

  it("returns empty list when no filter matches", () => {
    const entries = collectOperations(FIXTURE);
    const out = filterOperations(entries, { tag: "nonexistent" });
    expect(out).toEqual([]);
  });

  it("returns all entries with no filters", () => {
    const entries = collectOperations(FIXTURE);
    const out = filterOperations(entries, {});
    expect(out.length).toBe(entries.length);
  });

  it("combines tag + path glob", () => {
    const entries = collectOperations(FIXTURE);
    const out = filterOperations(entries, { tag: "runs", path: "/api/runs/*" });
    expect(out.map((e) => e.op.operationId)).toEqual(["getRun", "cancelRun"]);
  });

  it("search filter respects case-insensitivity", () => {
    const entries = collectOperations(FIXTURE);
    const out = filterOperations(entries, { search: "AGENT" });
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((e) => (e.op.tags ?? []).includes("agents"))).toBe(true);
  });
});

describe("findOperation", () => {
  it("finds by operationId", () => {
    const entry = findOperation(FIXTURE, "createRun");
    expect(entry?.method).toBe("post");
    expect(entry?.path).toBe("/api/runs");
  });

  it("finds by METHOD path", () => {
    const entry = findOperation(FIXTURE, "GET", "/api/runs");
    expect(entry?.op.operationId).toBe("listRuns");
  });

  it("parses 'METHOD /path' from a single arg", () => {
    const entry = findOperation(FIXTURE, "DELETE /api/runs/{id}");
    expect(entry?.op.operationId).toBe("cancelRun");
  });

  it("returns null for unknown operationId", () => {
    expect(findOperation(FIXTURE, "doesNotExist")).toBeNull();
  });

  it("returns null when METHOD doesn't match path", () => {
    expect(findOperation(FIXTURE, "POST", "/api/runs/{id}")).toBeNull();
  });
});

describe("formatList", () => {
  it("emits one line per entry with plain output", () => {
    const ops = collectOperations(FIXTURE);
    const out = formatList(ops, false);
    const lines = out.trimEnd().split("\n");
    expect(lines).toHaveLength(ops.length);
    // Method is padded to 6 chars so paths line up — `GET   ` is 6 chars
    expect(lines[0]).toMatch(/^GET {4}/); // "GET" + 3 spaces + space separator (padEnd(6)) then space
    expect(lines.some((l) => l.includes("DELETE"))).toBe(true);
  });

  it("shows [deprecated] for deprecated operations", () => {
    const ops = collectOperations(FIXTURE);
    const out = formatList(ops, false);
    expect(out).toContain("[deprecated]");
  });

  it("shows tags in brackets", () => {
    const ops = collectOperations(FIXTURE).filter((o) => o.op.operationId === "createRun");
    const out = formatList(ops, false);
    expect(out).toContain("[runs]");
  });

  it("includes the summary with a dash separator", () => {
    const ops = collectOperations(FIXTURE).filter((o) => o.op.operationId === "createRun");
    expect(formatList(ops, false)).toContain("— Create a run");
  });

  it("friendly message when the filtered list is empty", () => {
    expect(formatList([], false)).toMatch(/No operations match/);
  });

  it("includes ANSI color codes when useColor=true", () => {
    const ops = collectOperations(FIXTURE).filter((o) => o.op.operationId === "createRun");
    const out = formatList(ops, true);
    expect(out).toContain("\x1b[");
  });

  it("omits ANSI color codes when useColor=false", () => {
    const ops = collectOperations(FIXTURE).filter((o) => o.op.operationId === "createRun");
    const out = formatList(ops, false);
    expect(out).not.toContain("\x1b[");
  });
});

describe("toListJson", () => {
  it("emits minimal stable shape", () => {
    const ops = collectOperations(FIXTURE).filter((o) => o.op.operationId === "createRun");
    const json = toListJson(ops);
    expect(json).toEqual([
      {
        method: "POST",
        path: "/api/runs",
        operationId: "createRun",
        summary: "Create a run",
        tags: ["runs"],
      },
    ]);
  });

  it("omits optional fields when absent", () => {
    const ops = collectOperations(FIXTURE).filter((o) => o.op.operationId === "listAgents");
    const json = toListJson(ops);
    expect(json[0]).toEqual({
      method: "GET",
      path: "/api/agents",
      operationId: "listAgents",
      summary: "List agents",
      tags: ["agents"],
    });
  });

  it("includes deprecated=true when set", () => {
    const ops = collectOperations(FIXTURE).filter((o) => o.op.operationId === "legacyThing");
    expect(toListJson(ops)[0]?.deprecated).toBe(true);
  });
});

describe("formatShow", () => {
  it("renders summary / description / parameters / responses", () => {
    const entry = findOperation(FIXTURE, "listRuns");
    if (!entry) throw new Error("fixture drift");
    const out = formatShow(entry, false);
    expect(out).toContain("GET /api/runs");
    expect(out).toContain("operationId: listRuns");
    expect(out).toContain("tags: runs");
    expect(out).toContain("List runs");
    expect(out).toContain("Parameters:");
    expect(out).toContain("query.limit");
    expect(out).toContain("Responses:");
    expect(out).toContain("200");
    expect(out).toContain("401");
    expect(out).toContain("application/json");
  });

  it("marks required parameters", () => {
    const entry = findOperation(FIXTURE, "getRun");
    if (!entry) throw new Error("fixture drift");
    const out = formatShow(entry, false);
    expect(out).toContain("path.id");
    expect(out).toContain("(required)");
  });

  it("renders request body section when present", () => {
    const entry = findOperation(FIXTURE, "createRun");
    if (!entry) throw new Error("fixture drift");
    const out = formatShow(entry, false);
    expect(out).toContain("Request body (required):");
    expect(out).toContain("application/json");
  });

  it("marks deprecated operations prominently", () => {
    const entry = findOperation(FIXTURE, "legacyThing");
    if (!entry) throw new Error("fixture drift");
    const out = formatShow(entry, false);
    expect(out).toContain("DEPRECATED");
  });

  it("handles operations with no parameters and no request body", () => {
    const entry = findOperation(FIXTURE, "listAgents");
    if (!entry) throw new Error("fixture drift");
    const out = formatShow(entry, false);
    expect(out).toContain("GET /api/agents");
    // No parameters section since the op has none
    expect(out).not.toContain("Parameters:");
  });
});
