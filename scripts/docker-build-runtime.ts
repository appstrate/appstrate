/**
 * Build the runtime image PAIR — `appstrate-pi` + `appstrate-sidecar`.
 *
 * ## Why one command builds two images
 *
 * `PI_IMAGE` and `SIDECAR_IMAGE` are a **version contract**, not two
 * independent artifacts: the agent runtime speaks a wire protocol to the
 * sidecar (LLM reverse proxy, `/mcp`, credential injection), and both halves
 * of that protocol evolve in the same commit. A pair built from two different
 * commits starts normally, passes every health check, and then fails somewhere
 * upstream with a message that names neither image — issue #1195 cost a day of
 * bisecting exactly that (pi ≥ #1167 sends a zstd-compressed Codex body;
 * sidecar < #1166 buffered it as text and corrupted it — neither version was
 * buggy alone, only the pair was).
 *
 * The old `docker:build:runtime` rebuilt only `appstrate-pi`, so on a dev host
 * — where images are rebuilt by hand — the sidecar could silently be weeks
 * behind. Making the pair the only buildable unit removes that failure mode at
 * the source: there is no command left that builds one half.
 *
 * ## Build stamp
 *
 * Both images carry `org.opencontainers.image.revision` (+ `.version`,
 * `.created`), fed from this repo's git HEAD. The platform compares the two
 * revisions after pre-pulling at boot and warns when they differ
 * (`services/orchestrator/runtime-image-pair.ts`). Without a stamp both
 * labels read `unknown`, compare equal, and a mismatched pair stays invisible
 * — which is the state dev builds were in before this script existed.
 *
 * CI does not use this script: the release workflow builds multi-arch images
 * via buildx and stamps the same three labels from the release tag + SHA.
 */

import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");

interface RuntimeImage {
  readonly tag: string;
  readonly dockerfile: string;
}

/**
 * The pair, in build order. Sidecar second because it is the smaller build:
 * when the pi build fails the sidecar is skipped, which leaves the previous
 * (matching) pair on the host rather than a half-updated one.
 */
const IMAGES: readonly RuntimeImage[] = [
  { tag: "appstrate-pi", dockerfile: "runtime-pi/Dockerfile" },
  { tag: "appstrate-sidecar", dockerfile: "runtime-pi/sidecar/Dockerfile" },
];

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return proc.exitCode === 0 ? out.trim() : "";
}

/**
 * Build revision for this working tree: the short HEAD sha, suffixed
 * `-dirty` when there are uncommitted changes. Falls back to `unknown` outside
 * a git checkout (tarball export), which is exactly the pre-stamp behaviour —
 * degraded, never wrong.
 */
async function resolveRevision(): Promise<string> {
  const sha = await git("rev-parse", "--short=12", "HEAD");
  if (!sha) return "unknown";
  const dirty = await git("status", "--porcelain");
  return dirty ? `${sha}-dirty` : sha;
}

async function buildImage(image: RuntimeImage, buildArgs: readonly string[]): Promise<void> {
  const args = [
    "build",
    ...buildArgs.flatMap((arg) => ["--build-arg", arg]),
    "-t",
    image.tag,
    "-f",
    resolve(ROOT, image.dockerfile),
    ROOT,
  ];

  console.log(`\n→ docker build ${image.tag} (${image.dockerfile})`);
  // stdio inherited: BuildKit's progress UI is the whole point of watching a
  // docker build, and swallowing it to re-print at the end would lose it.
  const proc = Bun.spawn(["docker", ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`docker build failed for ${image.tag} (exit ${proc.exitCode})`);
  }
}

const revision = await resolveRevision();
// The root manifest carries no `version` (it is a private monorepo root), so
// the nearest release tag is the only version a local build has — and it is
// the more useful one anyway: "v1.0.0-beta.51-3-g09b15fe" says which release
// this host's images are ahead of. `--match "v*"` keeps package-publish tags
// (`core@7.0.0`, `afps-shared@0.3.1`) out of the answer.
const version =
  (await git("describe", "--tags", "--always", "--dirty", "--match", "v*")) || "unknown";
const created = new Date().toISOString();

const buildArgs = [
  `BUILD_VERSION=${version}`,
  `BUILD_REVISION=${revision}`,
  `BUILD_CREATED=${created}`,
];

console.log(`Building runtime image pair — revision ${revision}, version ${version}`);

for (const image of IMAGES) {
  await buildImage(image, buildArgs);
}

console.log(
  `\n✓ runtime image pair built from revision ${revision}: ${IMAGES.map((i) => i.tag).join(", ")}`,
);
