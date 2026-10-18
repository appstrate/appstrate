// SPDX-License-Identifier: Apache-2.0

import { useRef, useState, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import { Upload, X } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import { PackageIcon } from "../package-icon";
import { ICON_SOURCE_TYPES, encodeIconImage, iconImageErrorCode } from "../../lib/icon-image";

/** The integration's logo: its manifest `icon`, uploaded as a re-encoded image. */
export function IntegrationIconField({
  icon,
  onChange,
}: {
  icon: string | undefined;
  onChange: (icon: string | undefined) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Cleared so picking the same file again fires a change.
    event.currentTarget.value = "";
    if (!file) return;
    setError(null);
    try {
      onChange(await encodeIconImage(file));
    } catch (failure) {
      setError(t(`appearance.error.${iconImageErrorCode(failure)}`, { ns: "common" }));
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Label className="mb-0">{t("integrationEditor.icon.label")}</Label>
      <div className="flex items-center gap-3">
        <PackageIcon type="integration" icon={icon} />
        <input
          ref={input}
          type="file"
          accept={ICON_SOURCE_TYPES}
          className="hidden"
          tabIndex={-1}
          onChange={(event) => void upload(event)}
        />
        <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
          <Upload />
          {t("integrationEditor.icon.upload")}
        </Button>
        {icon && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(undefined)}>
            <X />
            {t("integrationEditor.icon.remove")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </div>
  );
}
