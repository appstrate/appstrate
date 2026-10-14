// SPDX-License-Identifier: Apache-2.0

// Preload of the packages whose tests need no platform harness: `os.tmpdir()`
// resolves inside a directory this process owns, removed after the last file.
import { afterAll } from "bun:test";
import { ownTmpdir } from "./temp-dirs.ts";

afterAll(ownTmpdir());
