// SPDX-License-Identifier: Apache-2.0
import { Link } from "react-router-dom";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  Background,
  type Node,
  type NodeProps,
  type Edge,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  Plug,
  Bot,
  Server,
  Globe,
  KeyRound,
  ShieldCheck,
  Package,
  Wrench,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type { IntegrationDetailWire } from "../../hooks/use-integrations";
import { readIntegrationSource } from "../../lib/package-manifest";
import { MapCard, MapRow, BoundaryNode } from "../map-primitives";
import { MapControls } from "../map-controls";
import { styleMapEdge } from "../map-edge";
import { Modal } from "../modal";
import { CopyBlock } from "../copy-block";
import { SettingValue } from "../settings/setting-row";
import { packageDetailPath } from "../../lib/package-paths";
import { usePackageDetail } from "../../hooks/use-packages";
import { useIntegrationClients } from "../../hooks/use-integrations";
import { usePermissions } from "../../hooks/use-permissions";
import { authMethodLabel } from "../../lib/integration-presentation";
import { connectionDisplayLabel } from "../integration-connect/connection-label";

function accessInfo(detail: IntegrationDetailWire) {
  const source = readIntegrationSource(detail.manifest.source);
  const meta = detail.manifest._meta as Record<string, unknown> | undefined;
  const api = meta?.["dev.appstrate/api"] as { auths?: Record<string, unknown> } | undefined;
  const apiKeys = Object.keys(api?.auths ?? {});
  const mcp = source?.kind === "local" || source?.kind === "remote";
  return {
    source,
    apiKeys,
    type: mcp ? (apiKeys.length ? "both" : "mcp") : apiKeys.length ? "api" : "none",
  };
}

export function IntegrationFunctioning({ detail }: { detail: IntegrationDetailWire }) {
  const { t } = useTranslation("settings");
  const { source, apiKeys, type } = accessInfo(detail);
  return (
    <dl>
      <SettingValue label={t("integration.structure.access")}>
        {t(`integration.structure.type.${type}`)}
      </SettingValue>
      {source && source.kind !== "none" && (
        <SettingValue label={t("integration.structure.hosting")}>
          {t(
            source.kind === "local"
              ? "integration.structure.local"
              : "integration.structure.remote",
          )}
        </SettingValue>
      )}
      {source?.kind === "local" && (
        <SettingValue label={t("integration.structure.serverPackage")}>
          <Link
            className="text-primary hover:underline"
            to={packageDetailPath("mcp-server", source.serverName)}
          >
            {source.serverName}
          </Link>{" "}
          {source.serverVersion}
        </SettingValue>
      )}
      {source?.kind === "remote" && (
        <SettingValue label={t("integration.structure.url")}>
          <CopyBlock value={source.url} />
        </SettingValue>
      )}
      {apiKeys.map((key) => (
        <SettingValue
          key={key}
          label={
            <>
              {t("integration.structure.addresses")} · {key}
            </>
          }
        >
          {(detail.manifest.auths?.[key]?.authorized_uris ?? []).map((uri) => (
            <CopyBlock key={uri} value={uri} />
          ))}
        </SettingValue>
      ))}
    </dl>
  );
}

