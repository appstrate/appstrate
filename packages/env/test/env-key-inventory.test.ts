// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { findUnreadEnvKeys } from "../src/env-key-inventory.ts";

const READ = new Set([
  "RUN_TOKEN_SECRET",
  "SMTP_PASS",
  "NODE_ENV",
  "GITHUB_CLIENT_ID",
  "RUNNER_IMAGE_BUN",
  "GIT_SHA",
]);

describe("findUnreadEnvKeys", () => {
  it("reports unread keys under a platform namespace and nothing else", () => {
    const present = [
      "RUN_TOKEN_SECRETS",
      "RUN_TOKEN_SECRET",
      "PATH",
      "HOME",
      "NODE_OPTIONS",
      "GITHUB_SHA",
      "RUNNER_OS",
      "GIT_SSH_COMMAND",
      "STRIPE_SECRET_KEY",
      "SMTP_PASSWORD",
      "modules",
    ];
    expect(findUnreadEnvKeys(present, READ)).toEqual(["RUN_TOKEN_SECRETS", "SMTP_PASSWORD"]);
  });

  // Infra keys are known, and their namespaces are not the platform's.
  it("never reports infra keys nor their neighbours, a platform typo still", () => {
    const present = [
      "POSTGRES_USER",
      "POSTGRES_DB",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "MINIO_ROOT_USER",
      "MINIO_BROWSER",
      "RUN_ADAPTR",
    ];
    expect(findUnreadEnvKeys(present, READ)).toEqual(["RUN_ADAPTR"]);
  });

  it("reports a duplicated key once", () => {
    expect(findUnreadEnvKeys(["SMTP_PASSWORD", "SMTP_PASSWORD"], READ)).toEqual(["SMTP_PASSWORD"]);
  });

  it("returns the result sorted", () => {
    expect(findUnreadEnvKeys(["SMTP_ZETA", "RUN_ALPHA", "SMTP_BETA"], READ)).toEqual([
      "RUN_ALPHA",
      "SMTP_BETA",
      "SMTP_ZETA",
    ]);
  });
});
