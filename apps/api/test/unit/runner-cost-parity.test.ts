// SPDX-License-Identifier: Apache-2.0

/**
 * The `source="runner"` ledger row's `cost_usd` is computed server-side by
 * `resolveRunnerCost` (`run-launcher/appstrate-event-sink.ts`) from
 * `runs.model_cost` and the reported token counters, not taken from the `cost`
 * the Pi container sends. Both sides multiply the SAME rates — `MODEL_COST` is
 * `JSON.stringify(runs.model_cost)` — so the two numbers must agree or every
 * platform run is silently re-priced.
 *
 * `llm-proxy-usage-parity.test.ts` pins the two token NORMALISATIONS the same
 * way; this file pins the two COST formulas.
 */

import { describe, it, expect } from "bun:test";
import { computeTokenCost, type TokenCost } from "@appstrate/afps-runtime/runner";
import { modelCostSchema } from "@appstrate/core/module";
// The record the CONTAINER drives its pi-ai session with — the process whose
// `calculateCost` this file transcribes. Built here, not read as text.
import { parseRuntimeEnv, buildPiModelFromEnv } from "../../../../runtime-pi/env.ts";
// The REAL snake_case projection `installSessionBridge` applies to Pi's
// counters before the platform prices them. Imported from the source path
// rather than `@appstrate/runner-pi`, whose barrel lists only names read
// outside that package. Transcribing it here instead would make both sides of
// the parity read the same copy, and the comparison would hold under a
// cacheRead/cacheWrite swap in the code it is supposed to be pinning.
import { toReportedUsage } from "../../../../packages/runner-pi/src/pi-runner.ts";

/** Pi's own four counters, as `installSessionBridge` reads them off the SDK. */
interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * pi-ai's `calculateCost`, transcribed for the way the platform configures it.
 * The last test in this file asserts the transcription still matches the
 * installed library, statement by statement.
 *
 * Two of the library's branches are dropped, each pinned by its own test below:
 * `tiers` (the platform's `ModelCost` cannot carry them) and `cacheWrite1h`
 * (non-zero only under Anthropic long cache retention, which the model records
 * the platform builds refuse structurally).
 *
 * The container reaches this function through `runtime-pi`'s `parseModelCost`,
 * which defaults an absent `cacheRead`/`cacheWrite` to `0` — the same value
 * `computeTokenCost` substitutes — so an incompletely priced model is at parity
 * too.
 */
function piReference(usage: PiUsage, rates: Required<TokenCost>): number {
  const input = (rates.input / 1_000_000) * usage.input;
  const output = (rates.output / 1_000_000) * usage.output;
  const cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
  const cacheWrite = (rates.cacheWrite * usage.cacheWrite) / 1_000_000;
  return input + output + cacheRead + cacheWrite;
}

/**
 * Assert `source` contains a snippet, with every whitespace difference erased
 * on both sides.
 *
 * `dist/models.js` is a build output, so its spacing belongs to whichever
 * bundler the vendor happened to run — a minified release would fail all six
 * assertions below while every rate stayed exactly where it is. A canary that
 * cries on formatting is one the next upgrade learns to wave through, which is
 * the only way this one can fail at its job. Everything below the whitespace —
 * operators, operands, their order — is still pinned character for character,
 * and the snippets stay written the way the library writes them so a reader can
 * diff them against the source by eye.
 */
function whitespaceInsensitiveContains(source: string): (snippet: string) => void {
  const normalized = source.replace(/\s+/g, "");
  return (snippet) => {
    expect(normalized).toContain(snippet.replace(/\s+/g, ""));
  };
}

const cases: { name: string; usage: PiUsage; rates: Required<TokenCost> }[] = [
  {
    name: "Claude-class rates, all four buckets carrying tokens",
    usage: { input: 1_000_000, output: 200_000, cacheRead: 500_000, cacheWrite: 100_000 },
    rates: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    name: "no cache traffic at all",
    usage: { input: 12_345, output: 6_789, cacheRead: 0, cacheWrite: 0 },
    rates: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2.5 },
  },
  {
    name: "cache-heavy turn (reads dominate)",
    usage: { input: 900, output: 4_100, cacheRead: 3_800_000, cacheWrite: 42_000 },
    rates: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  },
  {
    name: "sub-cent totals — the common case, and the one float noise shows up in",
    usage: { input: 431, output: 97, cacheRead: 2_048, cacheWrite: 512 },
    rates: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0.35 },
  },
  {
    name: "model priced for input/output only (absent cache rates default to 0 on both sides)",
    usage: { input: 50_000, output: 10_000, cacheRead: 20_000, cacheWrite: 5_000 },
    rates: { input: 1.25, output: 5, cacheRead: 0, cacheWrite: 0 },
  },
];

