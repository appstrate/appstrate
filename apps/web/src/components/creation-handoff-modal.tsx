// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Bot, MessageSquareText, PencilLine } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@appstrate/ui/components/tabs";
import { buildMcpClientConfig } from "../lib/mcp-client-config";
import {
  buildCreationPrompt,
  type CreationLocale,
  type CreationResource,
} from "../lib/creation-handoff";
import { useOrg } from "../hooks/use-org";
import { CopyBlock } from "./copy-block";
import { Modal } from "./modal";
import { McpClientConnect } from "./org-settings/mcp-client-connect";

interface CreationHandoffModalProps {
  resource: CreationResource;
  onClose: () => void;
  onManual: () => void;
  onChat: (prompt: string) => void;
}

const RESOURCE_KEYS: Record<CreationResource, string> = {
  agent: "creation.resource.agent",
  skill: "creation.resource.skill",
  integration: "creation.resource.integration",
  "mcp-server": "creation.resource.mcpServer",
};

export function CreationHandoffModal({
  resource,
  onClose,
  onManual,
  onChat,
}: CreationHandoffModalProps) {
  const { t, i18n } = useTranslation("settings");
  const { currentOrg } = useOrg();
  const [codingHandoff, setCodingHandoff] = useState(false);
  const locale: CreationLocale = i18n.language.toLowerCase().startsWith("fr") ? "fr" : "en";
  const resourceName = t(RESOURCE_KEYS[resource]);
  const codingPrompt = buildCreationPrompt(resource, "coding-agent", locale);
  const chatPrompt = buildCreationPrompt(resource, "chat", locale);
  const manualIsImport = resource === "mcp-server";

  if (codingHandoff) {
    const serverName = currentOrg ? `appstrate-${currentOrg.slug}` : "appstrate";
    const serverUrl = currentOrg
      ? `${window.location.origin}/api/mcp/o/${currentOrg.id}`
      : window.location.origin;
    const connection = buildMcpClientConfig(serverName, serverUrl);

    return (
      <Modal
        open
        onClose={onClose}
        title={t("creation.coding.title", { resource: resourceName })}
        className="sm:max-w-2xl"
      >
        <Tabs defaultValue="prompt">
          <TabsList>
            <TabsTrigger value="prompt">{t("creation.coding.promptTab")}</TabsTrigger>
            <TabsTrigger value="connection">{t("creation.coding.connectionTab")}</TabsTrigger>
          </TabsList>
          <TabsContent value="prompt" className="mt-4 space-y-3">
            <p className="text-muted-foreground text-sm">{t("creation.coding.promptHint")}</p>
            <CopyBlock value={codingPrompt} multiline testId="creation-coding-prompt" />
          </TabsContent>
          <TabsContent value="connection" className="mt-4 max-h-[60vh] overflow-y-auto pr-1">
            <p className="text-muted-foreground mb-4 text-sm">
              {t("creation.coding.connectionHint")}
            </p>
            {currentOrg ? (
              <McpClientConnect serverName={connection.serverName} url={connection.url} />
            ) : (
              <p className="text-muted-foreground text-sm">{t("creation.coding.noOrg")}</p>
            )}
          </TabsContent>
        </Tabs>
        <Button type="button" variant="ghost" size="sm" onClick={() => setCodingHandoff(false)}>
          <ArrowLeft />
          {t("creation.back")}
        </Button>
      </Modal>
    );
  }

  const methods = [
    {
      id: "manual",
      icon: PencilLine,
      title: t(manualIsImport ? "creation.manual.importTitle" : "creation.manual.title"),
      description: t(
        manualIsImport ? "creation.manual.importDescription" : "creation.manual.description",
      ),
      onClick: onManual,
    },
    {
      id: "chat",
      icon: MessageSquareText,
      title: t("creation.chat.title"),
      description: t("creation.chat.description"),
      onClick: () => onChat(chatPrompt),
    },
    {
      id: "coding-agent",
      icon: Bot,
      title: t("creation.codingAgent.title"),
      description: t("creation.codingAgent.description"),
      onClick: () => setCodingHandoff(true),
    },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title={t("creation.title", { resource: resourceName })}
      className="sm:max-w-xl"
    >
      <div className="space-y-2" data-creation-chooser={resource}>
        {methods.map(({ id, icon: Icon, title, description, onClick }) => (
          <Button
            key={id}
            type="button"
            variant="outline"
            className="h-auto min-h-16 w-full justify-start gap-3 p-3 text-left whitespace-normal"
            onClick={onClick}
            data-creation-method={id}
          >
            <span className="bg-muted grid size-9 shrink-0 place-items-center rounded-md">
              <Icon />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-2 text-sm font-semibold">
                {title}
                {id === "chat" && <Badge variant="secondary">Appstrate</Badge>}
              </span>
              <span className="text-muted-foreground mt-0.5 block text-xs leading-relaxed font-normal">
                {description}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </Modal>
  );
}
