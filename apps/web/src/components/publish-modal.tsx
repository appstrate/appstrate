import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Modal } from "./modal";
import { Spinner } from "./spinner";
import { useRegistryStatus, usePublishInfo, usePublishPackage } from "../hooks/use-registry";

interface PublishModalProps {
  open: boolean;
  onClose: () => void;
  packageId: string;
}

function bumpVersion(version: string, type: "patch" | "minor" | "major"): string {
  const parts = version.split(".").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) return version;
  if (type === "major") return `${parts[0] + 1}.0.0`;
  if (type === "minor") return `${parts[0]}.${parts[1] + 1}.0`;
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

export function PublishModal(props: PublishModalProps) {
  const { open, onClose, packageId } = props;
  const { t } = useTranslation(["flows", "settings", "common"]);
  const { data: registryStatus } = useRegistryStatus();
  const isConnected = registryStatus?.connected;

  return (
    <Modal open={open} onClose={onClose} title={t("publish.title")}>
      {!isConnected ? (
        <div className="publish-not-connected">
          <p>{t("publish.notConnected")}</p>
          <Link to="/preferences" onClick={onClose}>
            {t("publish.goToSettings")}
          </Link>
        </div>
      ) : (
        // Key on packageId ensures form resets when modal reopens for same or different package
        <PublishForm key={packageId + (open ? "-open" : "")} {...props} />
      )}
    </Modal>
  );
}

function PublishForm({ onClose, packageId }: PublishModalProps) {
  const { t } = useTranslation(["flows", "settings", "common"]);
  const { data: publishInfo } = usePublishInfo(packageId);
  const publishMutation = usePublishPackage();

  const effectiveScope = publishInfo?.registryScope;
  const effectiveName = publishInfo?.registryName;
  const effectiveLastVersion = publishInfo?.lastPublishedVersion;
  const scopes = publishInfo?.registryScopes ?? [];

  const [scope, setScope] = useState(effectiveScope ?? "");
  const [name, setName] = useState(effectiveName ?? packageId);
  const [version, setVersion] = useState(
    effectiveLastVersion ? bumpVersion(effectiveLastVersion, "patch") : "1.0.0",
  );
  const [published, setPublished] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    publishMutation.mutate(
      {
        packageId,
        scope: scope || undefined,
        name: name || undefined,
        version,
      },
      {
        onSuccess: () => setPublished(true),
      },
    );
  };

  if (published) {
    return (
      <div className="publish-success">
        <p>{t("publish.success")}</p>
        <div className="modal-actions">
          <button onClick={onClose}>{t("btn.done", { ns: "common" })}</button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="publish-form">
      <div className="form-group">
        <label>{t("publish.scope")}</label>
        <select value={scope} onChange={(e) => setScope(e.target.value)} required>
          <option value="">—</option>
          {scopes.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <div className="form-group">
        <label>{t("publish.name")}</label>
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>

      <div className="form-group">
        <label>{t("publish.version")}</label>
        <div className="publish-version-row">
          <input
            type="text"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            required
            pattern="^\d+\.\d+\.\d+.*$"
          />
          {effectiveLastVersion && (
            <div className="publish-bumps">
              <button
                type="button"
                className={version === bumpVersion(effectiveLastVersion, "patch") ? "active" : ""}
                onClick={() => setVersion(bumpVersion(effectiveLastVersion, "patch"))}
              >
                {t("publish.bump.patch")}
              </button>
              <button
                type="button"
                className={version === bumpVersion(effectiveLastVersion, "minor") ? "active" : ""}
                onClick={() => setVersion(bumpVersion(effectiveLastVersion, "minor"))}
              >
                {t("publish.bump.minor")}
              </button>
              <button
                type="button"
                className={version === bumpVersion(effectiveLastVersion, "major") ? "active" : ""}
                onClick={() => setVersion(bumpVersion(effectiveLastVersion, "major"))}
              >
                {t("publish.bump.major")}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="modal-actions">
        <button type="button" onClick={onClose}>
          {t("btn.cancel", { ns: "common" })}
        </button>
        <button type="submit" className="primary" disabled={publishMutation.isPending}>
          {publishMutation.isPending ? <Spinner /> : t("publish.publish")}
        </button>
      </div>
    </form>
  );
}
