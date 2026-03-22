/**
 * Root preload guard — intercepts `bun test` from the monorepo root
 * and delegates to apps/api with the correct preload and setup.
 */
import { resolve } from "path";

const apiDir = resolve(import.meta.dir, "../apps/api");
const result = Bun.spawnSync(["bun", "test", "test/"], {
  cwd: apiDir,
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});

process.exit(result.exitCode);
