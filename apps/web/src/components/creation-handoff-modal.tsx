// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link2, MessageSquareText, PencilLine, Upload } from "lucide-react";
import { Badge } from "@appstrate/ui/components/badge";
import { buildChatCreationDraft, type CreationResource } from "../lib/creation-handoff";
import { useCanReach } from "../hooks/use-can-reach";
import { ChoiceCard } from "./choice-card";
import { Modal } from "./modal";

interface CreationHandoffChoicesProps {
  resource: CreationResource;
  /** Absent for a type that cannot be written by hand (a local MCP server embeds its code). */
  onManual?: () => void;
  onChat: (prompt: string) => void;
  /** Importing a type takes the same grant as creating it, so whoever opens this may import. */
  onImport: () => void;
  /** Display name of the integration an agent starts with, mentioned in the Chat draft. */
  integrationName?: string;
  /** The guided way from an MCP server URL, offered first when set (integrations). */
  onFromUrl?: () => void;
}

/** An integration's manual way says what it configures, beside the guided one from a URL. */
const MANUAL_KEYS: Partial<Record<CreationResource, { title: string; description: string }>> = {
  integration: {
    title: "creation.manual.integrationTitle",
    description: "creation.manual.integrationDescription",
  },
};

export function CreationHandoffModal({
  onClose,
  ...choices
}: CreationHandoffChoicesProps & { onClose: () => void }) {
  const { t } = useTranslation("settings");
  return (
    <Modal
      onClose={onClose}
      title={t(`creation.title.${choices.resource}`)}
      className="sm:max-w-xl"
    >
      <CreationHandoffChoices {...choices} />
    </Modal>
  );
}

/**
 * The ways to make a package, the same for every type: by hand, with the chat, or from an
 * archive, and for an integration first the guided way from an MCP server URL. A way a type does
 * not have, or the chat when it is out of reach, stays listed, disabled, with the reason.
 */
export function CreationHandoffChoices({
  resource,
  onManual,
  onChat,
  onImport,
  onFromUrl,
  integrationName,
}: CreationHandoffChoicesProps) {
  const { t } = useTranslation("settings");
  const canReach = useCanReach();
  const translatePrompt = (key: string, values?: Record<string, string>) => t(key, values);
  const chatPrompt = buildChatCreationDraft(resource, translatePrompt, integrationName);
  const manual = MANUAL_KEYS[resource] ?? {
    title: "creation.manual.title",
    description: "creation.manual.description",
  };
  // The chat route gate covers both the feature flag and the `chat:read` permission.
  const chatAvailable = canReach("/chat");

  const methods = [
    ...(onFromUrl
      ? [
          {
            id: "url",
            icon: Link2,
            title: t("creation.fromUrl.title"),
            description: t("creation.fromUrl.description"),
            onClick: onFromUrl,
            disabled: false,
          },
        ]
      : []),
    {
      id: "manual",
      icon: PencilLine,
      title: t(manual.title),
      description: t(onManual ? manual.description : "creation.manual.unavailableDescription"),
      onClick: () => onManual?.(),
      disabled: !onManual,
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
      id: "import",
      icon: Upload,
      title: t("creation.import.title"),
      description: t("creation.import.description"),
      onClick: onImport,
      disabled: false,
    },
  ];

  return (
    <div className="flex flex-col gap-2">
      {methods.map(({ id, ...method }) => (
        <ChoiceCard
          key={id}
          {...method}
          adornment={id === "chat" ? <Badge variant="secondary">Appstrate</Badge> : undefined}
        />
      ))}
    </div>
  );
}
