import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getEnv, _resetCacheForTesting } from "../src/index.ts";

const TRACKED = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_ACTIVE_KID",
  "BETTER_AUTH_SECRETS",
  "CONNECTION_ENCRYPTION_KEY",
  "UPLOAD_SIGNING_SECRET",
  "CONNECT_SESSION_SECRET",
  "RUN_TOKEN_SECRET",
  "APP_URL",
  "NODE_ENV",
  "AUTH_DISABLE_SIGNUP",
  "AUTH_DISABLE_ORG_CREATION",
  "TRUST_PROXY",
  "USERCONTENT_URL",
  "PI_IMAGE",
  "SIDECAR_IMAGE",
  "APP_VERSION",
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
  process.env.RUN_TOKEN_SECRET = "z".repeat(32);
  process.env.CONNECT_SESSION_SECRET = "w".repeat(32);
  process.env.CONNECTION_ENCRYPTION_KEY = Buffer.alloc(32, 1).toString("base64");
  process.env.NODE_ENV = "test";
  delete process.env.APP_URL;
  delete process.env.BETTER_AUTH_ACTIVE_KID;
  delete process.env.USERCONTENT_URL;
  delete process.env.PI_IMAGE;
  delete process.env.SIDECAR_IMAGE;
  delete process.env.APP_VERSION;
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

