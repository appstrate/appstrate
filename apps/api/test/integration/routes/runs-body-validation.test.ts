// SPDX-License-Identifier: Apache-2.0

/**
 * Launch-body validation across the launch surfaces (#1187).
 *
 * The agent route had no body schema at all: the body was read with
 * `c.req.json<RunRequestBody>()` — a cast, not a validation — so an unknown
 * field was dropped without a trace and a malformed body became `{}`. Both
 * produced a `201` and a run executing with parameters nobody asked for.
 *
 * Every negative case below is asserted WITHOUT `?version=draft` against a
 * never-published agent, whose control case is a `404`. That pins two things at
 * once: the body is refused (400, not 404), and it is refused BEFORE any
 * lookup — a body this surface cannot honour never reaches version resolution.
 * It also keeps these tests from firing a real run, whose background tail
 * would race the next `truncateAll()`.
 *
 * Each negative case pins the RFC-9457 `code` and the blamed `errors[].field`
 * through {@link expectRejectedField} rather than the bare status: a `400` on
 * this surface is reachable for reasons that have nothing to do with the schema
 * rule under test, so a status-only assertion would stay green after that rule
 * stopped firing.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { createTestContext, authHeaders, type TestContext } from "../../helpers/auth.ts";
import { seedPackage } from "../../helpers/seed.ts";
import { expectRejectedField } from "../../helpers/body-validation.ts";
import { installPackage } from "../../../src/services/application-packages.ts";

const app = getTestApp();

const AGENT = "@bodyorg/body-agent";

describe("POST /api/agents/:scope/:name/run — body validation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "bodyorg" });
    await seedPackage({ id: AGENT, orgId: ctx.orgId, createdBy: ctx.user.id });
    await installPackage({ orgId: ctx.orgId, applicationId: ctx.defaultAppId }, AGENT);
  });

  /** POST a raw body string — lets a malformed payload be sent verbatim. */
  async function raw(body: string) {
    return app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body,
    });
  }

  async function post(body: Record<string, unknown>) {
    return raw(JSON.stringify(body));
  }

  it("accepts an empty body — a run whose input resolves from stored values", async () => {
    // The control case for every 400 below: no body is still a valid launch,
    // so it travels past the schema and dies at version resolution instead
    // (never published + no `?version=draft` ≡ `published` → 404).
    const res = await app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: authHeaders(ctx),
    });
    expect(res.status).toBe(404);
  });

  it("rejects an unknown field with 400 instead of ignoring it", async () => {
    // `config` is the field #1179 removed from this body with no alias: a
    // caller pinned to the previous shape used to get a 201 and a run with
    // other parameters. The barrier is generic — it refuses any undeclared
    // field, and names none.
    const res = await post({ input: {}, config: { days: 30 } });
    await expectRejectedField(res, "body");
  });

  it("rejects a malformed JSON body with 400 instead of launching without input", async () => {
    // The one refusal on this surface that is NOT `validation_failed`: the body
    // never reaches the schema, so `readJsonBody` answers `invalid_request` with
    // no `errors[]`. Asserted by code rather than through
    // `expectRejectedField` — a malformed body that started answering
    // `validation_failed` would mean it HAD parsed, which is the opposite of
    // what this case covers.
    const res = await raw('{"input": {');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("invalid_request");
  });

  it("rejects a wrong-typed input with 400", async () => {
    const res = await post({ input: "not-an-object" });
    await expectRejectedField(res, "input");
  });

  it("rejects a non-string rerun_from with 400", async () => {
    const res = await post({ rerun_from: 42 });
    await expectRejectedField(res, "rerun_from");
  });

  it("rejects an empty connection_overrides value with 400", async () => {
    const res = await post({ input: {}, connection_overrides: { "@acme/gmail": "" } });
    await expectRejectedField(res, "connection_overrides.@acme/gmail");
  });

  it("reads the body behind an Idempotency-Key — the CLI's path", async () => {
    // The idempotency middleware consumes the body with `c.req.text()` and
    // re-injects a fresh Request. The schema now reads the body the same way
    // (`readJsonBody` + `allowEmpty` needs the raw text to tell an empty body
    // from a malformed one), where the parser used to call `c.req.json()`. A
    // body invisible behind that re-injection would read as empty and launch an
    // input-less run — silently, which is the whole failure this closes. The
    // CLI always sends a key, so this is the production path, not an edge.
    const res = await app.request(`/api/agents/${AGENT}/run`, {
      method: "POST",
      headers: {
        ...authHeaders(ctx),
        "Content-Type": "application/json",
        "Idempotency-Key": `cli_${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ input: {}, config: { days: 30 } }),
    });
    await expectRejectedField(res, "body");
  });

  it("accepts every declared field", async () => {
    // Same control as the empty body: a fully-populated legal body reaches
    // version resolution (404) rather than being refused by the schema.
    const res = await post({
      input: { topic: "ops" },
      modelId: "claude-sonnet-4",
      generation: { temperature: 0.2 },
      proxyId: "none",
      connection_overrides: { "@acme/gmail": "conn_1" },
      dependency_overrides: { "@acme/skill": "draft" },
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/runs/inline/validate — body validation", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "inlinebodyorg" });
  });

  function validManifest() {
    return {
      name: "@inline/body-check",
      display_name: "Ad-hoc Agent",
      version: "0.0.0",
      type: "agent",
      description: "Inline run",
      schema_version: "0.1",
      dependencies: { skills: {} },
    };
  }

  async function post(body: unknown) {
    return app.request("/api/runs/inline/validate", {
      method: "POST",
      headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("accepts a legal inline body (control)", async () => {
    const res = await post({ manifest: validManifest(), prompt: "do something" });
    expect(res.status).toBe(200);
  });

  it("rejects an unknown field with 400", async () => {
    const res = await post({ manifest: validManifest(), prompt: "do", nope: 1 });
    await expectRejectedField(res, "body");
  });

  it("rejects dependency_overrides — accepted and silently ignored before #1187", async () => {
    // The inline surface never forwarded this field to the pipeline
    // (`triggerInlineRun` does not read it), so a caller pinning a dependency
    // got a run that ignored the pin. Undeclared here means refused, not
    // ignored.
    const res = await post({
      manifest: validManifest(),
      prompt: "do",
      dependency_overrides: { "@acme/skill": "draft" },
    });
    await expectRejectedField(res, "body");
  });

  it("accepts `generation` — honoured on this surface, now documented too", async () => {
    const res = await post({
      manifest: validManifest(),
      prompt: "do",
      generation: { temperature: 0.2 },
    });
    expect(res.status).toBe(200);
  });
});
