// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Label } from "@appstrate/ui/components/label";
import { StringListInput } from "./string-list-input";

/** A tool's `tools_policy.<tool>.required_scopes`: one scope list per auth. */
export function RequiredScopesField({
  authKeys,
  value,
  onChange,
}: {
  authKeys: string[];
  value: Record<string, string[]>;
  onChange: (value: Record<string, string[]>) => void;
}) {
  const { t } = useTranslation("agents");
  return (
    <div className="space-y-2">
      <Label>{t("integrationEditor.toolsPolicy.requiredScopes")}</Label>
      <p className="text-muted-foreground text-xs">
        {t("integrationEditor.toolsPolicy.requiredScopesDesc")}
      </p>
      {authKeys.length === 0 ? (
        <p className="text-muted-foreground text-xs italic">
          {t("integrationEditor.toolsPolicy.noAuths")}
        </p>
      ) : (
        authKeys.map((key) => (
          <StringListInput
            key={key}
            label={key}
            values={value[key] ?? []}
            onChange={(scopes) => onChange({ ...value, [key]: scopes })}
            placeholder="read"
          />
        ))
      )}
    </div>
  );
}
