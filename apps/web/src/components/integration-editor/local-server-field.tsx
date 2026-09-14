// SPDX-License-Identifier: Apache-2.0

/**
 * The server a LOCAL integration runs, picked rather than typed.
 *
 * It used to be two free-text fields, and nothing downstream checks them: an
 * integration is published and installed whatever they say, and at run time a
 * server that does not exist is dropped without a word
 * (`integration-spawn-resolver.ts`, `mcp_server_unresolved`) — the agent runs
 * without its tools. Only a version range no published version satisfies fails
 * the run. So the field lists the servers the organisation can actually run,
 * lets one be imported without leaving the form, and says both of those
 * failures out loud before anyone publishes.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Upload } from "lucide-react";
import { matchVersion } from "@appstrate/core/semver";
import { Input } from "@appstrate/ui/components/input";
import { Label } from "@appstrate/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@appstrate/ui/components/select";
import { useLibrary } from "../../hooks/use-library";
import { usePackageVersions } from "../../hooks/use-packages";
import { ImportModal } from "../import-modal";

/** The picker's own item for importing; never written to the manifest. */
const IMPORT_ITEM = "__import__";

export function LocalServerField({
  name,
  version,
  onChange,
}: {
  name: string;
  version: string;
  onChange: (patch: { serverName?: string; serverVersion?: string }) => void;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  const { data: library, isLoading } = useLibrary();
  const [importing, setImporting] = useState(false);
  const servers = library?.packages["mcp-server"] ?? [];
  const known = servers.find((server) => server.id === name);
  // Readable only where the caller can reach the server; an unreachable list
  // says nothing, rather than a false "no version".
  const versions = usePackageVersions("mcp-server", known ? name : undefined);
  const published = (versions.data ?? []).filter((v) => !v.yanked).map((v) => v.version);
  const unsatisfied =
    known &&
    versions.isSuccess &&
    (published.length === 0 || !matchVersion(published, version || "*"));

  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="int-source-server">
          {t("integrationEditor.source.server")}
          {" *"}
        </Label>
        <Select
          value={known ? name : ""}
          onValueChange={(next) => {
            if (next === IMPORT_ITEM) setImporting(true);
            else onChange({ serverName: next });
          }}
        >
          <SelectTrigger id="int-source-server" aria-describedby="hint-int-source-server">
            <SelectValue
              placeholder={
                isLoading
                  ? t("loading", { ns: "common" })
                  : t("integrationEditor.source.serverPick")
              }
            />
          </SelectTrigger>
          <SelectContent>
            {servers.map((server) => (
              <SelectItem key={server.id} value={server.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{server.name || server.id}</span>
                  <span className="text-muted-foreground truncate font-mono text-xs">
                    {server.id}
                  </span>
                  {server.source === "system" && (
                    <span className="text-muted-foreground text-xs">
                      {t("catalogue.sourceSystem", { ns: "settings" })}
                    </span>
                  )}
                </span>
              </SelectItem>
            ))}
            <SelectItem value={IMPORT_ITEM}>
              <span className="flex items-center gap-2">
                <Upload className="size-4" />
                {t("integrationEditor.source.serverImport")}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        <p id="hint-int-source-server" className="text-muted-foreground text-sm">
          {t("integrationEditor.source.serverDesc")}
        </p>
        {name && !known && !isLoading && (
          <Warning>{t("integrationEditor.source.serverMissing", { name })}</Warning>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="int-source-server-version">
          {t("integrationEditor.source.serverVersion")}
        </Label>
        <Input
          id="int-source-server-version"
          value={version}
          onChange={(event) => onChange({ serverVersion: event.target.value })}
          placeholder="^1.0.0"
          aria-describedby="hint-int-source-server-version"
        />
        {known && versions.isSuccess && (
          <p id="hint-int-source-server-version" className="text-muted-foreground text-sm">
            {published.length > 0
              ? t("integrationEditor.source.serverVersions", { versions: published.join(", ") })
              : t("integrationEditor.source.serverNoVersion")}
          </p>
        )}
        {unsatisfied && published.length > 0 && (
          <Warning>
            {t("integrationEditor.source.serverVersionUnmatched", { range: version || "*" })}
          </Warning>
        )}
      </div>

      <ImportModal
        open={importing}
        onClose={() => setImporting(false)}
        onImported={(result) => {
          if (result.type === "mcp-server") onChange({ serverName: result.packageId });
        }}
      />
    </>
  );
}

function Warning({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-warning flex items-start gap-1.5 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
