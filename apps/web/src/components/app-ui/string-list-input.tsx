// SPDX-License-Identifier: Apache-2.0

import { cn } from "@appstrate/ui/cn";
import { Button } from "@appstrate/ui/components/button";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";

interface StringListInputProps {
  label?: string;
  labelClassName?: string;
  commitOnBlur?: boolean;
  monospace?: boolean;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  description?: string;
}

/** Enter/comma-to-add chip list. Auth lists also commit pending text on blur. */
export function StringListInput({
  label,
  labelClassName,
  commitOnBlur = true,
  monospace = true,
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
    <div className="flex flex-col gap-2">
      {label && <Label className={labelClassName}>{label}</Label>}
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <span
              key={v}
              className={cn(
                "border-border bg-background text-muted-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs",
                monospace && "font-mono",
              )}
            >
              {v}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive size-auto p-0 text-sm leading-none"
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
        onBlur={commitOnBlur ? (e) => commitFromInput(e.currentTarget) : undefined}
      />
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
    </div>
  );
}
