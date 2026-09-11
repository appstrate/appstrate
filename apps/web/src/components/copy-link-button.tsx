// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";

export function CopyLinkButton({ token }: { token: string }) {
  const { t } = useTranslation(["common"]);
  const { copied, copy } = useCopyToClipboard();
  // Resolved on click, not on render: the origin is a browser fact and this
  // button also renders on the no-DOM test harness.
  const copyLink = () => copy(`${window.location.origin}/invite/${token}`);

  return (
    <Button variant="outline" size="sm" onClick={copyLink}>
      {copied ? t("btn.copied") : t("btn.copyLink")}
    </Button>
  );
}
