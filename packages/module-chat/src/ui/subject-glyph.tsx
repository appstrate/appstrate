// SPDX-License-Identifier: Apache-2.0

/**
 * The glyph of what a tool call acted on, as the platform presented it
 * (`tool-presentation.ts`): an integration's logo, an agent's tile, a skill, the user.
 */

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

/** Subjects a stack shows, at most; the rest are counted, not drawn. */
const MAX_STACKED = 4;

/** Overlapping glyphs of distinct subjects (a search's results, a group's reads). */
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
  return (
    <span className="flex shrink-0 items-center -space-x-1" aria-hidden="true">
      {distinct.slice(0, MAX_STACKED).map((s) => (
        <span key={`${s.kind}:${s.id}`} className="ring-card inline-flex rounded-sm ring-2">
          <SubjectGlyph subject={s} className="size-3.5" />
        </span>
      ))}
    </span>
  );
}
