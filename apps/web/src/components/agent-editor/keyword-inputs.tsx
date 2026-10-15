// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@appstrate/ui/components/input";
import type { JSONSchema7 } from "@appstrate/core/form";
import { setKeyword, toKeywordNumber, type NumericKeyword, type TextValue } from "./utils";

/**
 * Text input for a value that is parsed into a typed keyword. The raw text lives
 * in `draft` only while the user is typing (`null` = show the prop's text), so
 * "a, " or "-" are never collapsed mid-keystroke and external changes show up
 * without an effect. The parsed value is committed on blur and on Enter.
 */
export function DraftInput({
  text,
  onCommit,
  ...props
}: { text: string; onCommit: (text: string) => void } & Omit<
  React.ComponentProps<typeof Input>,
  "value" | "onChange" | "onBlur" | "onKeyDown"
>) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== text) onCommit(draft);
    setDraft(null);
  };
  return (
    <Input
      type="text"
      {...props}
      value={draft ?? text}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}

/** A value editable as text, or its JSON read-only when it cannot round-trip through text. */
export function KeywordInput({
  id,
  value,
  onCommit,
}: {
  id?: string;
  value: TextValue;
  onCommit: (text: string) => void;
}) {
  const { t } = useTranslation("agents");
  if (value.locked) {
    return (
      <Input
        id={id}
        type="text"
        value={value.text}
        disabled
        readOnly
        title={t("editor.fieldLockedJson")}
      />
    );
  }
  return <DraftInput id={id} text={value.text} onCommit={onCommit} />;
}

export function NumberKeywordInput({
  id,
  prop,
  keyword,
  onChange,
}: {
  id?: string;
  prop: JSONSchema7;
  keyword: NumericKeyword;
  onChange: (prop: JSONSchema7) => void;
}) {
  const current = prop[keyword];
  return (
    <DraftInput
      id={id}
      text={typeof current === "number" ? String(current) : ""}
      onCommit={(text) => onChange(setKeyword(prop, keyword, toKeywordNumber(keyword, text)))}
    />
  );
}
