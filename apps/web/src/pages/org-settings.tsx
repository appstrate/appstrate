import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useOrg } from "../hooks/use-org";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import type { OrganizationMember, OrgRole } from "@appstrate/shared-types";

export function OrgSettingsPage() {
  const navigate = useNavigate();
  const { currentOrg, isOrgAdmin, isOrgOwner } = useOrg();
  const queryClient = useQueryClient();

  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState("");

  // Members
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);

  const orgId = currentOrg?.id;

  const {
    data: members = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ["org-members", orgId],
    queryFn: async () => {
      const data = await api<{ members: OrganizationMember[] }>(`/orgs/${orgId}`);
      return data.members;
    },
    enabled: !!orgId,
  });

  // --- Mutations ---

  const updateNameMutation = useMutation({
    mutationFn: async (name: string) => {
      return api(`/orgs/${orgId}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["orgs"] });
      setEditingName(false);
    },
    onError: (err: Error) => {
      alert(`Erreur : ${err.message}`);
    },
  });

  const addMemberMutation = useMutation({
    mutationFn: async (email: string) => {
      return api(`/orgs/${orgId}/members`, {
        method: "POST",
        body: JSON.stringify({ email }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
      setInviteEmail("");
      setInviteError(null);
    },
    onError: (err: Error) => {
      setInviteError(err.message);
    },
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (userId: string) => {
      return api(`/orgs/${orgId}/members/${userId}`, {
        method: "DELETE",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (err: Error) => {
      alert(`Erreur : ${err.message}`);
    },
  });

  const changeRoleMutation = useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: OrgRole }) => {
      return api(`/orgs/${orgId}/members/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ role }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["org-members", orgId] });
    },
    onError: (err: Error) => {
      alert(`Erreur : ${err.message}`);
    },
  });

  const deleteOrgMutation = useMutation({
    mutationFn: async () => {
      return api(`/orgs/${orgId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ["orgs"] });
      navigate("/");
      // Force reload to reset org context
      window.location.reload();
    },
    onError: (err: Error) => {
      alert(`Erreur : ${err.message}`);
    },
  });

  // --- Guards ---

  if (!currentOrg) {
    return <EmptyState message="Aucune organisation selectionnee." />;
  }

  if (!isOrgAdmin) {
    return <EmptyState message="Acces reserve aux administrateurs de l'organisation." />;
  }

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  // --- Handlers ---

  const handleSaveName = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    updateNameMutation.mutate(trimmed);
  };

  const handleInvite = (e: React.FormEvent) => {
    e.preventDefault();
    setInviteError(null);
    const trimmed = inviteEmail.trim();
    if (!trimmed) return;
    addMemberMutation.mutate(trimmed);
  };

  const handleRemove = (member: OrganizationMember) => {
    const label = member.displayName || member.email || member.userId;
    if (!confirm(`Retirer ${label} de l'organisation ?`)) return;
    removeMemberMutation.mutate(member.userId);
  };

  const handleRoleChange = (userId: string, role: OrgRole) => {
    changeRoleMutation.mutate({ userId, role });
  };

  const roleLabel: Record<OrgRole, string> = {
    owner: "Proprietaire",
    admin: "Admin",
    member: "Membre",
  };

  return (
    <>
      {/* Organisation info */}
      <div className="section-title">Organisation</div>
      <div className="service-card" style={{ marginBottom: "1.5rem" }}>
        <div className="service-card-header">
          <div className="service-info">
            {editingName ? (
              <form onSubmit={handleSaveName} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder={currentOrg.name}
                  autoFocus
                  style={{
                    padding: "0.375rem 0.5rem",
                    fontSize: "0.875rem",
                    background: "var(--bg)",
                    border: "1px solid var(--border)",
                    borderRadius: "6px",
                    color: "var(--text)",
                    outline: "none",
                    fontFamily: "inherit",
                  }}
                />
                <button className="primary" type="submit" disabled={updateNameMutation.isPending}>
                  {updateNameMutation.isPending ? "..." : "Enregistrer"}
                </button>
                <button
                  type="button"
                  onClick={() => setEditingName(false)}
                >
                  Annuler
                </button>
              </form>
            ) : (
              <>
                <h3>{currentOrg.name}</h3>
                <span className="service-provider">{currentOrg.slug}</span>
              </>
            )}
          </div>
          {isOrgOwner && !editingName && (
            <button
              onClick={() => {
                setNewName(currentOrg.name);
                setEditingName(true);
              }}
            >
              Modifier
            </button>
          )}
        </div>
      </div>

      {/* Members */}
      <div className="section-header">
        <span className="section-title">Membres</span>
      </div>

      {/* Add member form */}
      <form
        onSubmit={handleInvite}
        style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", alignItems: "flex-start" }}
      >
        <div style={{ flex: 1 }}>
          <input
            type="email"
            value={inviteEmail}
            onChange={(e) => {
              setInviteEmail(e.target.value);
              setInviteError(null);
            }}
            placeholder="email@example.com"
            required
            style={{
              width: "100%",
              padding: "0.5rem 0.75rem",
              fontSize: "0.875rem",
              fontFamily: "inherit",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: "6px",
              color: "var(--text)",
              outline: "none",
            }}
          />
          {inviteError && (
            <p className="form-error" style={{ marginTop: "0.25rem" }}>
              {inviteError}
            </p>
          )}
        </div>
        <button className="primary" type="submit" disabled={addMemberMutation.isPending}>
          {addMemberMutation.isPending ? "..." : "Ajouter"}
        </button>
      </form>

      {/* Member list */}
      <div className="services-grid">
        {members.map((member) => {
          const label = member.displayName || member.email || member.userId;
          const isOwner = member.role === "owner";

          return (
            <div key={member.userId} className="service-card">
              <div className="service-card-header" style={{ marginBottom: 0 }}>
                <div className="service-info">
                  <h3 style={{ fontSize: "0.875rem" }}>{label}</h3>
                  {member.email && member.displayName && (
                    <span className="service-provider">{member.email}</span>
                  )}
                </div>
                <span
                  className={`badge ${isOwner ? "badge-running" : member.role === "admin" ? "badge-success" : "badge-pending"}`}
                >
                  {roleLabel[member.role]}
                </span>
              </div>
              {isOrgAdmin && !isOwner && (
                <div
                  className="service-card-actions"
                  style={{ marginTop: "0.75rem", paddingTop: "0.75rem", borderTop: "1px solid var(--border)" }}
                >
                  {isOrgOwner && (
                    <select
                      value={member.role}
                      onChange={(e) => handleRoleChange(member.userId, e.target.value as OrgRole)}
                      disabled={changeRoleMutation.isPending}
                      style={{
                        padding: "0.375rem 0.5rem",
                        fontSize: "0.8rem",
                        fontFamily: "inherit",
                        background: "var(--bg)",
                        border: "1px solid var(--border)",
                        borderRadius: "6px",
                        color: "var(--text)",
                        outline: "none",
                        cursor: "pointer",
                      }}
                    >
                      <option value="member">Membre</option>
                      <option value="admin">Admin</option>
                      <option value="owner">Proprietaire</option>
                    </select>
                  )}
                  <button
                    onClick={() => handleRemove(member)}
                    disabled={removeMemberMutation.isPending}
                    style={{ marginLeft: "auto" }}
                  >
                    Retirer
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {members.length === 0 && (
        <EmptyState message="Aucun membre." hint="Ajoutez des membres par email." compact />
      )}

      {/* Danger zone */}
      {isOrgOwner && (
        <>
          <div className="section-title" style={{ marginTop: "2rem" }}>Zone de danger</div>
          <div className="service-card" style={{ borderColor: "var(--danger, #e53e3e)" }}>
            <div className="service-card-header" style={{ marginBottom: 0 }}>
              <div className="service-info">
                <h3 style={{ fontSize: "0.875rem" }}>Supprimer l'organisation</h3>
                <span className="service-provider">
                  Tous les flows, executions, planifications et configurations seront supprimes.
                </span>
              </div>
              <button
                className="btn-danger"
                disabled={deleteOrgMutation.isPending}
                onClick={() => {
                  if (
                    confirm(
                      `Supprimer l'organisation "${currentOrg.name}" ? Toutes les donnees seront perdues. Cette action est irreversible.`,
                    )
                  ) {
                    deleteOrgMutation.mutate();
                  }
                }}
              >
                {deleteOrgMutation.isPending ? "Suppression..." : "Supprimer"}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
