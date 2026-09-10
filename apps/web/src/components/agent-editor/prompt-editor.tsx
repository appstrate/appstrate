// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { ContentEditor } from "../package-editor/content-editor";

interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function PromptEditor({ value, onChange }: PromptEditorProps) {
  const { t } = useTranslation(["agents", "common"]);

  return (
    <>
      {/* No `key`: the agent's prompt has exactly one writer, this editor's own
          `onChange`. The JSON tab applies the manifest only, the resolved-skills
          sync touches the manifest only, and a version restore happens on the
          package's detail page — the editor is not mounted for it. */}
      <ContentEditor value={value} onChange={onChange} language="markdown" />
      <div className="text-muted-foreground mt-1 text-xs">{t("editor.promptHint")}</div>
    </>
  );
}
