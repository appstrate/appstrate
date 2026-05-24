// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { _resetCacheForTesting } from "@appstrate/env";
import {
  encryptCredentials,
  encryptCredentialEnvelope,
  _resetKeyringForTesting,
} from "../src/encryption.ts";
import {
  decryptCredentialsToStringMap,
  decryptCredentialInputsToStringMap,
} from "../src/credential-decrypt.ts";

const PRIMARY_KEY_B64 = randomBytes(32).toString("base64");

// Snapshot the only env keys this file mutates, so other tests are unaffected.
const MUTATED_KEYS = [
  "CONNECTION_ENCRYPTION_KEY",
  "CONNECTION_ENCRYPTION_KEY_ID",
  "CONNECTION_ENCRYPTION_KEYS",
] as const;

let savedEnv: Partial<Record<(typeof MUTATED_KEYS)[number], string>> = {};

function snapshotEnv(): void {
  savedEnv = {};
  for (const k of MUTATED_KEYS) {
    if (k in process.env) savedEnv[k] = process.env[k];
  }
}

function restoreEnv(): void {
  for (const k of MUTATED_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _resetCacheForTesting();
  _resetKeyringForTesting();
}

beforeEach(() => {
  snapshotEnv();
  process.env.CONNECTION_ENCRYPTION_KEY = PRIMARY_KEY_B64;
  delete process.env.CONNECTION_ENCRYPTION_KEY_ID;
  delete process.env.CONNECTION_ENCRYPTION_KEYS;
  _resetCacheForTesting();
  _resetKeyringForTesting();
});

afterEach(() => {
  restoreEnv();
});

describe("decryptCredentialsToStringMap — outputs-only projection", () => {
  it("never returns an input-plane field", () => {
    const blob = encryptCredentialEnvelope({
      outputs: { access_token: "TOK", JSESSIONID: "abc" },
      inputs: { mot_de_passe: "s3cr3t", username: "alice" },
    });
    const outputs = decryptCredentialsToStringMap(blob);
    expect(outputs).toEqual({ access_token: "TOK", JSESSIONID: "abc" });
    // The input-plane keys/values must not leak into the injection map.
    expect(outputs).not.toHaveProperty("mot_de_passe");
    expect(outputs).not.toHaveProperty("username");
    expect(JSON.stringify(outputs)).not.toContain("s3cr3t");
  });

  it("drops non-string output values during projection", () => {
    const blob = encryptCredentialEnvelope({
      outputs: {
        access_token: "TOK",
        // Non-string values are not injectable as headers/body params.
        expires_in: 3600 as unknown as string,
        active: true as unknown as string,
        nested: { a: 1 } as unknown as string,
      },
    });
    const outputs = decryptCredentialsToStringMap(blob);
    expect(outputs).toEqual({ access_token: "TOK" });
  });

  it("reads a legacy v1 flat blob as all-outputs", () => {
    const v1 = encryptCredentials({ access_token: "at_123", refresh_token: "rt_456" });
    const outputs = decryptCredentialsToStringMap(v1);
    expect(outputs).toEqual({ access_token: "at_123", refresh_token: "rt_456" });
  });
});

describe("decryptCredentialInputsToStringMap — inputs-only projection", () => {
  it("never returns an output-plane field", () => {
    const blob = encryptCredentialEnvelope({
      outputs: { access_token: "TOK", JSESSIONID: "abc" },
      inputs: { mot_de_passe: "s3cr3t", username: "alice" },
    });
    const inputs = decryptCredentialInputsToStringMap(blob);
    expect(inputs).toEqual({ mot_de_passe: "s3cr3t", username: "alice" });
    // The output-plane keys must not bleed into the bootstrap inputs.
    expect(inputs).not.toHaveProperty("access_token");
    expect(inputs).not.toHaveProperty("JSESSIONID");
  });

  it("reads a legacy v1 flat blob as empty-inputs", () => {
    const v1 = encryptCredentials({ access_token: "at_123", refresh_token: "rt_456" });
    expect(decryptCredentialInputsToStringMap(v1)).toEqual({});
  });

  it("drops non-string input values during projection", () => {
    const blob = encryptCredentialEnvelope({
      outputs: { access_token: "TOK" },
      inputs: {
        password: "p@ss",
        attempts: 2 as unknown as string,
      },
    });
    expect(decryptCredentialInputsToStringMap(blob)).toEqual({ password: "p@ss" });
  });
});
