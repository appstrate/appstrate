import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getEnv, _resetCacheForTesting } from "../src/index.ts";

const TRACKED = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_ACTIVE_KID",
  "BETTER_AUTH_SECRETS",
  "CONNECTION_ENCRYPTION_KEY",
  "UPLOAD_SIGNING_SECRET",
  "APP_URL",
  "NODE_ENV",
] as const;

type Snap = Record<(typeof TRACKED)[number], string | undefined>;

function snap(): Snap {
  return Object.fromEntries(TRACKED.map((k) => [k, process.env[k]])) as Snap;
}

function restore(s: Snap): void {
  for (const k of TRACKED) {
    if (s[k] === undefined) delete process.env[k];
    else process.env[k] = s[k];
  }
}

function setBaseEnv(): void {
  process.env.BETTER_AUTH_SECRET = "x".repeat(32);
  process.env.UPLOAD_SIGNING_SECRET = "y".repeat(32);
  process.env.CONNECTION_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
  process.env.NODE_ENV = "test";
  delete process.env.APP_URL;
  delete process.env.BETTER_AUTH_ACTIVE_KID;
}

describe("BETTER_AUTH_SECRETS namespace-collision scrub", () => {
  let s: Snap;

  beforeEach(() => {
    s = snap();
    setBaseEnv();
    _resetCacheForTesting();
  });

  afterEach(() => {
    restore(s);
    _resetCacheForTesting();
  });

  it("removes process.env.BETTER_AUTH_SECRETS after parse (default empty case)", () => {
    delete process.env.BETTER_AUTH_SECRETS;
    const env = getEnv();
    expect(env.BETTER_AUTH_SECRETS).toEqual({});
    expect(process.env.BETTER_AUTH_SECRETS).toBeUndefined();
  });

  it("removes process.env.BETTER_AUTH_SECRETS after parse (literal `{}` from compose default)", () => {
    process.env.BETTER_AUTH_SECRETS = "{}";
    const env = getEnv();
    expect(env.BETTER_AUTH_SECRETS).toEqual({});
    expect(process.env.BETTER_AUTH_SECRETS).toBeUndefined();
  });

  it("removes process.env.BETTER_AUTH_SECRETS after parse (populated rotation map)", () => {
    process.env.BETTER_AUTH_SECRETS = JSON.stringify({
      k1: "old".repeat(11),
      k2: "new".repeat(11),
    });
    const env = getEnv();
    expect(env.BETTER_AUTH_SECRETS).toEqual({ k1: "old".repeat(11), k2: "new".repeat(11) });
    expect(process.env.BETTER_AUTH_SECRETS).toBeUndefined();
  });

  it("treats empty string as `{}` (compose `${VAR:-}` fallback)", () => {
    process.env.BETTER_AUTH_SECRETS = "";
    const env = getEnv();
    expect(env.BETTER_AUTH_SECRETS).toEqual({});
    expect(process.env.BETTER_AUTH_SECRETS).toBeUndefined();
  });

  it("rejects non-JSON value with a clear error (e.g. better-auth's CSV format)", () => {
    process.env.BETTER_AUTH_SECRETS = "v1:some-secret,v2:another";
    expect(() => getEnv()).toThrow(/BETTER_AUTH_SECRETS must be valid JSON/);
  });
});
