#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { runCli } from "../src/cli/index.ts";

const exitCode = await runCli(process.argv.slice(2), {
  stdout: (chunk) => process.stdout.write(chunk),
  stderr: (chunk) => process.stderr.write(chunk),
});
process.exit(exitCode);
