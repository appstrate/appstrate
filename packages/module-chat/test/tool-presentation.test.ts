// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/tool-presentation.ts` (how a call is named, in the thread and the context panel),
 * and what counts as a lookup (`conversation-tools.ts`): `isLookupCall`, `activityGroupOf`.
 */

import { describe, it, expect } from "bun:test";
import { EyeIcon, FileTextIcon, PlugIcon, Trash2Icon, ZapIcon } from "lucide-react";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import { callPresentation, showCall } from "../src/ui/tool-presentation.ts";
import { activityGroupOf, isLookupCall } from "../src/ui/conversation-tools.ts";

/** The FR bundle's verbs and tags; a key it lacks shows its default value, else the key. */
const FR: Record<string, string> = {
  "tool.verb.GET": "Lecture",
  "tool.verb.POST": "Action",
  "tool.verb.PUT": "Mise à jour",
  "tool.verb.PATCH": "Modification",
  "tool.verb.DELETE": "Suppression",
  "tool.tag.Agents": "Agents",
  "tool.tag.Integrations": "Intégrations",
  "tool.name.invoke_operation": "Opération",
  "tool.name.get_me": "Identité",
  "tool.name.call_integration_tool": "Outil d’intégration",
  "tool.name.read_resource": "Lecture de ressource",
};
const t = (key: string, params?: Record<string, string | number>) =>
  key === "tool.requests"
    ? `${params?.count} requêtes`
    : (FR[key] ?? String(params?.defaultValue ?? key));

const GMAIL = {
  kind: "integration",
  id: "@appstrate/gmail",
  display_name: "Gmail",
  icon: "https://example.test/gmail.svg",
} as const;

/** A proxied request's presentation, as the platform stamps it (`integration-tools.ts`). */
const apiCall = (method?: string): ToolPresentation => ({
  title: "API call",
  ...(method ? { method } : {}),
  subject: GMAIL,
});

const integrationCall = (args: Record<string, unknown>, presentation: ToolPresentation) =>
  showCall(
    {
      toolName: "call_integration_tool",
      args: { tool: "appstrate_gmail__api_call", arguments: args },
      presentation,
    },
    t,
  );

describe("callPresentation", () => {
  it("reads the presentation off the result's provider metadata", () => {
    const presentation = { title: "List agents" };
    expect(callPresentation({ resultProviderMetadata: { appstrate: { presentation } } })).toEqual(
      presentation,
    );
  });

  it("is undefined for a part without one, or a malformed one", () => {
    expect(callPresentation({ state: "input-available" })).toBeUndefined();
    expect(
      callPresentation({ resultProviderMetadata: { appstrate: { presentation: { title: "" } } } }),
    ).toBeUndefined();
    expect(callPresentation(undefined)).toBeUndefined();
  });
});

describe("showCall — an operation", () => {
  it("names it « domain · verb », identified by its id", () => {
    const shown = showCall(
      {
        toolName: "invoke_operation",
        args: { operation_id: "deleteAgent" },
        presentation: { title: "Delete agent", method: "DELETE", tag: "Agents" },
      },
      t,
    );
    expect(shown).toMatchObject({ label: "Agents · Suppression", idText: "deleteAgent" });
    expect(shown.Icon).toBe(Trash2Icon);
  });

  it("gives POST a neutral verb, whatever the operation does", () => {
    for (const operation_id of ["createAgent", "cancelRun", "testWebhook", "restoreVersion"]) {
      const shown = showCall(
        {
          toolName: "invoke_operation",
          args: { operation_id },
          presentation: { title: "Anything", method: "POST", tag: "Agents" },
        },
        t,
      );
      expect(shown.label).toBe("Agents · Action");
      expect(shown.Icon).toBe(ZapIcon);
    }
  });

  it("tells a PUT from a PATCH", () => {
    const label = (method: string) =>
      showCall(
        {
          toolName: "invoke_operation",
          args: {},
          presentation: { title: "x", method, tag: "Agents" },
        },
        t,
      ).label;
    expect(label("PUT")).toBe("Agents · Mise à jour");
    expect(label("PATCH")).toBe("Agents · Modification");
  });

  it("is identified by the subject it acted on, an integration without name or logo included", () => {
    const shown = showCall(
      {
        toolName: "invoke_operation",
        args: { operation_id: "getIntegration" },
        presentation: {
          title: "Get integration",
          method: "GET",
          tag: "Integrations",
          subject: { kind: "integration", id: "@acme/crm" },
        },
      },
      t,
    );
    expect(shown).toMatchObject({ label: "Intégrations · Lecture", idText: "@acme/crm" });
    expect(shown.Icon).toBe(EyeIcon);
  });
});

