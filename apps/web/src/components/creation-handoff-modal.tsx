// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Bot, MessageSquareText, PencilLine } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { Button } from "@appstrate/ui/components/button";
import { buildChatCreationDraft, type CreationResource } from "../lib/creation-handoff";
import { useAppConfig } from "../hooks/use-app-config";
import { Modal } from "./modal";

interface CreationHandoffModalProps {
  resource: CreationResource;
  onClose: () => void;
  onManual: () => void;
  onChat: (prompt: string) => void;
}

const TITLE_KEYS: Record<CreationResource, string> = {
  agent: "creation.title.agent",
  skill: "creation.title.skill",
  integration: "creation.title.integration",
  "mcp-server": "creation.title.mcpServer",
};

export function CreationHandoffModal({
  resource,
  onClose,
  onManual,
  onChat,
}: CreationHandoffModalProps) {
  const { t } = useTranslation("settings");
  const { features } = useAppConfig();
  const translatePrompt = (key: string, values?: Record<string, string>) => t(key, values);
  const chatPrompt = buildChatCreationDraft(resource, translatePrompt);
  const manualIsImport = resource === "mcp-server";
  const chatAvailable = Boolean(features.chat);

  const methods = [
    {
      id: "manual",
      icon: PencilLine,
      title: t(manualIsImport ? "creation.manual.importTitle" : "creation.manual.title"),
      description: t(
        manualIsImport ? "creation.manual.importDescription" : "creation.manual.description",
      ),
      onClick: onManual,
      disabled: false,
    },
    {
      id: "chat",
      icon: MessageSquareText,
      title: t("creation.chat.title"),
      description: t(
        chatAvailable ? "creation.chat.description" : "creation.chat.unavailableDescription",
      ),
      onClick: () => onChat(chatPrompt),
      disabled: !chatAvailable,
    },
    {
      id: "coding-agent",
      icon: Bot,
      title: t("creation.codingAgent.title"),
      description: t("creation.codingAgent.unavailableDescription"),
      onClick: undefined,
      disabled: true,
    },
  ];

  return (
    <Modal open onClose={onClose} title={t(TITLE_KEYS[resource])} className="sm:max-w-xl">
      <div className="space-y-2" data-creation-chooser={resource}>
        {methods.map(({ id, icon: Icon, title, description, onClick, disabled }) => (
          <Button
            key={id}
            type="button"
            variant="outline"
            className="h-auto min-h-16 w-full justify-start gap-3 p-3 text-left whitespace-normal"
            onClick={onClick}
            disabled={disabled}
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
