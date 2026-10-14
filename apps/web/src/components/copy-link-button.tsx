// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { CopyButton } from "./copy-button";
import { invitationUrl } from "../lib/invitation-url";

export function CopyLinkButton({ token }: { token: string }) {
  const { t } = useTranslation(["common"]);
  // Resolved on click, not on render: the origin is a browser fact and this
  // button also renders on the no-DOM test harness.
  return (
    <CopyButton variant="text" getValue={() => invitationUrl(token)} label={t("btn.copyLink")} />
  );
}
