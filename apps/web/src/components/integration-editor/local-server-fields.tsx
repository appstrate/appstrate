// SPDX-License-Identifier: Apache-2.0

/**
 * The run declaration of a LOCAL integration (`source.server`): how the sandbox starts the MCP
 * server the integration ships in its own files. `mcp_config.env` and `tools` are not edited here
 * (the manifest JSON editor owns them) but survive every edit (`setSource` merges).
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { FormField } from "../form-field";
import { LOCAL_SERVER_TYPES, entryPointMissing, type SourceState } from "./utils";

/** One argument per line; blank lines are not arguments. */
const parseArgs = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

const sameArgs = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((arg, index) => arg === b[index]);

interface LocalServerFieldsProps {
  source: SourceState;
  onChange: (patch: Partial<SourceState>) => void;
  /** Paths of the package's draft files; absent while unknown (no entry-point check then). */
  serverFiles?: readonly string[];
  /** Flag the empty required fields (after a refused save). */
  showErrors?: boolean;
}

export function LocalServerFields({
  source,
  onChange,
  serverFiles,
  showErrors,
}: LocalServerFieldsProps) {
  const { t } = useTranslation(["agents", "common"]);
  const requiredError = (value: string) =>
    showErrors && !value.trim() ? t("validation.required", { ns: "common" }) : undefined;
  // The textarea keeps what is typed (a trailing newline or a blank line is not an argument); a
  // change of the manifest from elsewhere (JSON editor) replaces it. `seenArgs` is the last value
  // this component read or emitted: only a different incoming one resets the text, so an argument
  // the text cannot carry back (an empty string) does not loop.
  const [argsText, setArgsText] = useState(source.args.join("\n"));
  const [seenArgs, setSeenArgs] = useState(source.args);
  if (!sameArgs(seenArgs, source.args)) {
    setSeenArgs(source.args);
    setArgsText(source.args.join("\n"));
  }

  return (
    <>
      <FormField
        id="int-source-server-type"
        label={t("integrationEditor.source.serverType")}
        value={source.serverType}
        onChange={(v) => {
          const type = LOCAL_SERVER_TYPES.find((candidate) => candidate === v);
          if (type) onChange({ serverType: type });
        }}
        enumValues={[...LOCAL_SERVER_TYPES]}
        description={t("integrationEditor.source.serverTypeDesc")}
      />
      <div className="flex flex-col gap-2">
        <FormField
          id="int-source-server-entry"
          label={t("integrationEditor.source.serverEntryPoint")}
          required
          value={source.entryPoint}
          onChange={(v) => onChange({ entryPoint: v })}
          placeholder="server/index.ts"
          error={requiredError(source.entryPoint)}
          description={t("integrationEditor.source.serverEntryPointDesc")}
        />
        {serverFiles && entryPointMissing(source.entryPoint, serverFiles) && (
          <p
            className="text-warning flex items-start gap-1.5 text-sm"
            data-testid="integration-editor-entry-point-missing"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>
              {t("integrationEditor.source.serverEntryPointMissing", { path: source.entryPoint })}
            </span>
          </p>
        )}
      </div>
      <FormField
        id="int-source-server-command"
        label={t("integrationEditor.source.serverCommand")}
        required
        value={source.command}
        onChange={(v) => onChange({ command: v })}
        placeholder="bun"
        error={requiredError(source.command)}
        description={t("integrationEditor.source.serverCommandDesc")}
      />
      <FormField
        id="int-source-server-args"
        label={t("integrationEditor.source.serverArgs")}
        type="textarea"
        value={argsText}
        onChange={(v) => {
          const args = parseArgs(v);
          setArgsText(v);
          setSeenArgs(args);
          onChange({ args });
        }}
        placeholder={"server/index.ts\n--stdio"}
        description={t("integrationEditor.source.serverArgsDesc")}
      />
      <p className="text-muted-foreground text-sm">{t("integrationEditor.source.serverHint")}</p>
    </>
  );
}