type MapItemRow = { id: string; label: string; sublabel?: string; href?: string; warning?: string };
type StructureNodeData = {
  title: string;
  rows: MapItemRow[];
  icon: LucideIcon;
  explanation: string;
  emptyLabel: string;
  onOpen?: () => void;
  actionLabel: string;
  count?: number;
  relationId?: string;
  onRelationActive?: (id: string | null) => void;
  packageId?: string;
  authKey?: string;
};
function StructureNode({ data }: NodeProps<Node<StructureNodeData>>) {
  const Icon = data.icon;
  return (
    <MapCard
      title={data.title}
      concept={{ title: data.title, body: data.explanation }}
      count={data.count}
      emptyLabel={data.emptyLabel}
      relationId={data.relationId}
      onRelationActive={data.onRelationActive}
      icon={<Icon />}
      targets={["left", "top", "bottom", "right"]}
      sources={["right", "bottom", "top", "left"]}
      action={
        data.onOpen ? { icon: "open", label: data.actionLabel, onClick: data.onOpen } : undefined
      }
    >
      {data.rows.map((row) => (
        <MapRow
          key={row.id}
          label={row.label}
          sublabel={row.sublabel}
          href={row.href}
          onClick={row.href ? undefined : data.onOpen}
          right={
            row.warning ? (
              <span className="text-warning shrink-0" title={row.warning} aria-label={row.warning}>
                <TriangleAlert className="size-3.5" />
              </span>
            ) : undefined
          }
        />
      ))}
    </MapCard>
  );
}
function OAuthClientsNode(props: NodeProps<Node<StructureNodeData>>) {
  const { t } = useTranslation("settings");
  const { can } = usePermissions();
  const clients = useIntegrationClients(
    can("integrations:configure") ? props.data.packageId : undefined,
    props.data.authKey,
  );
  const message = !can("integrations:configure")
    ? t("integration.structure.clientsAdminOnly")
    : clients.isLoading
      ? t("integration.structure.loading")
      : clients.isError
        ? t("integration.structure.unavailable")
        : null;
  const rows = message
    ? [{ id: "status", label: message }]
    : (clients.data ?? []).map((client) => ({
        id: client.client_ref,
        label: client.client_id,
        sublabel: client.is_default ? t("integration.structure.defaultClient") : undefined,
      }));
  return (
    <StructureNode
      {...props}
      data={{ ...props.data, rows, count: message ? undefined : clients.data?.length }}
    />
  );
}
const nodeTypes = { structure: StructureNode, clients: OAuthClientsNode, boundary: BoundaryNode };

