import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "./modal";
import { LoadingState } from "./page-states";
import { useProviderTemplates } from "../hooks/use-provider-templates";
import { authModeI18nKey } from "../lib/auth-mode";
import type { ProviderTemplate } from "@appstrate/shared-types";
import { Plus, Search } from "lucide-react";

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
      <div className="template-picker-search">
        <Search size={14} />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("providers.templates.searchPlaceholder")}
          autoFocus
        />
      </div>

      {isLoading ? (
        <LoadingState />
      ) : (
        <div className="template-grid">
          {data?.templates.map((tpl) => (
            <button
              key={tpl.templateId}
              className="template-card"
              onClick={() => onSelectTemplate(tpl, data.callbackUrl)}
            >
              <div className="template-card-header">
                {tpl.iconUrl && (
                  <img
                    src={tpl.iconUrl}
                    alt=""
                    className="template-card-icon"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = "none";
                    }}
                  />
                )}
                <span className="template-card-name">{tpl.displayName}</span>
              </div>
              <span className="badge badge-pending badge-sm">
                {t(authModeI18nKey(tpl.authMode), { defaultValue: tpl.authMode })}
              </span>
              <span className="template-card-desc">{tpl.description}</span>
            </button>
          ))}

          <button className="template-card template-card-custom" onClick={onSelectCustom}>
            <div className="template-card-header">
              <div className="template-card-icon-placeholder">
                <Plus size={16} />
              </div>
              <span className="template-card-name">{t("providers.templates.custom")}</span>
            </div>
            <span className="template-card-desc">{t("providers.templates.customDesc")}</span>
          </button>
        </div>
      )}
    </Modal>
  );
}
