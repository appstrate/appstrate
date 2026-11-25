// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "bun:test";
import { EyeIcon, Trash2Icon } from "lucide-react";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import {
  methodIcon,
  operationLabel,
  presentCall,
  presentationOf,
} from "../src/ui/tool-presentation.ts";
import { activityGroupOf, isFoldableRead } from "../src/ui/activity-group.ts";

/** A translator that shows the key, or the default value it was handed. */
const t = (key: string, params?: Record<string, string | number>) =>
  key === "tool.verb.GET"
    ? "Lecture"
    : key === "tool.tag.Agents"
      ? "Agents"
      : String(params?.defaultValue ?? key);

const base: ToolPresentation = { title: "List agents", read_only: true, destructive: false };

describe("presentationOf", () => {
  it("reads the presentation the engine relayed", () => {
    expect(presentationOf({ content: [], presentation: base })).toEqual(base);
  });

  it("is undefined for a result without one, or a malformed one", () => {
    expect(presentationOf({ content: [] })).toBeUndefined();
    expect(presentationOf({ presentation: { title: "" } })).toBeUndefined();
    expect(presentationOf(undefined)).toBeUndefined();
  });
});

describe("presentCall", () => {
  it("names an integration call by the integration and its tool's title", () => {
    const call = presentCall(
      {
        ...base,
        title: "Search issues",
        subject: { kind: "integration", id: "@acme/github", display_name: "GitHub" },
      },
      t,
      "Outil",
    );
    expect(call.label).toBe("GitHub · Search issues");
    expect(call.subject?.id).toBe("@acme/github");
  });

  it("names an operation by its method's verb and its translated tag", () => {
    const call = presentCall({ ...base, method: "GET", tag: "Agents" }, t, "Opération");
    expect(call.label).toBe("Lecture · Agents");
    expect(call.Icon).toBe(EyeIcon);
    expect(call.idText).toBe("List agents");
  });

  it("shows the subject an operation acted on as its id", () => {
    const call = presentCall(
      { ...base, method: "GET", tag: "Agents", subject: { kind: "agent", id: "@acme/bot" } },
      t,
      "Opération",
    );
    expect(call.idText).toBe("@acme/bot");
  });

  it("keeps an untranslated tag as the source names it", () => {
    expect(operationLabel({ ...base, method: "GET", tag: "Brand New" }, t)).toBe(
      "Lecture · Brand New",
    );
  });

  it("keeps the tool's own label for a tool with no method or integration", () => {
    const call = presentCall(
      { ...base, title: "Who am I", subject: { kind: "user", id: "u1", display_name: "Ada" } },
      t,
      "Identité",
    );
    expect(call.label).toBe("Identité");
    expect(call.idText).toBe("Ada");
  });
});

describe("methodIcon", () => {
  it("maps the verbs, and nothing for an unknown method", () => {
    expect(methodIcon("delete")).toBe(Trash2Icon);
    expect(methodIcon("OPTIONS")).toBeUndefined();
  });
});

describe("activityGroupOf", () => {
  const read = { type: "tool-call", providerMetadata: { appstrate: { readOnly: true } } };

  it("folds reasoning and stamped reads into the activity group", () => {
    expect(activityGroupOf({ type: "reasoning" })).toEqual(["group-activity", "group-reasoning"]);
    expect(activityGroupOf(read)).toEqual(["group-activity"]);
  });

  it("never folds a write, an unstamped call or text", () => {
    expect(activityGroupOf({ type: "tool-call" })).toBeNull();
    expect(
      activityGroupOf({ type: "tool-call", providerMetadata: { appstrate: { readOnly: false } } }),
    ).toBeNull();
    expect(activityGroupOf({ type: "text" })).toBeNull();
  });

  it("keeps a failed read out of the group, so its error stays inline", () => {
    expect(isFoldableRead({ ...read, status: { type: "complete" }, isError: true })).toBe(false);
    expect(
      isFoldableRead({
        ...read,
        status: { type: "complete" },
        result: {
          content: [{ type: "text", text: JSON.stringify({ status: 404, error: "nope" }) }],
        },
      }),
    ).toBe(false);
    expect(isFoldableRead({ ...read, status: { type: "complete" }, result: { content: [] } })).toBe(
      true,
    );
  });
});
