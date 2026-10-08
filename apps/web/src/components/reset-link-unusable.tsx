// SPDX-License-Identifier: Apache-2.0

import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertCircle } from "lucide-react";

/** A reset link that can no longer be used, with the way to get a new one. */
export function ResetLinkUnusable({ message }: { message: string }) {
  const { t } = useTranslation("settings");
  return (
    <div className="flex flex-col items-center gap-6 text-center">
      <div className="bg-destructive/10 flex h-16 w-16 items-center justify-center rounded-full">
        <AlertCircle className="text-destructive h-8 w-8" />
      </div>
      <p className="text-muted-foreground text-sm">{message}</p>
      <Link
        to="/forgot-password"
        className="text-muted-foreground hover:text-primary text-sm underline underline-offset-4"
      >
        {t("resetPassword.requestNew")}
      </Link>
    </div>
  );
}
