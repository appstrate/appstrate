// SPDX-License-Identifier: Apache-2.0

import { User, Building2 } from "lucide-react";

interface ProfileLabelProps {
  profileType: "user" | "org" | null;
  profileName: string | null;
  profileOwnerName?: string | null;
  iconSize?: string;
  className?: string;
}

export function ProfileLabel({
  profileType,
  profileName,
  profileOwnerName,
  iconSize = "size-3",
  className,
}: ProfileLabelProps) {
  if (!profileName) return null;

  const Icon = profileType === "org" ? Building2 : User;
  const label =
    profileType === "user" && profileOwnerName
      ? `${profileOwnerName} — ${profileName}`
      : profileName;

  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      <Icon className={iconSize} />
      {label}
    </span>
  );
}
