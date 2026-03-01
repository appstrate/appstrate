import { useState, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { useFlows } from "../hooks/use-flows";
import {
  useOrgSkills,
  useOrgExtensions,
  useUploadSkill,
  useUploadExtension,
} from "../hooks/use-library";
import { useOrg } from "../hooks/use-org";
import { ImportModal } from "../components/import-modal";
import { PackageCard } from "../components/package-card";
import { LoadingState, ErrorState, EmptyState } from "../components/page-states";
import { Spinner } from "../components/spinner";

type TabType = "flows" | "skills" | "extensions";

function FlowsTab() {
  const { t } = useTranslation(["flows", "common"]);
  const { data: flows, isLoading, error } = useFlows();
  const { isOrgAdmin } = useOrg();
  const [importOpen, setImportOpen] = useState(false);

  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState message={error.message} />;

  if (!flows || flows.length === 0) {
    return (
      <>
        <div className="flow-list-header">
          <div />
          <div className="flow-list-actions">
            {isOrgAdmin && (
              <Link to="/flows/new">
                <button>{t("list.create")}</button>
              </Link>
            )}
            <button onClick={() => setImportOpen(true)}>{t("list.import")}</button>
          </div>
        </div>
        <EmptyState message={t("list.empty")} hint={t("list.emptyHint")} icon={Layers}>
          {isOrgAdmin && (
            <Link to="/flows/new">
              <button>{t("list.create")}</button>
            </Link>
          )}
          <button onClick={() => setImportOpen(true)}>{t("list.import")}</button>
        </EmptyState>
        <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
      </>
    );
  }

  return (
    <>
      <div className="flow-list-header">
        <div />
        <div className="flow-list-actions">
          {isOrgAdmin && (
            <Link to="/flows/new">
              <button>{t("list.create")}</button>
            </Link>
          )}
          <button onClick={() => setImportOpen(true)}>{t("list.import")}</button>
        </div>
      </div>
      <div className="flow-grid">
        {flows.map((flow) => (
          <PackageCard
            key={flow.id}
            id={flow.id}
            displayName={flow.displayName}
            description={flow.description}
            type="flow"
            source={flow.source}
            runningExecutions={flow.runningExecutions}
            tags={flow.tags}
          />
        ))}
      </div>
      <ImportModal open={importOpen} onClose={() => setImportOpen(false)} />
    </>
  );
}

function SkillsTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: items, isLoading } = useOrgSkills();
  const upload = useUploadSkill();
  const { isOrgAdmin } = useOrg();
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    upload.mutate(file, {
      onSuccess: () => {
        if (fileRef.current) fileRef.current.value = "";
      },
      onError: (err) => alert(t("error.prefix", { message: err.message })),
    });
  };

  if (isLoading) return <LoadingState />;

  if (!items || items.length === 0) {
    return (
      <>
        {isOrgAdmin && (
          <div className="flow-list-header">
            <div />
            <div className="flow-list-actions">
              <label className="btn-upload">
                {upload.isPending ? <Spinner /> : t("library.uploadSkill")}
                <input
                  ref={fileRef}
                  type="file"
                  accept=".zip"
                  onChange={handleUpload}
                  className="hidden"
                  disabled={upload.isPending}
                />
              </label>
            </div>
          </div>
        )}
        <EmptyState message={t("library.emptySkill")} hint={t("library.emptySkillHint")} />
      </>
    );
  }

  return (
    <>
      {isOrgAdmin && (
        <div className="flow-list-header">
          <div />
          <div className="flow-list-actions">
            <label className="btn-upload">
              {upload.isPending ? <Spinner /> : t("library.uploadSkill")}
              <input
                ref={fileRef}
                type="file"
                accept=".zip"
                onChange={handleUpload}
                className="hidden"
                disabled={upload.isPending}
              />
            </label>
          </div>
        </div>
      )}
      <div className="flow-grid">
        {items.map((item) => (
          <PackageCard
            key={item.id}
            id={item.id}
            displayName={item.name || item.id}
            description={item.description}
            type="skill"
            source={item.source}
            usedByFlows={item.usedByFlows}
          />
        ))}
      </div>
    </>
  );
}

function ExtensionsTab() {
  const { t } = useTranslation(["settings", "common"]);
  const { data: items, isLoading } = useOrgExtensions();
  const upload = useUploadExtension();
  const { isOrgAdmin } = useOrg();
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    upload.mutate(file, {
      onSuccess: () => {
        if (fileRef.current) fileRef.current.value = "";
      },
      onError: (err) => alert(t("error.prefix", { message: err.message })),
    });
  };

  if (isLoading) return <LoadingState />;

  if (!items || items.length === 0) {
    return (
      <>
        {isOrgAdmin && (
          <div className="flow-list-header">
            <div />
            <div className="flow-list-actions">
              <label className="btn-upload">
                {upload.isPending ? <Spinner /> : t("library.uploadExtension")}
                <input
                  ref={fileRef}
                  type="file"
                  accept=".zip"
                  onChange={handleUpload}
                  className="hidden"
                  disabled={upload.isPending}
                />
              </label>
            </div>
          </div>
        )}
        <EmptyState message={t("library.emptyExtension")} hint={t("library.emptyExtensionHint")} />
      </>
    );
  }

  return (
    <>
      {isOrgAdmin && (
        <div className="flow-list-header">
          <div />
          <div className="flow-list-actions">
            <label className="btn-upload">
              {upload.isPending ? <Spinner /> : t("library.uploadExtension")}
              <input
                ref={fileRef}
                type="file"
                accept=".zip"
                onChange={handleUpload}
                className="hidden"
                disabled={upload.isPending}
              />
            </label>
          </div>
        </div>
      )}
      <div className="flow-grid">
        {items.map((item) => (
          <PackageCard
            key={item.id}
            id={item.id}
            displayName={item.name || item.id}
            description={item.description}
            type="extension"
            source={item.source}
            usedByFlows={item.usedByFlows}
          />
        ))}
      </div>
    </>
  );
}

export function PackageList() {
  const { t } = useTranslation(["flows", "settings", "common"]);
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: TabType = tabParam === "skills" || tabParam === "extensions" ? tabParam : "flows";

  const setTab = (newTab: TabType) => {
    if (newTab === "flows") {
      setSearchParams({}, { replace: true });
    } else {
      setSearchParams({ tab: newTab }, { replace: true });
    }
  };

  return (
    <>
      <div className="exec-tabs" role="tablist">
        <button
          role="tab"
          aria-selected={tab === "flows"}
          className={`tab ${tab === "flows" ? "active" : ""}`}
          onClick={() => setTab("flows")}
        >
          {t("list.tabFlows", { ns: "flows" })}
        </button>
        <button
          role="tab"
          aria-selected={tab === "skills"}
          className={`tab ${tab === "skills" ? "active" : ""}`}
          onClick={() => setTab("skills")}
        >
          {t("list.tabSkills", { ns: "flows" })}
        </button>
        <button
          role="tab"
          aria-selected={tab === "extensions"}
          className={`tab ${tab === "extensions" ? "active" : ""}`}
          onClick={() => setTab("extensions")}
        >
          {t("list.tabExtensions", { ns: "flows" })}
        </button>
      </div>

      {tab === "flows" && <FlowsTab />}
      {tab === "skills" && <SkillsTab />}
      {tab === "extensions" && <ExtensionsTab />}
    </>
  );
}
