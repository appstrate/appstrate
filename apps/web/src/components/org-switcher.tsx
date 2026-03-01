import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  Users,
  ChevronDown,
  Check,
  Calendar,
  BookOpen,
  ShoppingBag,
  Plug,
  Settings,
  Plus,
} from "lucide-react";
import { useOrg } from "../hooks/use-org";
import { useClickOutside } from "../hooks/use-click-outside";
import { Spinner } from "./spinner";

export function OrgSwitcher() {
  const { t } = useTranslation();
  const { currentOrg, orgs, switchOrg, loading, isOrgAdmin } = useOrg();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, open, close);

  if (loading) {
    return <Spinner />;
  }

  if (!currentOrg) {
    return null;
  }

  return (
    <div className="user-menu org-switcher" ref={ref}>
      <button
        className="org-switcher-trigger"
        onClick={() => setOpen(!open)}
        aria-label={t("orgSwitcher.ariaLabel")}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <Users size={16} className="flex-shrink-0" />
        <span className="text-ellipsis">{currentOrg.name}</span>
        <ChevronDown size={10} strokeWidth={2.5} className="flex-shrink-0 opacity-50" />
      </button>

      {open && (
        <div
          className="user-menu-dropdown org-switcher-dropdown"
          role="listbox"
          aria-label={t("orgSwitcher.ariaLabelList")}
        >
          {orgs.map((org) => {
            const isActive = org.id === currentOrg.id;
            return (
              <button
                key={org.id}
                role="option"
                aria-selected={isActive}
                className={`org-switcher-option${isActive ? " active" : ""}`}
                onClick={() => {
                  if (!isActive) switchOrg(org.id);
                  setOpen(false);
                }}
              >
                <span className="text-ellipsis-nowrap">{org.name}</span>
                {isActive && <Check size={14} strokeWidth={2.5} className="org-switcher-check" />}
              </button>
            );
          })}

          <div className="org-switcher-divider">
            <Link to="/schedules" className="org-switcher-link" onClick={() => setOpen(false)}>
              <Calendar size={14} />
              {t("orgSwitcher.schedules")}
            </Link>
            <Link to="/library" className="org-switcher-link" onClick={() => setOpen(false)}>
              <BookOpen size={14} />
              {t("orgSwitcher.library")}
            </Link>
            <Link to="/marketplace" className="org-switcher-link" onClick={() => setOpen(false)}>
              <ShoppingBag size={14} />
              {t("orgSwitcher.marketplace")}
            </Link>
            <Link to="/connectors" className="org-switcher-link" onClick={() => setOpen(false)}>
              <Plug size={14} />
              {t("orgSwitcher.connectors")}
            </Link>
            {isOrgAdmin && (
              <Link to="/org-settings" className="org-switcher-link" onClick={() => setOpen(false)}>
                <Settings size={14} />
                {t("orgSwitcher.settings")}
              </Link>
            )}
            <Link
              to="/create-org"
              className="org-switcher-link org-switcher-link-primary"
              onClick={() => setOpen(false)}
            >
              <Plus size={14} />
              {t("orgSwitcher.create")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
