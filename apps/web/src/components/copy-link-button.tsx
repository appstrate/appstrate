// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "../hooks/use-copy-to-clipboard";

export function CopyLinkButton({ token }: { token: string }) {
  const { t } = useTranslation(["common"]);
  const { copied, copy } = useCopyToClipboard();
  const link = `${window.location.origin}/invite/${token}`;

  return (
    <Button variant="outline" size="sm" onClick={() => copy(link)}>
      {copied ? t("btn.copied") : t("btn.copyLink")}
    </Button>
  );
}