describe("runner cost parity: server recompute vs pi-ai calculateCost (container)", () => {
  for (const { name, usage, rates } of cases) {
    it(`agrees to within float noise — ${name}`, () => {
      const server = computeTokenCost(toReportedUsage(usage), rates);
      const container = piReference(usage, rates);
      // Not `toBe`: the two sides associate the same four products differently
      // and can differ in the last representable bit. The tolerance is six
      // orders of magnitude tighter than the production divergence epsilon
      // (1e-6 USD), so it absorbs float noise and never a formula change.
      expect(server).toBeCloseTo(container, 12);
    });
  }

  it("an absent cache rate prices those tokens at zero on both sides", () => {
    // Divergence here would mean an incompletely priced model changes price —
    // the exact population `pricing_status='partial'` marks.
    const usage: PiUsage = { input: 1_000, output: 500, cacheRead: 9_000, cacheWrite: 3_000 };
    const partial: TokenCost = { input: 3, output: 15 };
    expect(computeTokenCost(toReportedUsage(usage), partial)).toBeCloseTo(
      piReference(usage, { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }),
      12,
    );
  });

  it("`ModelCost` structurally cannot carry volume tiers", () => {
    // Precondition for dropping the tier loop from `piReference`: `MODEL_COST`
    // is `JSON.stringify(runs.model_cost)`, read back through `modelCostSchema`,
    // which knows only the four rate keys. Add tiers to the catalog and the
    // container re-prices while the server does not — noticed here.
    const parsed = modelCostSchema.parse({
      input: 3,
      output: 15,
      tiers: [{ inputTokensAbove: 200_000, input: 6, output: 22.5 }],
    });
    expect(parsed).toEqual({ input: 3, output: 15 });
  });

  it("the model record the container drives REFUSES long cache retention", () => {
    // Precondition for dropping `cacheWrite1h` from `piReference`. pi-ai sets
    // that counter only from `cache_creation.ephemeral_1h_input_tokens`, which
    // Anthropic returns only for a request carrying `cache_control.ttl: "1h"`,
    // which pi-ai emits only when the MODEL RECORD does not refuse it:
    //
    //   const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
    //   supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
    //
    // That one flag is the WHOLE precondition, which is why this test asserts
    // it and nothing else. It holds for every `options.cacheRetention` value
    // and for every `PI_CACHE_RETENTION` in the environment — including one an
    // agent assigns to `process.env` from inside its own container, which no
    // check on what the PLATFORM injects could ever see. It also defaults to
    // TRUE, so the record has to refuse OUT LOUD; silence is consent.
    //
    // Asserted on the real builder, not on a hand-written record: this must
    // fail when `buildPiModelFromEnv` stops setting it. The sidecar's own
    // record (`buildBackingModel`, the aliased path, where pi-ai runs one
    // process to the left) carries the same flag, proven end-to-end against
    // real originated bytes in `runtime-pi/sidecar/test/pi-messages-backend.test.ts`.
    const model = buildPiModelFromEnv(
      parseRuntimeEnv({
        AGENT_RUN_ID: "run_parity",
        APPSTRATE_SINK_URL: "https://api.example.com/api/runs/run_parity/events",
        APPSTRATE_SINK_FINALIZE_URL: "https://api.example.com/api/runs/run_parity/events/finalize",
        APPSTRATE_SINK_SECRET: "abcdefghijklmnopqrstuvwxyz0123456789",
        MODEL_API: "anthropic-messages",
        MODEL_ID: "claude-sonnet-4-6",
        AGENT_PROMPT: "You are a helpful agent.",
      }),
    );
    // Asserted on the compat OBJECT, not `model.compat?.supportsLongCacheRetention`:
    // pi-ai types `compat` per API shape and `BedrockCompat` — one arm of that
    // union — declares no such key, so the property read does not typecheck on
    // a `Model<Api>`. `toMatchObject` states the same thing without a cast.
    expect(model.compat).toMatchObject({ supportsLongCacheRetention: false });
  });

  it("library formula unchanged — the transcription above still matches node_modules", async () => {
    // Anchors `piReference` to the installed library: a pi-ai upgrade that
    // re-prices any bucket fails HERE — re-read the source, re-transcribe,
    // re-check the recompute — instead of silently making the server's
    // authoritative number the wrong one.
    const source = await Bun.file(
      new URL("../../../../node_modules/@earendil-works/pi-ai/dist/models.js", import.meta.url),
    ).text();
    const contains = whitespaceInsensitiveContains(source);

    contains("usage.cost.input = (rates.input / 1000000) * usage.input;");
    contains("usage.cost.output = (rates.output / 1000000) * usage.output;");
    contains("usage.cost.cacheRead = (rates.cacheRead / 1000000) * usage.cacheRead;");
    contains(
      "usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000;",
    );
    // The two dropped branches, pinned by their source text so a library change
    // that makes either reachable by default is caught here.
    contains("for (const tier of model.cost.tiers ?? [])");
    contains("const longWrite = usage.cacheWrite1h ?? 0;");
  });
});
