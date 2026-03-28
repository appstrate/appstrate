import type { JSONSchemaObject } from "@appstrate/core/form";
import { usePackageDetail } from "../../hooks/use-packages";
import {
  useConnectApiKey,
  useConnectCredentials,
  useBindAdminProvider,
} from "../../hooks/use-mutations";
import { useCreateSchedule, useUpdateSchedule, useDeleteSchedule } from "../../hooks/use-schedules";
import { useCurrentProfileId, profileIdParam } from "../../hooks/use-current-profile";
import { useFlowDetailUI } from "../../stores/flow-detail-ui-store";
import { ScheduleModal } from "../schedule-modal";
import { ApiKeyModal } from "../api-key-modal";
import { CustomCredentialsModal } from "../custom-credentials-modal";

export function FlowModals({ packageId }: { packageId: string }) {
  const { data: detail } = usePackageDetail("flow", packageId);
  const populatedProviders = detail?.populatedProviders;
  const profileId = useCurrentProfileId();
  const pParam = profileIdParam(profileId);

  const apiKeyMutation = useConnectApiKey();
  const credentialsMutation = useConnectCredentials();
  const bindAdmin = useBindAdminProvider(packageId);
  const createSchedule = useCreateSchedule(packageId);
  const updateSchedule = useUpdateSchedule();
  const deleteSchedule = useDeleteSchedule();

  const {
    scheduleOpen,
    setScheduleOpen,
    editingSchedule,
    setEditingSchedule,
    apiKeyService,
    setApiKeyService,
    customCredService,
    setCustomCredService,
  } = useFlowDetailUI();

  if (!detail) return null;

  const customCredProviderDef = customCredService
    ? populatedProviders?.[customCredService.provider]
    : undefined;
  const customCredSchema =
    (customCredProviderDef?.credentialSchema as JSONSchemaObject | undefined) ?? undefined;

  return (
    <>
      <ScheduleModal
        open={scheduleOpen}
        onClose={() => {
          setScheduleOpen(false);
          setEditingSchedule(null);
        }}
        schedule={editingSchedule}
        inputSchema={detail.input?.schema}
        onSave={(data) => {
          if (editingSchedule) {
            updateSchedule.mutate({ id: editingSchedule.id, ...data });
          } else {
            createSchedule.mutate(data);
          }
        }}
        onDelete={
          editingSchedule
            ? () => {
                deleteSchedule.mutate(editingSchedule.id);
                setScheduleOpen(false);
                setEditingSchedule(null);
              }
            : undefined
        }
        isPending={createSchedule.isPending || updateSchedule.isPending}
      />
      <ApiKeyModal
        open={!!apiKeyService}
        onClose={() => setApiKeyService(null)}
        providerName={apiKeyService?.id ?? ""}
        isPending={apiKeyMutation.isPending}
        onSubmit={(apiKey) => {
          if (apiKeyService) {
            const { id: serviceId, bindAfter } = apiKeyService;
            apiKeyMutation.mutate(
              { provider: apiKeyService.provider, apiKey, ...pParam },
              {
                onSuccess: () => {
                  setApiKeyService(null);
                  if (bindAfter) {
                    bindAdmin.mutate(serviceId);
                  }
                },
              },
            );
          }
        }}
      />
      {customCredService && customCredSchema && (
        <CustomCredentialsModal
          open
          onClose={() => setCustomCredService(null)}
          schema={customCredSchema}
          providerId={customCredService.id}
          providerName={customCredService.name}
          isPending={credentialsMutation.isPending}
          onSubmit={(credentials) => {
            const { provider, id: serviceId, bindAfter } = customCredService;
            credentialsMutation.mutate(
              { provider, credentials, ...pParam },
              {
                onSuccess: () => {
                  setCustomCredService(null);
                  if (bindAfter) {
                    bindAdmin.mutate(serviceId);
                  }
                },
              },
            );
          }}
        />
      )}
    </>
  );
}
