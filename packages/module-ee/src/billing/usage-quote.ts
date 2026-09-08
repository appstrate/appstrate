/**
 * Usage quoting — the credit estimate for one admission attempt.
 *
 * The platform no longer decides which operations are free: it reports neutral
 * execution facts (`credentialSource`, `executionPlane`, `timeoutSeconds`) on
 * EVERY metered usage attempt, and this module turns those facts into an
 * estimated amount. Admission then gates on the amount, not on a boolean.
 *
 * Why that matters: the old rule was "platform-provided model ⇒ gate, else
 * skip", which hard-codes "BYOK ⇒ free". That is true only while platform
 * compute is unbilled. The moment compute is billed, a platform-hosted BYOK run
 * has `model = 0`, `compute > 0` and MUST be gated. Quoting the components
 * separately makes enabling that a rate change, not a topology change.
 *
 * `quoteUsage` is deliberately PURE — no DB, no clock, no module-scope config
 * read. Rates arrive as a parameter so a test can inject a non-zero compute
 * rate without `mock.module()` (banned repo-wide) and so the production rates
 * live in exactly one place (`DEFAULT_QUOTE_RATES` in `src/config.ts`). That
 * constraint is on the QUOTE, not on the file: `assertExecutionFacts` below logs
 * its refusal, because a refusal nobody can query is half of the failure mode
 * this module is trying to remove.
 */
import type { BeforeUsageParams } from "@appstrate/core/module";
import { platformVersionUnsupported } from "../http-errors.ts";
import { logger } from "../logger.ts";

/**
 * The `@appstrate/core` range this module declares in `peerDependencies`.
 * Logged with the refusal so an operator reads the fix off the event itself.
 */
const REQUIRED_CORE_RANGE = ">=10.0.0";

/** Per-component credit estimate for a single admission attempt. */
export interface UsageQuote {
  /** Credits estimated for inference paid with a platform-supplied credential. */
  modelCredits: number;
  /** Credits estimated for platform-funded compute time. */
  computeCredits: number;
  /** `modelCredits + computeCredits` — the figure admission gates on. */
  totalCredits: number;
}

/** Credit rates the quote is derived from. Injected, never read from scope. */
export interface QuoteRates {
  /** Model estimate per projected in-flight run. */
  modelCreditsPerRun: number;
  /** Model estimate per chat turn. */
  modelCreditsPerChatTurn: number;
  /** Compute estimate per second of a run's effective timeout. Phase 1: 0. */
  computeCreditsPerRunSecond: number;
  /** Compute estimate per chat turn. Phase 1: 0. */
  computeCreditsPerChatTurn: number;
}

/**
 * Refuse an admission whose execution facts are not values this module knows.
 *
 * `credentialSource` and `executionPlane` are declared REQUIRED on
 * `BeforeUsageParams` and have been since `@appstrate/core` 5.0.0 — four majors
 * below this module's declared floor (`peerDependencies` in package.json). The
 * platform enforces that floor at LOAD: its module loader reads this package's
 * own `@appstrate/core` range and refuses to boot when the core it ships does
 * not satisfy it. On a correctly configured deployment this function therefore
 * cannot fire.
 *
 * It exists anyway because that load gate has escapes — an operator can
 * downgrade it to a warning (`MODULE_CONTRACT_ENFORCE=warn`), and a platform
 * predating the gate never had it — and because a type is a compile-time
 * contract between two SEPARATELY DEPLOYED artifacts. Hence the deliberately
 * narrow cast to `unknown`: distrusting the fields the wire fills, not widening
 * the public contract.
 *
 * THROWING is the whole point, and it replaces an earlier "quote the worst case
 * instead" degrade. Substituting facts makes an unsupported platform WORK:
 * every customer is billed at worst-case rates for as long as the mismatch
 * lasts, with a log line per admission as the only signal — a wrong system that
 * looks like a working one. A throw refuses the operation instead (`callHook`
 * does not catch, so every seam fails closed on it). It mirrors the platform's
 * guard in the opposite direction — `checkUsageAllowed` throws on a caller built
 * against core < 6.0.0 rather than defaulting the flag it is missing — for the
 * same reason: a refused operation is visible and recoverable, a mispriced one
 * is neither.
 *
 * "Visible" is a property of the THROWN TYPE, not of throwing: an `ApiError` is
 * what the scheduler's catch, the HTTP error handler and the Pi SDK's retry rule
 * all read, and a bare `Error` degrades on each of the three. What each seam
 * does with this one, and why 409: `platformVersionUnsupported` in
 * `src/http-errors.ts`.
 *
 * `null` is NOT missing — it is a documented `credentialSource` value on the run
 * variant (a remote-origin run that resolves its model on its own host), so it
 * must pass. Validation is per-context because the chat variant's unions are
 * narrower (no `null` credential, `"platform"` plane only).
 */
