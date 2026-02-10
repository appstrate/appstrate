import { Modal } from "./modal";
import { useResetState } from "../hooks/use-mutations";
import type { FlowDetail } from "@openflows/shared-types";

interface StateModalProps {
  open: boolean;
  onClose: () => void;
  flow: FlowDetail;
}

export function StateModal({ open, onClose, flow }: StateModalProps) {
  const mutation = useResetState(flow.id);

  const handleReset = () => {
    if (!confirm("Reinitialiser l'etat du flow ? Cette action est irreversible.")) return;
    mutation.mutate(undefined, { onSuccess: onClose });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Etat — ${flow.displayName}`}
      actions={
        <>
          <button onClick={onClose}>Fermer</button>
          <button className="btn-danger" onClick={handleReset} disabled={mutation.isPending}>
            Reinitialiser
          </button>
        </>
      }
    >
      <pre className="state-json">{JSON.stringify(flow.state, null, 2)}</pre>
    </Modal>
  );
}
