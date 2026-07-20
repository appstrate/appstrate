// SPDX-License-Identifier: Apache-2.0

import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

if (process.platform !== "darwin") throw new Error("build:macos must run on macOS");

const root = join(import.meta.dir, "..");
const app = join(root, "dist", "Appstrate Browser.app");
const contents = join(app, "Contents");
const macos = join(contents, "MacOS");
await rm(app, { recursive: true, force: true });
await mkdir(macos, { recursive: true });

const bundle = Bun.spawn(
  [
    "bun",
    "build",
    join(root, "src", "cli.ts"),
    "--compile",
    "--outfile",
    join(macos, "appstrate-browser-worker"),
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await bundle.exited) !== 0) throw new Error("Bun companion build failed");

const swift = Bun.spawn(
  [
    "swiftc",
    "-parse-as-library",
    join(root, "macos", "AppDelegate.swift"),
    "-o",
    join(macos, "AppstrateBrowser"),
    "-module-cache-path",
    join(root, "dist", ".swift-module-cache"),
    "-framework",
    "AppKit",
    "-framework",
    "Carbon",
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await swift.exited) !== 0) throw new Error("Swift URL-handler build failed");

await cp(join(root, "macos", "Info.plist"), join(contents, "Info.plist"));
const sign = Bun.spawn(["codesign", "--force", "--deep", "--sign", "-", app], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await sign.exited) !== 0) throw new Error("Ad-hoc app signing failed");
console.info(app);
