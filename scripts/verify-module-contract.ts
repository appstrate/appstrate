/**
 * Verify the module contract (`@appstrate/core/module`) stays minimal — no
 * dead members, no single-owner business extension points smuggled into a
 * published interface.
 *
 * Origin: issue #488 ("le contrat a grossi sous la pression d'un module —
 * chat — qui est en réalité une application"). #577 removed the 3 dead
 * members by hand. This check makes that pressure mechanical so the next
 * "chat" cannot regrow the surface unnoticed.
 *
 * FOUR surfaces are audited, because "the contract" is not just
 * `AppstrateModule`: hook names, event names and `PlatformServices` members are
 * where dead surface actually accumulated (an audit found `PlatformServices`
 * grown to 10 members, plus two contract members with zero implementers).
 *
 * The primary gate is the COMPILE gate: every ledger below is typed
 * `Record<…Member, …>`, so adding a member / hook / event / capability fails
 * `tsc` until the author files a ledger entry naming its owners. That review is
 * what stops the next "chat" from regrowing the surface silently.
 *
 * On top of it, two runtime policies:
 *
 *   `AppstrateModule` members are classified, and a best-effort source scan
 *   warns when the ledger and reality drift apart:
 *     - `extension`  — generic point. Justified iff >= 2 independent owners.
 *                      Single-owner extension → it belongs to the owner module.
 *     - `seam`       — layering decoupler. Single-owner is legal BY DESIGN
 *                      (removing it would force a lower/sibling layer to import
 *                      the owner module — e.g. @appstrate/db importing oidc).
 *                      Requires a written justification in the ledger.
 *     - `lifecycle`  — universal plumbing (init/manifest/shutdown). Exempt.
 *
 *   Hook / event names and `PlatformServices` members: ZERO owners is dead
 *   surface and FAILS — a hook nobody implements, or a capability nobody calls,
 *   is published API with no user. ONE owner is legal and common here (an
 *   admission gate has one authority), so the ">= 2 owners" rule does NOT
 *   transfer; the rationale for each of these lives in the JSDoc on the member
 *   itself, not duplicated here.
 *
 * Private repos absent in CI (cloud) never cause failure: the ledger records
 * their expected ownership, and the scanner only *adds* drift when a present
 * module declares a member the ledger did not expect.
 *
 * Override via env: `MODULE_CONTRACT_POLICY=warn|fail|off`.
 */

import type {
  AppstrateModule,
  ModuleEvents,
  ModuleHooks,
  PlatformServices,
} from "@appstrate/core/module";
import { Glob } from "bun";
import { resolve, dirname } from "node:path";

// Default-secure (`fail`). The `MODULE_CONTRACT_POLICY` downgrade exists for
// local iteration only — under CI it is ignored so a green pipeline can never
// be bought with `MODULE_CONTRACT_POLICY=off`.
const POLICY = process.env.CI
  ? "fail"
  : ((process.env.MODULE_CONTRACT_POLICY ?? "fail") as "warn" | "fail" | "off");
const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");
const WORKSPACE = resolve(ROOT, "..");

/**
 * The ONLY members allowed to carry `kind: "lifecycle"` (universal plumbing,
 * exempt from the owner-count + scan-drift policy). Pinning this prevents the
 * bypass where a real extension member is relabeled `lifecycle` with empty
 * owners to skip every hard check while still satisfying the compile gate.
 */
const LIFECYCLE_ALLOWLIST = new Set<string>(["shutdown"]);

/**
 * Every member of `AppstrateModule` except the required lifecycle pair
 * (`manifest`/`init`, always present). Derived from `keyof` — this is the
 * compile gate: add a member to the interface and `tsc` fails on the
 * `satisfies Record<ContractMember, …>` below until a ledger entry (with its
 * justification) is filed. That review is what stops the next "chat" from
 * regrowing the contract silently.
 */
type ContractMember = Exclude<keyof AppstrateModule, "manifest" | "init">;
/** Individual hook names — a finer grain than the `hooks` contract member. */
type HookMember = keyof ModuleHooks;
/** Individual event names — a finer grain than the `events` contract member. */
type EventMember = keyof ModuleEvents;
/** Capabilities the platform injects — what a module CONSUMES, not declares. */
type ServiceMember = keyof PlatformServices;

type Tenant = "oss" | "cloud";
type Classification = "extension" | "seam" | "lifecycle";

interface LedgerEntry {
  kind: Classification;
  /** Module ids expected to declare this member. */
  owners: string[];
  /** Required for `seam` (single-owner) and for any `extension` that looks borderline. */
  justification?: string;
}

/**
 * Ledger entry for a surface where the razor is "zero owners is dead" and
 * single ownership is legitimate — hook/event names and `PlatformServices`
 * members. Owners only: the compile gate forces the entry to exist, and why the
 * point earns its keep is documented on the member's own JSDoc.
 */
