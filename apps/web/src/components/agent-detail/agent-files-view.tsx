// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  GitCompareArrows,
  Link2,
  Search,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@appstrate/ui/components/tooltip";
import { client, $api, ApiError } from "../../api/client";
import { useOrgScope } from "../../hooks/use-org-scope";
import { usePackageDetail, usePackageVersions, useVersionDetail } from "../../hooks/use-packages";
import { type PackageFileEntry, type TreeNode } from "../../lib/package-file-tree";
import { packageDetailPath, splitPackageRef } from "../../lib/package-paths";
import { DiffTab } from "../diff-tab";
import { Modal } from "../modal";
import { ErrorState, LoadingState } from "../page-states";
import { FilePreview } from "../package-files/file-preview";
import { ReadOnlyFileTree } from "../package-files/read-only-file-tree";
import { usePackageFileDownload } from "../package-files/use-package-file";
import { AgentDetailPaneHeader, AgentDetailSplit } from "./agent-detail-split";

interface PackageReference {
  id: string;
  version: string | null;
  type: "skill" | "mcp-server";
}

interface VirtualFile {
  treeEntry: PackageFileEntry;
  sourceEntry: PackageFileEntry;
  packageId: string;
  source: "bundle" | "dependency";
  dependency?: PackageReference;
}

type SelectedItem =
  | { kind: "file"; file: VirtualFile }
  | { kind: "folder"; path: string; dependency?: PackageReference };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dependencyReferences(
  manifest: Record<string, unknown> | undefined,
  key: "skills" | "mcp_servers",
  type: PackageReference["type"],
): PackageReference[] {
  if (!manifest || !isRecord(manifest.dependencies)) return [];
  const dependencies = manifest.dependencies[key];
  if (!isRecord(dependencies)) return [];
  return Object.entries(dependencies).map(([id, version]) => ({
    id,
    version: typeof version === "string" ? version : null,
    type,
  }));
}

function packageFolderName(packageId: string): string {
  return packageId.slice(packageId.lastIndexOf("/") + 1);
}

