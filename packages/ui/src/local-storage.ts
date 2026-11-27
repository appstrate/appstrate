// SPDX-License-Identifier: Apache-2.0

import { useSyncExternalStore } from "react";

/**
 * Per-browser preferences: one key format (`appstrate:<zone>:<key>[:<scope>]`), one inventory
 * (`LOCAL_STORAGE_KEYS`), one factory (`createLocalStore`). `localStorage` can be absent, blocked
 * or full, so every access is guarded: a failure costs the preference, never the click.
 * Not inventoried, owned by a library: `i18nextLng` and the emoji picker's cache.
 */

/** Where a key lives, so one feature's keys sort together in the devtools. */
type LocalStorageZone = "auth" | "chat" | "web";

export interface LocalStorageEntry {
  readonly zone: LocalStorageZone;
  readonly key: string;
  /** `user`: the key carries the signed-in user id, bound with `store.bind(userId)`. */
  readonly scope?: "user";
}

/** Every `localStorage` key the app writes. Add the entry here, then build its store from it. */
export const LOCAL_STORAGE_KEYS = {
  signedIn: { zone: "auth", key: "signedIn" },
  theme: { zone: "web", key: "theme" },
  sidebar: { zone: "web", key: "sidebar" },
  chatSidebar: { zone: "web", key: "chatSidebar" },
  currentOrg: { zone: "web", key: "currentOrg" },
  lastSpace: { zone: "web", key: "lastSpace" },
  viewAs: { zone: "web", key: "viewAs" },
  overview: { zone: "web", key: "overview" },
  pendingPairings: { zone: "web", key: "pendingPairings" },
  sidebarTips: { zone: "web", key: "sidebarTips", scope: "user" },
  /** Per list name (sub-key). */
  listView: { zone: "web", key: "view" },
  rolesView: { zone: "web", key: "rolesView" },
  /** Per table name (sub-key). */
  columnVisibility: { zone: "web", key: "columns" },
  columnWidths: { zone: "web", key: "columnWidths" },
  /** Per panel view (sub-key). */
  chatPanelWidth: { zone: "chat", key: "contextWidth" },
  chatSummarySections: { zone: "chat", key: "summarySections" },
  chatModelPick: { zone: "chat", key: "modelPick" },
  chatGeneration: { zone: "chat", key: "generation" },
  chatContextAllSpaces: { zone: "chat", key: "contextAllSpaces", scope: "user" },
  chatPackageAuthoring: { zone: "chat", key: "packageAuthoring", scope: "user" },
  chatInlineRunModel: { zone: "chat", key: "inlineRunModel", scope: "user" },
} as const satisfies Record<string, LocalStorageEntry>;

/** Every `sessionStorage` key the app writes, in the same format. */
export const SESSION_STORAGE_KEYS = {
  chunkReload: { zone: "web", key: "chunkReload" },
  oidcState: { zone: "auth", key: "oidcState" },
  oidcVerifier: { zone: "auth", key: "oidcVerifier" },
  oidcRedirect: { zone: "auth", key: "oidcRedirect" },
} as const satisfies Record<string, LocalStorageEntry>;

/** The stored key: `appstrate:<zone>:<key>`, then `:<sub>` when one is given. */
export function storageKey(entry: LocalStorageEntry, sub?: string): string {
  const base = `appstrate:${entry.zone}:${entry.key}`;
  return sub === undefined ? base : `${base}:${sub}`;
}

