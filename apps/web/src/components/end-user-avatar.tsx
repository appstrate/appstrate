// SPDX-License-Identifier: Apache-2.0

import type { EndUserInfo } from "../hooks/use-end-users";

const COLORS = [
  "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
  "bg-violet-500/20 text-violet-600 dark:text-violet-400",
  "bg-amber-500/20 text-amber-600 dark:text-amber-400",
  "bg-rose-500/20 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400",
  "bg-fuchsia-500/20 text-fuchsia-600 dark:text-fuchsia-400",
  "bg-orange-500/20 text-orange-600 dark:text-orange-400",
];

function hashCode(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function initials(name: string | null, email: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/);
    if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  return email ? email.slice(0, 2).toUpperCase() : "?";
}

export function EndUserAvatar({ user }: { user: EndUserInfo }) {
  const color = COLORS[hashCode(user.id) % COLORS.length]!;
  return (
    <span
      aria-hidden
      className={`flex size-8 shrink-0 items-center justify-center rounded-full text-[0.7rem] font-semibold ${color}`}
    >
      {initials(user.name, user.email)}
    </span>
  );
}