export function AgentFilesView({
  packageId,
  initialVersion,
  currentManifest,
  currentContent,
}: {
  packageId: string;
  initialVersion?: string | undefined;
  currentManifest?: Record<string, unknown> | undefined;
  currentContent?: string | null | undefined;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const scope = useOrgScope();
  const [selectedVersion, setSelectedVersion] = useState(initialVersion ?? "draft");
  const [compareVersion, setCompareVersion] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<SelectedItem | null>(null);

  const { data: versions } = usePackageVersions("agent", packageId);
  const { data: selectedVersionDetail } = useVersionDetail(
    "agent",
    packageId,
    selectedVersion === "draft" ? undefined : selectedVersion,
  );
  const { data: compareVersionDetail } = useVersionDetail(
    "agent",
    packageId,
    compareVersion ?? undefined,
  );
  const { data: bundleIndex, error: bundleError } = $api.useQuery(
    "get",
    "/api/packages/{scope}/{name}/files",
    {
      params: {
        path: splitPackageRef(packageId),
        ...(selectedVersion === "draft" ? {} : { query: { version: selectedVersion } }),
        header: scope.header,
      },
    },
    { enabled: scope.enabled },
  );

  const manifest = selectedVersion === "draft" ? currentManifest : selectedVersionDetail?.manifest;
  const skills = useMemo(() => dependencyReferences(manifest, "skills", "skill"), [manifest]);
  const mcpServers = useMemo(
    () => dependencyReferences(manifest, "mcp_servers", "mcp-server"),
    [manifest],
  );
  const skillIndexes = useQueries({
    queries: skills.map((skill) => ({
      queryKey: [
        "agent-runtime-skill-files",
        scope.header["X-Org-Id"],
        scope.header["X-Application-Id"],
        skill.id,
      ],
      enabled: scope.enabled,
      queryFn: async () => {
        const { data, error } = await client.GET("/api/packages/{scope}/{name}/files", {
          params: { path: splitPackageRef(skill.id), header: scope.header },
        });
        if (error) throw error;
        return data;
      },
    })),
  });
  const localMcpIndexes = useQueries({
    queries: mcpServers.map((server) => ({
      queryKey: [
        "agent-runtime-local-mcp-files",
        scope.header["X-Org-Id"],
        scope.header["X-Application-Id"],
        server.id,
      ],
      enabled: scope.enabled,
      queryFn: async () => {
        const { data: detail, error: detailError } = await client.GET(
          "/api/packages/mcp-servers/{scope}/{name}",
          { params: { path: splitPackageRef(server.id), header: scope.header } },
        );
        if (detailError) throw detailError;
        if (detail.source !== "local" || !isRecord(detail.manifest)) return null;
        const serverManifest = detail.manifest.server;
        if (!isRecord(serverManifest) || typeof serverManifest.entry_point !== "string")
          return null;

        const { data: files, error: filesError } = await client.GET(
          "/api/packages/{scope}/{name}/files",
          { params: { path: splitPackageRef(server.id), header: scope.header } },
        );
        if (filesError) throw filesError;
        const paths = new Set(files.entries.map((entry) => entry.path));
        if (!paths.has("manifest.json") || !paths.has(serverManifest.entry_point)) return null;
        return files;
      },
    })),
  });

  const files = useMemo<VirtualFile[]>(() => {
    const bundle =
      bundleIndex?.entries.map((entry) => ({
        source: "bundle" as const,
        packageId,
        sourceEntry: entry,
        treeEntry: { ...entry, path: `Bundle AFPS/${entry.path}` },
      })) ?? [];
    const runtimeSkills = skills.flatMap((skill, index) => {
      const entries = skillIndexes[index]?.data?.entries ?? [];
      return entries
        .filter((entry) => entry.path !== "manifest.json")
        .map((entry) => ({
          source: "dependency" as const,
          packageId: skill.id,
          dependency: skill,
          sourceEntry: entry,
          treeEntry: {
            ...entry,
            path: `Dépendances/Skills/${packageFolderName(skill.id)}/${entry.path}`,
          },
        }));
    });
    const localServers = mcpServers.flatMap((server, index) => {
      const entries = localMcpIndexes[index]?.data?.entries ?? [];
      return entries.map((entry) => ({
        source: "dependency" as const,
        packageId: server.id,
        dependency: server,
        sourceEntry: entry,
        treeEntry: {
          ...entry,
          path: `Dépendances/Serveurs MCP/${packageFolderName(server.id)}/${entry.path}`,
        },
      }));
    });
    return [...bundle, ...runtimeSkills, ...localServers];
  }, [bundleIndex, localMcpIndexes, mcpServers, packageId, skillIndexes, skills]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleFiles = useMemo(
    () =>
      normalizedQuery === ""
        ? files
        : files.filter((file) => file.treeEntry.path.toLocaleLowerCase().includes(normalizedQuery)),
    [files, normalizedQuery],
  );
  const fileByPath = useMemo(
    () => new Map(visibleFiles.map((file) => [file.treeEntry.path, file])),
    [visibleFiles],
  );
  const defaultFile =
    visibleFiles.find((file) => file.treeEntry.path === "Bundle AFPS/prompt.md") ?? visibleFiles[0];
  const activeSelection =
    selected ?? (defaultFile ? { kind: "file" as const, file: defaultFile } : null);
  const selectedDependency =
    activeSelection?.kind === "file"
      ? activeSelection.file.dependency
      : activeSelection?.dependency;
  const { data: selectedDependencyDetail } = usePackageDetail(
    selectedDependency?.type ?? "skill",
    selectedDependency?.id,
  );
  const publishedVersions = versions?.filter((version) => !version.yanked) ?? [];
  const dependenciesLoading =
    skillIndexes.some((result) => result.isLoading) ||
    localMcpIndexes.some((result) => result.isLoading);
  const selectedVersionLabel =
    selectedVersion === "draft" ? t("agents:detail.files.currentDraft") : `v${selectedVersion}`;

  const selectPath = (path: string, node: TreeNode) => {
    if (node.kind === "file") {
      const file = fileByPath.get(path);
      if (file) setSelected({ kind: "file", file });
      return;
    }
    const dependency = [...skills, ...mcpServers].find((candidate) => {
      const group = candidate.type === "skill" ? "Skills" : "Serveurs MCP";
      const root = `Dépendances/${group}/${packageFolderName(candidate.id)}`;
      return path === root || path.startsWith(`${root}/`);
    });
    setSelected({ kind: "folder", path, ...(dependency ? { dependency } : {}) });
  };

  return (
    <div className="bg-card overflow-hidden" data-agent-files>
      <AgentDetailSplit
        railClassName="flex min-h-[610px] flex-col text-left"
        rail={
          <>
            <AgentDetailPaneHeader>
              <div className="relative w-full">
                <Search
                  className="text-muted-foreground absolute top-2 left-2.5 size-4"
                  aria-hidden
                />
                <Input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelected(null);
                  }}
                  placeholder={t("common:switcher.searchPlaceholder")}
                  className="h-8 pl-8"
                />
              </div>
            </AgentDetailPaneHeader>
            <div className="min-h-0 flex-1 overflow-hidden">
              {bundleError ? (
                <ErrorState
                  message={t(
                    bundleError instanceof ApiError && bundleError.status === 404
                      ? "agents:files.errorMissingArtifact"
                      : "agents:files.errorLoad",
                  )}
                  compact
                />
              ) : !bundleIndex || dependenciesLoading ? (
                <LoadingState />
              ) : (
                <ReadOnlyFileTree
                  entries={visibleFiles.map((file) => file.treeEntry)}
                  directories={[
                    "Bundle AFPS",
                    "Dépendances",
                    "Dépendances/Skills",
                    "Dépendances/Serveurs MCP",
                  ]}
                  initialCollapsedPaths={["Dépendances/Skills", "Dépendances/Serveurs MCP"]}
                  selectedPath={
                    activeSelection?.kind === "file"
                      ? activeSelection.file.treeEntry.path
                      : (activeSelection?.path ?? null)
                  }
                  onSelect={(path) => {
                    const file = fileByPath.get(path);
                    if (file) setSelected({ kind: "file", file });
                  }}
                  onSelectNode={(node) => {
                    if (node.kind === "dir") selectPath(node.path, node);
                  }}
                  label="Fichiers de l’agent"
                  controlsId="agent-file-preview"
                  className="h-full w-full p-1 text-left"
                />
              )}
            </div>
            <div className="bg-card shrink-0 space-y-1.5 border-t p-3">
              <span className="text-muted-foreground text-xs font-medium">
                {t("agents:detail.files.version")}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full justify-between">
                    <span className="truncate">{selectedVersionLabel}</span>
                    <ChevronDown className="shrink-0" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-52">
                  <DropdownMenuItem
                    onSelect={() => {
                      setSelectedVersion("draft");
                      setSelected(null);
                    }}
                  >
                    <Check className={selectedVersion === "draft" ? "opacity-100" : "opacity-0"} />
                    {t("agents:detail.files.currentDraft")}
                  </DropdownMenuItem>
                  {publishedVersions.map((version) => (
                    <DropdownMenuItem
                      key={version.version}
                      onSelect={() => {
                        setSelectedVersion(version.version);
                        setSelected(null);
                      }}
                    >
                      <Check
                        className={
                          selectedVersion === version.version ? "opacity-100" : "opacity-0"
                        }
                      />
                      v{version.version}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>
                      <GitCompareArrows />
                      {t("agents:detail.files.compareWith")}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {publishedVersions.length > 0 ? (
                        publishedVersions.map((version) => (
                          <DropdownMenuItem
                            key={version.version}
                            disabled={version.version === selectedVersion}
                            onSelect={() => setCompareVersion(version.version)}
                          >
                            v{version.version}
                          </DropdownMenuItem>
                        ))
                      ) : (
                        <DropdownMenuItem disabled>
                          {t("agents:detail.files.noPublishedVersions")}
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        }
      >
        <div className="bg-background/30 min-w-0">
          {activeSelection?.kind === "file" ? (
            <div className="flex h-full min-w-0 flex-col">
              <SelectionHeader
                selection={activeSelection}
                resolvedVersion={selectedDependencyDetail?.version ?? null}
                fileVersion={
                  activeSelection.file.source === "bundle"
                    ? selectedVersion === "draft"
                      ? undefined
                      : selectedVersion
                    : (selectedDependencyDetail?.version ?? undefined)
                }
              />
              <FilePreview
                id="agent-file-preview"
                packageId={activeSelection.file.packageId}
                version={
                  activeSelection.file.source === "bundle"
                    ? selectedVersion === "draft"
                      ? undefined
                      : selectedVersion
                    : (selectedDependencyDetail?.version ?? undefined)
                }
                entry={activeSelection.file.sourceEntry}
                className="h-full flex-1 rounded-none border-0"
                hideHeader
              />
            </div>
          ) : activeSelection?.kind === "folder" ? (
            <div className="flex h-full min-w-0 flex-col">
              <SelectionHeader
                selection={activeSelection}
                resolvedVersion={selectedDependencyDetail?.version ?? null}
              />
              <FolderPreview path={activeSelection.path} dependency={activeSelection.dependency} />
            </div>
          ) : (
            <div className="text-muted-foreground grid h-full place-items-center text-sm">
              {t("agents:detail.files.selectItem")}
            </div>
          )}
        </div>
      </AgentDetailSplit>

      <Modal
        open={compareVersion !== null}
        onClose={() => setCompareVersion(null)}
        title={t("agents:detail.files.compareTitle", { version: compareVersion })}
        className="max-w-5xl"
      >
        {compareVersionDetail ? (
          <DiffTab
            type="agent"
            latestVersion={compareVersionDetail}
            currentManifest={currentManifest}
            currentContent={currentContent}
          />
        ) : (
          <LoadingState />
        )}
      </Modal>
    </div>
  );
}
function SelectionHeader({
  selection,
  resolvedVersion,
  fileVersion,
}: {
  selection: SelectedItem;
  resolvedVersion: string | null;
  fileVersion?: string;
}) {
  const path = selection.kind === "file" ? selection.file.treeEntry.path : selection.path;
  const dependency = selection.kind === "file" ? selection.file.dependency : selection.dependency;
  const pathParts = path.split("/");

  return (
    <AgentDetailPaneHeader className="flex-wrap gap-3 text-left max-xl:h-auto max-xl:py-2">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-xs">
          {pathParts.map((part, index) => (
            <span key={`${part}-${index}`} className="flex min-w-0 items-center gap-1">
              {index > 0 && <span className="text-muted-foreground">/</span>}
              <span
                className={
                  index === pathParts.length - 1
                    ? "truncate font-semibold"
                    : "text-muted-foreground shrink-0"
                }
              >
                {part}
              </span>
            </span>
          ))}
        </div>
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1.5 max-lg:w-full">
        {dependency && (
          <DependencyStatusCluster
            requestedVersion={dependency.version}
            resolvedVersion={resolvedVersion}
          />
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {dependency && (
            <DependencyVersion
              requestedVersion={dependency.version}
              resolvedVersion={resolvedVersion}
            />
          )}
          {selection.kind === "file" ? (
            <FileSelectionActions file={selection.file} version={fileVersion} />
          ) : dependency ? (
            <DependencySelectionActions dependency={dependency} />
          ) : null}
        </div>
      </div>
    </AgentDetailPaneHeader>
  );
}

function DependencyStatusCluster({
  requestedVersion,
  resolvedVersion,
}: {
  requestedVersion: string | null;
  resolvedVersion: string | null;
}) {
  const { t } = useTranslation("agents");
  const isResolved = Boolean(resolvedVersion ?? requestedVersion);

  return (
    <TooltipProvider delayDuration={250}>
      <div className="flex items-center gap-1.5">
        {isResolved && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" className="cursor-help rounded-full focus-visible:outline-2">
                <Badge variant="secondary">{t("detail.files.status.resolved")}</Badge>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-xs">
              {t("detail.files.tooltip.resolved")}
            </TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="cursor-help rounded-full focus-visible:outline-2">
              <Badge variant="outline">{t("detail.files.readOnly")}</Badge>
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {t("detail.files.tooltip.readOnly")}
          </TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}

function DependencyVersion({
  requestedVersion,
  resolvedVersion,
}: {
  requestedVersion: string | null;
  resolvedVersion: string | null;
}) {
  const { t } = useTranslation("agents");
  const requested = requestedVersion ?? resolvedVersion;
  const resolved = resolvedVersion ?? requestedVersion;
  const differs = Boolean(requested && resolved && requested !== resolved);
  const label = differs
    ? `${requested} → ${resolved}`
    : resolved
      ? resolved.startsWith("v")
        ? resolved
        : `v${resolved}`
      : "—";
  const tooltip = differs
    ? t("detail.files.tooltip.versionDifferent", { requested, resolved })
    : t("detail.files.tooltip.versionSame", { version: resolved ?? requested ?? "—" });

  return (
    <TooltipProvider delayDuration={250}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground cursor-help rounded-sm font-mono text-xs whitespace-nowrap focus-visible:outline-2"
          >
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          {tooltip}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function FileSelectionActions({ file, version }: { file: VirtualFile; version?: string }) {
  const { t } = useTranslation("agents");
  const download = usePackageFileDownload(file.packageId, version);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {t("detail.files.actions")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => void download(file.sourceEntry.path)}>
          <Download />
          {t("files.downloadFile")}
        </DropdownMenuItem>
        {file.dependency && (
          <DropdownMenuItem asChild>
            <Link to={packageDetailPath(file.dependency.type, file.dependency.id)}>
              <Link2 />
              {t("detail.files.openDependency")}
            </Link>
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DependencySelectionActions({ dependency }: { dependency: PackageReference }) {
  const { t } = useTranslation("agents");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          {t("detail.files.actions")}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link to={packageDetailPath(dependency.type, dependency.id)}>
            <Link2 />
            {t("detail.files.openDependency")}
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FolderPreview({ path, dependency }: { path: string; dependency?: PackageReference }) {
  const { t } = useTranslation("agents");
  return (
    <div className="h-full p-6 text-left">
      <div className="flex items-center gap-3">
        <FolderOpen className="text-muted-foreground size-5" aria-hidden />
        <h3 className="font-mono text-sm font-semibold">{path}</h3>
      </div>
      {dependency && (
        <p className="text-muted-foreground mt-3 max-w-lg text-sm">
          {t("detail.files.selectItem")}
        </p>
      )}
    </div>
  );
}