function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `null` removes the key. `false` when the storage refused: the caller keeps the value for the session. */
function writeItem(key: string, value: string | null): boolean {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** How a value maps to its stored string; `serialize` returning `null` removes the key. */
interface LocalStoreCodec<T> {
  /** `raw` is `null` when nothing is stored. */
  parse(raw: string | null): T;
  serialize(value: T): string | null;
}

/**
 * A JSON value narrowed by `parse`; nothing stored reaches `parse` as `null`, and so does invalid
 * JSON unless `unreadable` is given. Writing `null` removes the key.
 */
export function jsonCodec<T>(
  parse: (value: unknown) => T,
  unreadable?: () => T,
): LocalStoreCodec<T> {
  return {
    parse(raw) {
      if (raw === null) return parse(null);
      try {
        return parse(JSON.parse(raw));
      } catch {
        return unreadable ? unreadable() : parse(null);
      }
    },
    serialize: (value) => (value === null ? null : JSON.stringify(value)),
  };
}

/** One scalar stored as its string form; writing `null` removes the key. */
export function scalarCodec<T extends string | boolean | null>(
  parse: (raw: string | null) => T,
): LocalStoreCodec<T> {
  return { parse, serialize: (value) => (value === null ? null : String(value)) };
}

/** A boolean of which only the departure from `defaultValue` is stored (`"on"` / `"off"`). */
export function flagCodec(defaultValue: boolean): LocalStoreCodec<boolean> {
  return {
    parse: (raw) => (raw === null ? defaultValue : raw === "on"),
    serialize: (value) => (value === defaultValue ? null : value ? "on" : "off"),
  };
}

export interface LocalStore<T> {
  /** The stored value, read now. `sub` selects one key of a keyed store. */
  read(sub?: string): T;
  write(value: T, sub?: string): void;
  subscribe(listener: () => void): () => void;
  /** Subscribed value for components; the reference is stable between writes. */
  useValue(sub?: string): [T, (value: T) => void];
  /** `scope: "user"` entries only: the signed-in user id, `null` = unbound (default, nothing persisted). */
  bind(userId: string | null): void;
}

/**
 * The one store factory. A keyed family (a table, a list) takes its sub-key on each call; a
 * `scope: "user"` entry is bound once with `bind`. Shared by every component and every tab.
 */
export function createLocalStore<T>(
  entry: LocalStorageEntry,
  codec: LocalStoreCodec<T>,
): LocalStore<T> {
  const base = storageKey(entry);
  const listeners = new Set<() => void>();
  /** Stable `useValue` snapshots by stored key; the unbound user scope lives under `""`. */
  const snapshots = new Map<string, T>();
  /** Writes no storage took (blocked, full, absent, or no user bound): kept for the session. */
  const session = new Map<string, T>();
  const userScoped = entry.scope === "user";
  let user: string | null = null;

  /** `null` = an unbound user entry: no stored key. */
  const resolve = (sub?: string): string | null => {
    if (!userScoped) return storageKey(entry, sub);
    return user === null ? null : storageKey(entry, user);
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };

  // A browser fires this event in the other documents sharing the same storage area.
  globalThis.addEventListener?.("storage", (event: StorageEvent) => {
    if (event.key !== null && event.key !== base && !event.key.startsWith(`${base}:`)) return;
    try {
      if (event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    if (event.key === null) {
      snapshots.clear();
      session.clear();
    } else {
      snapshots.delete(event.key);
      session.delete(event.key);
    }
    notify();
  });

  const read = (sub?: string): T => {
    const key = resolve(sub);
    if (key === null) return session.has("") ? (session.get("") as T) : codec.parse(null);
    return session.has(key) ? (session.get(key) as T) : codec.parse(readItem(key));
  };

  const write = (value: T, sub?: string): void => {
    if (Object.is(read(sub), value)) return;
    const key = resolve(sub);
    if (key === null) {
      session.set("", value);
      snapshots.set("", value);
    } else {
      if (writeItem(key, codec.serialize(value))) session.delete(key);
      else session.set(key, value);
      snapshots.set(key, value);
    }
    notify();
  };

  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const snapshot = (sub?: string): T => {
    const key = resolve(sub) ?? "";
    if (snapshots.has(key)) return snapshots.get(key) as T;
    const value = read(sub);
    snapshots.set(key, value);
    return value;
  };

  return {
    read,
    write,
    subscribe,
    useValue: (sub) => {
      const value = useSyncExternalStore(
        subscribe,
        () => snapshot(sub),
        () => snapshot(sub),
      );
      return [value, (next) => write(next, sub)];
    },
    bind(userId) {
      if (userId === user) return;
      user = userId;
      snapshots.delete("");
      session.delete("");
      notify();
    },
  };
}
