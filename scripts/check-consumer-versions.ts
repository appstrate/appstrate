/**
 * Verify that every known `@appstrate/core` consumer is in lockstep with
 * the version about to be published. Run by `.github/workflows/publish-core.yml`
 * before npm publish — failing here forces a consumer bump pass before a new
 * core version goes out.
 *
 * Drift policy:
 *   - >= 2 minors behind  → fail (block publish).
 *   - 1 minor behind      → warn.
 *   - in sync             → OK.
 *
 * Override via env: `CONSUMER_DRIFT_POLICY=warn|fail|off`.
 */

interface Consumer {
  /** GitHub repo in `owner/repo` form. */
  repo: string;
  /** package.json paths within the repo. */
  paths: string[];
}

const CONSUMERS: Consumer[] = [
  {
    repo: "appstrate/registry",
    paths: ["package.json", "apps/api/package.json", "apps/web/package.json"],
  },
  { repo: "appstrate/cloud", paths: ["package.json"] },
  { repo: "appstrate/portal", paths: ["package.json"] },
];

const DEPENDENCY_NAME = "@appstrate/core";
const POLICY = (process.env.CONSUMER_DRIFT_POLICY ?? "fail") as "warn" | "fail" | "off";

function parseSemver(v: string): [number, number, number] | null {
  const cleaned = v.replace(/^[\^~>=<\s]+/, "").trim();
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(cleaned);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  }
  return 0;
}

async function fetchPackageJson(
  repo: string,
  path: string,
): Promise<Record<string, unknown> | null> {
  const url = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.raw+json",
    "User-Agent": "appstrate-consumer-version-check",
  };
  const token = process.env.GITHUB_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  if (POLICY === "off") {
    console.log("CONSUMER_DRIFT_POLICY=off — skipping check.");
    return;
  }

  const localPkg = await Bun.file("packages/core/package.json").json();
  const localVersion = parseSemver(String(localPkg.version));
  if (!localVersion) {
    console.error(`Cannot parse local @appstrate/core version: ${localPkg.version}`);
    process.exit(1);
  }
  const [lMaj, lMin] = localVersion;
  console.log(`Publishing @appstrate/core@${lMaj}.${lMin}.${localVersion[2]}`);
  console.log("");

  let warnings = 0;
  let failures = 0;

  for (const consumer of CONSUMERS) {
    for (const path of consumer.paths) {
      let pkg: Record<string, unknown> | null;
      try {
        pkg = await fetchPackageJson(consumer.repo, path);
      } catch (err) {
        console.warn(
          `  ! ${consumer.repo}/${path} — fetch failed (${err instanceof Error ? err.message : String(err)})`,
        );
        continue;
      }
      if (!pkg) {
        console.log(`  - ${consumer.repo}/${path} — not present, skipping`);
        continue;
      }

      const deps = {
        ...(pkg.dependencies as Record<string, string> | undefined),
        ...(pkg.devDependencies as Record<string, string> | undefined),
      };
      const range = deps[DEPENDENCY_NAME];
      if (!range) {
        console.log(`  - ${consumer.repo}/${path} — does not depend on ${DEPENDENCY_NAME}`);
        continue;
      }

      const consumerVersion = parseSemver(range);
      if (!consumerVersion) {
        console.warn(`  ? ${consumer.repo}/${path} — unparsable range "${range}"`);
        continue;
      }

      const [cMaj, cMin] = consumerVersion;
      if (cMaj !== lMaj) {
        const msg = `${consumer.repo}/${path} pins ${range} but local is ${localPkg.version} (major mismatch)`;
        console.error(`  ✗ ${msg}`);
        failures++;
        continue;
      }

      const minorDelta = lMin - cMin;
      if (minorDelta >= 2) {
        console.error(
          `  ✗ ${consumer.repo}/${path} pins ${range} — ${minorDelta} minors behind ${localPkg.version}`,
        );
        failures++;
      } else if (minorDelta === 1) {
        console.warn(
          `  ! ${consumer.repo}/${path} pins ${range} — 1 minor behind ${localPkg.version}`,
        );
        warnings++;
      } else if (compare(consumerVersion, localVersion) < 0) {
        console.log(`  ✓ ${consumer.repo}/${path} pins ${range} — patch-behind, OK`);
      } else {
        console.log(`  ✓ ${consumer.repo}/${path} pins ${range} — in sync`);
      }
    }
  }

  console.log("");
  console.log(`Summary: ${failures} failure(s), ${warnings} warning(s)`);

  if (failures > 0 && POLICY === "fail") {
    console.error("");
    console.error("Bump the failing consumers to match before publishing core.");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
