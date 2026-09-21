import { maxParcelItems, maxParcelsPerShipment, parcelItemUnitTypeValues } from "../parcelItems.service.js";
import { getPortalCountryNames } from "../reference/portalCountries.js";
import { shipmentContentTypeValues, shipmentServiceTypeValues } from "../../models/shipmentDraft.model.js";

export const shipmentImportTemplateVersion = "SHIPMENT-IMPORT-1.0";
export const shipmentImportSheetNames = {
  instructions: "Read Me",
  shipment: "Shipment",
  parcels: "Parcels",
  items: "Items",
  lists: "_Lists"
} as const;

export const shipmentImportLimits = {
  filesPerBatch: 25,
  totalBytesPerBatch: 25 * 1024 * 1024,
  parcelsPerShipment: maxParcelsPerShipment,
  itemsPerParcel: maxParcelItems
} as const;

export const shipmentTypeOptions = ["CSB-IV", "CSB-V"] as const;
export const serviceTypeOptions = shipmentServiceTypeValues.map((value) => (
  value === "COURIER" ? "Courier" : "Cargo"
));
export const contentTypeOptions = shipmentContentTypeValues.map((value) => ({
  value,
  label: value.charAt(0) + value.slice(1).toLowerCase()
}));
export const unitTypeOptions = [...parcelItemUnitTypeValues];
export const destinationCountryOptions = getPortalCountryNames();

export const shipmentImportFields = [
  { key: "templateVersion", label: "Template Version", required: true, placeholder: shipmentImportTemplateVersion, locked: true },
  { key: "shipmentType", label: "Shipment Type (Choose CSB-IV or CSB-V)", required: true, placeholder: "CHOOSE ONE" },
  { key: "serviceType", label: "Service Type (Choose Courier or Cargo)", required: true, placeholder: "CHOOSE ONE" },
  { key: "declarationNote", label: "Declaration Note", required: false, placeholder: "EXAMPLE: Commercial samples for customs review" },
  { key: "consignorCompany", label: "Consignor Company", required: false, placeholder: "EXAMPLE: Swiftline Cargo" },
  { key: "consignorContactName", label: "Consignor Contact Name", required: true, placeholder: "EXAMPLE: Aman Negi" },
  { key: "consignorEmail", label: "Consignor Email", required: true, placeholder: "EXAMPLE: sender@example.com" },
  { key: "consignorMobileNumber", label: "Consignor Mobile Number", required: true, placeholder: "EXAMPLE: 8745073206" },
  { key: "consignorCountry", label: "Consignor Country", required: true, placeholder: "India", locked: true },
  { key: "pickupAddressLine1", label: "Pickup Address Line 1", required: true, placeholder: "EXAMPLE: Begreen Plaza, Mahipalpur" },
  { key: "pickupAddressLine2", label: "Pickup Address Line 2", required: false, placeholder: "EXAMPLE: Office 204" },
  { key: "pickupTownOrCity", label: "Pickup Town / City", required: true, placeholder: "EXAMPLE: New Delhi" },
  { key: "pickupState", label: "Pickup State", required: true, placeholder: "EXAMPLE: Delhi" },
  { key: "pickupPinCode", label: "Pickup PIN Code", required: true, placeholder: "EXAMPLE: 110037" },
  { key: "pickupInstructions", label: "Pickup Instructions", required: false, placeholder: "EXAMPLE: Call before pickup" },
  { key: "consigneeCompany", label: "Consignee Company", required: false, placeholder: "EXAMPLE: Drifter Co" },
  { key: "consigneeContactName", label: "Consignee Contact Name", required: true, placeholder: "EXAMPLE: Bonny Paulson" },
  { key: "consigneeEmail", label: "Consignee Email", required: true, placeholder: "EXAMPLE: recipient@example.com" },
  { key: "consigneeMobile", label: "Consignee Mobile With Country Code", required: true, placeholder: "EXAMPLE: +44 7123456789" },
  { key: "deliveryInstructions", label: "Delivery Instructions", required: false, placeholder: "EXAMPLE: Deliver at reception" },
  { key: "destinationCountry", label: "Destination Country (Choose from dropdown)", required: true, placeholder: "CHOOSE ONE" },
  { key: "deliveryAddressLine1", label: "Delivery Address Line 1", required: true, placeholder: "EXAMPLE: 14 Marvell Avenue" },
  { key: "deliveryAddressLine2", label: "Delivery Address Line 2", required: false, placeholder: "EXAMPLE: Hayes" },
  { key: "deliveryTownOrCity", label: "Delivery Town / City", required: true, placeholder: "EXAMPLE: London" },
  { key: "deliveryStateOrCounty", label: "Delivery State / County", required: false, placeholder: "EXAMPLE: Greater London" },
  { key: "deliveryPostcode", label: "Delivery Postcode", required: true, placeholder: "EXAMPLE: UB4 0QR" }
] as const;

export type ShipmentImportFieldKey = (typeof shipmentImportFields)[number]["key"];

export function normalizedImportLabel(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function isShipmentImportPlaceholder(value: string) {
  const normalized = value.trim().toUpperCase();
  return normalized === "CHOOSE ONE" || normalized.startsWith("EXAMPLE:");
}
