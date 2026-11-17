// SPDX-License-Identifier: Apache-2.0

/**
 * The settings row, in three shapes (field / toggle / action). The control IS the setting:
 * never a value with an Edit button beside it.
 * Documentation-like explanation goes in `details` (folded); what must be seen to act
 * (e.g. why the control is disabled) stays in `description`.
 */
import { useId, type ReactNode } from "react";
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
export function SettingValue({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="pb-8 last:pb-0">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="text-muted-foreground mt-1 text-sm leading-relaxed break-words">{children}</dd>
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
  /** A function receives the label's id, for controls the label does not name (select `aria-labelledby`). */
  children: ReactNode | ((labelId: string) => ReactNode);
  /** What the write says about itself: a `SaveFeedback`, under a field, beside a toggle or an action. */
  status?: ReactNode;
  className?: string;
}) {
  const labelId = useId();
  const control = typeof children === "function" ? children(labelId) : children;
  const labelText = (
    <div id={labelId} className="text-sm font-medium">
      {label}
    </div>
  );
  const explanation = (description || details) && (
    <RowExplanation description={description} details={details} />
  );
  const copy = (
    <div className="min-w-0">
      {labelText}
      {explanation}
    </div>
  );

  if (variant === "field") {
    return (
      <div
        data-slot="setting-row"
        data-variant="field"
        // The write's line takes part of the gap to the next row.
        className={cn(status ? "pb-5" : "pb-8", "last:pb-0", className)}
      >
        {copy}
        <div className="mt-3 flex w-full items-center gap-2">{control}</div>
        {status && <div className="mt-1.5">{status}</div>}
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
          {control}
          {labelText}
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
        {control}
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
