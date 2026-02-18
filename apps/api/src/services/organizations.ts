import { supabase } from "../lib/supabase.ts";
import type { OrgRole } from "../types/index.ts";

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface OrgMemberRow {
  org_id: string;
  user_id: string;
  role: string;
  joined_at: string;
}

export async function createOrganization(
  name: string,
  slug: string,
  userId: string,
): Promise<OrgRow> {
  const { data: org, error: orgErr } = await supabase
    .from("organizations")
    .insert({ name, slug, created_by: userId })
    .select()
    .single();

  if (orgErr) throw new Error(`Failed to create organization: ${orgErr.message}`);

  // Add creator as owner
  const { error: memberErr } = await supabase.from("organization_members").insert({
    org_id: org.id,
    user_id: userId,
    role: "owner",
  });

  if (memberErr) throw new Error(`Failed to add owner: ${memberErr.message}`);

  return org as OrgRow;
}

export async function getUserOrganizations(
  userId: string,
): Promise<(OrgRow & { role: OrgRole })[]> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("role, organizations(*)")
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to fetch user orgs: ${error.message}`);

  return (data ?? []).map((row) => {
    const org = (row as unknown as { organizations: OrgRow }).organizations;
    return { ...org, role: row.role as OrgRole };
  });
}

export async function getOrgById(orgId: string): Promise<OrgRow | null> {
  const { data } = await supabase.from("organizations").select("*").eq("id", orgId).single();
  return (data as OrgRow) ?? null;
}

export async function updateOrganization(
  orgId: string,
  updates: { name?: string; slug?: string },
): Promise<OrgRow | null> {
  const { data, error } = await supabase
    .from("organizations")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", orgId)
    .select()
    .single();

  if (error) throw new Error(`Failed to update organization: ${error.message}`);
  return (data as OrgRow) ?? null;
}

export async function getOrgMembers(
  orgId: string,
): Promise<(OrgMemberRow & { display_name?: string })[]> {
  const { data, error } = await supabase
    .from("organization_members")
    .select("org_id, user_id, role, joined_at")
    .eq("org_id", orgId)
    .order("joined_at", { ascending: true });

  if (error) throw new Error(`Failed to fetch org members: ${error.message}`);

  const members = (data ?? []) as OrgMemberRow[];
  if (members.length === 0) return [];

  // Fetch display names from profiles (no direct FK between organization_members and profiles)
  const userIds = members.map((m) => m.user_id);
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, display_name")
    .in("id", userIds);

  const profileMap = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  return members.map((row) => ({
    ...row,
    display_name: profileMap.get(row.user_id) ?? undefined,
  }));
}

export async function getOrgMember(
  orgId: string,
  userId: string,
): Promise<OrgMemberRow | null> {
  const { data } = await supabase
    .from("organization_members")
    .select("*")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .single();

  return (data as OrgMemberRow) ?? null;
}

export async function findUserByEmail(email: string): Promise<{ id: string } | null> {
  // Look up user in auth.users via profiles join
  // Since we use service role, we can query auth.users
  const { data } = await supabase.rpc("get_user_id_by_email" as never, {
    p_email: email,
  } as never);

  // Fallback: search in auth admin API
  if (!data) {
    const { data: { users }, error } = await supabase.auth.admin.listUsers();
    if (error) return null;
    const user = users.find((u) => u.email === email);
    return user ? { id: user.id } : null;
  }

  return data ? { id: data as string } : null;
}

export async function addMember(
  orgId: string,
  userId: string,
  role: OrgRole = "member",
): Promise<void> {
  const { error } = await supabase.from("organization_members").insert({
    org_id: orgId,
    user_id: userId,
    role,
  });

  if (error) {
    if (error.code === "23505") throw new Error("Cet utilisateur est deja membre de cette organisation");
    throw new Error(`Failed to add member: ${error.message}`);
  }
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  const { error } = await supabase
    .from("organization_members")
    .delete()
    .eq("org_id", orgId)
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to remove member: ${error.message}`);
}

export async function updateMemberRole(
  orgId: string,
  userId: string,
  role: OrgRole,
): Promise<void> {
  const { error } = await supabase
    .from("organization_members")
    .update({ role })
    .eq("org_id", orgId)
    .eq("user_id", userId);

  if (error) throw new Error(`Failed to update member role: ${error.message}`);
}

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

export async function deleteOrganization(orgId: string): Promise<void> {
  // Check for running executions
  const { count: runningCount } = await supabase
    .from("executions")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .in("status", ["pending", "running"]);

  if (runningCount && runningCount > 0) {
    throw new Error("Impossible de supprimer l'organisation : des executions sont en cours");
  }

  // Delete in FK-safe order (children before parents)
  // execution_logs → executions (cascade), but org_id FK needs manual delete
  await supabase.from("execution_logs").delete().eq("org_id", orgId);
  await supabase.from("executions").delete().eq("org_id", orgId);
  await supabase.from("share_tokens").delete().eq("org_id", orgId);
  await supabase.from("flow_admin_connections").delete().eq("org_id", orgId);
  // schedule_runs cascades from flow_schedules
  await supabase.from("flow_schedules").delete().eq("org_id", orgId);
  await supabase.from("flow_configs").delete().eq("org_id", orgId);
  await supabase.from("flows").delete().eq("org_id", orgId);
  // organization_members cascades from organizations

  const { error } = await supabase.from("organizations").delete().eq("id", orgId);
  if (error) throw new Error(`Failed to delete organization: ${error.message}`);
}

export async function isSlugAvailable(slug: string): Promise<boolean> {
  const { count } = await supabase
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .eq("slug", slug);
  return (count ?? 0) === 0;
}
