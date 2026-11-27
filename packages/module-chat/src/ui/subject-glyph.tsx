// SPDX-License-Identifier: Apache-2.0

import * as React from "react";
import { BookOpenIcon, CircleUserIcon } from "lucide-react";
import type { PresentationSubject } from "@appstrate/core/mcp-presentation";
import { IntegrationIcon } from "@appstrate/ui/components/integration-icon";
import { KnownAgentGlyph } from "./agent-glyph.tsx";
import { subjectName } from "./tool-presentation.ts";

/** The glyph of what a call acted on: the integration's logo, the agent's tile, the user. */
export function SubjectGlyph({
  subject,
  className = "size-4",
}: {
  subject: PresentationSubject;
  className?: string;
}) {
  switch (subject.kind) {
    case "integration":
      return <IntegrationIcon src={subject.icon} className={`${className} shrink-0 rounded-sm`} />;
    case "agent":
      return (
        <KnownAgentGlyph
          agentRef={{ packageId: subject.id }}
          label={subjectName(subject)}
          className={className}
        />
      );
    case "skill":
      return <BookOpenIcon className={`text-muted-foreground ${className} shrink-0`} />;
    case "user":
      return <CircleUserIcon className={`text-muted-foreground ${className} shrink-0`} />;
  }
}

const MAX_STACKED = 4;

/** Overlapping glyphs of distinct subjects (a search's results, a group's reads), past 4 « +N ». */
export function SubjectStack({ subjects }: { subjects: readonly PresentationSubject[] }) {
  const distinct = React.useMemo(() => {
    const seen = new Set<string>();
    return subjects.filter((s) => {
      const key = `${s.kind}:${s.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [subjects]);
  if (distinct.length === 0) return null;
  const hidden = distinct.length - MAX_STACKED;
  return (
    <span className="flex shrink-0 items-center -space-x-1" aria-hidden="true">
      {distinct.slice(0, MAX_STACKED).map((s) => (
        <span key={`${s.kind}:${s.id}`} className="ring-card inline-flex rounded-sm ring-2">
          <SubjectGlyph subject={s} className="size-3.5" />
        </span>
      ))}
      {hidden > 0 ? (
        <span className="bg-muted text-muted-foreground ring-card inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-sm px-0.5 text-[9px] leading-none font-medium tabular-nums ring-2">
          +{hidden}
        </span>
      ) : null}
    </span>
  );
}
