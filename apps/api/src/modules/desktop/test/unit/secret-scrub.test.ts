// SPDX-License-Identifier: Apache-2.0

/**
 * Secret scrubbing — the OUT half of the "agents never see passwords"
 * guarantee. Substitution keeps values out of the context on dispatch;
 * this store redacts them from every reply that comes back, including
 * replies to later commands in the same run.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { registerRunSecrets, scrubRunSecrets, clearRunSecrets } from "../../secret-scrub.ts";

const RUN = "run_scrubtest";

describe("secret-scrub", () => {
  beforeEach(() => {
    clearRunSecrets(RUN);
  });

  it("is a no-op for runs that never substituted", () => {
    const value = { result: "S3cret!Pass" };
    expect(scrubRunSecrets("run_other_untouched", value)).toEqual(value);
  });

  it("redacts registered values from strings, deep", () => {
    registerRunSecrets(RUN, ["S3cret!Pass"]);
    const out = scrubRunSecrets(RUN, {
      result: "the field contains S3cret!Pass now",
      nested: ["ok", { echo: "S3cret!Pass" }],
      count: 3,
    }) as { result: string; nested: unknown[]; count: number };
    expect(out.result).not.toContain("S3cret!Pass");
    expect(out.result).toContain("[redacted:");
    expect(JSON.stringify(out.nested)).not.toContain("S3cret!Pass");
    expect(out.count).toBe(3);
  });

  it("persists across commands — a later reply is still scrubbed", () => {
    registerRunSecrets(RUN, ["S3cret!Pass"]);
    // Simulates: fill with substitution, then a separate evaluate that
    // reads the input's .value back.
    const later = scrubRunSecrets(RUN, { result: "S3cret!Pass" }) as { result: string };
    expect(later.result).not.toContain("S3cret!Pass");
  });

  it("redacts multiple occurrences and multiple values", () => {
    registerRunSecrets(RUN, ["S3cret!Pass", "tok-abc123"]);
    const out = scrubRunSecrets(RUN, "a S3cret!Pass b tok-abc123 c S3cret!Pass") as string;
    expect(out).not.toContain("S3cret!Pass");
    expect(out).not.toContain("tok-abc123");
  });

  it("skips values too short to scrub safely", () => {
    registerRunSecrets(RUN, ["ab"]);
    expect(scrubRunSecrets(RUN, "abricot")).toBe("abricot");
  });

  it("does not treat secret values as regex patterns", () => {
    registerRunSecrets(RUN, ["p.ss(w[or]d)+"]);
    expect(scrubRunSecrets(RUN, "password")).toBe("password");
    expect(scrubRunSecrets(RUN, "x p.ss(w[or]d)+ y")).not.toContain("p.ss(");
  });
});
