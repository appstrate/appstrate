// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { CopyBlock } from "../copy-block";
import { buildMcpClientConfig } from "../../lib/mcp-client-config";
import { spaceLabel } from "../../lib/space-label";
import { toSlug } from "../../lib/strings";
import { useSpaces } from "../../hooks/use-spaces";
import { isSpaceEnterable } from "../../hooks/use-current-space";

interface McpClientConnectProps {
  orgId: string;
  orgSlug: string;
}

/** The value of the "every space" scope; any other value is a space id. */
const ALL_SPACES = "all";

/** A row pairing a one-click deeplink button with its JSON fallback. */
function DeeplinkTab({ label, href, fallback }: { label: string; href: string; fallback: string }) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-3">
      <Button asChild variant="default" size="sm">
        <a href={href}>
          <ExternalLink />
          {label}
        </a>
      </Button>
      <p className="text-muted-foreground text-xs">{t("orgSettings.mcpManualFallback")}</p>
      <CopyBlock value={fallback} multiline />
    </div>
  );
}

/**
 * Multi-client connection block for an organization's MCP server. Surfaces the
 * raw endpoint plus copy-paste / one-click snippets for every common client —
 * not just the Claude Code CLI. The scope picks the endpoint: the org's URL
 * reaches every space the caller holds a role in (each call names its space),
 * a space's URL (`…/s/<space>`) pins the connection to that one space — the
 * one way to confine a client to a space, header-less clients included.
 */
export function McpClientConnect({ orgId, orgSlug }: McpClientConnectProps) {
  const { t } = useTranslation("settings");
  const { data: spaces = [] } = useSpaces();
  const [scope, setScope] = useState(ALL_SPACES);
  const enterable = spaces.filter(isSpaceEnterable);
  const space = enterable.find((s) => s.id === scope);
  const base = `${window.location.origin}/api/mcp/o/${orgId}`;
  const cfg = space
    ? buildMcpClientConfig(
        `appstrate-${orgSlug}-${toSlug(spaceLabel(space, t)) || "space"}`,
        `${base}/s/${space.id}`,
      )
    : buildMcpClientConfig(`appstrate-${orgSlug}`, base);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-muted-foreground mb-1 text-xs font-medium">
          {t("orgSettings.mcpScopeLabel")}
        </p>
        <Select value={space ? space.id : ALL_SPACES} onValueChange={setScope}>
          <SelectTrigger className="w-full sm:w-72" data-testid="mcp-scope-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SPACES}>{t("orgSettings.mcpScopeAll")}</SelectItem>
            {enterable.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {spaceLabel(s, t)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground mt-1 text-xs">
          {space ? t("orgSettings.mcpScopeSpaceHint") : t("orgSettings.mcpScopeAllHint")}
        </p>
      </div>

      {/* Tier 1: the raw endpoint works in any spec-compliant client. */}
      <div>
        <p className="text-muted-foreground mb-1 text-xs font-medium">
          {t("orgSettings.mcpEndpointLabel")}
        </p>
        <CopyBlock value={cfg.url} multiline />
        <p className="text-muted-foreground mt-1 text-xs">{t("orgSettings.mcpEndpointHint")}</p>
      </div>

      {/* Tier 2: per-client convenience snippets. */}
      <Tabs defaultValue="claude-code">
        <TabsList className="h-auto w-full flex-wrap justify-start max-sm:grid max-sm:grid-cols-2">
          <TabsTrigger className="max-sm:w-full" value="claude-code">
            Claude Code
          </TabsTrigger>
          <TabsTrigger className="max-sm:w-full" value="claude-desktop">
            Claude Desktop
          </TabsTrigger>
          <TabsTrigger className="max-sm:w-full" value="cursor">
            Cursor
          </TabsTrigger>
          <TabsTrigger className="max-sm:w-full" value="vscode">
            VS Code
          </TabsTrigger>
          <TabsTrigger className="max-sm:w-full" value="json">
            JSON
          </TabsTrigger>
          <TabsTrigger className="max-sm:w-full" value="mcp-remote">
            {t("orgSettings.mcpTabLegacy")}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="claude-code" className="space-y-2">
          <p className="text-muted-foreground text-xs">{t("orgSettings.mcpClaudeCodeHint")}</p>
          <CopyBlock value={cfg.claudeCodeCommand} multiline />
        </TabsContent>

        <TabsContent value="claude-desktop" className="space-y-2">
          <p className="text-muted-foreground text-xs">{t("orgSettings.mcpJsonHint")}</p>
          <CopyBlock value={cfg.httpJson} multiline />
        </TabsContent>

        <TabsContent value="cursor">
          <DeeplinkTab
            label={t("orgSettings.mcpAddToCursor")}
            href={cfg.cursorDeeplink}
            fallback={cfg.httpJson}
          />
        </TabsContent>

        <TabsContent value="vscode">
          <DeeplinkTab
            label={t("orgSettings.mcpAddToVscode")}
            href={cfg.vscodeDeeplink}
            fallback={cfg.httpJson}
          />
        </TabsContent>

        <TabsContent value="json" className="space-y-2">
          <p className="text-muted-foreground text-xs">{t("orgSettings.mcpGenericHint")}</p>
          <CopyBlock value={cfg.httpJson} multiline />
        </TabsContent>

        <TabsContent value="mcp-remote" className="space-y-2">
          <p className="text-muted-foreground text-xs">{t("orgSettings.mcpRemoteHint")}</p>
          <CopyBlock value={cfg.mcpRemoteJson} multiline />
        </TabsContent>
      </Tabs>
    </div>
  );
}