export function IntegrationMap({
  detail,
  packageId,
  renderPanel,
}: {
  detail: IntegrationDetailWire;
  packageId: string;
  renderPanel: (section: string, openPanel: (section: string) => void) => ReactNode;
}) {
  const { t } = useTranslation("settings");
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<string | null>(null);
  const open = useCallback((section: string) => setPanel(section), []);
  const [hoveredRelation, setHoveredRelation] = useState<string | null>(null);
  const [selectedRelation, setSelectedRelation] = useState<string | null>(null);
  const activeRelation = hoveredRelation ?? selectedRelation;
  const onRelationActive = useCallback((id: string | null) => setHoveredRelation(id), []);
  const { data: pkg } = usePackageDetail("integration", packageId);
  const projected = useMemo(() => {
    const { source, type } = accessInfo(detail);
    const labelFor = (auth: IntegrationDetailWire["auths"][number]) =>
      authMethodLabel(auth, detail.auths, t(`integration.auth.type.${auth.type}`));
    type Item = {
      id: string;
      title: string;
      rows: MapItemRow[];
      icon: LucideIcon;
      concept: string;
      section: string;
      authKey?: string;
      count?: number;
      nodeType?: string;
    };
    const bundleItems: Item[] = [
      {
        id: "package",
        title: t("integration.structure.package"),
        rows: [
          {
            id: "package",
            label: detail.manifest.display_name ?? detail.manifest.name,
            sublabel: detail.manifest.version,
          },
        ],
        icon: Package,
        concept: "package",
        section: "files",
      },
      ...detail.auths.map((auth) => ({
        id: `auth:${auth.auth_key}`,
        title: labelFor(auth),
        rows: [
          {
            id: auth.auth_key,
            label: t(auth.required ? "integration.auth.required" : "integration.auth.optional"),
            sublabel: auth.scopes.join(" · ") || undefined,
          },
        ],
        icon: KeyRound,
        concept: "auth",
        section: `auth:${auth.auth_key}`,
        authKey: auth.auth_key,
      })),
      {
        id: "tools",
        title: t("integration.tabs.tools"),
        rows: (detail.tool_catalog ?? []).map((tool) => ({
          id: tool.name,
          label: tool.name,
          sublabel: tool.description,
        })),
        icon: Wrench,
        concept: "tools",
        section: "tools",
        count: detail.tool_catalog?.length ?? 0,
      },
    ];
    const configItems: Item[] = detail.auths.flatMap((auth) => [
      {
        id: `accounts:${auth.auth_key}`,
        title: `${t("integration.structure.accounts")} · ${labelFor(auth)}`,
        rows: auth.connections.map((connection) => ({
          id: connection.id,
          label: connectionDisplayLabel(connection),
          sublabel: labelFor(auth),
          warning: connection.needs_reconnection
            ? t("integration.health.reconnect", { method: labelFor(auth), count: 1 })
            : undefined,
        })),
        icon: Plug,
        concept: "accounts",
        section: `connections:${auth.auth_key}`,
        authKey: auth.auth_key,
        count: auth.connections.length,
      },
      ...(auth.type === "oauth2"
        ? [
            {
              id: `clients:${auth.auth_key}`,
              title: `${t("integration.structure.clients")} · ${labelFor(auth)}`,
              rows: [] as MapItemRow[],
              icon: KeyRound,
              concept: "clients",
              section: `auth:${auth.auth_key}`,
              authKey: auth.auth_key,
              nodeType: "clients",
            },
          ]
        : []),
    ]);
    configItems.push({
      id: "access",
      title: t("integration.admin.accessRules.title"),
      rows: [
        {
          id: "access",
          label: t(
            detail.block_user_connections
              ? "integration.structure.adminConnections"
              : "integration.structure.memberConnections",
          ),
        },
      ],
      icon: ShieldCheck,
      concept: "access",
      section: "access",
    });
    const configHeight = 110 + Math.ceil(configItems.length / 3) * 246;
    const bundleHeight = 110 + Math.ceil(bundleItems.length / 3) * 246;
    const bundleY = configHeight + 110;
    const boundary = (
      id: string,
      x: number,
      y: number,
      width: number,
      height: number,
      label: string,
      description: string,
    ): Node => ({
      id,
      type: "boundary",
      position: { x, y },
      zIndex: 0,
      style: { width, height },
      data: { label, description },
    });
    const nodes: Node[] = [
      boundary(
        "source-boundary",
        0,
        bundleY,
        280,
        bundleHeight,
        t("integration.structure.source"),
        t("integration.structure.sourceDescription"),
      ),
      boundary(
        "configuration-boundary",
        410,
        0,
        740,
        configHeight,
        t("integration.structure.configuration"),
        t("integration.structure.configurationDescription"),
      ),
      boundary(
        "bundle-boundary",
        410,
        bundleY,
        740,
        bundleHeight,
        t("integration.structure.bundle"),
        t("integration.structure.bundleDescription"),
      ),
      boundary(
        "agents-boundary",
        1280,
        bundleY,
        280,
        bundleHeight,
        t("integration.overview.usage"),
        t("integration.structure.agentsDescription"),
      ),
    ];
    const parents = new Map<string, string>();
    const addItem = (item: Item, parentId: string, x: number, y: number) => {
      parents.set(item.id, parentId);
      nodes.push({
        id: item.id,
        type: item.nodeType ?? "structure",
        parentId,
        // Keep interactive cards above their contextual edges, as in the agent map.
        zIndex: 4,
        extent: "parent",
        position: { x, y },
        data: {
          title: item.title,
          rows: item.rows,
          icon: item.icon,
          explanation: t(`integration.structure.concept.${item.concept}`),
          emptyLabel: t(`integration.structure.empty.${item.concept}`),
          count: item.count,
          packageId,
          authKey: item.authKey,
          relationId: item.id,
          onRelationActive,
          actionLabel: item.title,
          onOpen: item.section === "agents" ? undefined : () => open(item.section),
        },
      });
    };
    addItem(
      {
        id: "source",
        title: t("integration.structure.source"),
        rows: [
          {
            id: "source",
            label:
              source?.kind === "local"
                ? source.serverName
                : source?.kind === "remote"
                  ? source.url
                  : t(`integration.structure.type.${type}`),
            sublabel:
              source?.kind === "local"
                ? `${t("integration.structure.local")} · ${source.serverVersion}`
                : source?.kind === "remote"
                  ? t("integration.structure.remote")
                  : undefined,
            href:
              source?.kind === "local"
                ? packageDetailPath("mcp-server", source.serverName)
                : undefined,
          },
        ],
        icon: source?.kind === "local" ? Server : Globe,
        concept: "source",
        section: "functioning",
      },
      "source-boundary",
      35,
      110,
    );
    configItems.forEach((item, i) =>
      addItem(item, "configuration-boundary", 25 + (i % 3) * 240, 110 + Math.floor(i / 3) * 246),
    );
    bundleItems.forEach((item, i) =>
      addItem(item, "bundle-boundary", 25 + (i % 3) * 240, 110 + Math.floor(i / 3) * 246),
    );
    addItem(
      {
        id: "agents",
        title: t("integration.overview.usage"),
        rows:
          pkg?.agents.map((agent) => ({
            id: agent.id,
            label: agent.display_name || agent.id,
            sublabel: agent.id,
            href: packageDetailPath("agent", agent.id),
          })) ?? [],
        icon: Bot,
        concept: "agents",
        section: "agents",
        count: pkg?.agents.length,
      },
      "agents-boundary",
      35,
      110,
    );

    const mainEdges: Edge[] = [
      {
        id: "source-bundle",
        source: "source-boundary",
        target: "bundle-boundary",
        sourceHandle: "s-right",
        targetHandle: "t-left",
        label: t("integration.structure.supplies"),
      },
      {
        id: "bundle-agents",
        source: "bundle-boundary",
        target: "agents-boundary",
        sourceHandle: "s-right",
        targetHandle: "t-left",
        label: t("integration.structure.exposes"),
      },
      {
        id: "configuration-bundle",
        source: "configuration-boundary",
        target: "bundle-boundary",
        sourceHandle: "s-bottom",
        targetHandle: "t-top",
        label: t("integration.structure.configures"),
        style: { strokeDasharray: "5 4" },
      },
    ];
    const fineEdges: Edge[] = [
      {
        id: "fine:source-tools",
        source: "source",
        target: "tools",
        // Route above the card row, not through the package and auth cards.
        sourceHandle: "top",
        targetHandle: "top",
        label: t("integration.structure.supplies"),
      },
      ...(pkg?.agents.length
        ? [
            {
              id: "fine:tools-agents",
              source: "tools",
              target: "agents",
              sourceHandle: "right",
              targetHandle: "left",
              label: t("integration.structure.selection"),
            },
          ]
        : []),
      ...detail.auths.flatMap((auth) => [
        {
          id: `fine:accounts:${auth.auth_key}`,
          source: `accounts:${auth.auth_key}`,
          target: `auth:${auth.auth_key}`,
          sourceHandle: "bottom",
          targetHandle: "top",
          label: t("integration.structure.usesMethod"),
        },
        ...(auth.type === "oauth2"
          ? [
              {
                id: `fine:clients:${auth.auth_key}`,
                source: `clients:${auth.auth_key}`,
                target: `auth:${auth.auth_key}`,
                sourceHandle: "bottom",
                targetHandle: "top",
                label: t("integration.structure.configuresOAuth"),
              },
            ]
          : []),
      ]),
    ];
    return { nodes, parents, mainEdges, fineEdges };
  }, [detail, pkg?.agents, packageId, t, open, onRelationActive]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(projected.nodes);
  useEffect(() => {
    setNodes((current) => {
      const byId = new Map(current.map((node) => [node.id, node]));
      return projected.nodes.map((node) => ({
        ...node,
        measured: byId.get(node.id)?.measured,
        selected: byId.get(node.id)?.selected,
      }));
    });
  }, [projected.nodes, setNodes]);
  const { parents, mainEdges, fineEdges } = projected;
  const decorate = (edge: Edge): Edge => {
    const kind =
      edge.source.startsWith("accounts:") ||
      edge.source.startsWith("clients:") ||
      edge.source === "configuration-boundary"
        ? "resolution"
        : "dependency";
    const styled = styleMapEdge(edge, kind);
    return {
      ...styled,
      selectable: false,
      focusable: false,
      interactionWidth: 0,
      style: { ...styled.style, pointerEvents: "none" },
      labelStyle: { fontSize: 11, fontWeight: 700, fill: "var(--muted-foreground)" },
      labelBgStyle: {
        fill: "var(--card)",
        fillOpacity: 1,
        stroke: "var(--border)",
        strokeWidth: 1,
      },
      labelBgPadding: [8, 5],
      labelBgBorderRadius: 6,
    };
  };
  const visibleFineEdges = fineEdges.filter(
    (edge) =>
      activeRelation &&
      (edge.source === activeRelation ||
        edge.target === activeRelation ||
        parents.get(edge.source) === activeRelation ||
        parents.get(edge.target) === activeRelation),
  );
  // Like the agent map, replace only the relevant group relation.
  // Do not fade every edge or let the new paths intercept the hovered card.
  const detailedGroups = new Set<string>(
    visibleFineEdges.map((edge) =>
      edge.id.startsWith("fine:source")
        ? "source-bundle"
        : edge.id.startsWith("fine:tools")
          ? "bundle-agents"
          : "configuration-bundle",
    ),
  );
  const edges = [
    ...mainEdges.filter((edge) => !detailedGroups.has(edge.id)).map((edge) => decorate(edge)),
    ...visibleFineEdges.map((edge) => decorate(edge)),
  ];
  const canvas = (
    // React Flow gives edge labels pointer-events: all independently of the path.
    // They must not steal the pointer from the node that reveals them on hover.
    <div className="bg-muted/20 [&_.selected_.agent-map-card]:ring-primary h-full min-h-0 overflow-hidden rounded-lg border [&_.react-flow__edge-textwrapper]:pointer-events-none [&_.selected_.agent-map-card]:ring-2 [&_.selected_.agent-map-card]:ring-offset-2">
      <ReactFlow
        nodes={nodes}
        onNodesChange={onNodesChange}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
        nodesDraggable={false}
        nodesConnectable={false}
        colorMode="system"
        edgesFocusable={false}
        minZoom={0.3}
        maxZoom={1.5}
        panOnScroll
        zoomOnScroll={false}
        onNodeMouseEnter={(_event, node) => {
          if (node.type === "boundary") setHoveredRelation(node.id);
        }}
        onNodeMouseLeave={(_event, node) => {
          if (node.type === "boundary")
            setHoveredRelation((current) => (current === node.id ? null : current));
        }}
        onNodeClick={(_event, node) =>
          setSelectedRelation((current) => (current === node.id ? null : node.id))
        }
        onPaneClick={() => {
          setSelectedRelation(null);
          setHoveredRelation(null);
        }}
      >
        <Background gap={24} size={1} />
        <MapControls expanded={expanded} onToggle={() => setExpanded((value) => !value)} />
      </ReactFlow>
    </div>
  );
  const panelNode = projected.nodes.find((node) => {
    const id = node.id;
    return panel === "functioning"
      ? id === "source"
      : panel === "files"
        ? id === "package"
        : panel?.startsWith("connections:")
          ? id === panel.replace("connections:", "accounts:")
          : id === panel;
  });
  const panelTitle = String(panelNode?.data.title ?? t("integration.presentation.authentication"));
  return (
    <>
      {expanded ? (
        <Modal
          open
          onClose={() => setExpanded(false)}
          title={t("integration.structure.map")}
          className="h-[calc(100dvh-2rem)] !w-[calc(100vw-2rem)] !max-w-[calc(100vw-2rem)] grid-rows-[auto_minmax(0,1fr)]"
        >
          {canvas}
        </Modal>
      ) : (
        <div className="h-[60vh] min-h-[420px]">{canvas}</div>
      )}
      <Modal
        open={panel !== null}
        onClose={() => setPanel(null)}
        title={panelTitle}
        className="sm:max-w-3xl"
      >
        <div className="max-h-[70vh] overflow-y-auto">{panel && renderPanel(panel, open)}</div>
      </Modal>
    </>
  );
}
