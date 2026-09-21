/**
 * Shipment limits shared by the client, staff, and public booking forms.
 * These mirror the backend shipment contract and keep the count controls from
 * offering values that the server cannot accept.
 */
export const maxParcelsPerShipment = 100;
