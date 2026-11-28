// SPDX-License-Identifier: Apache-2.0

/**
 * `src/ui/tool-presentation.ts` (how a call is named, in the thread and the context panel),
 * and what counts as a lookup (`conversation-tools.ts`): `isPanelLookup`, `activityGroupOf`,
 * `endsInActivity`.
 */

import { describe, it, expect } from "bun:test";
import { BookOpenIcon, EyeIcon, FileTextIcon, PlugIcon, Trash2Icon, ZapIcon } from "lucide-react";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import { callPresentation, showCall } from "../src/ui/tool-presentation.ts";
import { activityGroupOf, endsInActivity, isPanelLookup } from "../src/ui/conversation-tools.ts";

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
  icons: [{ src: "https://example.test/gmail.svg" }],
} as const;

/** A proxied request's presentation, as the platform stamps it (`integration-tools.ts`). */
const apiCall = (method?: string, requests?: number): ToolPresentation => ({
  call: "proxied_request",
  ...(method ? { method } : {}),
  ...(requests ? { requests } : {}),
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
    const presentation = { call: "caller", subject: { kind: "user", id: "u1" } };
    expect(callPresentation({ resultProviderMetadata: { appstrate: { presentation } } })).toEqual(
      presentation,
    );
  });

  it("is undefined for a part without one, or a malformed one", () => {
    expect(callPresentation({ state: "input-available" })).toBeUndefined();
    expect(
      callPresentation({
        resultProviderMetadata: { appstrate: { presentation: { title: "List agents" } } },
      }),
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
        presentation: { call: "operation", method: "DELETE", tag: "Agents" },
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
          presentation: { call: "operation", method: "POST", tag: "Agents" },
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
          presentation: { call: "operation", method, tag: "Agents" },
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
          call: "operation",
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

  it("keeps an untranslated tag as the source names it", () => {
    const shown = showCall(
      {
        toolName: "invoke_operation",
        args: {},
        presentation: { call: "operation", method: "GET", tag: "Brand New" },
      },
      t,
    );
    expect(shown.label).toBe("Brand New · Lecture");
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
      integrationCall({ requests: [{ method: "GET", target }] }, apiCall("GET", 1)).idText;
    expect(one("https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread")).toBe(
      "/gmail/v1/users/me/messages",
    );
    expect(one("/users/me/labels?maxResults=5#top")).toBe("/users/me/labels");
    expect(integrationCall({ requests: [{}] }, apiCall("GET", 1)).idText).toBeUndefined();
  });

  it("names a batch by the number of requests the server counted", () => {
    const shown = integrationCall({ requests: [{}, {}, {}] }, apiCall(undefined, 3));
    expect(shown.label).toBe("Gmail · 3 requêtes");
    expect(shown.idText).toBeUndefined();
  });

  it("never shows the server's English text for a proxied request", () => {
    for (const shown of [
      integrationCall({ method: "GET" }, apiCall("GET")),
      integrationCall({ requests: [{}] }, apiCall(undefined, 1)),
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
          call: "remote_tool",
          title: "Search issues",
          subject: { kind: "integration", id: "@acme/github", display_name: "GitHub" },
        },
      },
      t,
    );
    expect(shown.label).toBe("GitHub · Search issues");
    expect(shown.idText).toBeUndefined();
  });

  it("keeps a remote tool's title whatever its name starts with", () => {
    const shown = showCall(
      {
        toolName: "call_integration_tool",
        args: { tool: "acme_github__api_search", arguments: {} },
        presentation: {
          call: "remote_tool",
          title: "Search code",
          subject: { kind: "integration", id: "@acme/github", display_name: "GitHub" },
        },
      },
      t,
    );
    expect(shown.label).toBe("GitHub · Search code");
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
    // A describe of several items names each of them.
    expect(
      showCall(
        { toolName: "describe", args: { kind: "operation", ids: ["listRuns", "getRun"] } },
        t,
      ),
    ).toMatchObject({ idText: "listRuns, getRun", Icon: BookOpenIcon });
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
            call: "caller",
            subject: { kind: "user", id: "u1", display_name: "Ada" },
          },
        },
        t,
      ),
    ).toMatchObject({ label: "Identité", idText: "Ada" });
  });

  it("falls back to the tool's name for a tool with no label", () => {
    expect(showCall({ toolName: "brand_new", args: {} }, t).label).toBe("brand_new");
  });

  it("names a search by its own tool", () => {
    expect(
      showCall(
        {
          toolName: "search",
          args: { query: "crm" },
          presentation: { call: "search", count: 2, items: [] },
        },
        t,
      ),
    ).toMatchObject({ idText: "crm" });
  });
});

