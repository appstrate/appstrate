import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
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

type FormData = { name: string };

export function ForkPackageModal({ open, onClose, packageId, defaultName, type }: Props) {
  const { t } = useTranslation(["flows", "common"]);
  const navigate = useNavigate();
  const { currentOrg } = useOrg();
  const forkMutation = useForkPackage();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    control,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { name: defaultName },
  });

  useEffect(() => {
    if (open) {
      reset({ name: defaultName });
    }
  }, [open, defaultName, reset]);

  const name = useWatch({ control, name: "name" });
  const isValid = name.length > 0 && SLUG_REGEX.test(name);

  const handleClose = () => {
    reset({ name: defaultName });
    forkMutation.reset();
    onClose();
  };

  const onSubmit = handleSubmit((data) => {
    if (!isValid) return;

    forkMutation.mutate(
      { packageId, name: data.name },
      {
        onSuccess: (result) => {
          handleClose();
          navigate(packageDetailPath(type, result.packageId));
        },
        onError: (err) => {
          const code = err instanceof ApiError ? err.code : "";
          if (code === "already_owned") {
            setError("root", { message: t("fork.errorOwned") });
          } else if (code === "name_collision") {
            setError("root", { message: t("fork.errorCollision") });
          } else if (code === "no_published_version") {
            setError("root", { message: t("fork.errorNoPublishedVersion") });
          } else {
            setError("root", {
              message: err instanceof Error ? err.message : t("fork.errorCollision"),
            });
          }
        },
      },
    );
  });

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
      <form id="fork-package-form" onSubmit={onSubmit}>
        <div className="space-y-2">
          <Label htmlFor="fork-name">{t("fork.nameLabel")}</Label>
          <Input
            id="fork-name"
            type="text"
            {...register("name", {
              required: true,
              pattern: SLUG_REGEX,
              setValueAs: (v: string) => v.toLowerCase(),
            })}
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
        {errors.root?.message && (
          <p className="text-sm text-destructive mt-2">{errors.root.message}</p>
        )}
      </form>
    </Modal>
  );
}
