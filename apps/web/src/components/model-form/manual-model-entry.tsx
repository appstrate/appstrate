// SPDX-License-Identifier: Apache-2.0

/**
 * « Ajouter un identifiant de modèle »: the last line of a model list whose service does not
 * publish every id it serves (an endpoint without `/models`). It opens the model form's own
 * manual fields (id, name, capabilities); the model typed joins the list, ticked.
 */

import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { useAppForm } from "../../hooks/use-app-form";
import { manualRow, type ManualRowFields as Fields } from "@/lib/model-form-payload";
import type { ModelPickRow } from "@/lib/model-source";
import { ManualModelFields } from "./manual-model-fields";

const EMPTY: Fields = {
  label: "",
  modelId: "",
  capabilitiesExplicit: false,
  inputText: true,
  inputImage: false,
  contextWindow: "",
  maxTokens: "",
  reasoning: false,
};

function ManualModelForm({
  onAdd,
  onCancel,
}: {
  onAdd: (row: ModelPickRow) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const form = useAppForm<Fields>({ defaultValues: EMPTY });
  const { register, handleSubmit, showError, formState } = form;

  const submit = handleSubmit((data) => {
    onAdd(manualRow(data));
    onCancel();
  });

  return (
    <FormProvider {...form}>
      <form onSubmit={submit} noValidate className="space-y-4 px-3 py-3">
        <ManualModelFields
          idPrefix="mdl-manual"
          modelIdProps={register("modelId", {
            validate: (v) => (v.trim() ? undefined : t("validation.required", { ns: "common" })),
          })}
          modelIdError={showError("modelId") ? formState.errors.modelId?.message : undefined}
          labelProps={register("label")}
          labelPlaceholder={t("models.form.labelPlaceholder")}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("btn.cancel")}
          </Button>
          <Button type="submit">{t("models.choice.manualConfirm")}</Button>
        </div>
      </form>
    </FormProvider>
  );
}

export function ManualModelEntry({ onAdd }: { onAdd: (row: ModelPickRow) => void }) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);

  if (open) return <ManualModelForm onAdd={onAdd} onCancel={() => setOpen(false)} />;
  return (
    <Button
      type="button"
      variant="ghost"
      className="text-muted-foreground w-full justify-start rounded-none px-3"
      onClick={() => setOpen(true)}
    >
      <Plus />
      {t("models.choice.manualAdd")}
    </Button>
  );
}
