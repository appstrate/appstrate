// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { envSchema } from "../src/index.ts";
import { FOREIGN_ENV_NAMESPACES } from "./foreign-env-namespaces.ts";
import {
  PLATFORM_ENV_NAMESPACES,
  envNamespace,
  findUnreadEnvKeys,
} from "../src/env-key-inventory.ts";

const READ = new Set([
  "RUN_TOKEN_SECRET",
  "SMTP_PASS",
  "NODE_ENV",
  "GITHUB_CLIENT_ID",
  "RUNNER_IMAGE_NODE",
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
      "GIT_SSH_COMMAND",
      "STRIPE_SECRET_KEY",
      "SMTP_PASSWORD",
      "modules",
    ];
    expect(findUnreadEnvKeys(present, READ)).toEqual(["RUN_TOKEN_SECRETS", "SMTP_PASSWORD"]);
  });

  it("reports a misspelled key under every platform namespace but the runtime's and git's", () => {
    const present = [
      "GITHUB_CLIENT_ID",
      "GITHUB_CLIENT_IDD",
      "RUNNER_IMAGE_NODE",
      "RUNNER_IMAGE_NODEE",
      "NODE_ENVV",
      "GIT_SHAA",
    ];
    expect(findUnreadEnvKeys(present, READ)).toEqual(["GITHUB_CLIENT_IDD", "RUNNER_IMAGE_NODEE"]);
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

describe("PLATFORM_ENV_NAMESPACES", () => {
  // A removed key leaves its namespace behind: the operator who still sets it is warned.
  it("still reports a key of a declared namespace that no key reads any more", () => {
    expect(findUnreadEnvKeys(["OAUTH_REFRESH_WORKER_ENABLED"], READ)).toEqual([
      "OAUTH_REFRESH_WORKER_ENABLED",
    ]);
    expect(READ.has("OAUTH_REFRESH_WORKER_ENABLED")).toBe(false);
    expect([...READ].some((key) => envNamespace(key) === "OAUTH")).toBe(false);
  });

  it("declares the namespace of every schema key, so a new family has to be named", () => {
    const missing = Object.keys(envSchema.shape).filter(
      (key) =>
        !PLATFORM_ENV_NAMESPACES.has(envNamespace(key)) &&
        !FOREIGN_ENV_NAMESPACES.has(envNamespace(key)),
    );
    expect(missing, "declare the namespace in PLATFORM_ENV_NAMESPACES").toEqual([]);
  });

  it("holds neither the foreign namespaces nor lowercase names", () => {
    for (const namespace of FOREIGN_ENV_NAMESPACES) {
      expect(PLATFORM_ENV_NAMESPACES.has(namespace)).toBe(false);
    }
    for (const namespace of PLATFORM_ENV_NAMESPACES) expect(namespace).toMatch(/^[A-Z][A-Z0-9]*$/);
  });
});
