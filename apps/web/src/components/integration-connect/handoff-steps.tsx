// SPDX-License-Identifier: Apache-2.0

/**
 * What the user has to do once a connection's credentials were MINTED by the
 * platform rather than pasted by them.
 *
 * The server returns these as an ordered list of typed steps, so this renders
 * the list and nothing else knows what SSH is. A second provisioning kind — an
 * SSH certificate authority, an mTLS client cert — ships without a branch here.
 * It replaced three hand-written sections (a block, a fingerprint, a teardown
 * block) that each had their own markup and their own localised heading.
 *
 * Labels and notes are SERVER text, exactly like `setup_guide`'s: the wording
 * belongs to whatever minted the material, and half of it (a shell block) is
 * generated. Only the page's own chrome is localised here.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@appstrate/ui/components/button";

export interface HandoffStep {
  kind: "command" | "value";
  label: string;
  note?: string;
  /** `kind: "command"` — shell to run on the target. */
  shell?: string;
  /** `kind: "command"` — run when the connection is deleted, not now. */
  deferred?: boolean;
  /** `kind: "value"` — a value to read or compare. */
  value?: string;
}

const BLOCK_CLASS =
  "bg-muted/40 max-h-80 overflow-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed whitespace-pre";

function CommandStep({
  step,
  index,
  hideLabel,
}: {
  step: HandoffStep;
  index: number;
  /** The label is already the `<summary>` of a collapsed step — do not repeat it. */
  hideLabel?: boolean;
}) {
  const { t } = useTranslation("settings");
  const [copied, setCopied] = useState(false);
  const shell = step.shell ?? "";
  return (
    <div className="space-y-2" data-testid={`handoff-step-${index}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{hideLabel ? "" : step.label}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid={`handoff-copy-${index}`}
          onClick={() => {
            void navigator.clipboard
              .writeText(shell)
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
      {step.note && <p className="text-muted-foreground text-xs leading-snug">{step.note}</p>}
      <pre className={BLOCK_CLASS}>{shell}</pre>
    </div>
  );
}

function ValueStep({ step, index }: { step: HandoffStep; index: number }) {
  return (
    <div className="space-y-1" data-testid={`handoff-step-${index}`}>
      <span className="text-xs font-semibold">{step.label}</span>
      <p className="font-mono text-xs break-all" data-testid={`handoff-value-${index}`}>
        {step.value}
      </p>
      {step.note && <p className="text-muted-foreground text-xs">{step.note}</p>}
    </div>
  );
}

export function HandoffSteps({ steps }: { steps: readonly HandoffStep[] }) {
  const { t } = useTranslation("settings");
  if (steps.length === 0) return null;

  // A deferred step is not part of what to do now — collapsing it keeps the
  // screen about the one action that matters, without hiding the teardown the
  // user will need later and nothing else will hand them.
  const now = steps.filter((s) => !s.deferred);
  const later = steps.filter((s) => s.deferred);

  return (
    <div className="space-y-5" data-testid="handoff-steps">
      {now.map((step, i) => {
        // An unknown kind is skipped rather than rendered as an empty box: a
        // provisioner shipped by a module can add one, and the steps around it
        // still carry what the user has to do.
        if (step.kind === "command") return <CommandStep key={i} step={step} index={i} />;
        if (step.kind === "value") return <ValueStep key={i} step={step} index={i} />;
        return null;
      })}

      {later.map((step, i) =>
        step.kind !== "command" ? null : (
          <details key={i} className="space-y-1">
            <summary className="cursor-pointer text-xs font-semibold">
              {step.label}
              <span className="text-muted-foreground font-normal">
                {" — "}
                {t("integration.connect.provisioned.deferredHint")}
              </span>
            </summary>
            <div className="mt-2">
              <CommandStep step={step} index={now.length + i} hideLabel />
            </div>
          </details>
        ),
      )}
    </div>
  );
}