export function assertExecutionFacts(params: BeforeUsageParams): void {
  const { credentialSource, executionPlane } = params as {
    credentialSource: unknown;
    executionPlane: unknown;
  };
  const usable =
    params.context === "run"
      ? (credentialSource === "system" ||
          credentialSource === "org" ||
          credentialSource === null) &&
        (executionPlane === "platform" || executionPlane === "remote")
      : (credentialSource === "system" || credentialSource === "org") &&
        executionPlane === "platform";
  if (usable) return;

  // The diagnosis is logged, STRUCTURED, at the point of refusal — never on the
  // wire (#50), and never only inside a message string. Two reasons it has to be
  // here and has to be fields:
  //
  //  - The values name what an operator filters a skewed deploy on. Interpolated
  //    into prose they survive but are not queryable, and the `detail` that would
  //    carry them is written verbatim onto a failed run row an org member reads.
  //  - Without it the only trace is the platform's generic
  //    `{ requestId, error, stack }` around the throw, which makes a permanent
  //    version mismatch indistinguishable from a genuine bug.
  logger.error("beforeUsage: unrecognized execution facts — refusing usage", {
    orgId: params.orgId,
    context: params.context,
    credentialSource,
    executionPlane,
    requiredCore: REQUIRED_CORE_RANGE,
    hint: "the execution facts landed in @appstrate/core 5.0.0 — check the platform version and the module deploy order",
  });

  throw platformVersionUnsupported();
}

/**
 * Normalize one raw component into integer credits.
 *
 * Rounds UP so a sub-credit rate (e.g. 0.001 credits/second over a 30s run)
 * never silently quotes zero and lets an operation through ungated. Clamps
 * non-finite and negative inputs to 0 defensively: a rate misconfigured to
 * `NaN`/`Infinity` (or a negative count arriving from a caller bug) must not
 * poison `totalCredits` — `NaN > remaining` is false, so an unclamped NaN would
 * silently ADMIT everything, which is the opposite of the fail-closed posture
 * the rest of the admission path takes.
 */
function toCredits(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.ceil(raw);
}

/**
 * Estimate the billable components of one operation.
 *
 * - `modelCredits` — non-zero only when a platform-supplied credential funds the
 *   inference (`credentialSource === "system"`). An org spending its OWN
 *   credential (BYOK key or OAuth subscription) costs the platform no model
 *   component. `null` (a remote-origin run that resolves its model elsewhere)
 *   is likewise unquotable here — if such a run later routes inference through
 *   the system model proxy, that seam dispatches its own admission where the
 *   fact IS known.
 * - `computeCredits` — non-zero only when the work runs on platform-funded
 *   compute (`executionPlane === "platform"`). A run additionally needs a
 *   `timeoutSeconds` upper bound to derive a duration estimate from; `null`
 *   means "this seam does not own the run's compute" and contributes ZERO. It
 *   must never be read as "unknown, assume the worst": the system-proxy seam
 *   passes `null` while admitting inference for an already-running run whose
 *   compute was quoted at its own preflight, so assuming the worst would
 *   double-count it.
 */
export function quoteUsage(params: BeforeUsageParams, rates: QuoteRates): UsageQuote {
  let rawModel = 0;
  let rawCompute = 0;

  if (params.credentialSource === "system") {
    // Runs multiply by the projected in-flight count (which INCLUDES the run
    // being admitted) — a pessimistic concurrent-overshoot guard, since the
    // soft cap cannot reserve. A chat turn is short-lived and single-shot, so
    // it carries no concurrency term.
    //
    // KNOWN OVER-QUOTE, deliberately deferred. `modelCreditsPerRun` is a
    // per-RUN rate, but the run variant is dispatched by two seams that meter
    // different units: the preflight gate admits one run LAUNCH (rate matches
    // the unit), while the system-proxy seam admits ONE raw `/api/llm-proxy`
    // CALL of an already-running run (`timeoutSeconds: null`). On that second
    // seam the per-run rate is charged per call, so an agent making many proxy
    // calls is quoted far above what it will actually consume — a soft cap that
    // over-gates, never under-gates. Fixing it needs a unit discriminant on
    // `BeforeUsageParams` (launch vs. call) so a per-call rate can be applied;
    // that is a core contract change and is intentionally NOT done here.
    rawModel =
      params.context === "run"
        ? rates.modelCreditsPerRun * params.runningCount
        : rates.modelCreditsPerChatTurn;
  }

  if (params.executionPlane === "platform") {
    if (params.context === "run") {
      // `null` ⇒ this seam does not own the run's compute — contribute nothing.
      rawCompute =
        params.timeoutSeconds === null
          ? 0
          : rates.computeCreditsPerRunSecond * params.timeoutSeconds;
    } else {
      rawCompute = rates.computeCreditsPerChatTurn;
    }
  }

  const modelCredits = toCredits(rawModel);
  const computeCredits = toCredits(rawCompute);

  return { modelCredits, computeCredits, totalCredits: modelCredits + computeCredits };
}
