// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Check, Copy, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import { buildMcpClientConfig } from "../../lib/mcp-client-config";

interface McpClientConnectProps {
  serverName: string;
  url: string;
}

/** A single copy-to-clipboard code block. */
function CopyBlock({ value, multiline = false }: { value: string; multiline?: boolean }) {
  const { t } = useTranslation("common");
  const { copied, copy } = useCopyToClipboard();
  return (
    <div className="border-border bg-muted/50 relative rounded-md border">
      <code
        className={`text-foreground block px-3 py-2 pr-12 font-mono text-xs select-all ${
          multiline ? "overflow-x-auto whitespace-pre" : "break-all"
        }`}
      >
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-foreground absolute top-1 right-1 h-7 w-7"
        aria-label={t("btn.copy")}
        onClick={() => copy(value)}
      >
        {copied ? <Check className="text-primary" /> : <Copy />}
      </Button>
    </div>
  );
}

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
 * not just the Claude Code CLI.
 */
export function McpClientConnect({ serverName, url }: McpClientConnectProps) {
  const { t } = useTranslation("settings");
  const cfg = buildMcpClientConfig(serverName, url);

  return (
    <div className="space-y-4">
      {/* Tier 1: the raw endpoint works in any spec-compliant client. */}
      <div>
        <p className="text-muted-foreground mb-1 text-xs font-medium">
          {t("orgSettings.mcpEndpointLabel")}
        </p>
        <CopyBlock value={cfg.url} />
        <p className="text-muted-foreground mt-1 text-xs">{t("orgSettings.mcpEndpointHint")}</p>
      </div>

      {/* Tier 2: per-client convenience snippets. */}
      <Tabs defaultValue="claude-code">
        <TabsList className="flex-wrap">
          <TabsTrigger value="claude-code">Claude Code</TabsTrigger>
          <TabsTrigger value="claude-desktop">Claude Desktop</TabsTrigger>
          <TabsTrigger value="cursor">Cursor</TabsTrigger>
          <TabsTrigger value="vscode">VS Code</TabsTrigger>
          <TabsTrigger value="json">JSON</TabsTrigger>
          <TabsTrigger value="mcp-remote">{t("orgSettings.mcpTabLegacy")}</TabsTrigger>
        </TabsList>

        <TabsContent value="claude-code" className="space-y-2">
          <p className="text-muted-foreground text-xs">{t("orgSettings.mcpClaudeCodeHint")}</p>
          <CopyBlock value={cfg.claudeCodeCommand} />
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
