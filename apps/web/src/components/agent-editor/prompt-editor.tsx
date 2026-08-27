// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ContentEditor } from "../package-editor/content-editor";

interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
  showHint?: boolean;
}

export function PromptEditor({ value, onChange, showHint = true }: PromptEditorProps) {
  const { t } = useTranslation(["agents", "common"]);

  return (
    <>
      <ContentEditor value={value} onChange={onChange} language="markdown" />
      {showHint && (
        <div className="text-muted-foreground mt-1 text-xs">{t("editor.promptHint")}</div>
      )}
    </>
  );
}