interface NamedLedgerEntry {
  /** Module ids expected to handle (hooks/events) or consume (services) this. */
  owners: string[];
}

/** Which license tenant each known module belongs to. */
const MODULE_TENANT: Record<string, Tenant> = {
  oidc: "oss",
  webhooks: "oss",
  mcp: "oss",
  "core-providers": "oss",
  firecracker: "oss",
  "module-codex": "oss",
  "module-claude-code": "oss",
  "module-chat": "oss",
  "module-observability": "oss",
  cloud: "cloud",
};

/**
 * Module source roots to scan. A module's contract members are frequently
 * split across files (cloud declares `openApiPaths` in `openapi.ts`, oidc
 * declares `events`/`hooks` in sub-modules re-exported into the literal), so
 * we scan the whole tree, not just `index.ts`. Paths relative to the
 * workspace root; absent roots (private repos in CI) are skipped silently.
 */
const DECLARER_ROOTS: Record<string, string> = {
  oidc: "appstrate/apps/api/src/modules/oidc",
  webhooks: "appstrate/apps/api/src/modules/webhooks",
  mcp: "appstrate/apps/api/src/modules/mcp",
  "core-providers": "appstrate/apps/api/src/modules/core-providers",
  firecracker: "appstrate/apps/api/src/modules/firecracker",
  "module-codex": "appstrate/packages/module-codex/src",
  "module-claude-code": "appstrate/packages/module-claude-code/src",
  "module-chat": "appstrate/packages/module-chat/src",
  "module-observability": "appstrate/packages/module-observability/src",
  cloud: "cloud/src",
};

const LEDGER: Record<ContractMember, LedgerEntry> = {
  // ── lifecycle — exempt ──────────────────────────────────────────────────
  shutdown: { kind: "lifecycle", owners: [] },

  // ── extension — generic, must have >= 2 owners ──────────────────────────
  createRouter: { kind: "extension", owners: ["oidc", "webhooks", "cloud", "module-chat"] },
  publicPaths: { kind: "extension", owners: ["oidc", "cloud"] },
  permissionsContribution: {
    kind: "extension",
    owners: ["oidc", "webhooks", "cloud", "module-chat"],
    justification: "RBAC — the open-core boundary; cloud cannot migrate it into core (#488).",
  },
  hooks: {
    kind: "extension",
    owners: ["oidc", "cloud", "module-codex", "module-claude-code"],
  },
  events: { kind: "extension", owners: ["webhooks", "cloud"] },
  features: { kind: "extension", owners: ["oidc", "webhooks", "cloud", "module-chat"] },
  modelProviders: {
    kind: "extension",
    owners: ["core-providers", "module-codex", "module-claude-code"],
    justification:
      "Provider registry stays module-owned: subscription providers live outside core while core-providers holds the built-in API-key catalog.",
  },
  openApiPaths: { kind: "extension", owners: ["oidc", "webhooks", "cloud", "module-chat"] },
  openApiComponentSchemas: {
    kind: "extension",
    owners: ["oidc", "webhooks", "cloud", "module-chat"],
  },
  openApiTags: { kind: "extension", owners: ["oidc", "webhooks", "cloud", "module-chat"] },
  openApiSchemas: {
    kind: "extension",
    owners: ["oidc", "webhooks", "module-chat"],
    justification:
      "Zod/OpenAPI parity is tied to each module's routes; centralizing these schemas would make the platform import module-private request shapes.",
  },

  // Generic extension: two independent owners (oidc's end-user JWT + module-chat's
  // process-local loopback bearer) prove the auth pipeline stays module-agnostic.
  authStrategies: {
    kind: "extension",
    owners: ["oidc", "module-chat"],
    justification:
      "Auth pipeline (lib/auth-pipeline.ts) must stay module-agnostic; direct import would name oidc. " +
      "module-chat adds its process-local loopback bearer strategy through the same seam.",
  },
  betterAuthPlugins: {
    kind: "seam",
    owners: ["oidc"],
    justification:
      "@appstrate/db/auth.ts builds the auth instance below the module layer; cannot import oidc.",
  },
  appConfigContribution: {
    kind: "seam",
    owners: ["oidc"],
    justification:
      "Structured (non-boolean) injection into core buildAppConfig(); features holds booleans only.",
  },
  orchestrators: {
    kind: "seam",
    owners: ["firecracker"],
    justification:
      "Execution backends beyond core docker/process plug into the orchestrator registry — " +
      "firecracker is the reference (and only) contributor; core stays free of KVM/Linux code.",
  },
  emailOverrides: {
    kind: "seam",
    owners: ["cloud"],
    justification:
      "Email-template override into @appstrate/emails registry — cloud branding, single-owner by design.",
  },
} satisfies Record<ContractMember, LedgerEntry>;

