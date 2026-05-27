// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface StringListInputProps {
  label?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  description?: string;
}

/** Enter/comma-to-add chip list (authorized URIs, scopes, URL patterns, …). */
export function StringListInput({
  label,
  values,
  onChange,
  placeholder,
  description,
}: StringListInputProps) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const input = e.currentTarget;
      const v = input.value.trim().replace(/,$/g, "");
      if (v && !values.includes(v)) onChange([...values, v]);
      input.value = "";
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
      <Input type="text" placeholder={placeholder} onKeyDown={handleKeyDown} />
      {description && <p className="text-muted-foreground text-xs">{description}</p>}
    </div>
  );
}
