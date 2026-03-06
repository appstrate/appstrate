import { useFlowDetailContext } from "../../hooks/use-flow-detail-context";
import { ConfigModal } from "../config-modal";
import { ScheduleModal } from "../schedule-modal";
import { ApiKeyModal } from "../api-key-modal";
import { CustomCredentialsModal } from "../custom-credentials-modal";

export function FlowModals() {
  const ctx = useFlowDetailContext();
  const {
    detail,
    configOpen,
    setConfigOpen,
    scheduleOpen,
    setScheduleOpen,
    editingSchedule,
    setEditingSchedule,
    apiKeyService,
    setApiKeyService,
    customCredService,
    setCustomCredService,
    customCredSchema,
    apiKeyMutation,
    credentialsMutation,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    bindAdmin,
    pParam,
  } = ctx;

  return (
    <>
      <ConfigModal open={configOpen} onClose={() => setConfigOpen(false)} flow={detail} />
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
          serviceId={customCredService.id}
          serviceName={customCredService.name}
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
