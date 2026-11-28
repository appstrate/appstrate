// SPDX-License-Identifier: Apache-2.0

/**
 * « Connecter » a model configuration: who pays (the organization, or the caller with their own
 * key or subscription), then which kind of secret the configuration accepts. One choice is a
 * plain button; several are a button for the first and a menu for all, each group saying who
 * pays.
 */

import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, KeyRound, Link2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { ButtonGroup } from "@appstrate/ui/components/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import type { ConnectChoice } from "@/lib/model-configs";

export function ConnectMenu({
  choices,
  label,
  onPick,
  variant = "outline",
}: {
  choices: readonly ConnectChoice[];
  /** « Connecter » or « Reconnecter ». */
  label: string;
  onPick: (choice: ConnectChoice) => void;
  variant?: "default" | "outline";
}) {
  const { t } = useTranslation("settings");
  const [first] = choices;
  if (!first) return null;
  const kind = (choice: ConnectChoice) =>
    choice.provider.authMode === "oauth2"
      ? t("modelConfigs.connect.subscription", { name: choice.provider.displayName })
      : t("modelConfigs.connect.apiKey");
  if (choices.length === 1) {
    return (
      <Button type="button" size="sm" variant={variant} onClick={() => onPick(first)}>
        {label}
      </Button>
    );
  }
  const owners = (["org", "user"] as const).filter((owner) =>
    choices.some((c) => c.owner === owner),
  );
  return (
    <ButtonGroup>
      <Button type="button" size="sm" variant={variant} onClick={() => onPick(first)}>
        {label}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="sm"
              variant={variant}
              className="px-2"
              aria-label={t("modelConfigs.connect.more")}
            />
          }
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-64">
          {owners.map((owner, index) => (
            <Fragment key={owner}>
              {index > 0 && <DropdownMenuSeparator />}
              <DropdownMenuLabel>
                <span className="block">
                  {t(owner === "org" ? "modelConfigs.connect.forOrg" : "modelConfigs.connect.mine")}
                </span>
                <span className="text-muted-foreground block text-xs font-normal">
                  {t(
                    owner === "org"
                      ? "modelConfigs.connect.orgPays"
                      : "modelConfigs.connect.youPay",
                  )}
                </span>
              </DropdownMenuLabel>
              {choices
                .filter((c) => c.owner === owner)
                .map((choice) => (
                  <DropdownMenuItem
                    key={`${owner}:${choice.provider.providerId}`}
                    onClick={() => onPick(choice)}
                  >
                    {choice.provider.authMode === "oauth2" ? <Link2 /> : <KeyRound />}
                    {kind(choice)}
                  </DropdownMenuItem>
                ))}
            </Fragment>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}
