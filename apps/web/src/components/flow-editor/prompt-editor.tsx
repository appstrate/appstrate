import { useTranslation } from "react-i18next";
import { ContentEditor } from "../package-editor/content-editor";

interface PromptEditorProps {
  value: string;
  onChange: (value: string) => void;
}

export function PromptEditor({ value, onChange }: PromptEditorProps) {
  const { t } = useTranslation(["flows", "common"]);

  return (
    <>
      <ContentEditor value={value} onChange={onChange} language="markdown" />
      <div className="hint">{t("editor.promptHint")}</div>
    </>
  );
}
