import { requestJson } from "./shipmentsList";
import type { OperatorWorkspace } from "./operatorWorkspaces";

export type ClientWorkspaceAccess = {
  swiftline: boolean;
  operators: OperatorWorkspace[];
};

export function getClientWorkspaceAccess() {
  return requestJson<{ success: true } & ClientWorkspaceAccess>("/api/v1/auth/client-workspaces");
}
