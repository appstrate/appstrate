// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { SLUG_REGEX } from "@appstrate/core/naming";
import { FormModal } from "./form-modal";
import { FormField } from "./form-field";
import { useCreatePackage } from "../hooks/use-mutations";
import { useAuth } from "../hooks/use-auth";
import { useOrg } from "../hooks/use-org";
import { defaultIntegrationManifest } from "./agent-editor/utils";
import { createPackageBody } from "../lib/create-package";
import { SourceSection } from "./integration-editor/source-section";
import { AuthsSection } from "./integration-editor/auths-section";
import { AdvancedSection } from "./advanced-section";
import { getSource, isRemoteSourceUrl } from "./integration-editor/utils";
import { packageDetailPath } from "../lib/package-paths";
import { errorMessage } from "../lib/mutation-error";
import { toLiveSlug, toSlug } from "../lib/strings";

/** Create a package, then author its advanced settings and files on the detail page. */
export function CreatePackageModal({
  type,
  onClose,
}: {
  type: "agent" | "skill" | "integration";
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
  const [error, setError] = useState<string | null>(null);
  const [integration, setIntegration] = useState<Record<string, unknown>>(() =>
    defaultIntegrationManifest(currentOrg?.slug, user?.email),
  );
  const [authsOpen, setAuthsOpen] = useState(false);
  const valid =
    displayName.trim() !== "" &&
    SLUG_REGEX.test(id) &&
    id.length <= 64 &&
    (type === "integration" || prompt.trim() !== "") &&
    (type !== "skill" || description.trim() !== "");

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!currentOrg || !valid || create.isPending) return;
    if (type === "integration") {
      const source = getSource(integration);
      if (source.kind === "remote" && !isRemoteSourceUrl(source.remoteUrl)) {
        setError(t("integrationEditor.source.errorRemoteUrl"));
        return;
      }
    }
    create.mutate(
      createPackageBody({
        type,
        scope: currentOrg.slug,
        author: user?.email,
        slug: id,
        name: displayName,
        description,
        content: prompt,
        integration,
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
      title={t(
        type === "agent"
          ? "createAgent.title"
          : type === "skill"
            ? "editor.breadcrumbNewSkill"
            : "editor.breadcrumbNewIntegration",
      )}
      onSubmit={onSubmit}
      isPending={create.isPending}
      submitLabel={t("btn.create")}
      submitDisabled={!valid}
      error={error}
      className="max-h-[85dvh] overflow-y-auto sm:max-w-xl"
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
        required={type === "skill"}
        type="textarea"
        value={description}
        onChange={setDescription}
      />
      {type === "integration" ? (
        <>
          <SourceSection manifest={integration} onChange={setIntegration} />
          <AdvancedSection
            title={t("integrationEditor.tabAuthMethods")}
            open={authsOpen}
            onOpenChange={setAuthsOpen}
          >
            <AuthsSection manifest={integration} onChange={setIntegration} />
          </AdvancedSection>
        </>
      ) : (
        <FormField
          id="create-agent-prompt"
          label={t(type === "agent" ? "createAgent.prompt" : "createPackage.skillBody")}
          type="textarea"
          required
          value={prompt}
          onChange={setPrompt}
          placeholder={type === "agent" ? t("createAgent.promptPlaceholder") : undefined}
          description={type === "agent" ? t("createAgent.promptHint") : undefined}
        />
      )}
    </FormModal>
  );
}
