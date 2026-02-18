import { useState, useRef, useEffect } from "react";
import { Link } from "react-router-dom";
import { useOrg } from "../hooks/use-org";
import { Spinner } from "./spinner";

export function OrgSwitcher() {
  const { currentOrg, orgs, switchOrg, loading } = useOrg();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  if (loading) {
    return <Spinner />;
  }

  if (!currentOrg) {
    return null;
  }

  return (
    <div className="user-menu" ref={ref} style={{ marginRight: "0.5rem" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.375rem",
          padding: "0.25rem 0.625rem",
          fontSize: "0.8rem",
          fontWeight: 500,
          fontFamily: "inherit",
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "6px",
          color: "var(--text)",
          cursor: "pointer",
          transition: "border-color 0.15s",
          whiteSpace: "nowrap",
          maxWidth: "180px",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        aria-label="Changer d'organisation"
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
          style={{ flexShrink: 0 }}
        >
          <path d="M18 21a8 8 0 0 0-16 0" />
          <circle cx="10" cy="8" r="5" />
          <path d="M22 20c0-3.37-2-6.5-4-8a5 5 0 0 0-.45-8.3" />
        </svg>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{currentOrg.name}</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, opacity: 0.5 }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          className="user-menu-dropdown"
          role="listbox"
          aria-label="Organisations"
          style={{ minWidth: "220px" }}
        >
          {orgs.map((org) => {
            const isActive = org.id === currentOrg.id;
            return (
              <button
                key={org.id}
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  if (!isActive) switchOrg(org.id);
                  setOpen(false);
                }}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  width: "100%",
                  textAlign: "left",
                  fontSize: "0.8rem",
                  padding: "0.5rem",
                  border: "none",
                  borderRadius: "4px",
                  background: isActive ? "var(--bg)" : "none",
                  color: isActive ? "var(--text)" : "var(--text-muted)",
                  cursor: "pointer",
                  fontFamily: "inherit",
                  fontWeight: isActive ? 500 : 400,
                }}
              >
                <span
                  style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {org.name}
                </span>
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
                    style={{ flexShrink: 0, marginLeft: "0.5rem" }}
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}

          <div
            style={{
              borderTop: "1px solid var(--border)",
              marginTop: "0.375rem",
              paddingTop: "0.375rem",
            }}
          >
            <Link
              to="/org-settings"
              onClick={() => setOpen(false)}
              style={{
                display: "block",
                fontSize: "0.8rem",
                padding: "0.375rem 0.5rem",
                color: "var(--text-muted)",
                textDecoration: "none",
                borderRadius: "4px",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--text)";
                (e.currentTarget as HTMLElement).style.background = "var(--bg)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.color = "var(--text-muted)";
                (e.currentTarget as HTMLElement).style.background = "none";
              }}
            >
              Parametres de l'organisation
            </Link>
            <Link
              to="/create-org"
              onClick={() => setOpen(false)}
              style={{
                display: "block",
                fontSize: "0.8rem",
                padding: "0.375rem 0.5rem",
                color: "var(--primary)",
                textDecoration: "none",
                borderRadius: "4px",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background = "rgba(59, 130, 246, 0.08)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "none";
              }}
            >
              + Nouvelle organisation
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
