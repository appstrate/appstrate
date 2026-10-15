// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { SLUG_REGEX } from "@appstrate/core/naming";
import { FormModal } from "./form-modal";
import { FormField } from "./form-field";
import { useCreatePackage } from "../hooks/use-mutations";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import { defaultEditorState } from "./agent-editor/utils";
import { packageCreateBody } from "../lib/package-file-drafts";
import { packageDetailPath } from "../lib/package-paths";
import { errorMessage } from "../lib/mutation-error";
import { toLiveSlug, toSlug } from "../lib/strings";

/**
 * The few things a new agent needs to exist: a name, its identifier, what it is for and its
 * prompt. Everything else (schema, skills, integrations, timeout, appearance) is set in its
 * settings, where the agent is edited. Mounted by the caller while open.
 */
export function CreateAgentModal({
  onClose,
  onLeave,
}: {
  onClose: () => void;
  /** Leaves the modal for the new agent's page. */
  onLeave: (to: string) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { user } = useAuth();
  const { currentOrg } = useOrg();
  const create = useCreatePackage("agent");
  const [displayName, setDisplayName] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState<string | null>(null);
  const valid = displayName.trim() !== "" && SLUG_REGEX.test(id) && prompt.trim() !== "";

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const base = defaultEditorState(currentOrg?.slug, user?.email);
    create.mutate(
      packageCreateBody(
        {
          manifest: {
            ...base.manifest,
            name: `@${currentOrg?.slug}/${id}`,
            display_name: displayName.trim(),
            description: description.trim(),
          },
          operations: [{ op: "write", path: "prompt.md", text: prompt }],
        },
        "agent",
      ),
      {
        onSuccess: (created) => onLeave(packageDetailPath("agent", created.id)),
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <FormModal
      onClose={onClose}
      title={t("createAgent.title")}
      description={t("createAgent.description")}
      onSubmit={onSubmit}
      isPending={create.isPending}
      submitLabel={t("createAgent.submit")}
      submitDisabled={!valid}
      error={error}
      className="sm:max-w-xl"
    >
      <FormField
        id="create-agent-name"
        label={t("editor.metaDisplayName")}
        required
        value={displayName}
        onChange={(v) => {
          setDisplayName(v);
          if (!idEdited) setId(toSlug(v));
        }}
        placeholder={t("editor.metaDisplayNamePlaceholder")}
      />
      <FormField
        id="create-agent-id"
        label={t("editor.metaName")}
        required
        value={id}
        onChange={(v) => {
          setIdEdited(true);
          setId(toLiveSlug(v));
        }}
        onBlur={() => setId(toSlug(id))}
        placeholder={t("editor.metaNamePlaceholder")}
        description={`@${currentOrg?.slug ?? ""}/${id || "…"}`}
      />
      <FormField
        id="create-agent-description"
        label={t("editor.fieldDescLabel")}
        type="textarea"
        value={description}
        onChange={setDescription}
      />
      <FormField
        id="create-agent-prompt"
        label={t("createAgent.prompt")}
        type="textarea"
        required
        value={prompt}
        onChange={setPrompt}
        placeholder={t("createAgent.promptPlaceholder")}
        description={t("createAgent.promptHint")}
      />
    </FormModal>
  );
}
