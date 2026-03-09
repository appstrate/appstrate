import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { SLUG_REGEX } from "@appstrate/core/naming";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "./spinner";
import { useForkPackage } from "../hooks/use-packages";
import { useOrg } from "../hooks/use-org";
import { ApiError } from "../api";
import { packageDetailPath } from "../lib/package-paths";

interface Props {
  open: boolean;
  onClose: () => void;
  packageId: string;
  defaultName: string;
  type: string;
}

export function ForkPackageModal({ open, onClose, packageId, defaultName, type }: Props) {
  const { t } = useTranslation(["flows", "common"]);
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const forkMutation = useForkPackage();

  const [name, setName] = useState(defaultName);
  const [error, setError] = useState("");

  const isValid = name.length > 0 && SLUG_REGEX.test(name);

  const handleClose = () => {
    setName(defaultName);
    setError("");
    forkMutation.reset();
    onClose();
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!isValid) return;
    setError("");

    forkMutation.mutate(
      { packageId, name },
      {
        onSuccess: (data) => {
          handleClose();
          navigate(packageDetailPath(type, data.packageId));
        },
        onError: (err) => {
          const code = err instanceof ApiError ? err.code : "";
          if (code === "ALREADY_OWNED") {
            setError(t("fork.errorOwned"));
          } else if (code === "NAME_COLLISION") {
            setError(t("fork.errorCollision"));
          } else if (code === "NO_PUBLISHED_VERSION") {
            setError(t("fork.errorNoPublishedVersion"));
          } else {
            setError(err instanceof Error ? err.message : t("fork.errorCollision"));
          }
        },
      },
    );
  };

  const orgSlug = currentOrg?.slug ?? "";

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={t("fork.title")}
      actions={
        <>
          <Button variant="outline" type="button" onClick={handleClose}>
            {t("btn.cancel", { ns: "common" })}
          </Button>
          <Button
            type="submit"
            form="fork-package-form"
            disabled={forkMutation.isPending || !isValid}
          >
            {forkMutation.isPending ? <Spinner /> : t("fork.submit")}
          </Button>
        </>
      }
    >
      <form id="fork-package-form" onSubmit={handleSubmit}>
        <div className="space-y-2">
          <Label htmlFor="fork-name">{t("fork.nameLabel")}</Label>
          <Input
            id="fork-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder={t("fork.namePlaceholder")}
            required
            autoFocus
          />
          {name.length > 0 && !SLUG_REGEX.test(name) && (
            <p className="text-sm text-destructive">{t("fork.invalidName")}</p>
          )}
        </div>
        <p className="text-sm text-muted-foreground mt-3">
          {t("fork.prefix")}{" "}
          <code className="text-foreground">
            @{orgSlug}/{name || "..."}
          </code>
        </p>
        {error && <p className="text-sm text-destructive mt-2">{error}</p>}
      </form>
    </Modal>
  );
}
