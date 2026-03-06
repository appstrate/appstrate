import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { LoadingState } from "./page-states";
import { useProviderTemplates } from "../hooks/use-provider-templates";
import { authModeI18nKey } from "../lib/auth-mode";
import type { ProviderTemplate } from "@appstrate/shared-types";
import { Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface ProviderTemplatePickerProps {
  open: boolean;
  onClose: () => void;
  onSelectTemplate: (template: ProviderTemplate, callbackUrl: string) => void;
  onSelectCustom: () => void;
}

export function ProviderTemplatePicker({
  open,
  onClose,
  onSelectTemplate,
  onSelectCustom,
}: ProviderTemplatePickerProps) {
  const { t } = useTranslation(["settings"]);
  const [search, setSearch] = useState("");
  const { data, isLoading } = useProviderTemplates(search);

  const handleClose = () => {
    setSearch("");
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title={t("providers.templates.title")}>
      <div className="relative mb-4">
        <Search
          size={14}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("providers.templates.searchPlaceholder")}
          autoFocus
          className="pl-9"
        />
      </div>

      {isLoading ? (
        <LoadingState />
      ) : (
        <div className="grid grid-cols-1 gap-3">
          {data?.templates.map((tpl) => (
            <Button
              key={tpl.templateId}
              variant="outline"
              className="h-auto p-4 justify-start text-left hover:border-primary hover:bg-muted/30 w-full flex-col items-start"
              onClick={() => onSelectTemplate(tpl, data.callbackUrl)}
            >
              <div className="flex items-center gap-2 mb-1">
                {tpl.iconUrl && (
                  <img
                    src={tpl.iconUrl}
                    alt=""
                    className="h-5 w-5 rounded object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                )}
                <span className="font-medium text-sm">{tpl.displayName}</span>
              </div>
              <span className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground mb-1">
                {t(authModeI18nKey(tpl.authMode), { defaultValue: tpl.authMode })}
              </span>
              <span className="text-sm text-muted-foreground mt-1 block font-normal">
                {tpl.description}
              </span>
            </Button>
          ))}

          <Button
            variant="outline"
            className="h-auto p-4 justify-start text-left border-dashed hover:border-primary hover:bg-muted/30 w-full flex-col items-start"
            onClick={onSelectCustom}
          >
            <div className="flex items-center gap-2 mb-1">
              <div className="flex items-center justify-center h-5 w-5 rounded bg-muted text-muted-foreground">
                <Plus size={16} />
              </div>
              <span className="font-medium text-sm">{t("providers.templates.custom")}</span>
            </div>
            <span className="text-sm text-muted-foreground mt-1 block font-normal">
              {t("providers.templates.customDesc")}
            </span>
          </Button>
        </div>
      )}
    </Modal>
  );
}
