// SPDX-License-Identifier: Apache-2.0

/**
 * What the user has to do once a connection's credentials were MINTED by the
 * platform rather than pasted by them.
 *
 * The server returns these as an ordered list of typed steps, so this renders
 * the list and nothing else knows what SSH is. A second provisioning kind — an
 * SSH certificate authority, an mTLS client cert — ships without a branch here.
 *
 * Every step carries a stable `id`, so its label and note are read from the
 * bundle when a key exists and fall back to the server's English otherwise — a
 * new step is legible the day it ships. Shell blocks and values are generated
 * material and are rendered verbatim.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@appstrate/ui/components/button";
import type { components } from "../../api/schema";

/**
 * Straight off the generated wire types — the server owns this shape, so
 * restating it here would be a copy free to drift from the one the spec checks.
 */
export type HandoffStep = components["schemas"]["HandoffStep"];

/** The two arms of the union, each carrying the payload its `kind` requires. */
type HandoffCommandStep = Extract<HandoffStep, { kind: "command" }>;
type HandoffValueStep = Extract<HandoffStep, { kind: "value" }>;

/** The translated label, or the English the server sent when no key exists. */
const stepLabel = (t: TFunction, step: HandoffStep): string =>
  t(`integration.connect.handoff.${step.id}.label`, { defaultValue: step.label });

/**
 * The translated note, or the server's. Keyed off the step HAVING one: a
 * bundle key must not conjure a note onto a step the server sent none for.
 */
const stepNote = (t: TFunction, step: HandoffStep): string | undefined =>
  step.note
    ? t(`integration.connect.handoff.${step.id}.note`, { defaultValue: step.note })
    : undefined;

const BLOCK_CLASS =
  "bg-muted/40 max-h-80 overflow-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed whitespace-pre";

function CommandStep({
  step,
  index,
  hideLabel,
}: {
  step: HandoffCommandStep;
  index: number;
  /** The label is already the `<summary>` of a collapsed step — do not repeat it. */
  hideLabel?: boolean;
}) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2" data-testid={`handoff-step-${index}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{hideLabel ? "" : stepLabel(t, step)}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`handoff-copy-${index}`}
          onClick={() => {
            void navigator.clipboard
              .writeText(step.shell)
              .then(() => setCopied(true))
              // Clipboard access can be denied (permissions, insecure context).
              // The block is selectable either way, so the failure only costs
              // the confirmation.
              .catch(() => setCopied(false));
          }}
        >
          {copied ? t("integration.connect.provisioned.copied") : t("btn.copy")}
        </Button>
      </div>
      {step.note && (
        <p className="text-muted-foreground text-xs leading-snug">{stepNote(t, step)}</p>
      )}
      <pre className={BLOCK_CLASS}>{step.shell}</pre>
    </div>
  );
}

function ValueStep({ step, index }: { step: HandoffValueStep; index: number }) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-1" data-testid={`handoff-step-${index}`}>
      <span className="text-xs font-semibold">{stepLabel(t, step)}</span>
      <p className="font-mono text-xs break-all" data-testid={`handoff-value-${index}`}>
        {step.value}
      </p>
      {step.note && <p className="text-muted-foreground text-xs">{stepNote(t, step)}</p>}
    </div>
  );
}

export function HandoffSteps({ steps }: { steps: readonly HandoffStep[] }) {
  const { t } = useTranslation("settings");
  if (steps.length === 0) return null;

  // A deferred step is not part of what to do now — collapsing it keeps the
  // screen about the one action that matters, without hiding the teardown the
  // user will need later and nothing else will hand them.
  // `flatMap` rather than a second `filter`: it is what narrows a kept step to
  // the command arm the `<details>` below reads.
  const now = steps.filter((s) => !(s.kind === "command" && s.deferred));
  const later = steps.flatMap((s) => (s.kind === "command" && s.deferred ? [s] : []));

  return (
    <div className="space-y-5" data-testid="handoff-steps">
      {now.map((step, i) =>
        step.kind === "command" ? (
          <CommandStep key={i} step={step} index={i} />
        ) : (
          <ValueStep key={i} step={step} index={i} />
        ),
      )}

      {later.map((step, i) => (
        <details key={i} className="space-y-1">
          <summary className="cursor-pointer text-xs font-semibold">
            {stepLabel(t, step)}
            <span className="text-muted-foreground font-normal">
              {" — "}
              {t("integration.connect.provisioned.deferredHint")}
            </span>
          </summary>
          <div className="mt-2">
            <CommandStep step={step} index={now.length + i} hideLabel />
          </div>
        </details>
      ))}
    </div>
  );
}