describe("isPanelLookup", () => {
  const stamped = { appstrate: { lookup: true } };
  const presented = (method: string): ToolPresentation => ({ call: "operation", method });

  it("is a call stamped a lookup that has not failed", () => {
    for (const standing of ["running", "success"] as const) {
      expect(isPanelLookup(stamped, undefined, standing)).toBe(true);
    }
    expect(isPanelLookup(stamped, undefined, "error")).toBe(false);
    expect(isPanelLookup(stamped, undefined, "denied")).toBe(false);
  });

  it("is a call presented as a read (GET, HEAD), unless it failed or was denied", () => {
    expect(isPanelLookup(undefined, presented("GET"), "success")).toBe(true);
    expect(isPanelLookup(undefined, presented("head"), "success")).toBe(true);
    expect(isPanelLookup(undefined, presented("GET"), "error")).toBe(false);
    expect(isPanelLookup(undefined, presented("GET"), "denied")).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      expect(isPanelLookup(undefined, presented(method), "success")).toBe(false);
    }
  });

  it("is never an unstamped call presented without a read", () => {
    expect(isPanelLookup(undefined, undefined, "success")).toBe(false);
    expect(isPanelLookup({ appstrate: { lookup: false } }, presented("POST"), "success")).toBe(
      false,
    );
    expect(isPanelLookup({ appstrate: { spaceId: "spc_a" } }, undefined, "success")).toBe(false);
  });
});

describe("activityGroupOf", () => {
  const read = {
    type: "tool-call",
    toolName: "search",
    providerMetadata: { appstrate: { lookup: true } },
  };

  it("makes reasoning and every tool call one activity group, a lookup or not", () => {
    expect(activityGroupOf({ type: "reasoning" })).toEqual(["group-activity", "group-reasoning"]);
    expect(activityGroupOf(read)).toEqual(["group-activity"]);
    expect(activityGroupOf({ type: "tool-call", toolName: "invoke_operation" })).toEqual([
      "group-activity",
    ]);
    expect(activityGroupOf({ type: "text" })).toBeNull();
  });

  it("leaves a call whose card is its whole display out of any group", () => {
    expect(activityGroupOf({ type: "tool-call", toolName: "run_and_wait" })).toBeNull();
  });

  it("decides on the tool's name alone: a result or a failure moves nothing", () => {
    expect(activityGroupOf({ ...read, status: { type: "complete" }, isError: true })).toEqual([
      "group-activity",
    ]);
  });
});

describe("endsInActivity", () => {
  const read = { type: "tool-call", toolName: "search", toolCallId: "a" };

  it("is true when the last part belongs to an activity group", () => {
    expect(endsInActivity([read])).toBe(true);
    expect(endsInActivity([{ type: "text" }, { type: "reasoning" }])).toBe(true);
  });

  it("is false for an empty message, a text tail, or a card of its own", () => {
    expect(endsInActivity([])).toBe(false);
    expect(endsInActivity([read, { type: "text" }])).toBe(false);
    expect(endsInActivity([read, { type: "tool-call", toolName: "run_and_wait" }])).toBe(false);
  });
});
