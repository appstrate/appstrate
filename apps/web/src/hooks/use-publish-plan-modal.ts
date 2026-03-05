import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import type { PublishPlan } from "./use-registry";

export interface PublishPlanModalProps {
  open: boolean;
  onClose: () => void;
  items: PublishPlan["items"];
  circular: PublishPlan["circular"];
  rootVersion: string | undefined;
  onComplete: () => void;
}

interface UsePublishPlanModalReturn {
  /** Fetch the publish plan and open the modal */
  open: (packageId: string, version?: string) => Promise<void>;
  /** Close the modal and reset state */
  close: () => void;
  /** Whether the plan is currently being fetched */
  isFetching: boolean;
  /** Whether a plan has been fetched and the modal can be rendered */
  hasPlan: boolean;
  /** Props to spread on PublishPlanModal — only valid when hasPlan is true */
  modalProps: PublishPlanModalProps;
}

export function usePublishPlanModal(): UsePublishPlanModalReturn {
  const { t } = useTranslation(["common"]);
  const [isOpen, setIsOpen] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [rootVersion, setRootVersion] = useState<string | undefined>();

  const close = useCallback(() => {
    setIsOpen(false);
    setPlan(null);
    setRootVersion(undefined);
  }, []);

  const open = useCallback(
    async (packageId: string, version?: string) => {
      setIsFetching(true);
      try {
        const query = version ? `?version=${encodeURIComponent(version)}` : "";
        const result = await api<PublishPlan>(`/packages/${packageId}/publish-plan${query}`);
        setPlan(result);
        setRootVersion(version);
        setIsOpen(true);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        alert(t("error.prefix", { message }));
      } finally {
        setIsFetching(false);
      }
    },
    [t],
  );

  return {
    open,
    close,
    isFetching,
    hasPlan: plan !== null,
    modalProps: {
      open: isOpen,
      onClose: close,
      items: plan?.items ?? [],
      circular: plan?.circular ?? null,
      rootVersion,
      onComplete: close,
    },
  };
}