/**
 * Hook names. The `hooks` entry above only proves SOMEBODY declares a hooks
 * block; it cannot see that a specific hook has no implementer. `afterRun`
 * lived here for a full release cycle with zero implementers while the
 * platform maintained its whole call path.
 */
const HOOK_LEDGER: Record<HookMember, NamedLedgerEntry> = {
  beforeUsage: { owners: ["cloud"] },
  beforeSignup: { owners: ["oidc"] },
  afterSignup: { owners: ["oidc"] },
};

/**
 * Event names. Same rationale as {@link HOOK_LEDGER}: the `events` contract
 * member cannot see an individual event with no listener. `onUsageRecorded`
 * was emitted on every ledger write and listened to by nobody.
 */
const EVENT_LEDGER: Record<EventMember, NamedLedgerEntry> = {
  onRunStatusChange: { owners: ["webhooks"] },
  onRunConnectionMissing: { owners: ["webhooks"] },
  onOrgCreate: { owners: ["mcp", "cloud"] },
  onOrgDelete: { owners: ["mcp", "cloud"] },
};

/**
 * `PlatformServices` — capabilities the platform INJECTS. The razor bites
 * hardest here: this is the surface an application-shaped module grows when it
 * cannot reach the database, and it is invisible to the `AppstrateModule`
 * ledger. Single-consumer entries are legal; the member's own JSDoc says WHY the
 * consumer cannot obtain the capability any other way.
 */
const SERVICE_LEDGER: Record<ServiceMember, NamedLedgerEntry> = {
  logger: { owners: ["module-observability"] },
  http: { owners: ["module-chat", "module-observability"] },
  usage: { owners: ["cloud"] },
  inProcess: { owners: ["module-chat"] },
  resolveSubscriptionChatModel: { owners: ["module-chat"] },
  recordChatUsage: { owners: ["module-chat"] },
  resolveChatAttachment: { owners: ["module-chat"] },
  cleanupSessionDocuments: { owners: ["module-chat"] },
  checkUsageAllowed: { owners: ["module-chat"] },
  setDocumentStorageLimit: { owners: ["cloud"] },
};

/**
 * Detect a top-level object-literal member declaration on its own indented
 * line: `member:` (value), `member(` (method), or `member,` (ES shorthand —
 * how cloud declares `openApiPaths,`/`openApiTags,`). The scan is best-effort
 * (warnings only), so a stray false positive is a nudge, not a gate.
 */
function declaresMember(source: string, member: string): boolean {
  return new RegExp(`(^|\\n)\\s+(async\\s+)?${member}\\s*[:(,]`).test(source);
}

async function moduleIsPresent(root: string): Promise<boolean> {
  return Bun.file(resolve(WORKSPACE, root, "index.ts")).exists();
}

async function scanDeclarers(): Promise<{
  observed: Map<string, Set<string>>;
  present: Set<string>;
}> {
  const memberKeys = Object.keys(LEDGER);
  const observed = new Map(memberKeys.map((k) => [k, new Set<string>()]));
  const present = new Set<string>();

  for (const [moduleId, root] of Object.entries(DECLARER_ROOTS)) {
    const absRoot = resolve(WORKSPACE, root);
    if (!(await moduleIsPresent(root))) continue; // private repo absent in CI — ledger covers it
    present.add(moduleId);

    const glob = new Glob("**/*.ts");
    for await (const rel of glob.scan({ cwd: absRoot })) {
      if (rel.includes("/test/") || rel.startsWith("test/") || rel.endsWith(".test.ts")) continue;
      const source = await Bun.file(resolve(absRoot, rel)).text();
      for (const member of memberKeys) {
        if (declaresMember(source, member)) observed.get(member)!.add(moduleId);
      }
    }
  }
  return { observed, present };
}

const problems: string[] = []; // hard failures — derived from the reviewed ledger
const warnings: string[] = []; // soft hints — derived from the best-effort source scan

const { observed, present: presentModules } = await scanDeclarers();

