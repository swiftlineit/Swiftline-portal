export const SHIPPER_DECLARATION_VERSION = "v1";

export type ShipperDeclarationAcceptance = {
  shipperDeclarationAcceptedAt?: Date | null;
  shipperDeclarationVersion?: string;
};

export function hasCurrentShipperDeclarationAcceptance(
  draft: ShipperDeclarationAcceptance | null | undefined
) {
  return Boolean(
    draft?.shipperDeclarationAcceptedAt
    && draft.shipperDeclarationVersion === SHIPPER_DECLARATION_VERSION
  );
}

export function bookingRequiresShipperDeclarationAcceptance(
  actor: "admin" | "client" | "operator" | "public",
  draft: ShipperDeclarationAcceptance | null | undefined
) {
  return (actor === "admin" || actor === "client")
    && !hasCurrentShipperDeclarationAcceptance(draft);
}

export function resolveShipperDeclarationAcceptance(input: {
  current: ShipperDeclarationAcceptance;
  requestedAcceptance?: boolean;
  shipmentDetailsChanged: boolean;
  acceptedAt?: Date;
}): Required<ShipperDeclarationAcceptance> {
  const wasAccepted = hasCurrentShipperDeclarationAcceptance(input.current);

  // Editing shipment details after accepting means the user must review the new
  // declaration context and accept again, even if autosave carries a stale true.
  if (wasAccepted && input.shipmentDetailsChanged) {
    return { shipperDeclarationAcceptedAt: null, shipperDeclarationVersion: "" };
  }

  if (input.requestedAcceptance === false) {
    return { shipperDeclarationAcceptedAt: null, shipperDeclarationVersion: "" };
  }

  if (input.requestedAcceptance === true && !wasAccepted) {
    return {
      shipperDeclarationAcceptedAt: input.acceptedAt ?? new Date(),
      shipperDeclarationVersion: SHIPPER_DECLARATION_VERSION
    };
  }

  if (wasAccepted) {
    return {
      shipperDeclarationAcceptedAt: input.current.shipperDeclarationAcceptedAt ?? null,
      shipperDeclarationVersion: input.current.shipperDeclarationVersion ?? ""
    };
  }

  return { shipperDeclarationAcceptedAt: null, shipperDeclarationVersion: "" };
}
