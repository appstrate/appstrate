import { useContext } from "react";
import {
  FlowDetailContext,
  type FlowDetailContextValue,
} from "../contexts/flow-detail-context-value";

export function useFlowDetailContext(): FlowDetailContextValue {
  const ctx = useContext(FlowDetailContext);
  if (!ctx) throw new Error("useFlowDetailContext must be used within FlowDetailProvider");
  return ctx;
}