for (const [member, entry] of Object.entries(LEDGER) as [ContractMember, LedgerEntry][]) {
  // ── Lifecycle is the broadest exemption (skips owner-count + scan-drift),
  //    so guard which members may claim it. Anything outside the allowlist
  //    must be a real extension/seam and earn its keep. ──
  if (entry.kind === "lifecycle" && !LIFECYCLE_ALLOWLIST.has(member)) {
    problems.push(
      `illegal lifecycle: \`${member}\` is classified \`lifecycle\` but only ` +
        `${[...LIFECYCLE_ALLOWLIST].map((m) => `\`${m}\``).join(", ")} may be. ` +
        `Reclassify as \`extension\` (>= 2 owners) or \`seam\` (justified single-owner).`,
    );
  }

  // ── Ledger policy (hard) — the ledger is the reviewed source of truth ──
  if (entry.kind === "extension") {
    const ownerCount = entry.owners.length;
    if (ownerCount === 0) {
      problems.push(
        `dead: \`${member}\` has 0 owners in the ledger. ` +
          `Remove it from the interface + its loader machinery (cf. #577).`,
      );
    } else if (ownerCount === 1) {
      problems.push(
        `single-owner extension: \`${member}\` is owned only by \`${entry.owners[0]}\`. ` +
          `Internalize it into that module, or reclassify as \`seam\` with a justification.`,
      );
    } else {
      const tenants = new Set(entry.owners.map((o) => MODULE_TENANT[o] ?? "oss"));
      if (tenants.size < 2 && !entry.justification) {
        warnings.push(
          `\`${member}\` has ${ownerCount} owners but all in one license tenant (${[...tenants][0]}). ` +
            `Fine today; becomes single-owner if those owners consolidate.`,
        );
      }
    }
  }

  if (entry.kind === "seam") {
    if (!entry.justification) {
      problems.push(
        `seam \`${member}\` is missing a justification — every seam must document why removing it breaks layering.`,
      );
    }
    if (entry.owners.length > 1) {
      warnings.push(
        `\`${member}\` is classified \`seam\` but the ledger lists ${entry.owners.length} owners — ` +
          `promote it to \`extension\` (it earned a generic point).`,
      );
    }
  }

  // ── Scan drift (soft) — assistive only; the scan can't see members
  //    assembled dynamically, so disagreement is a nudge, not a gate.
  //    Lifecycle members (shutdown) are universal plumbing — their owner
  //    list is intentionally empty, so drift-policing them is pure noise. ──
  if (entry.kind === "lifecycle") continue;
  reportScanDrift("LEDGER", member, entry.owners, observed.get(member)!);
}

/**
 * Apply the "zero owners is dead" policy to a name-keyed surface (hooks,
 * events, `PlatformServices`). `surface` names the interface to clean up when a
 * name goes dead — removing a name means removing its whole path (dispatch /
 * emit sites, params types, `registry.ts` wiring), not just the declaration.
 */
function auditNamedSurface(
  ledgerName: string,
  ledger: Record<string, NamedLedgerEntry>,
  surface: string,
): void {
  for (const [name, entry] of Object.entries(ledger)) {
    if (entry.owners.length === 0) {
      problems.push(
        `dead: \`${name}\` has no owner in ${ledgerName}. Remove it from ${surface} AND its ` +
          `whole path (call/emit sites, params types, platform wiring).`,
      );
    }
  }
}

/**
 * Scan drift (soft) — assistive only; the scan can't see members assembled
 * dynamically, nor modules whose repo is absent (cloud in CI), so disagreement
 * is a nudge, not a gate.
 */
function reportScanDrift(
  ledgerName: string,
  name: string,
  owners: string[],
  seen: Set<string>,
): void {
  const ledgerOwners = new Set(owners);
  for (const mod of seen) {
    if (!ledgerOwners.has(mod)) {
      warnings.push(
        `scan: \`${name}\` appears used by \`${mod}\`, not in ledger owners — verify and update ${ledgerName}.${name}.owners.`,
      );
    }
  }
  for (const mod of ledgerOwners) {
    if (presentModules.has(mod) && !seen.has(mod)) {
      warnings.push(
        `scan: ${ledgerName} lists \`${mod}\` for \`${name}\` but the scan didn't find it — verify it's still there.`,
      );
    }
  }
}

auditNamedSurface("HOOK_LEDGER", HOOK_LEDGER, "ModuleHooks");
auditNamedSurface("EVENT_LEDGER", EVENT_LEDGER, "ModuleEvents");
auditNamedSurface("SERVICE_LEDGER", SERVICE_LEDGER, "PlatformServices");

for (const w of warnings) console.warn(`⚠️  ${w}`);
for (const p of problems) console.error(`❌ ${p}`);

if (problems.length === 0) {
  const audited =
    Object.keys(LEDGER).length +
    Object.keys(HOOK_LEDGER).length +
    Object.keys(EVENT_LEDGER).length +
    Object.keys(SERVICE_LEDGER).length;
  console.log(
    `✅ module contract clean — ${audited} entries audited across 4 surfaces ` +
      `(${Object.keys(LEDGER).length} AppstrateModule, ${Object.keys(HOOK_LEDGER).length} hooks, ` +
      `${Object.keys(EVENT_LEDGER).length} events, ${Object.keys(SERVICE_LEDGER).length} services), no drift.`,
  );
}

if (problems.length > 0 && POLICY === "fail") process.exit(1);
