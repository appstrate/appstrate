// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FormField } from "../form-field";

describe("FormField native controls", () => {
  for (const type of ["text", "number", "url", "password", "textarea"] as const) {
    it(`preserves ${type} values, constraints and label/help associations`, () => {
      const html = renderToStaticMarkup(
        <FormField
          id="field"
          label="Label"
          type={type}
          value="42"
          onChange={() => {}}
          required
          disabled
          min={2}
          description="Help"
          placeholder="Placeholder"
        />,
      );
      expect(html).toContain('for="field"');
      expect(html).toContain('id="field"');
      expect(html).toContain('aria-describedby="field-hint"');
      expect(html).toContain('id="field-hint"');
      expect(html).toContain('disabled=""');
      expect(html).toContain('required=""');
      expect(html).toContain('placeholder="Placeholder"');
      if (type === "textarea") {
        expect(html).toContain('rows="4"');
        expect(html).toContain(">42</textarea>");
      } else {
        expect(html).toContain(`type="${type}"`);
        expect(html).toContain('value="42"');
        expect(html).toContain('min="2"');
      }
    });
  }
});
