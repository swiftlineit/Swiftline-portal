import mongoose from "mongoose";
import { env } from "../../config/env.js";
import { getTenantContext } from "../tenantScope.service.js";
import { isShipmentFundingRecordCompleted } from "./shipmentFunding.service.js";

export const SHIPMENT_LABEL_PAYMENT_REQUIRED_MESSAGE =
  "Shipment payment must be completed before its label can be accessed.";

export type LabelPolicyShipment = {
  shipmentDraftId: mongoose.Types.ObjectId;
  createdAt?: Date | null;
  labelPaymentPolicy?: unknown;
};

export type LabelPolicyDocument = {
  createdAt?: Date | null;
  generatedAt?: Date | null;
};

function validDate(value: unknown): Date | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value : null;
}

/**
 * A legacy label is exempt only when every persisted timestamp proving that
 * this booking and this stored label predate rollout is present and earlier
 * than the configured boundary, and no new-policy marker is set.
 */
export function isHistoricalLabelBeforePaymentPolicy(input: {
  shipment: LabelPolicyShipment;
  label: LabelPolicyDocument;
  activatedAt?: string;
}): boolean {
  if (input.shipment.labelPaymentPolicy !== undefined && input.shipment.labelPaymentPolicy !== null) {
    return false;
  }

  const activation = input.activatedAt ?? env.LABEL_PAYMENT_POLICY_ACTIVATED_AT;
  if (!activation) return false;
  const activationDate = new Date(activation);
  if (!Number.isFinite(activationDate.getTime())) return false;

  const timestamps = [
    validDate(input.shipment.createdAt),
    validDate(input.label.createdAt),
    validDate(input.label.generatedAt)
  ];
  return timestamps.every((timestamp) => timestamp !== null && timestamp.getTime() < activationDate.getTime());
}

/** Shared by label URL issuance and the signed label-file endpoint. */
export async function canAccessShipmentLabel(input: {
  shipment: LabelPolicyShipment;
  label: LabelPolicyDocument;
}): Promise<boolean> {
  // Operator tenants retain their separately managed legacy payment policy.
  if (getTenantContext()?.kind === "OPERATOR") return true;

  if (isHistoricalLabelBeforePaymentPolicy(input)) return true;
  return isShipmentFundingRecordCompleted(input.shipment.shipmentDraftId);
}
