// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import { SLUG_REGEX } from "@appstrate/core/naming";
import { FormModal } from "./form-modal";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { useForkPackage } from "../hooks/use-packages";
import { useOrg } from "../hooks/use-org";
import { ApiError } from "../api/errors";
import { packageDetailPath } from "../lib/package-paths";
import { errorMessage } from "../lib/mutation-error";

interface Props {
  onClose: () => void;
  /** Leaves the modal for the copy's page. */
  onLeave: (to: string) => void;
  packageId: string;
  defaultName: string;
  type: string;
}

type FormData = { name: string };

/** Mounted by the caller while open: closing abandons the name. */
export function ForkPackageModal({ onClose, onLeave, packageId, defaultName, type }: Props) {
  const { t } = useTranslation(["agents", "common"]);
  const { currentOrg } = useOrg();
  const forkMutation = useForkPackage();

  const {
    register,
    handleSubmit,
    setError,
    control,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { name: defaultName },
  });

  const name = useWatch({ control, name: "name" });
  const isValid = name.length > 0 && SLUG_REGEX.test(name);

  const onSubmit = handleSubmit((data) => {
    if (!isValid) return;

    forkMutation.mutate(
      { packageId, name: data.name },
      {
        onSuccess: (result) => onLeave(packageDetailPath(type, result.id)),
        onError: (err) => {
          const code = err instanceof ApiError ? err.code : "";
          if (code === "already_owned") {
            setError("root", { message: t("fork.errorOwned") });
          } else if (code === "no_published_version") {
            setError("root", { message: t("fork.errorNoPublishedVersion") });
          } else {
            setError("root", { message: errorMessage(err) });
          }
        },
      },
    );
  });

  const orgSlug = currentOrg?.slug ?? "";

  return (
    <FormModal
      onClose={onClose}
      title={t("fork.title")}
      onSubmit={onSubmit}
      isPending={forkMutation.isPending}
      submitLabel={t("fork.button")}
      submitDisabled={!isValid}
      error={errors.root?.message}
    >
      <FormItem
        id="fork-name"
        label={t("fork.nameLabel")}
        error={name.length > 0 && !SLUG_REGEX.test(name) ? t("fork.invalidName") : undefined}
      >
        <Input
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
      </FormItem>
      <p className="text-muted-foreground text-sm">
        {t("fork.prefix")}{" "}
        <code className="text-foreground">
          @{orgSlug}/{name || "..."}
        </code>
      </p>
    </FormModal>
  );
}
