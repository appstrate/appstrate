import { useState, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useOrg } from "../hooks/use-org";
import { useClickOutside } from "../hooks/use-click-outside";
import { Spinner } from "./spinner";

export function OrgSwitcher() {
  const { t } = useTranslation();
  const { currentOrg, orgs, switchOrg, loading } = useOrg();
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
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0"
        >
          <path d="M18 21a8 8 0 0 0-16 0" />
          <circle cx="10" cy="8" r="5" />
          <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
        </svg>
        <span className="text-ellipsis">{currentOrg.name}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="flex-shrink-0 opacity-50"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
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
                {isActive && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="org-switcher-check"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}

          <div className="org-switcher-divider">
            <Link to="/connectors" className="org-switcher-link" onClick={() => setOpen(false)}>
              {t("orgSwitcher.connectors")}
            </Link>
            <Link to="/org-settings" className="org-switcher-link" onClick={() => setOpen(false)}>
              {t("orgSwitcher.settings")}
            </Link>
            <Link
              to="/create-org"
              className="org-switcher-link org-switcher-link-primary"
              onClick={() => setOpen(false)}
            >
              {t("orgSwitcher.create")}
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
