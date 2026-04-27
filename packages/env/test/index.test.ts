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
  "AUTH_DISABLE_SIGNUP",
  "AUTH_DISABLE_ORG_CREATION",
  "TRUST_PROXY",
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

describe("empty string is universally treated as unset (compose `${VAR:-}` pattern)", () => {
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

  it('BETTER_AUTH_ACTIVE_KID: empty string falls back to default `"k1"`', () => {
    process.env.BETTER_AUTH_ACTIVE_KID = "";
    expect(getEnv().BETTER_AUTH_ACTIVE_KID).toBe("k1");
  });

  it("BETTER_AUTH_ACTIVE_KID: explicit value passes through", () => {
    process.env.BETTER_AUTH_ACTIVE_KID = "k7";
    expect(getEnv().BETTER_AUTH_ACTIVE_KID).toBe("k7");
  });

  it("BETTER_AUTH_ACTIVE_KID: invalid value (non-matching regex) still fails fast", () => {
    process.env.BETTER_AUTH_ACTIVE_KID = "bad/kid";
    expect(() => getEnv()).toThrow(/BETTER_AUTH_ACTIVE_KID/);
  });

  it('NODE_ENV: empty string falls back to default `"development"`', () => {
    process.env.NODE_ENV = "";
    expect(getEnv().NODE_ENV).toBe("development");
  });
});

describe("boolean env vars accept empty string (compose `${VAR:-}` pattern)", () => {
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

  it("AUTH_DISABLE_SIGNUP: empty string falls back to default `false`", () => {
    process.env.AUTH_DISABLE_SIGNUP = "";
    expect(getEnv().AUTH_DISABLE_SIGNUP).toBe(false);
  });

  it("AUTH_DISABLE_SIGNUP: unset falls back to default `false`", () => {
    delete process.env.AUTH_DISABLE_SIGNUP;
    expect(getEnv().AUTH_DISABLE_SIGNUP).toBe(false);
  });

  it('AUTH_DISABLE_SIGNUP: `"true"` parses to true', () => {
    process.env.AUTH_DISABLE_SIGNUP = "true";
    expect(getEnv().AUTH_DISABLE_SIGNUP).toBe(true);
  });

  it('AUTH_DISABLE_SIGNUP: `"false"` parses to false', () => {
    process.env.AUTH_DISABLE_SIGNUP = "false";
    expect(getEnv().AUTH_DISABLE_SIGNUP).toBe(false);
  });

  it("AUTH_DISABLE_SIGNUP: invalid value fails fast with a clear error", () => {
    process.env.AUTH_DISABLE_SIGNUP = "yes";
    expect(() => getEnv()).toThrow(/AUTH_DISABLE_SIGNUP/);
  });

  it("AUTH_DISABLE_ORG_CREATION: empty string falls back to default `false`", () => {
    process.env.AUTH_DISABLE_ORG_CREATION = "";
    expect(getEnv().AUTH_DISABLE_ORG_CREATION).toBe(false);
  });

  it('AUTH_DISABLE_ORG_CREATION: `"true"` parses to true', () => {
    process.env.AUTH_DISABLE_ORG_CREATION = "true";
    expect(getEnv().AUTH_DISABLE_ORG_CREATION).toBe(true);
  });

  it('TRUST_PROXY: empty string falls back to default `"false"`', () => {
    process.env.TRUST_PROXY = "";
    expect(getEnv().TRUST_PROXY).toBe("false");
  });

  it("TRUST_PROXY: integer string passes through", () => {
    process.env.TRUST_PROXY = "2";
    expect(getEnv().TRUST_PROXY).toBe("2");
  });

  it("TRUST_PROXY: invalid value fails fast", () => {
    process.env.TRUST_PROXY = "maybe";
    expect(() => getEnv()).toThrow(/TRUST_PROXY/);
  });
});
