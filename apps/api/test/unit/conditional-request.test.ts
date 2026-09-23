// SPDX-License-Identifier: Apache-2.0

/**
 * RFC 9110 §13 conditional requests. `If-None-Match` (§13.1.2) is shared by the OpenAPI spec
 * route and the package file explorer. The two used to carry a copy each; these
 * cases are the union of what both relied on, plus the one parameter that made
 * them look different (`allowWildcard`).
 */

import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import type { ApiError } from "@appstrate/core/api-errors";
import { PgDialect } from "drizzle-orm/pg-core";
import { schedules } from "@appstrate/db/schema";
import {
  assertIfMatch,
  ifMatchWhere,
  ifNoneMatchSatisfied,
  setEtag,
  versionEtag,
} from "../../src/lib/conditional-request.ts";

describe("ifNoneMatchSatisfied", () => {
  it("rejects a missing or empty header", () => {
    expect(ifNoneMatchSatisfied(undefined, '"abc"')).toBe(false);
    expect(ifNoneMatchSatisfied("", '"abc"')).toBe(false);
  });

  it("matches an exact tag", () => {
    expect(ifNoneMatchSatisfied('"abc"', '"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('"other"', '"abc"')).toBe(false);
  });

  it("does not treat a substring as a match", () => {
    // The quotes are part of the comparison, so a prefix cannot pass.
    expect(ifNoneMatchSatisfied('"ab"', '"abc"')).toBe(false);
    expect(ifNoneMatchSatisfied('"abcd"', '"abc"')).toBe(false);
  });

  it("compares weakly — W/ on either side is the same tag", () => {
    expect(ifNoneMatchSatisfied('W/"abc"', '"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('"abc"', 'W/"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('W/"abc"', 'W/"abc"')).toBe(true);
    // Only a LEADING `W/` is a weakness marker.
    expect(ifNoneMatchSatisfied('"W/abc"', '"abc"')).toBe(false);
  });

  it("accepts any member of a comma-separated list, with surrounding spaces", () => {
    expect(ifNoneMatchSatisfied('"x", "abc" ,"y"', '"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('  W/"abc"  ', '"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('"x","y"', '"abc"')).toBe(false);
  });

  it("honours `*` by default, including inside a list", () => {
    expect(ifNoneMatchSatisfied("*", '"abc"')).toBe(true);
    expect(ifNoneMatchSatisfied('"x", *', '"abc"')).toBe(true);
  });

  it("refuses `*` under allowWildcard: false, without disabling real tags", () => {
    // The pre-read short-circuit on the file-content route: `*` means "if any
    // current representation exists", which the server cannot affirm before it
    // knows the path is in the artifact — answering 304 there would tell the
    // caller a file exists. A concrete tag still matches, because it proves the
    // client already got a 200 for that exact representation.
    expect(ifNoneMatchSatisfied("*", '"abc"', { allowWildcard: false })).toBe(false);
    expect(ifNoneMatchSatisfied('"x", *', '"abc"', { allowWildcard: false })).toBe(false);
    expect(ifNoneMatchSatisfied('"abc", *', '"abc"', { allowWildcard: false })).toBe(true);
    expect(ifNoneMatchSatisfied("*", '"abc"', { allowWildcard: true })).toBe(true);
    expect(ifNoneMatchSatisfied("*", '"abc"', {})).toBe(true);
  });
});

describe("versionEtag", () => {
  it("mints a strong tag from a counter or a timestamp, at millisecond precision", () => {
    expect(versionEtag(7)).toBe('"7"');
    const at = new Date("2026-09-23T10:00:00.123Z");
    expect(versionEtag(at)).toBe(`"${at.getTime()}"`);
    // The ISO string a DTO carries names the same version as the Date it came from.
    expect(versionEtag(at.toISOString())).toBe(versionEtag(at));
  });
});

describe("assertIfMatch", () => {
  // The evaluation sees the request's header and throws the refusal.
  async function evaluate(ifMatch: string | undefined, required = false) {
    const app = new Hono().patch("/", (c) => {
      try {
        assertIfMatch(c, 3, { required });
        setEtag(c, 4);
        return c.json({ status: 200 });
      } catch (err) {
        const e = err as ApiError;
        return c.json({ status: e.status, code: e.code, etag: e.headers?.ETag ?? null });
      }
    });
    const res = await app.request("/", {
      method: "PATCH",
      headers: ifMatch === undefined ? {} : { "If-Match": ifMatch },
    });
    const body = (await res.json()) as { status: number; code?: string; etag?: string | null };
    return { ...body, header: res.headers.get("ETag") };
  }

  it("passes on the current tag, `*`, or a list holding either", async () => {
    expect((await evaluate('"3"')).status).toBe(200);
    expect((await evaluate("*")).status).toBe(200);
    expect((await evaluate('"1", "3"')).status).toBe(200);
    expect((await evaluate('"3"')).header).toBe('"4"');
  });

  it("refuses a stale tag with 412, naming the current one", async () => {
    expect(await evaluate('"2"')).toMatchObject({
      status: 412,
      code: "precondition_failed",
      etag: '"3"',
    });
  });

  it("compares strongly: a weak tag never matches", async () => {
    expect((await evaluate('W/"3"')).status).toBe(412);
  });

  it("is a no-op without the header unless the route requires it (428)", async () => {
    expect((await evaluate(undefined)).status).toBe(200);
    expect(await evaluate(undefined, true)).toMatchObject({
      status: 428,
      code: "precondition_required",
    });
  });
});

describe("ifMatchWhere", () => {
  // The predicate the request's header yields, rendered as SQL (or undefined).
  async function predicate(ifMatch: string | undefined) {
    let where: ReturnType<typeof ifMatchWhere>;
    const app = new Hono().patch("/", (c) => {
      where = ifMatchWhere(c, schedules.updatedAt);
      return c.body(null, 204);
    });
    await app.request("/", {
      method: "PATCH",
      headers: ifMatch === undefined ? {} : { "If-Match": ifMatch },
    });
    return where && new PgDialect().sqlToQuery(where);
  }

  it("adds nothing without the header, or for `*`", async () => {
    expect(await predicate(undefined)).toBeUndefined();
    expect(await predicate('"1", *')).toBeUndefined();
  });

  it("compares the listed strong tags at the millisecond the ETag keeps", async () => {
    const query = (await predicate('"1767225600123", "7"'))!;
    expect(query.sql).toContain("floor(extract(epoch from");
    expect(query.params).toEqual(["1767225600123", "7"]);
  });

  it("matches nothing for weak or foreign tags", async () => {
    expect((await predicate('W/"1", "abc"'))!.sql).toBe("false");
  });
});
