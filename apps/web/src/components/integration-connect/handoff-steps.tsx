// SPDX-License-Identifier: Apache-2.0

/**
 * Steps to do once credentials were MINTED by the platform. Server-sent typed steps; label and
 * note come from the bundle by step `id` (server English fallback), shell/values verbatim.
 */

import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { CopyBlock } from "../copy-block";
import type { components } from "../../api/schema";

export type HandoffStep = components["schemas"]["HandoffStep"];

const stepLabel = (t: TFunction, step: HandoffStep): string =>
  t(`integration.connect.handoff.${step.id}.label`, { defaultValue: step.label });

/** Keyed off the step HAVING a note: a bundle key must not conjure one. */
const stepNote = (t: TFunction, step: HandoffStep): string | undefined =>
  step.note
    ? t(`integration.connect.handoff.${step.id}.note`, { defaultValue: step.note })
    : undefined;

function Step({ step, index }: { step: HandoffStep; index: number }) {
  const { t } = useTranslation("settings");
  const label = stepLabel(t, step);
  const note = stepNote(t, step);
  const command = step.kind === "command";
  const body = (
    <>
      <CopyBlock
        value={command ? step.shell : step.value}
        multiline={command}
        className={command ? "max-h-80 overflow-y-auto" : ""}
        testId={`handoff-step-${index}`}
      />
      {note && <p className="text-muted-foreground text-xs leading-snug">{note}</p>}
    </>
  );

  // A deferred step (the teardown) is not what to do now: collapsed, never dropped.
  if (command && step.deferred) {
    return (
      <details>
        <summary className="cursor-pointer text-xs font-semibold">
          {label}
          <span className="text-muted-foreground font-normal">
            {" — "}
            {t("integration.connect.handoffPanel.deferredHint")}
          </span>
        </summary>
        <div className="mt-2 space-y-2">{body}</div>
      </details>
    );
  }
  return (
    <div className="space-y-2">
      <span className="block text-xs font-semibold">{label}</span>
      {body}
    </div>
  );
}

export function HandoffSteps({ steps }: { steps: readonly HandoffStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="space-y-5" data-testid="handoff-steps">
      {steps.map((step, i) => (
        <Step key={i} step={step} index={i} />
      ))}
    </div>
  );
}
