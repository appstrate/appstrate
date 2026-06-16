// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { PackageVersionSelect } from "./package-version-select";

const INHERIT = "__inherit__";
const DRAFT = "draft";

interface SkillDep {
  id: string;
  version?: string;
  name?: string;
}

export interface DependencyOverridesSectionProps {
  /** Agent's declared skill dependencies (`agent.dependencies.skills`). */
  skills: SkillDep[];
  /** Controlled value — flat `{ "@scope/skill": "draft" | "<version>" }`. */
  value: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}

/**
 * Per-skill dependency override editor (#666). For each declared skill the
 * user can keep the manifest pin (inherit), run the dependency's mutable
 * working copy ("draft" — the skill edit loop), or pin an exact published
 * version for this run. Emits the flat `{ skillId: "draft" | "<version>" }`
 * map `dependency_overrides` expects, with inherit entries omitted so the
 * payload only carries genuine overrides.
 *
 * Skills are the only bundled dependency type the run resolves, matching
 * `buildAgentPackage` server-side.
 */
export function DependencyOverridesSection({
  skills,
  value,
  onChange,
}: DependencyOverridesSectionProps) {
  const { t } = useTranslation(["agents"]);
  if (skills.length === 0) return null;
  return (
    <div className="space-y-2">
      <Label>{t("run.overrides.dependencyLabel")}</Label>
      <p className="text-muted-foreground text-xs">{t("run.overrides.dependencyHint")}</p>
      <div className="border-border bg-card space-y-3 rounded-md border p-3">
        {skills.map((skill) => (
          <DependencyOverrideRow
            key={skill.id}
            skill={skill}
            value={value[skill.id] ?? INHERIT}
            onChange={(next) => {
              const updated = { ...value };
              if (next === INHERIT) delete updated[skill.id];
              else updated[skill.id] = next;
              onChange(updated);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function DependencyOverrideRow({
  skill,
  value,
  onChange,
}: {
  skill: SkillDep;
  /** Current selection: INHERIT, "draft", or an exact published version. */
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation(["agents"]);
  const label = skill.name ?? skill.id;
  return (
    <div className="space-y-1.5" data-testid={`dep-override-row-${skill.id}`}>
      <div className="text-xs font-medium">{label}</div>
      <PackageVersionSelect
        type="skill"
        packageId={skill.id}
        value={value}
        onChange={onChange}
        leadingOptions={[
          {
            value: INHERIT,
            label: skill.version
              ? t("run.overrides.dependencyInheritPinned", { version: skill.version })
              : t("run.overrides.dependencyInherit"),
          },
          // "draft" runs the dependency's mutable working copy — the skill
          // edit loop. Persisted on the run row so a drafted run is never
          // mistaken for a reproducible one.
          { value: DRAFT, label: t("run.overrides.dependencyDraft") },
        ]}
      />
    </div>
  );
}