describe("signing-secret keyrings (comma-separated, per-key validation)", () => {
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

  it("UPLOAD_SIGNING_SECRET: single ≥16-char key passes (keyring of one)", () => {
    process.env.UPLOAD_SIGNING_SECRET = "a".repeat(16);
    expect(getEnv().UPLOAD_SIGNING_SECRET).toBe("a".repeat(16));
  });

  it("UPLOAD_SIGNING_SECRET: multiple ≥16-char keys pass", () => {
    process.env.UPLOAD_SIGNING_SECRET = `${"a".repeat(16)},${"b".repeat(20)}`;
    expect(getEnv().UPLOAD_SIGNING_SECRET).toBe(`${"a".repeat(16)},${"b".repeat(20)}`);
  });

  it("UPLOAD_SIGNING_SECRET: rejects a keyring containing a <16-char key", () => {
    process.env.UPLOAD_SIGNING_SECRET = `${"a".repeat(16)},short`;
    expect(() => getEnv()).toThrow(/UPLOAD_SIGNING_SECRET/);
  });

  it("UPLOAD_SIGNING_SECRET: rejects an empty segment (trailing comma)", () => {
    process.env.UPLOAD_SIGNING_SECRET = `${"a".repeat(16)},`;
    expect(() => getEnv()).toThrow(/UPLOAD_SIGNING_SECRET/);
  });

  it("CONNECT_SESSION_SECRET: required — unset fails boot (issue #905)", () => {
    delete process.env.CONNECT_SESSION_SECRET;
    expect(() => getEnv()).toThrow(/CONNECT_SESSION_SECRET/);
  });

  it("CONNECT_SESSION_SECRET: multiple ≥16-char keys pass (keyring rotation)", () => {
    process.env.CONNECT_SESSION_SECRET = `${"a".repeat(16)},${"b".repeat(20)}`;
    expect(getEnv().CONNECT_SESSION_SECRET).toBe(`${"a".repeat(16)},${"b".repeat(20)}`);
  });

  it("CONNECT_SESSION_SECRET: rejects a keyring containing a <16-char key", () => {
    process.env.CONNECT_SESSION_SECRET = `${"a".repeat(16)},short`;
    expect(() => getEnv()).toThrow(/CONNECT_SESSION_SECRET/);
  });

  it("RUN_TOKEN_SECRET: comma-separated ≥16-char keys pass", () => {
    process.env.RUN_TOKEN_SECRET = `${"a".repeat(16)},${"b".repeat(20)}`;
    expect(getEnv().RUN_TOKEN_SECRET).toBe(`${"a".repeat(16)},${"b".repeat(20)}`);
  });

  it("RUN_TOKEN_SECRET: rejects an empty segment", () => {
    process.env.RUN_TOKEN_SECRET = `${"a".repeat(16)},,${"b".repeat(16)}`;
    expect(() => getEnv()).toThrow(/RUN_TOKEN_SECRET/);
  });

  it("RUN_TOKEN_SECRET: rejects a keyring containing a <16-char key", () => {
    process.env.RUN_TOKEN_SECRET = `${"a".repeat(16)},short`;
    expect(() => getEnv()).toThrow(/RUN_TOKEN_SECRET/);
  });

  it("RUN_TOKEN_SECRET: unset is rejected (required)", () => {
    delete process.env.RUN_TOKEN_SECRET;
    expect(() => getEnv()).toThrow(/RUN_TOKEN_SECRET/);
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

describe("APP_URL is the canonical public origin", () => {
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

  it("normalizes an absolute HTTP(S) URL to its origin", () => {
    process.env.APP_URL = "https://APP.Example.COM:443/";
    expect(getEnv().APP_URL).toBe("https://app.example.com");
  });

  it("rejects a deployment subpath", () => {
    process.env.APP_URL = "https://app.example.com/app";
    expect(() => getEnv()).toThrow(/APP_URL: must be an origin only/);
  });

  it("rejects a malformed absolute URL with an actionable env error", () => {
    process.env.APP_URL = "app.example.com";
    expect(() => getEnv()).toThrow(/APP_URL: must be an absolute URL/);
  });

  it("rejects a non-HTTP(S) scheme", () => {
    process.env.APP_URL = "ftp://app.example.com";
    expect(() => getEnv()).toThrow(/APP_URL: only http: and https: are supported/);
  });

  it("rejects embedded credentials", () => {
    process.env.APP_URL = "https://operator:secret@app.example.com";
    expect(() => getEnv()).toThrow(/APP_URL: credentials are not supported/);
  });

  it("rejects a query string", () => {
    process.env.APP_URL = "https://app.example.com?tenant=one";
    expect(() => getEnv()).toThrow(/APP_URL: must be an origin only/);
  });
});

// USERCONTENT_URL is the origin agent-authored HTML previews are served from.
// Its presence grants no extra execution context — `mayServeActiveHtml` serves
// active HTML only for a proven iframe load, in every mode. What a value
// sharing APP_URL's host costs is NOT a stripped response header (the SPA
// iframe's own `sandbox` attribute survives that, so the document stays
// opaque-origin): it is a UA that ignores sandboxing entirely, a future
// app-origin page that frames the preview WITHOUT the attribute (which
// `frame-ancestors` permits, leaving the response header as the only control),
// and the storage/cookie/process partition itself. The floor is host
// inequality — stricter than origin inequality (cookies are host-scoped, so
// another port/scheme is not separation), and boot must fail rather than
// silently degrade.
describe("USERCONTENT_URL must be a genuinely separate preview origin", () => {
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

  it("unset is valid (same-origin preview mode — the OSS default)", () => {
    delete process.env.USERCONTENT_URL;
    expect(getEnv().USERCONTENT_URL).toBeUndefined();
  });

  it("empty string is treated as unset (compose `${VAR:-}` pattern)", () => {
    process.env.USERCONTENT_URL = "";
    expect(getEnv().USERCONTENT_URL).toBeUndefined();
  });

  it("a distinct host passes through verbatim", () => {
    process.env.APP_URL = "https://app.example.com";
    process.env.USERCONTENT_URL = "https://usercontent.example.net";
    expect(getEnv().USERCONTENT_URL).toBe("https://usercontent.example.net");
  });

  it("a sibling subdomain of APP_URL is accepted (host differs — the documented floor)", () => {
    process.env.APP_URL = "https://app.example.com";
    process.env.USERCONTENT_URL = "https://usercontent.example.com";
    expect(getEnv().USERCONTENT_URL).toBe("https://usercontent.example.com");
  });

  it("rejects a value identical to APP_URL (the copy-paste foot-gun)", () => {
    process.env.APP_URL = "https://app.example.com";
    process.env.USERCONTENT_URL = "https://app.example.com";
    expect(() => getEnv()).toThrow(/USERCONTENT_URL must be a DIFFERENT host than APP_URL/);
  });

  it("rejects a value differing from APP_URL only by a trailing slash", () => {
    process.env.APP_URL = "https://app.example.com";
    process.env.USERCONTENT_URL = "https://app.example.com/";
    expect(() => getEnv()).toThrow(/USERCONTENT_URL must be a DIFFERENT host than APP_URL/);
  });

  it("rejects a value differing from APP_URL only by an explicit default port", () => {
    process.env.APP_URL = "https://app.example.com";
    process.env.USERCONTENT_URL = "https://app.example.com:443";
    expect(() => getEnv()).toThrow(/USERCONTENT_URL must be a DIFFERENT host than APP_URL/);
  });

  it("rejects the same host on a different port (different origin, SAME cookie jar)", () => {
    process.env.APP_URL = "https://app.example.com";
    process.env.USERCONTENT_URL = "https://app.example.com:8443";
    expect(() => getEnv()).toThrow(/USERCONTENT_URL must be a DIFFERENT host than APP_URL/);
  });

  it("rejects the same host on a different scheme", () => {
    process.env.APP_URL = "https://app.example.com";
    process.env.USERCONTENT_URL = "http://app.example.com";
    expect(() => getEnv()).toThrow(/USERCONTENT_URL must be a DIFFERENT host than APP_URL/);
  });

  it("host comparison is case-insensitive (URL parsing lowercases the host)", () => {
    process.env.APP_URL = "https://app.example.com";
    process.env.USERCONTENT_URL = "https://APP.Example.COM";
    expect(() => getEnv()).toThrow(/USERCONTENT_URL must be a DIFFERENT host than APP_URL/);
  });

  it("rejects a value matching APP_URL's default `http://localhost:3000`", () => {
    delete process.env.APP_URL;
    process.env.USERCONTENT_URL = "http://localhost:3000";
    expect(() => getEnv()).toThrow(/USERCONTENT_URL must be a DIFFERENT host than APP_URL/);
  });

  it("rejects a non-URL string (bare hostname, no scheme)", () => {
    process.env.USERCONTENT_URL = "usercontent.example.com";
    expect(() => getEnv()).toThrow(/USERCONTENT_URL/);
  });

  it("rejects a non-URL string (free text)", () => {
    process.env.USERCONTENT_URL = "not a url";
    expect(() => getEnv()).toThrow(/USERCONTENT_URL/);
  });

  it("requires https:// when NODE_ENV=production (same rule APP_URL carries)", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_URL = "https://app.example.com";
    process.env.USERCONTENT_URL = "http://usercontent.example.com";
    expect(() => getEnv()).toThrow(/USERCONTENT_URL must use https:\/\/ when NODE_ENV=production/);
  });

  it("accepts https:// in production", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_URL = "https://app.example.com";
    process.env.USERCONTENT_URL = "https://usercontent.example.com";
    expect(getEnv().USERCONTENT_URL).toBe("https://usercontent.example.com");
  });

  it("exempts http://localhost in production (TLS-terminating local proxy)", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_URL = "http://127.0.0.1:3000";
    process.env.USERCONTENT_URL = "http://localhost:3000";
    expect(getEnv().USERCONTENT_URL).toBe("http://localhost:3000");
  });
});

// The full case table for the rule itself lives on the pure function, in
// `packages/core/test/image-ref.test.ts`. What is left here is the wiring: that
// the schema calls it at all, and that it feeds it APP_VERSION — the value the
// trio rule added, and the only way a *matched pair* can now abort boot.
//
// Plus the trios the repo itself boots. Those belong here and not only on the
// pure function, because "does this configuration start the platform?" is a
// question about `getEnv()`, and the two configurations below — the
// health-container e2e job and the alias tag families `release.yml` publishes —
// were both aborting boot while every case on the pure function passed.
describe("APP_VERSION / PI_IMAGE / SIDECAR_IMAGE are a version contract", () => {
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

  it("all three unset is valid — the defaults are the matching dev triple", () => {
    expect(getEnv().PI_IMAGE).toBe("appstrate-pi:latest");
    expect(getEnv().SIDECAR_IMAGE).toBe("appstrate-sidecar:latest");
  });

  it("aborts boot when the runtime pair is one release behind the platform", () => {
    process.env.APP_VERSION = "v1.0.0-beta.52";
    process.env.PI_IMAGE = "ghcr.io/appstrate/appstrate-pi:1.0.0-beta.51";
    process.env.SIDECAR_IMAGE = "ghcr.io/appstrate/appstrate-sidecar:1.0.0-beta.51";
    expect(() => getEnv()).toThrow(/platform build 1\.0\.0-beta\.52.*Out of step: the platform/s);
  });

  it("anchors the platform-outlier issue on a variable the operator can set", () => {
    // `oddOneOut` has three values. In this trio the two images agree with each
    // other and disagree with the platform, so `oddOneOut === "platform"` and
    // BOTH images have to move. The path used to be a two-way ternary that sent
    // this case to SIDECAR_IMAGE — the one variable the message says is not
    // individually at fault — and nothing asserted the path, so it went unseen.
    process.env.APP_VERSION = "v1.0.0-beta.52";
    process.env.PI_IMAGE = "ghcr.io/appstrate/appstrate-pi:1.0.0-beta.51";
    process.env.SIDECAR_IMAGE = "ghcr.io/appstrate/appstrate-sidecar:1.0.0-beta.51";

    // Match the PATH prefix only. The message body legitimately names all three
    // variables, so asserting over the whole line proves nothing.
    let paths: string[] = [];
    try {
      getEnv();
    } catch (err) {
      paths = [...String((err as Error).message).matchAll(/^\s*- ([A-Z_]+):/gm)].map(
        (m) => m[1] as string,
      );
    }
    expect(paths, "no issue path parsed — the error format changed").not.toEqual([]);
    expect(paths).toContain("PI_IMAGE");
    expect(paths).not.toContain("SIDECAR_IMAGE");
  });

  it("boots the health-container e2e trio (APP_VERSION=health-container-e2e, images :local)", () => {
    // scripts/health-container-e2e.sh + test/setup/docker-compose.health-e2e.yml,
    // verbatim. This is a CI job: if it cannot get past getEnv(), the container
    // never reaches its own healthcheck.
    process.env.APP_VERSION = "health-container-e2e";
    process.env.PI_IMAGE = "appstrate-health-e2e:local";
    process.env.SIDECAR_IMAGE = "appstrate-health-e2e:local";
    expect(getEnv().PI_IMAGE).toBe("appstrate-health-e2e:local");
  });

  for (const tag of ["latest", "1.0", "sha-abc1234"]) {
    it(`boots a released platform against runtime images pinned to :${tag}`, () => {
      // `release.yml` publishes `{{version}}`, `{{major}}.{{minor}}`,
      // `sha-<sha>` and `latest` for the same image, and every shipped compose
      // file derives all three images from one ${APPSTRATE_VERSION}. The
      // platform's APP_VERSION is a git ref name and can only ever equal a
      // `{{version}}` tag, so these trios are coherent.
      process.env.APP_VERSION = "v1.0.0-beta.51";
      process.env.PI_IMAGE = `ghcr.io/appstrate/appstrate-pi:${tag}`;
      process.env.SIDECAR_IMAGE = `ghcr.io/appstrate/appstrate-sidecar:${tag}`;
      expect(getEnv().SIDECAR_IMAGE).toBe(`ghcr.io/appstrate/appstrate-sidecar:${tag}`);
    });
  }

  it("still aborts boot when the two runtime refs sit in different tag families", () => {
    process.env.APP_VERSION = "v1.0.0-beta.51";
    process.env.PI_IMAGE = "ghcr.io/appstrate/appstrate-pi:latest";
    process.env.SIDECAR_IMAGE = "ghcr.io/appstrate/appstrate-sidecar:1.0.0-beta.51";
    expect(() => getEnv()).toThrow(
      /PI_IMAGE tag latest.*Out of step: PI_IMAGE and SIDECAR_IMAGE, which disagree with each other/s,
    );
  });
});
