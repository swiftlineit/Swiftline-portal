import { requestJson } from "@/lib/shipmentsList";

export type OperatorWorkspace = {
  slug: string;
  companyName: string;
  status: "DRAFT" | "ACTIVE";
  role: "OPERATOR_ADMIN" | "OPERATIONS" | "FINANCE" | "CLIENT";
};

export function listOperatorWorkspaces() {
  return requestJson<{ success: true; workspaces: OperatorWorkspace[] }>("/api/v1/auth/operator-workspaces");
}
