// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, afterEach } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SchemaForm } from "../src/schema-form/index.tsx";

const originalTz = process.env.TZ;
afterEach(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

const labels = {
  locale: "fr-FR",
  unusualYear: (year: string) => `Année inhabituelle (${year}) : vérifiez la saisie.`,
};

function render(format: string, value: unknown): string {
  return renderToStaticMarkup(
    <SchemaForm
      wrapper={{
        schema: { type: "object", properties: { field: { type: "string", format } } },
      }}
      formData={{ field: value }}
      labels={labels as never}
    />,
  );
}

describe("date echo", () => {
  it("writes the date in full and links it to the input", () => {
    const html = render("date", "2026-09-01");
    expect(html).toContain("mardi 1 septembre 2026");
    expect(html).toContain('aria-describedby="root_field-echo"');
    expect(html).toContain('id="root_field-echo"');
    expect(html).not.toContain("Année inhabituelle");
  });

  it.each(["America/Los_Angeles", "Pacific/Auckland"])(
    "keeps the day of a date under TZ=%s",
    (tz) => {
      process.env.TZ = tz;
      expect(render("date", "2026-01-01")).toContain("jeudi 1 janvier 2026");
      expect(render("date", "2026-12-31")).toContain("jeudi 31 décembre 2026");
    },
  );

  it("writes a date-time as local wall time with its time", () => {
    process.env.TZ = "Pacific/Auckland";
    const html = render("date-time", "2026-09-01T23:30");
    expect(html).toContain("mardi 1 septembre 2026");
    expect(html).toContain("23:30");
  });

  it("warns, without blocking, on a year below 1000", () => {
    const html = render("date", "0026-09-01");
    expect(html).toContain("Année inhabituelle (0026) : vérifiez la saisie.");
    expect(html).toContain("26");
  });

  it("warns on a date-time whose year is below 1000", () => {
    expect(render("date-time", "0026-09-01T10:00")).toContain("Année inhabituelle (0026)");
  });

  it("shows nothing for an empty or invalid value", () => {
    for (const value of [undefined, "", "2026-02-30", "not a date"]) {
      const html = render("date", value);
      expect(html).not.toContain("root_field-echo");
      expect(html).not.toContain("Année inhabituelle");
    }
  });

  it("shows nothing under a time input", () => {
    const html = render("time", "10:30");
    expect(html).not.toContain("root_field-echo");
  });
});
