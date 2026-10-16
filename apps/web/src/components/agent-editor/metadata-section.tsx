// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StringListInput } from "../app-ui/string-list-input";
import { Label } from "@appstrate/ui/components/label";
import { Textarea } from "@appstrate/ui/components/textarea";
import { FormField } from "../form-field";
import { SettingsHeading } from "../settings/settings-heading";
import { toSlug, toLiveSlug } from "../../lib/strings";

export interface MetadataState {
  id: string;
  scope: string;
  version: string;
  displayName: string; // canonical-casing-exempt: TS-internal editor state (carve-out); writes go through metadataToManifestPatch → snake_case `display_name`.
  description: string;
  author: string;
  keywords: string[];
}

interface MetadataSectionProps {
  value: MetadataState;
  onChange: (value: MetadataState) => void;
  isEdit: boolean;
  /**
   * Editor-specific fields (e.g. the agent editor's `timeout`), rendered in
   * their own group after the common ones. Each editor binds them to its
   * manifest state — MetadataSection only owns the fields every package type shares.
   */
  children?: React.ReactNode;
  /** Package-specific identity controls, such as Agent icon and colour. */
  identityChildren?: React.ReactNode;
}

export function MetadataSection({
  value,
  onChange,
  isEdit,
  children,
  identityChildren,
}: MetadataSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const update = (patch: Partial<MetadataState>) => onChange({ ...value, ...patch });
  const [nameEdited, setNameEdited] = useState(isEdit);

  const handleDisplayNameChange = (v: string) => {
    if (nameEdited) {
      update({ displayName: v }); // canonical-casing-exempt: MetadataState TS-internal (carve-out)
    } else {
      update({ displayName: v, id: toSlug(v) }); // canonical-casing-exempt: MetadataState TS-internal (carve-out)
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <SettingsFieldGroup title={t("editor.identity")}>
        <FormField
          id="meta-displayName"
          label={t("editor.metaDisplayName")}
          required
          value={value.displayName}
          onChange={handleDisplayNameChange}
          placeholder={t("editor.metaDisplayNamePlaceholder")}
        />
        <FormField
          id="meta-name"
          label={t("editor.metaName")}
          required
          value={value.id}
          onChange={(v) => {
            setNameEdited(true);
            update({ id: toLiveSlug(v) });
          }}
          onBlur={() => update({ id: toSlug(value.id) })}
          placeholder={t("editor.metaNamePlaceholder")}
          description={isEdit ? t("editor.metaNameEditDesc") : t("editor.metaNameDesc")}
        />
        <FormField
          id="meta-scope"
          label={t("runs.filterScope")}
          value={value.scope}
          onChange={() => {}}
          description={t("editor.metaScopeDesc")}
          disabled
        />
        {identityChildren}
      </SettingsFieldGroup>
      <SettingsFieldGroup title={t("editor.publication")}>
        <FormField
          id="meta-version"
          label={t("run.infoVersion")}
          required
          value={value.version}
          onChange={(v) => update({ version: v })}
          placeholder="1.0.0"
          description={t("editor.metaVersionDesc")}
        />
        <div className="flex flex-col gap-2">
          <Label className="mb-0" htmlFor="meta-description">
            {t("editor.fieldDescLabel")}
          </Label>
          <Textarea
            id="meta-description"
            value={value.description}
            onChange={(e) => update({ description: e.target.value })}
            placeholder={t("editor.metaDescPlaceholder")}
          />
        </div>
        <StringListInput
          label={t("manifest.keywords")}
          labelClassName="mb-0"
          values={value.keywords}
          onChange={(keywords) => update({ keywords })}
          placeholder={t("editor.metaKeywordPlaceholder")}
          commitOnBlur={false}
          monospace={false}
        />
      </SettingsFieldGroup>
      {children && (
        <SettingsFieldGroup title={t("run.infoExecution")}>{children}</SettingsFieldGroup>
      )}
    </div>
  );
}

function SettingsFieldGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <SettingsHeading level="group" title={title} />
      <div className="flex max-w-2xl flex-col gap-5">{children}</div>
    </section>
  );
}
