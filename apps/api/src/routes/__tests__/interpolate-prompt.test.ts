import { describe, test, expect } from "bun:test";
import { interpolatePrompt } from "../executions.ts";

describe("interpolatePrompt", () => {
  test("replaces {{config.*}} variables", () => {
    const result = interpolatePrompt("List: {{config.list_id}}", { list_id: "abc" }, {});
    expect(result).toBe("List: abc");
  });

  test("replaces {{state.*}} variables", () => {
    const result = interpolatePrompt(
      "Last run: {{state.last_run}}",
      {},
      { last_run: "2025-01-01" },
    );
    expect(result).toBe("Last run: 2025-01-01");
  });

  test("replaces {{input.*}} variables", () => {
    const result = interpolatePrompt("Topic: {{input.topic}}", {}, {}, { topic: "AI" });
    expect(result).toBe("Topic: AI");
  });

  test("handles {{#if state.*}} ... {{/if}} blocks", () => {
    const prompt = "{{#if state.last_run}}Since {{state.last_run}}{{/if}}";
    expect(interpolatePrompt(prompt, {}, { last_run: "2025-01-01" })).toBe("Since 2025-01-01");
    expect(interpolatePrompt(prompt, {}, {})).toBe("");
  });

  test("handles {{#if state.*}} ... {{else}} ... {{/if}} blocks", () => {
    const prompt = "{{#if state.last_run}}Since {{state.last_run}}{{else}}First run{{/if}}";
    expect(interpolatePrompt(prompt, {}, { last_run: "2025-01-01" })).toBe("Since 2025-01-01");
    expect(interpolatePrompt(prompt, {}, {})).toBe("First run");
  });

  test("handles {{#if config.*}} (previously unsupported)", () => {
    const prompt =
      "{{#if config.clickup_list_id}}List: {{config.clickup_list_id}}{{else}}All workspace{{/if}}";
    expect(interpolatePrompt(prompt, { clickup_list_id: "123" }, {})).toBe("List: 123");
    expect(interpolatePrompt(prompt, {}, {})).toBe("All workspace");
  });

  test("missing variables resolve to empty string", () => {
    const result = interpolatePrompt("Value: {{config.missing}}", {}, {});
    expect(result).toBe("Value: ");
  });

  test("does not HTML-escape values (noEscape)", () => {
    const result = interpolatePrompt("{{config.val}}", { val: "<b>bold</b>" }, {});
    expect(result).toBe("<b>bold</b>");
  });

  test("handles complex prompt with multiple namespaces", () => {
    const prompt = [
      "Config: {{config.language}}",
      "State: {{state.last_run}}",
      "Input: {{input.topic}}",
      "{{#if state.last_run}}Has state{{else}}No state{{/if}}",
    ].join("\n");

    const result = interpolatePrompt(
      prompt,
      { language: "fr" },
      { last_run: "2025-06-01" },
      { topic: "AI" },
    );

    expect(result).toContain("Config: fr");
    expect(result).toContain("State: 2025-06-01");
    expect(result).toContain("Input: AI");
    expect(result).toContain("Has state");
  });
});
