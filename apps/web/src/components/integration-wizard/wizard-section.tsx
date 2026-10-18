// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { cn } from "@appstrate/ui/cn";

const WIZARD_STEPS = ["address", "review", "connect", "tools"] as const;
export type WizardStepId = (typeof WIZARD_STEPS)[number];

const STEP_LABEL_KEYS: Record<WizardStepId, string> = {
  address: "integrationWizard.steps.address",
  review: "integrationWizard.steps.review",
  connect: "integrationWizard.steps.connect",
  tools: "integrationWizard.steps.tools",
};

/** Stable, so a section's heading takes the focus once, when it appears. */
const focusOnMount = (heading: HTMLHeadingElement | null) => heading?.focus();

/** The steps, the current one marked; `null` once all are done. */
export function WizardProgress({ current }: { current: WizardStepId | null }) {
  const { t } = useTranslation("agents");
  const at = current ? WIZARD_STEPS.indexOf(current) : WIZARD_STEPS.length;
  return (
    <ol
      className="flex flex-wrap gap-x-6 gap-y-2 text-sm"
      aria-label={t("integrationWizard.steps.label")}
    >
      {WIZARD_STEPS.map((step, index) => (
        <li
          key={step}
          aria-current={index === at ? "step" : undefined}
          className={cn(
            "flex items-center gap-2",
            index === at ? "text-foreground font-medium" : "text-muted-foreground",
          )}
        >
          <span
            className={cn(
              "grid size-6 place-items-center rounded-full border text-xs tabular-nums",
              index < at && "bg-primary text-primary-foreground border-transparent",
            )}
            aria-hidden
          >
            {index < at ? <Check className="size-3.5" /> : index + 1}
          </span>
          {t(STEP_LABEL_KEYS[step])}
        </li>
      ))}
    </ol>
  );
}

/** One step of the page: its heading takes the focus when it appears. */
export function WizardSection({
  title,
  description,
  focus = true,
  className,
  children,
}: {
  title: string;
  description?: ReactNode;
  /** The first section of a page is reached by Tab, not given the focus. */
  focus?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn("bg-card border-border flex flex-col gap-4 rounded-lg border p-6", className)}
    >
      <header>
        <h2
          ref={focus ? focusOnMount : undefined}
          tabIndex={-1}
          className="text-base font-semibold outline-none"
        >
          {title}
        </h2>
        {description && (
          <div className="text-muted-foreground mt-1 max-w-2xl text-sm leading-relaxed">
            {description}
          </div>
        )}
      </header>
      {children}
    </section>
  );
}
