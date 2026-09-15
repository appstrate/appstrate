// SPDX-License-Identifier: Apache-2.0

/**
 * The settings row, in the three shapes the control itself calls for.
 *
 * One shape for every setting in the product, so the answer to "how do I change
 * this" never has to be learned twice. The rule it encodes: **the control IS
 * the setting**. A field you can type in, a dropdown you can open, a toggle you
 * can flip — never a value with an Edit button beside it, which puts two clicks
 * and a mode change between the user and a one-word change.
 *
 * Fields follow their explanation and take a readable line of their own.
 * Toggles sit beside their label. Actions stay opposite their explanation.
 *
 * A setting whose explanation is documentation rather than a decision keeps a
 * one-line description and folds the rest behind "Voir les détails" (`details`):
 * the row reads like every other one, and the depth is one click away. What
 * must be seen to act (a reason the control is disabled) stays in `description`.
 */
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import { cn } from "@appstrate/ui/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { SettingsHeading } from "./settings-heading";

/** Read-only counterpart of a setting field. Render inside a description list. */
export function SettingValue({
  label,
  children,
  technical = false,
}: {
  label: ReactNode;
  children: ReactNode;
  technical?: boolean;
}) {
  return (
    <div className="pb-8 last:pb-0">
      <dt className="text-sm font-medium">{label}</dt>
      <dd
        className={cn(
          "text-muted-foreground mt-1 space-y-2 text-sm leading-relaxed break-words",
          technical && "font-mono break-all",
        )}
      >
        {children}
      </dd>
    </div>
  );
}

export function SettingsGroup({
  title,
  children,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-8", className)}>
      {title && <SettingsHeading level="group" title={title} />}
      <div>{children}</div>
    </section>
  );
}

export function SettingRow({
  variant = "field",
  label,
  description,
  children,
  status,
  details,
  className,
}: {
  variant?: "field" | "toggle" | "action";
  label: ReactNode;
  description?: ReactNode;
  /** The long explanation, folded under the description behind "Voir les détails". */
  details?: ReactNode;
  /** The control. Its kind decides the row's shape. */
  children: ReactNode;
  /** Transient state rendered beside the control, such as a saving spinner. */
  status?: ReactNode;
  className?: string;
}) {
  const explanation = (description || details) && (
    <RowExplanation description={description} details={details} />
  );
  const copy = (
    <div className="min-w-0">
      <div className="text-sm font-medium">{label}</div>
      {explanation}
    </div>
  );

  if (variant === "field") {
    return (
      <div data-slot="setting-row" data-variant="field" className={cn("pb-8 last:pb-0", className)}>
        {copy}
        <div className="mt-3 flex w-full items-center gap-2">
          {children}
          {status}
        </div>
      </div>
    );
  }

  if (variant === "toggle") {
    return (
      <div
        data-slot="setting-row"
        data-variant="toggle"
        className={cn("pb-8 last:pb-0", className)}
      >
        <div className="flex items-center gap-2">
          {children}
          <div className="text-sm font-medium">{label}</div>
          {status}
        </div>
        {explanation}
      </div>
    );
  }

  return (
    <div
      data-slot="setting-row"
      data-variant="action"
      className={cn("flex items-center justify-between gap-6 pb-8 last:pb-0", className)}
    >
      {copy}
      <div className="flex shrink-0 items-center gap-2">
        {children}
        {status}
      </div>
    </div>
  );
}

function RowExplanation({
  description,
  details,
}: {
  description?: ReactNode;
  details?: ReactNode;
}) {
  const { t } = useTranslation("common");
  if (!details) {
    return <div className="text-muted-foreground mt-1 text-xs leading-relaxed">{description}</div>;
  }
  return (
    <Collapsible className="group/details">
      <div className="text-muted-foreground mt-1 text-xs leading-relaxed">
        {description}
        {description && " "}
        <CollapsibleTrigger className="text-foreground focus-visible:ring-ring inline-flex h-auto items-center gap-0.5 rounded-sm bg-transparent p-0 text-xs font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2">
          <span className="group-data-[state=open]/details:hidden">
            {t("settingRow.showDetails")}
          </span>
          <span className="hidden group-data-[state=open]/details:inline">
            {t("settingRow.hideDetails")}
          </span>
          <ChevronDown
            className="size-3 transition-transform group-data-[state=open]/details:rotate-180"
            aria-hidden
          />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="text-muted-foreground mt-2 max-w-3xl text-xs leading-relaxed">
        {details}
      </CollapsibleContent>
    </Collapsible>
  );
}
