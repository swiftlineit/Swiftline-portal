import type { ShipmentDraft } from "@/lib/dpdLabels";

export const SHIPPER_DECLARATION_VERSION = "v1";

export function hasCurrentShipperDeclarationAcceptance(
  draft: Pick<ShipmentDraft, "shipperDeclarationAcceptedAt" | "shipperDeclarationVersion"> | null | undefined
) {
  return Boolean(
    draft?.shipperDeclarationAcceptedAt
    && draft.shipperDeclarationVersion === SHIPPER_DECLARATION_VERSION
  );
}
