// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, spyOn } from "bun:test";
import type { ComponentProps, MouseEvent } from "react";
import { Route, Routes } from "react-router-dom";
import { QueryClient } from "@tanstack/react-query";
import type { Middleware } from "openapi-fetch";
import { Button } from "@appstrate/ui/components/button";
import { installFakeStorage } from "../../test/fake-storage.ts";
import { packageKeys, runKeys } from "../../lib/query-keys.ts";

installFakeStorage({ __APP_CONFIG__: { features: {}, trustedOrigins: [] } });

const { RunDetailPage } = await import("../run-detail.tsx");
const { RunModal } = await import("../../components/run-modal.tsx");
const { client, $api } = await import("../../api/client.ts");
const { orgStore } = await import("../../stores/org-store.ts");
const { spaceStore } = await import("../../stores/space-store.ts");
const { render } = await import("../../test/render.tsx");
const { default: i18n, i18nReady } = await import("../../i18n.ts");
await i18nReady;
await i18n.changeLanguage("fr");

const ORG = "org_rerun";
const SPACE = "space_rerun";
const RUN = "run_incident_42";
const AGENT = "@acme/reporter";

async function withPage(
  options: { canReadAgent: boolean; inline?: boolean; version?: string },
  check: (page: {
    buttons: ComponentProps<typeof Button>[];
    modals: ComponentProps<typeof RunModal>[];
    requests: Request[];
    request: Promise<Request>;
  }) => Promise<void>,
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const orgSnapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG,
  });
  const spaceSnapshot = spyOn(spaceStore, "getInitialState").mockReturnValue({
    ...spaceStore.getInitialState(),
    id: SPACE,
  });
  qc.setQueryData(["orgs"], [{ id: ORG, role: "member", permissions: [] }]);
  qc.setQueryData(
    $api.queryOptions("get", "/api/spaces", {
      params: { header: { "X-Org-Id": ORG } },
    }).queryKey,
    {
      object: "list",
      data: [
        {
          id: SPACE,
          access: "member",
          permissions: ["agents:run", ...(options.canReadAgent ? ["agents:read"] : [])],
        },
      ],
      hasMore: false,
    },
  );
  const packageId = options.inline ? "@inline/incident" : AGENT;
  qc.setQueryData(packageKeys.detail("agents", ORG, SPACE, packageId), {
    id: packageId,
    display_name: "Reporter",
    input: {
      schema: { type: "object", properties: { topic: { type: "string", default: "weekly" } } },
    },
  });
  qc.setQueryData(runKeys.detail(ORG, SPACE, RUN), {
    id: RUN,
    packageId,
    status: "success",
    runNumber: 42,
    started_at: "2026-09-11T10:00:00Z",
    duration: 1000,
    input: options.canReadAgent ? { topic: "incident-42" } : null,
    version_ref: options.version ?? "1.2.3",
    file_counts: { input: 0, output: 0 },
    package_ephemeral: options.inline ?? false,
    cost: null,
    token_usage: null,
    result: null,
  });
  qc.setQueryData(runKeys.logs(ORG, SPACE, RUN), []);

  const requests: Request[] = [];
  const pendingRequest = Promise.withResolvers<Request>();
  // Bun's Request needs an absolute URL; browsers resolve this same-origin
  // path themselves. Keep the real client's serialization and middleware.
  const post = client.POST;
  const transport = spyOn(client, "POST").mockImplementation((path, ...[init]) =>
    Reflect.apply(post, client, [path, { ...init, baseUrl: "https://app.example.test" }]),
  );
  const middleware: Middleware = {
    onRequest({ request }) {
      requests.push(request);
      pendingRequest.resolve(request);
      return Response.json({ id: "run_replayed" }, { status: 201 });
    },
  };
  client.use(middleware);
  const buttons: ComponentProps<typeof Button>[] = [];
  const modals: ComponentProps<typeof RunModal>[] = [];
  // Capture the page's real event handlers while the existing SSR harness
  // supplies its router and query providers. Only the two UI leaves are
  // replaced; useRunAgent and the typed HTTP serializer run unchanged.
  function RerunButton(props: ComponentProps<typeof Button>) {
    buttons.push(props);
    return <Button {...props} />;
  }
  function InputModal(props: ComponentProps<typeof RunModal>) {
    modals.push(props);
    return null;
  }
  try {
    render(
      <Routes>
        <Route
          path="/agents/:scope/:name/runs/:runId"
          element={<RunDetailPage RerunButton={RerunButton} InputModal={InputModal} />}
        />
      </Routes>,
      { queryClient: qc, initialEntries: [`/agents/${packageId}/runs/${RUN}`] },
    );
    await check({ buttons, modals, requests, request: pendingRequest.promise });
  } finally {
    client.eject(middleware);
    transport.mockRestore();
    orgSnapshot.mockRestore();
    spaceSnapshot.mockRestore();
    qc.clear();
  }
}

describe("run detail rerun", () => {
  it.each(["draft", "1.2.3"])(
    "replays concealed input server-side at version %s",
    async (version) => {
      await withPage({ canReadAgent: false, version }, async ({ buttons, modals, request }) => {
        expect(buttons).toHaveLength(1);
        expect(buttons[0]!.disabled).not.toBe(true);
        buttons[0]!.onClick!({} as MouseEvent<HTMLButtonElement>);
        expect(modals).toHaveLength(0);
        const sent = await request;
        expect(sent.method).toBe("POST");
        expect(sent.url).toBe(
          `https://app.example.test/api/agents/${AGENT}/run?version=${version}`,
        );
        expect(await sent.json()).toEqual({ rerun_from: RUN });
      });
    },
  );

  it("keeps the editor's original input and submits the edited values", async () => {
    await withPage({ canReadAgent: true }, async ({ buttons, modals, requests, request }) => {
      expect(buttons).toHaveLength(1);
      buttons[0]!.onClick!({} as MouseEvent<HTMLButtonElement>);
      expect(requests).toHaveLength(0);
      expect(modals).toHaveLength(1);
      expect(modals[0]!.initialInput).toEqual({ topic: "incident-42" });
      modals[0]!.onSubmit({ topic: "incident-43" });
      const sent = await request;
      expect(sent.url).toBe(`https://app.example.test/api/agents/${AGENT}/run?version=1.2.3`);
      expect(await sent.json()).toEqual({ input: { topic: "incident-43" } });
    });
  });

  it("keeps inline runs without a rerun action", async () => {
    await withPage({ canReadAgent: false, inline: true }, async ({ buttons, requests }) => {
      expect(buttons).toHaveLength(0);
      expect(requests).toHaveLength(0);
    });
  });
});