describe("showCall — a call that reached an integration", () => {
  it("names a proxied request by its integration and its method's verb", () => {
    expect(integrationCall({ method: "GET" }, apiCall("GET"))).toMatchObject({
      label: "Gmail · Lecture",
      subject: GMAIL,
    });
    expect(integrationCall({ method: "DELETE" }, apiCall("DELETE")).label).toBe(
      "Gmail · Suppression",
    );
    expect(integrationCall({ method: "POST" }, apiCall("POST")).label).toBe("Gmail · Action");
  });

  it("is identified by the path of the one request it sends, without origin or query", () => {
    const one = (target: string) =>
      integrationCall({ requests: [{ method: "GET", target }] }, apiCall("GET")).idText;
    expect(one("https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread")).toBe(
      "/gmail/v1/users/me/messages",
    );
    expect(one("/users/me/labels?maxResults=5#top")).toBe("/users/me/labels");
    expect(integrationCall({ requests: [{}] }, apiCall("GET")).idText).toBeUndefined();
  });

  it("names a batch by the number of requests its arguments send", () => {
    const shown = integrationCall({ requests: [{}, {}, {}] }, apiCall());
    expect(shown.label).toBe("Gmail · 3 requêtes");
    expect(shown.idText).toBeUndefined();
  });

  it("never shows the server's English text for a proxied request", () => {
    for (const shown of [
      integrationCall({ method: "GET" }, apiCall("GET")),
      integrationCall({ requests: [{}] }, apiCall()),
      // Neither a method nor readable requests: the tool's own label, never the server's text.
      integrationCall({}, apiCall()),
      integrationCall({ requests: "garbled" }, apiCall()),
      showCall({ toolName: "call_integration_tool", args: {}, presentation: apiCall() }, t),
    ]) {
      expect(shown.label).not.toContain("API call");
    }
    expect(integrationCall({}, apiCall()).label).toBe("Gmail · Outil d’intégration");
  });

  it("names a remote tool by its integration and its server's title", () => {
    const shown = showCall(
      {
        toolName: "call_integration_tool",
        // A remote tool's own `requests` argument is not a batch.
        args: { tool: "acme_github__search_issues", arguments: { requests: [1, 2] } },
        presentation: {
          title: "Search issues",
          subject: { kind: "integration", id: "@acme/github", display_name: "GitHub" },
        },
      },
      t,
    );
    expect(shown.label).toBe("GitHub · Search issues");
    expect(shown.idText).toBeUndefined();
  });
});

describe("showCall — any other tool", () => {
  it("names a call by its own tool and arguments until a presentation lands", () => {
    expect(
      showCall({ toolName: "invoke_operation", args: { operation_id: "deleteAgent" } }, t),
    ).toMatchObject({ label: "Opération", idText: "deleteAgent", Icon: ZapIcon });
    expect(
      showCall({ toolName: "run_and_wait", args: { scope: "@acme", name: "triage" } }, t),
    ).toMatchObject({ label: "run_and_wait", idText: "@acme/triage" });
    // The tool's own name: the namespace (never holding `__`) is a lossy cut of the package id.
    expect(
      showCall(
        { toolName: "call_integration_tool", args: { tool: "acme_crm__find__by_email" } },
        t,
      ),
    ).toMatchObject({ label: "Outil d’intégration", idText: "find__by_email", Icon: PlugIcon });
  });

  it("names a resource read by its own tool, identified by its uri", () => {
    expect(
      showCall({ toolName: "read_resource", args: { uri: "appstrate://agents/@acme/triage" } }, t),
    ).toMatchObject({
      label: "Lecture de ressource",
      idText: "appstrate://agents/@acme/triage",
      Icon: FileTextIcon,
    });
  });

  it("keeps its own name, identified by the subject it acted on", () => {
    expect(
      showCall(
        {
          toolName: "get_me",
          args: {},
          presentation: {
            title: "Who am I",
            subject: { kind: "user", id: "u1", display_name: "Ada" },
          },
        },
        t,
      ),
    ).toMatchObject({ label: "Identité", idText: "Ada" });
  });

  it("falls back to the presented title, then the tool's name, for a tool with no label", () => {
    expect(
      showCall({ toolName: "brand_new", args: {}, presentation: { title: "New" } }, t).label,
    ).toBe("New");
    expect(showCall({ toolName: "brand_new", args: {} }, t).label).toBe("brand_new");
  });
});

describe("isLookupCall", () => {
  const stamped = { appstrate: { lookup: true } };
  const presented = (method: string): ToolPresentation => ({ title: "x", method });

  it("is a call stamped a lookup that has not failed", () => {
    for (const standing of ["running", "success"] as const) {
      expect(isLookupCall(stamped, undefined, standing)).toBe(true);
    }
    expect(isLookupCall(stamped, undefined, "error")).toBe(false);
    expect(isLookupCall(stamped, undefined, "denied")).toBe(false);
  });

  it("is a call presented as a read (GET, HEAD), unless it failed or was denied", () => {
    expect(isLookupCall(undefined, presented("GET"), "success")).toBe(true);
    expect(isLookupCall(undefined, presented("head"), "success")).toBe(true);
    expect(isLookupCall(undefined, presented("GET"), "error")).toBe(false);
    expect(isLookupCall(undefined, presented("GET"), "denied")).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isLookupCall(undefined, presented(method), "success")).toBe(false);
    }
  });

  it("is never an unstamped call presented without a read", () => {
    expect(isLookupCall(undefined, undefined, "success")).toBe(false);
    expect(isLookupCall({ appstrate: { lookup: false } }, { title: "x" }, "success")).toBe(false);
    expect(isLookupCall({ appstrate: { spaceId: "spc_a" } }, undefined, "success")).toBe(false);
  });
});

describe("activityGroupOf", () => {
  const read = { type: "tool-call", providerMetadata: { appstrate: { lookup: true } } };

  it("folds reasoning and stamped lookups into the activity group", () => {
    expect(activityGroupOf({ type: "reasoning" })).toEqual(["group-activity", "group-reasoning"]);
    expect(activityGroupOf(read)).toEqual(["group-activity"]);
  });

  it("never folds an unstamped call, a read whose method lands with its result included", () => {
    expect(activityGroupOf({ type: "tool-call" })).toBeNull();
    expect(
      activityGroupOf({ type: "tool-call", status: { type: "complete" }, result: { content: [] } }),
    ).toBeNull();
    expect(activityGroupOf({ type: "text" })).toBeNull();
  });

  it("keeps a failed lookup in its group: membership is the pre-call stamp alone", () => {
    expect(activityGroupOf({ ...read, status: { type: "complete" }, isError: true })).toEqual([
      "group-activity",
    ]);
  });
});
