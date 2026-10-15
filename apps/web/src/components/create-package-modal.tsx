// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { SLUG_REGEX } from "@appstrate/core/naming";
import { FormModal } from "./form-modal";
import { FormField } from "./form-field";
import { isRemoteSourceUrl } from "./integration-editor/utils";
import { useCreatePackage } from "../hooks/use-mutations";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import { newPackageBody, type NewPackageType } from "../lib/new-package-body";
import { packageDetailPath } from "../lib/package-paths";
import { errorMessage } from "../lib/mutation-error";
import { toLiveSlug, toSlug } from "../lib/strings";

const WORDS = {
  agent: {
    title: "createPackage.agent.title",
    description: "createPackage.agent.description",
    submit: "createPackage.agent.submit",
  },
  skill: {
    title: "createPackage.skill.title",
    description: "createPackage.skill.description",
    submit: "createPackage.skill.submit",
  },
  integration: {
    title: "createPackage.integration.title",
    description: "createPackage.integration.description",
    submit: "createPackage.integration.submit",
  },
} as const;

/**
 * The few things a new agent, skill or integration needs to exist: a name, its identifier, what it
 * is for, and the one thing the type cannot do without (an agent's prompt, an integration's server
 * URL). Everything else is set on the saved package, where it is edited. Mounted by the caller while open.
 */
export function CreatePackageModal({
  type,
  onClose,
}: {
  type: NewPackageType;
  onClose: () => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const { user } = useAuth();
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const create = useCreatePackage(type);
  const [displayName, setDisplayName] = useState("");
  const [id, setId] = useState("");
  const [idEdited, setIdEdited] = useState(false);
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const valid =
    displayName.trim() !== "" &&
    SLUG_REGEX.test(id) &&
    // A skill's description is required by its SKILL.md; an agent's prompt and an integration's URL by the type.
    (type !== "skill" || description.trim() !== "") &&
    (type !== "agent" || prompt.trim() !== "") &&
    (type !== "integration" || isRemoteSourceUrl(url.trim()));

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    create.mutate(
      newPackageBody(type, {
        scope: currentOrg?.slug,
        email: user?.email,
        id,
        displayName,
        description,
        prompt,
        url,
      }),
      {
        onSuccess: (created) => navigate(packageDetailPath(type, created.id)),
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <FormModal
      onClose={onClose}
      title={t(WORDS[type].title)}
      description={t(WORDS[type].description)}
      onSubmit={onSubmit}
      isPending={create.isPending}
      submitLabel={t(WORDS[type].submit)}
      submitDisabled={!valid}
      error={error}
      className="sm:max-w-xl"
    >
      <FormField
        id="create-package-name"
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
        id="create-package-id"
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
        id="create-package-description"
        label={t("editor.fieldDescLabel")}
        type="textarea"
        required={type === "skill"}
        value={description}
        onChange={setDescription}
      />
      {type === "agent" && (
        <FormField
          id="create-package-prompt"
          label={t("createPackage.agent.prompt")}
          type="textarea"
          required
          value={prompt}
          onChange={setPrompt}
          placeholder={t("createPackage.agent.promptPlaceholder")}
          description={t("createPackage.agent.promptHint")}
        />
      )}
      {type === "integration" && (
        <FormField
          id="create-package-url"
          label={t("integrationEditor.source.remoteUrl")}
          required
          value={url}
          onChange={setUrl}
          placeholder="https://example.com/mcp/v1"
          description={t("createPackage.integration.urlHint")}
        />
      )}
    </FormModal>
  );
}
