// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { describe, it, expect } from "bun:test";
import {
  VERSION,
  executionContextSchema,
  renderTemplate,
  renderPrompt,
  reduceEvents,
} from "../src/index.ts";

describe("public surface", () => {
  it("exports VERSION matching package.json", () => {
    expect(VERSION).toBe("0.0.0");
  });

  it("exports the ExecutionContext Zod schema", () => {
    expect(executionContextSchema).toBeDefined();
    expect(typeof executionContextSchema.safeParse).toBe("function");
  });

  it("exports the template + bundle render surface", () => {
    expect(typeof renderTemplate).toBe("function");
    expect(typeof renderPrompt).toBe("function");
  });

  it("exports the canonical reduceEvents reducer", () => {
    expect(typeof reduceEvents).toBe("function");
  });
});
