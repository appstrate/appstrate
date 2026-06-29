// SPDX-License-Identifier: Apache-2.0

import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";

interface StringListInputProps {
  label?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  description?: string;
}

/**
 * Enter/comma-to-add chip list (authorized URIs, scopes, URL patterns, …).
 *
 * Pending typed text that the user hasn't yet confirmed with Enter/comma is
 * auto-committed on blur (focus loss) — leaving the section, switching tabs,
 * or clicking outside the field saves the in-progress chip rather than
 * silently discarding it.
 */
export function StringListInput({
  label,
  values,
  onChange,
  placeholder,
  description,
}: StringListInputProps) {
  const commitFromInput = (input: HTMLInputElement) => {
    const v = input.value.trim().replace(/,$/g, "");
    if (v && !values.includes(v)) onChange([...values, v]);
    input.value = "";
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitFromInput(e.currentTarget);
    }
  };

  return (
    <div className="space-y-2">
      {label && <Label>{label}</Label>}
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className="border-border bg-background text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 font-mono text-xs"
            >
              {v}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive h-auto w-auto p-0 text-sm leading-none"
                onClick={() => onChange(values.filter((x) => x !== v))}
              >
                &times;
              </Button>
            </span>
          ))}
        </div>
      )}
      <Input
        type="text"
        placeholder={placeholder}
        onKeyDown={handleKeyDown}
        onBlur={(e) => commitFromInput(e.currentTarget)}
      />
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
    </div>
  );
}
