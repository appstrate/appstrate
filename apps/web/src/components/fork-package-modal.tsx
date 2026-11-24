// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { SLUG_REGEX } from "@appstrate/core/naming";
import { FormModal } from "./form-modal";
import { FormItem } from "@/components/app-ui/form-item";
import { Input } from "@appstrate/ui/components/input";
import { useForkPackage } from "../hooks/use-packages";
import { useSpaceLink } from "../hooks/use-current-space";
import { useOrg } from "../hooks/use-org";
import { packageDetailPath } from "../lib/package-paths";
import { errorMessage } from "../lib/mutation-error";

interface Props {
  onClose: () => void;
  packageId: string;
  spaceId: string;
  defaultName: string;
  type: string;
}

/** Mounted by the caller while open: closing abandons the name. */
export function ForkPackageModal({ onClose, packageId, spaceId, defaultName, type }: Props) {
  const { t } = useTranslation(["agents", "common"]);
  const { currentOrg } = useOrg();
  const navigate = useNavigate();
  const linkInSpace = useSpaceLink();
  const forkMutation = useForkPackage();

  const [name, setName] = useState(defaultName.toLowerCase());
  const [error, setError] = useState<string | null>(null);
  const isValid = SLUG_REGEX.test(name);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    forkMutation.mutate(
      { packageId, name, spaceId },
      {
        onSuccess: (result) => {
          onClose();
          navigate(linkInSpace(packageDetailPath(type, result.id), spaceId));
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  const orgSlug = currentOrg?.slug ?? "";

  return (
    <FormModal
      inSpace={spaceId}
      onClose={onClose}
      title={t("fork.title")}
      onSubmit={onSubmit}
      isPending={forkMutation.isPending}
      submitLabel={t("fork.button")}
      submitDisabled={!isValid}
      error={error}
    >
      <FormItem
        id="fork-name"
        label={t("fork.nameLabel")}
        error={name && !isValid ? t("fork.invalidName") : undefined}
      >
        <Input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value.toLowerCase())}
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
