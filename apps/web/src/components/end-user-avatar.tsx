// SPDX-License-Identifier: Apache-2.0

import type { EndUserInfo } from "../hooks/use-end-users";

// The person palette (`--avatar-*` in `styles.css`), spelled out whole for Tailwind.
const COLORS = [
  "bg-avatar-1/20 text-avatar-1",
  "bg-avatar-2/20 text-avatar-2",
  "bg-avatar-3/20 text-avatar-3",
  "bg-avatar-4/20 text-avatar-4",
  "bg-avatar-5/20 text-avatar-5",
  "bg-avatar-6/20 text-avatar-6",
  "bg-avatar-7/20 text-avatar-7",
  "bg-avatar-8/20 text-avatar-8",
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
