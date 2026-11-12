// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { ErrorCode, McpError, ResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createInProcessPair,
  createMcpServer,
  type AppstrateResourceProvider,
} from "../src/index.ts";
import type { SkillEntry } from "@appstrate/core/skill-uri";

const ENTRY: SkillEntry = {
  uri: "skill://space/acme/refunds/refunds/SKILL.md",
  frontmatter: { name: "refunds", description: "Process refunds" },
  resources: [
    {
      uri: "skill://space/acme/refunds/refunds/SKILL.md",
      digest: `sha256:${"0".repeat(64)}`,
      size: 42,
    },
  ],
};

const resources: AppstrateResourceProvider = {
  read: (uri) => ({ contents: [{ uri, mimeType: "text/markdown", text: "" }] }),
};

const skills = {
  list: () => [ENTRY],
  get: (uri: string) => {
    if (uri === ENTRY.uri) return ENTRY;
    throw new McpError(ErrorCode.InvalidParams, `Unknown skill: ${uri}`);
  },
};

describe("createMcpServer — skills extension (SEP-2640)", () => {
  it("declares the extension next to the resources capability", async () => {
    const pair = await createInProcessPair([], { resources, skills });
    try {
      const caps = pair.client.getServerCapabilities();
      expect(caps?.resources).toBeDefined();
      expect(caps?.extensions?.["io.modelcontextprotocol/skills"]).toEqual({});
    } finally {
      await pair.close();
    }
  });

  it("does not declare the extension without a skill provider", async () => {
    const pair = await createInProcessPair([], { resources });
    try {
      expect(pair.client.getServerCapabilities()?.extensions).toBeUndefined();
    } finally {
      await pair.close();
    }
  });

  it("answers skills/list and skills/get with no attribute of a later protocol revision", async () => {
    const pair = await createInProcessPair([], { resources, skills });
    try {
      const list = await pair.client.request({ method: "skills/list", params: {} }, ResultSchema);
      expect(list).toEqual({ skills: [ENTRY] });
      const get = await pair.client.request(
        { method: "skills/get", params: { uri: ENTRY.uri } },
        ResultSchema,
      );
      expect(get).toEqual({ skill: ENTRY });
    } finally {
      await pair.close();
    }
  });

  it("refuses skills/get without a uri or for an unknown skill with -32602", async () => {
    const pair = await createInProcessPair([], { resources, skills });
    try {
      for (const params of [{}, { uri: "skill://space/acme/other/other/SKILL.md" }]) {
        const err = await pair.client.request({ method: "skills/get", params }, ResultSchema).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(McpError);
        expect((err as McpError).code).toBe(ErrorCode.InvalidParams);
      }
    } finally {
      await pair.close();
    }
  });

  it("keeps answering unknown methods with -32601", async () => {
    const pair = await createInProcessPair([], { resources, skills });
    try {
      const err = await pair.client
        .request({ method: "skills/unknown", params: {} }, ResultSchema)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(McpError);
      expect((err as McpError).code).toBe(ErrorCode.MethodNotFound);
    } finally {
      await pair.close();
    }
  });

  it("rejects a skill provider without a resource provider", () => {
    expect(() => createMcpServer([], undefined, { skills })).toThrow(
      "the skills extension requires a resource provider",
    );
  });
});
