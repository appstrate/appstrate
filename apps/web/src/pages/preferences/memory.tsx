// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useStore } from "zustand";
import { Brain, Download, Pencil, Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { Badge } from "@appstrate/ui/components/badge";
import { Textarea } from "@appstrate/ui/components/textarea";
import { Input } from "@appstrate/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import {
  USER_MEMORY_CONTENT_MAX_CHARS,
  USER_MEMORY_SUBJECT_MAX_CHARS,
  USER_MEMORY_TYPES,
  renderUserMemories,
  type UserMemoryType,
} from "@appstrate/core/user-memory";
import { $api } from "../../api/client";
import type { paths } from "../../api/schema";
import { LoadingState, ErrorState, EmptyState } from "../../components/page-states";
import { ConfirmModal } from "../../components/confirm-modal";
import { Spinner } from "../../components/spinner";
import { useOrg } from "../../hooks/use-org";
import { authStore } from "../../stores/auth-store";
import { ABOUT_ME, createMemoryBody } from "../../lib/user-memory";

type Memory =
  paths["/api/me/memories"]["get"]["responses"]["200"]["content"]["application/json"]["data"][number];

const MEMORIES_KEY = ["get", "/api/me/memories"] as const;

function useMemories() {
  return $api.useQuery("get", "/api/me/memories", {}, { select: (envelope) => envelope.data });
}

/** One group per origin: about the person first, then each organization. */
function groupByOrigin(
  memories: readonly Memory[],
): Array<{ orgId: string | null; items: Memory[] }> {
  const groups = new Map<string | null, Memory[]>();
  for (const m of memories) groups.set(m.orgId, [...(groups.get(m.orgId) ?? []), m]);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? -1 : b === null ? 1 : 0))
    .map(([orgId, items]) => ({ orgId, items }));
}

function downloadMarkdown(memories: readonly Memory[]) {
  const orgNames = Object.fromEntries(
    memories.filter((m) => m.orgId && m.org_name).map((m) => [m.orgId!, m.org_name!]),
  );
  const body = `# Memory\n\n${renderUserMemories(memories, { orgNames })}\n`;
  const url = URL.createObjectURL(new Blob([body], { type: "text/markdown" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "assistant-memory.md";
  link.click();
  URL.revokeObjectURL(url);
}

function MemoryRow({ memory }: { memory: Memory }) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(memory.content);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const invalidate = () => queryClient.invalidateQueries({ queryKey: MEMORIES_KEY });
  const update = $api.useMutation("patch", "/api/me/memories/{id}", { onSuccess: invalidate });
  const remove = $api.useMutation("delete", "/api/me/memories/{id}", { onSuccess: invalidate });

  return (
    <li className="border-border flex items-start gap-3 border-b py-3 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <Badge variant="secondary">{t(`memory.type.${memory.type}`)}</Badge>
          {memory.subject && <Badge variant="outline">{memory.subject}</Badge>}
          <span className="text-muted-foreground text-xs">
            {memory.created_by === "assistant" ? t("memory.byAssistant") : t("memory.byYou")}
          </span>
        </div>
        {editing ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              update.mutate(
                { params: { path: { id: memory.id } }, body: { content } },
                { onSuccess: () => setEditing(false) },
              );
            }}
          >
            <Textarea
              value={content}
              maxLength={USER_MEMORY_CONTENT_MAX_CHARS}
              onChange={(e) => setContent(e.target.value)}
              autoFocus
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={update.isPending || !content.trim()}>
                {update.isPending ? <Spinner /> : t("btn.save", { ns: "common" })}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(false)}>
                {t("btn.cancel", { ns: "common" })}
              </Button>
            </div>
          </form>
        ) : (
          <p className="text-sm">{memory.content}</p>
        )}
      </div>
      {!editing && (
        <div className="flex shrink-0 gap-1">
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("memory.edit")}
            onClick={() => setEditing(true)}
          >
            <Pencil size={14} />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("memory.delete")}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 size={14} />
          </Button>
        </div>
      )}
      <ConfirmModal
        open={confirmDelete}
        title={t("memory.deleteTitle")}
        description={memory.content}
        confirmLabel={t("memory.delete")}
        variant="destructive"
        isPending={remove.isPending}
        onConfirm={() =>
          remove.mutate(
            { params: { path: { id: memory.id } } },
            { onSuccess: () => setConfirmDelete(false) },
          )
        }
        onClose={() => setConfirmDelete(false)}
      />
    </li>
  );
}

function AddMemoryForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const { orgs } = useOrg();
  const [type, setType] = useState<UserMemoryType>("preference");
  const [content, setContent] = useState("");
  const [subject, setSubject] = useState("");
  const [origin, setOrigin] = useState<string>(ABOUT_ME);
  const create = $api.useMutation("post", "/api/me/memories", {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEMORIES_KEY }),
  });

  return (
    <form
      className="border-border bg-card mb-4 flex flex-col gap-3 rounded-lg border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          { body: createMemoryBody({ type, content, subject, origin }) },
          { onSuccess: onDone },
        );
      }}
    >
      <div className="flex flex-wrap gap-2">
        <Select value={type} onValueChange={(v) => setType(v as UserMemoryType)}>
          <SelectTrigger className="w-[180px]" aria-label={t("memory.typeLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {USER_MEMORY_TYPES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`memory.type.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={origin} onValueChange={setOrigin}>
          <SelectTrigger className="w-[240px]" aria-label={t("memory.originLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ABOUT_ME}>{t("memory.aboutMe")}</SelectItem>
            {orgs.map((org) => (
              <SelectItem key={org.id} value={org.id}>
                {org.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          className="w-[200px]"
          placeholder={t("memory.subjectPlaceholder")}
          maxLength={USER_MEMORY_SUBJECT_MAX_CHARS}
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
        />
      </div>
      <Textarea
        placeholder={t("memory.contentPlaceholder")}
        maxLength={USER_MEMORY_CONTENT_MAX_CHARS}
        value={content}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={create.isPending || !content.trim()}>
          {create.isPending ? <Spinner /> : t("memory.add")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("btn.cancel", { ns: "common" })}
        </Button>
      </div>
    </form>
  );
}

export function PreferencesMemoryPage() {
  const { t } = useTranslation(["settings", "common"]);
  const queryClient = useQueryClient();
  const profile = useStore(authStore, (s) => s.profile);
  const enabled = profile?.assistantMemory ?? true;
  const { data, isLoading, error } = useMemories();
  const [adding, setAdding] = useState(false);
  const [forgetOrigin, setForgetOrigin] = useState<{ origin: string; label: string } | null>(null);

  const toggle = $api.useMutation("patch", "/api/profile", {
    onSuccess: (updated) => {
      const state = authStore.getState();
      if (state.profile) {
        authStore.setState({
          profile: { ...state.profile, assistantMemory: updated.assistant_memory },
        });
      }
    },
  });
  const forget = $api.useMutation("delete", "/api/me/memories", {
    onSuccess: () => queryClient.invalidateQueries({ queryKey: MEMORIES_KEY }),
  });

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} />;
  const memories = data ?? [];
  const originLabel = (group: { orgId: string | null; items: Memory[] }) =>
    group.orgId === null
      ? t("memory.aboutMe")
      : (group.items[0]?.org_name ?? t("memory.unknownOrg"));

  return (
    <>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-muted-foreground text-sm font-medium">{t("memory.title")}</div>
          <p className="text-muted-foreground mt-1 max-w-prose text-xs">
            {t("memory.description")}
          </p>
        </div>
        <Button
          variant={enabled ? "default" : "outline"}
          size="sm"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate({ body: { assistant_memory: !enabled } })}
        >
          {toggle.isPending ? <Spinner /> : enabled ? t("memory.turnOff") : t("memory.turnOn")}
        </Button>
      </div>

      {!enabled && (
        <p className="border-border bg-muted text-muted-foreground mb-4 rounded-lg border p-3 text-sm">
          {t("memory.offNotice")}
        </p>
      )}

      <div className="mb-4 flex flex-wrap gap-2">
        {!adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            {t("memory.add")}
          </Button>
        )}
        {memories.length > 0 && (
          <>
            <Button size="sm" variant="outline" onClick={() => downloadMarkdown(memories)}>
              <Download size={14} />
              {t("memory.export")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setForgetOrigin({ origin: "all", label: t("memory.everything") })}
            >
              {t("memory.forgetAll")}
            </Button>
          </>
        )}
      </div>

      {adding && <AddMemoryForm onDone={() => setAdding(false)} />}

      {memories.length === 0 ? (
        <EmptyState icon={Brain} message={t("memory.emptyTitle")} hint={t("memory.emptyHint")} />
      ) : (
        <div className="flex flex-col gap-4">
          {groupByOrigin(memories).map((group) => (
            <section
              key={group.orgId ?? "me"}
              className="border-border bg-card rounded-lg border px-4 py-2"
            >
              <div className="flex items-center justify-between gap-2 py-2">
                <h3 className="text-sm font-semibold">
                  {originLabel(group)}
                  {group.items[0]?.org_member === false && (
                    <span className="text-muted-foreground ml-2 text-xs font-normal">
                      {t("memory.leftOrg")}
                    </span>
                  )}
                </h3>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setForgetOrigin({ origin: group.orgId ?? "me", label: originLabel(group) })
                  }
                >
                  {t("memory.forgetGroup")}
                </Button>
              </div>
              <ul>
                {group.items.map((memory) => (
                  <MemoryRow key={memory.id} memory={memory} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <ConfirmModal
        open={forgetOrigin !== null}
        title={t("memory.forgetTitle")}
        description={t("memory.forgetDescription", { label: forgetOrigin?.label ?? "" })}
        confirmLabel={t("memory.forget")}
        variant="destructive"
        isPending={forget.isPending}
        onConfirm={() => {
          if (!forgetOrigin) return;
          forget.mutate(
            { params: { query: { origin: forgetOrigin.origin } } },
            { onSuccess: () => setForgetOrigin(null) },
          );
        }}
        onClose={() => setForgetOrigin(null)}
      />
    </>
  );
}
