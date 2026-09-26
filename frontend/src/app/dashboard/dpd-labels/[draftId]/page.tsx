"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ChangeEvent, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { FiArrowLeft, FiCheckCircle, FiChevronDown, FiExternalLink, FiMapPin, FiPackage, FiSave, FiSearch, FiTruck } from "react-icons/fi";
import { toast } from "react-toastify";
import { exceedsStandardParcelSize, standardParcelDimensionsLabel } from "@/lib/shipmentPricing";
import { DashboardLoading } from "@/components/DashboardShell";
import {
  ShipmentCsbTypeField,
  ShipmentFieldLabel,
  ShipmentPhoneCodeField,
  ShipmentSelectField,
  ShipmentTextField
} from "@/components/shipments/ShipmentFormControls";
import { ParcelItemsEditor } from "@/components/shipments/ParcelItemsEditor";
import ShipmentImportBanner from "@/components/shipments/ShipmentImportBanner";
import { ConsignorKycSection } from "@/components/shipments/ConsignorKycSection";
import { ShipmentLabelsPanel } from "@/components/shipments/ShipmentLabelsPanel";
import {
  ConsignorForm,
  ParcelKycState,
  nextContactNameOnCompanyChange,
  consigneeContactFrom,
  consignorFormFromDraft,
  consignorFormToPatch,
  consignorFormsMatch,
  createEmptyConsignorForm,
  getConsignorFormIssueDetail,
  getConsignorFormIssues,
  getKycIssues,
  mergeShipmentFormIssues,
  allShipmentFormIssues,
  type ShipmentFormIssues
} from "@/lib/shipmentConsignor";
import { useUnsavedChanges } from "@/lib/useUnsavedChanges";
import { useShipmentDraftAutosave } from "@/lib/useShipmentDraftAutosave";
import { getDraftRateCardContext, type ClientCountryRateCard } from "@/lib/countryRateCards";
import { findRestrictedCategories } from "@/lib/restrictedGoods";
import { normalizeCsbType, type CsbType } from "@/lib/csbType";
import { maxParcelsPerShipment } from "@/lib/shipmentLimits";
import { defaultDeclarationNote } from "@/lib/customsInvoice";
import {
  composeContentsDescription,
  createEmptyParcelItem,
  getParcelItemAmountError,
  getHsnCodeError,
  getPositiveNumberError,
  getShipmentDescriptionLimitMessage,
  isUntouchedParcelItem,
  mergeSavedParcelItemsWithLocalRows,
  normalizeParcelItems,
  type ParcelItem
} from "@/lib/parcelItems";
import {
  getDialCodeForCountryCode,
  getPostcodeError,
  getShipmentEmailError,
  getShipmentMobileCountryMismatchError,
  getShipmentMobileError,
  isPostcodeValidForCountry
} from "@/lib/shipmentContactValidation";
import {
  AddressPrediction,
  DpdShipmentHistoryItem,
  ShipmentDraft,
  type ShipmentDraftPatch,
  ShipmentContentType,
  ShipmentKycDocuments,
  ShipmentServiceType,
  autocompleteAddress,
  autocompleteConsignorAddress,
  confirmAddress,
  createManualShipmentDraft,
  createShipment,
  type CounterPaymentInput,
  deleteShipmentKycDocument,
  deleteShipmentParcelKycDocument,
  formatShipmentValidationIssues,
  getConsignorPlaceAddress,
  getDpdLabelAccessUrl,
  getPlaceAddress,
  getShipmentDraft,
  isDpdLabelDestination,
  listDpdShipments,
  openShipmentKycDocument,
  openShipmentParcelKycDocument,
  shipmentContentTypeOptions,
  updateShipmentDraft,
  uploadShipmentKycDocument,
  uploadShipmentParcelKycDocument,
  validateAddress,
  validateShipmentDraft,
  type ShipmentImportSummary
} from "@/lib/dpdLabels";
import ShipmentCostEstimatePanel from "@/components/shipments/ShipmentCostEstimatePanel";
import ShipmentPriceChangeDialog from "@/components/shipments/ShipmentPriceChangeDialog";
import {
  DpdLabelUnavailableError,
  ShipmentPriceChangedError,
  maxBoxWeightIssue,
  type ShipmentCostEstimateInput
} from "@/lib/shipmentCostEstimate";
import { useShipmentCostEstimate } from "@/lib/useShipmentCostEstimate";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { FaRegWindowClose, FaWeight } from "react-icons/fa";
import BookingPausedNotice from "@/components/booking/BookingPausedNotice";
import { isCountryPaused, listActiveBookingPauses, type BookingPause } from "@/lib/bookingPause";

type DpdShipmentResult = Awaited<ReturnType<typeof createShipment>>;
const parcelRenderStyle = { contentVisibility: "auto", containIntrinsicSize: "auto 360px" } as const;
/** The booking-panel action currently running; the two booking values are the
 *  provider each button books with. Null when the page is idle. */
type PendingAction = "BOOKING" | "BOOKING_NO_DPD" | "DRAFT" | "ADDRESS" | null;
type AddressForm = {
  countryCode: string;
  countryName: string;
  addressLine1: string;
  addressLine2: string;
  townOrCity: string;
  county: string;
  postcode: string;
};
type DraftCorrectionForm = {
  companyName: string;
  contactName: string;
  email: string;
  mobileCountryCode: string;
  mobileNumber: string;
  deliveryInstructions: string;
  serviceType: ShipmentServiceType;
  serviceCode: string;
};
type ParcelForm = {
  sequence: number;
  weightKg: string;
  lengthCm: string;
  widthCm: string;
  heightCm: string;
  shipmentContentType: ShipmentContentType;
  // One row per distinct good, each with its own HSN code. The joined
  // descriptions become contentsDescription on save.
  items: ParcelItem[];
  contentsDescription: string;
  shipmentReference1: string;
  shipmentReference2: string;
  aadhaarNumber: string;
};

const maxParcelCount = maxParcelsPerShipment;
const prohibitedItems = [
  "Alcohol / Liquor",
  "Tobacco / Nicotine / Vape",
  "Cash / Currency",
  "Gold / Silver / Precious Metals",
  "Gems / Diamonds",
  "Arms / Ammunition / Weapons",
  "Explosives / Fireworks",
  "Flammable Items",
  "Dangerous Chemicals",
  "Poison / Toxic Material",
  "Prescription Medicines",
  "Narcotics / Drugs",
  "Live Animals",
  "Plants / Seeds",
  "Pornographic Material",
  "Counterfeit Goods",
  "Loose battery / power bank without approval",
  "Perishable fresh food",
  "Human remains / ashes without approval"
];

function getCountryName(countryCode: string) {
  // Intl.DisplayNames throws RangeError("invalid_argument") on anything that is
  // not a region code, blanks included. A draft may well have no destination
  // country yet, so an empty code has to resolve to an empty name rather than
  // taking down the save that is trying to store it.
  const code = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";

  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

function createEmptyParcelForm(sequence: number): ParcelForm {
  return {
    sequence,
    weightKg: "",
    lengthCm: "",
    widthCm: "",
    heightCm: "",
    shipmentContentType: "PARCEL",
    items: [createEmptyParcelItem()],
    contentsDescription: "",
    shipmentReference1: "",
    shipmentReference2: "",
    aadhaarNumber: ""
  };
}

function SourceBadge({ children }: { children: string }) {
  return (
    <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
      {children}
    </span>
  );
}

function getFieldIssue(issues: string[], patterns: string[]) {
  return issues.find((issue) => patterns.every((pattern) => issue.toLowerCase().includes(pattern)));
}

/**
 * Review-form problems split into blank fields and wrongly filled ones.
 *
 * A blank field is deferrable: the draft stores it and booking blocks on it
 * later. A wrongly filled one is not, because saving it would put data into the
 * draft that the form refuses to reopen cleanly.
 */
function getReviewFormIssueDetail(
  addressForm: AddressForm,
  draftCorrectionForm: DraftCorrectionForm,
  parcelForms: ParcelForm[],
  csbType: CsbType
): ShipmentFormIssues {
  const missing: string[] = [];
  const invalid: string[] = [];

  if (!draftCorrectionForm.contactName.trim()) missing.push("Contact name is required");
  if (!draftCorrectionForm.mobileCountryCode.trim()) missing.push("Mobile country code is required");
  if (!draftCorrectionForm.mobileNumber.trim()) {
    missing.push("Mobile number is required");
  } else {
    const mobileError = getShipmentMobileError(draftCorrectionForm.mobileCountryCode, draftCorrectionForm.mobileNumber);
    if (mobileError) invalid.push(mobileError);
  }
  // The dial code must belong to the destination country (GB goes with +44),
  // so a number that is valid elsewhere still fails here.
  const countryCodeMismatchError = getShipmentMobileCountryMismatchError(addressForm.countryCode, draftCorrectionForm.mobileCountryCode);
  if (countryCodeMismatchError) invalid.push(countryCodeMismatchError);
  if (!draftCorrectionForm.email.trim()) {
    missing.push("Email is required");
  } else {
    const emailError = getShipmentEmailError(draftCorrectionForm.email);
    if (emailError) invalid.push(emailError);
  }
  if (!addressForm.countryCode.trim()) missing.push("Country is required");
  if (!addressForm.addressLine1.trim()) missing.push("Address line 1 is required");
  if (!addressForm.townOrCity.trim()) missing.push("Town or city is required");
  if (!addressForm.postcode.trim()) {
    missing.push("Postcode is required");
  } else {
    const postcodeError = getPostcodeError(addressForm.countryCode, addressForm.postcode);
    if (postcodeError) invalid.push(postcodeError);
  }
  if (!parcelForms.length) missing.push("At least one parcel is required");
  if (parcelForms.length > maxParcelCount) invalid.push(`Number of Parcels (PCS) must be ${maxParcelCount} or fewer`);
  parcelForms.forEach((parcel, index) => {
    const weightKg = Number(parcel.weightKg);
    const label = `Parcel ${index + 1}`;
    if (parcel.sequence !== index + 1) invalid.push(`${label}: sequence must be ${index + 1}`);
    if (!parcel.weightKg.trim()) {
      missing.push(`${label}: weight is required`);
    } else if (!Number.isFinite(weightKg) || weightKg <= 0) {
      invalid.push(`${label}: weight must be greater than zero`);
    }
    for (const [field, value] of [["length", parcel.lengthCm], ["width", parcel.widthCm], ["height", parcel.heightCm]]) {
      if (!value.trim()) {
        missing.push(`${label}: ${field} is required`);
      } else if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
        invalid.push(`${label}: ${field} must be greater than zero`);
      }
    }
    if (!parcel.shipmentContentType) missing.push(`${label}: shipment content type is required`);
    if (!parcel.shipmentReference1.trim()) missing.push(`${label}: reference is required`);
    // Every declared item needs a description. The HS code is a CSB-V customs
    // requirement, so CSB-IV senders may leave it blank.
    const requireHsnCode = csbType === "CSB_V";
    const items = parcel.items.filter((item) => item.description.trim() || item.hsnCode.trim());
    if (!items.length) {
      missing.push(`${label}: contents are required`);
    }
    items.forEach((item, itemIndex) => {
      const itemLabel = `${label} item ${itemIndex + 1}`;
      if (!item.description.trim()) {
        missing.push(`${itemLabel}: description is required`);
      } else {
        const restricted = findRestrictedCategories(item.description);
        if (restricted.length) {
          invalid.push(`${itemLabel}: ${restricted.join(", ")} is a restricted item and cannot be shipped`);
        }
      }
      // Each of these reports a blank and a malformed value differently, so the
      // empty check decides which bucket the message lands in.
      const hsnError = getHsnCodeError(item.hsnCode, requireHsnCode);
      if (hsnError) {
        (item.hsnCode.trim() ? invalid : missing).push(`${itemLabel}: ${hsnError.replace(/\.$/, "").toLowerCase()}`);
      }
      // Quantity and unit rate print on the customs invoice, so both are required.
      const quantityError = getPositiveNumberError(item.quantity, "Quantity");
      if (quantityError) {
        (item.quantity.trim() ? invalid : missing).push(`${itemLabel}: ${quantityError.replace(/\.$/, "").toLowerCase()}`);
      }
      const unitRateError = getPositiveNumberError(item.unitRate, "Unit rate");
      if (unitRateError) {
        (item.unitRate.trim() ? invalid : missing).push(`${itemLabel}: ${unitRateError.replace(/\.$/, "").toLowerCase()}`);
      }
      const amountError = getParcelItemAmountError(item);
      if (amountError) invalid.push(`${itemLabel}: ${amountError.replace(/\.$/, "").toLowerCase()}`);
    });
  });

  return { missing, invalid };
}

/** Every review-form problem, blank fields included. Use before booking. */
function getReviewFormIssues(
  addressForm: AddressForm,
  draftCorrectionForm: DraftCorrectionForm,
  parcelForms: ParcelForm[],
  csbType: CsbType
) {
  return allShipmentFormIssues(
    getReviewFormIssueDetail(addressForm, draftCorrectionForm, parcelForms, csbType)
  );
}

function normalizeParcelForms(parcels: ShipmentDraft["parcelList"]): ParcelForm[] {
  const sourceParcels: ShipmentDraft["parcelList"] = parcels.length
    ? parcels
    : [{ sequence: 1, weightKg: 0, shipmentContentType: "PARCEL", contentsDescription: "" }];

  return sourceParcels.map((parcel, index) => ({
    sequence: index + 1,
    weightKg: parcel.weightKg ? String(parcel.weightKg) : "",
    lengthCm: parcel.lengthCm ? String(parcel.lengthCm) : "",
    widthCm: parcel.widthCm ? String(parcel.widthCm) : "",
    heightCm: parcel.heightCm ? String(parcel.heightCm) : "",
    shipmentContentType: parcel.shipmentContentType ?? "PARCEL",
    // Drafts saved before per-item capture surface as a single item seeded from
    // their existing description, so they open without a migration.
    items: normalizeParcelItems(parcel),
    contentsDescription: parcel.contentsDescription ?? "",
    shipmentReference1: parcel.shipmentReference1 ?? "",
    shipmentReference2: parcel.shipmentReference2 ?? "",
    aadhaarNumber: parcel.aadhaarNumber ?? ""
  }));
}

function comparableParcelForms(parcels: ParcelForm[]): ParcelForm[] {
  return parcels.map((parcel) => ({
    ...parcel,
    items: parcel.items.filter((item) => !isUntouchedParcelItem(item))
  }));
}

function isParcelFormEmpty(parcel: ParcelForm) {
  return !parcel.weightKg && !parcel.lengthCm && !parcel.widthCm && !parcel.heightCm
    && parcel.shipmentContentType === "PARCEL"
    && !parcel.contentsDescription && !parcel.shipmentReference1 && !parcel.shipmentReference2
    && !parcel.aadhaarNumber;
}

function shipmentHistoryToResult(item: DpdShipmentHistoryItem): DpdShipmentResult {
  return {
    success: true,
    reused: true,
    dpdShipment: {
      id: item.dpdShipment.id,
      dpdShipmentId: item.dpdShipment.dpdShipmentId,
      dpdTransactionId: item.dpdShipment.dpdTransactionId,
      swiftlineTrackingNumber: item.dpdShipment.swiftlineTrackingNumber,
      parcelNumbers: item.dpdShipment.parcelNumbers,
      serviceCode: item.dpdShipment.serviceCode,
      status: item.dpdShipment.status,
      createdAt: item.dpdShipment.createdAt
    },
    labels: item.labels.map((label) => ({
      id: label.id,
      parcelNumber: label.parcelNumber,
      labelType: label.labelType,
      format: label.format,
      labelSize: label.labelSize,
      generatedAt: label.generatedAt
    })),
    bookingConfirmation: item.bookingConfirmation,
    shipmentInvoice: item.shipmentInvoice
      ? {
          id: "",
          invoiceNumber: item.shipmentInvoice.invoiceNumber,
          currency: item.shipmentInvoice.currency,
          totalAmountMinor: item.shipmentInvoice.totalAmountMinor,
          revision: item.shipmentInvoice.revision,
          status: item.shipmentInvoice.status
        }
      : null
  };
}

export default function DpdLabelDraftPage() {
  const params = useParams<{ draftId: string }>();
  const router = useRouter();
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [draft, setDraft] = useState<ShipmentDraft | null>(null);
  const [result, setResult] = useState<DpdShipmentResult | null>(null);
  // Walk-in payment capture. Ignored entirely for business shipments.
  const [counterMethod, setCounterMethod] = useState<CounterPaymentInput["method"]>("CASH");
  const [counterReference, setCounterReference] = useState("");
  const [rates, setRates] = useState<ClientCountryRateCard[]>([]);
  const [addressForm, setAddressForm] = useState<AddressForm>({
    countryCode: "GB",
    countryName: "United Kingdom",
    addressLine1: "",
    addressLine2: "",
    townOrCity: "",
    county: "",
    postcode: ""
  });
  const [draftCorrectionForm, setDraftCorrectionForm] = useState<DraftCorrectionForm>({
    companyName: "",
    contactName: "",
    email: "",
    // The consignee delivers to the UK by default, so the UK dial code is pre-selected.
    mobileCountryCode: "+44",
    mobileNumber: "",
    deliveryInstructions: "",
    serviceType: "COURIER",
    serviceCode: ""
  });
  const [consignorForm, setConsignorForm] = useState<ConsignorForm>(createEmptyConsignorForm());
  const [kycUseForAll, setKycUseForAll] = useState(true);
  const [kycDocuments, setKycDocuments] = useState<ShipmentKycDocuments>({});
  const [parcelKyc, setParcelKyc] = useState<Record<number, ShipmentKycDocuments>>({});
  const [parcelForms, setParcelForms] = useState<ParcelForm[]>([createEmptyParcelForm(1)]);
  const deferredPricingParcels = useDeferredValue(parcelForms);
  const [parcelCountInput, setParcelCountInput] = useState(String(parcelForms.length));

  // Customs route for the shipment. Drafts saved before CSB selection existed
  // read as CSB-IV, matching how the backend prices them.
  const [csbType, setCsbType] = useState<CsbType>("CSB_IV");
  // Optional transit cover. Off unless the customer asks for it.
  const [insuranceOptIn, setInsuranceOptIn] = useState(false);
  const [forceGst, setForceGst] = useState(false);
  // Set when the server refuses a booking because the price moved after it was
  // quoted. Holds the new breakdown until it is accepted or cancelled.
  const [priceChange, setPriceChange] = useState<ShipmentPriceChangedError | null>(null);
  // Which button opened the price change dialog, so accepting re-books the same way.
  // Present only on drafts created from an uploaded invoice.
  const [shipmentImport, setShipmentImport] = useState<ShipmentImportSummary | null>(null);
  // Printed as the NOTE block on the shipment (customs) invoice.
  const [declarationNote, setDeclarationNote] = useState(defaultDeclarationNote);
  const [addressQuery, setAddressQuery] = useState("");
  const [predictions, setPredictions] = useState<AddressPrediction[]>([]);
  // Which action is in flight, not merely whether one is. Every action button
  // locks while any of them runs- booking is irreversible, so a second click
  // anywhere must not land- but only the one that was clicked shows progress.
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [creatingNewShipment, setCreatingNewShipment] = useState(false);
  /**
   * The DPD label failure currently being offered a way past.
   *
   * Set only when the server confirmed nothing was booked, which is what makes
   * it safe to offer a booking that skips the carrier label. Empty is the normal
   * state: the button below can also be shown without any failure at all.
   */
  const [dpdLabelError, setDpdLabelError] = useState("");
  const busy = pendingAction !== null;
  const [addressBusy, setAddressBusy] = useState(false);
  const [error, setError] = useState("");
  const [, setReviewIssues] = useState<string[]>([]);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [manualAddressConfirmationRequired, setManualAddressConfirmationRequired] = useState(false);
  const [bookingPauses, setBookingPauses] = useState<BookingPause[]>([]);
  const manualAddressConfirmationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!manualAddressConfirmationRequired) return;

    manualAddressConfirmationRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }, [manualAddressConfirmationRequired]);

  const correctionChanged = useMemo(() => {
    if (!draft) return false;

    return (
      draftCorrectionForm.companyName !== (draft.consigneeEnteredAddress.companyName ?? "") ||
      draftCorrectionForm.contactName !== (draft.consigneeEnteredAddress.contactName ?? "") ||
      draftCorrectionForm.email !== (draft.consigneeEnteredAddress.email ?? "") ||
      draftCorrectionForm.mobileCountryCode !== (draft.consigneeEnteredAddress.mobileCountryCode || "+44") ||
      draftCorrectionForm.mobileNumber !== (draft.consigneeEnteredAddress.mobileNumber ?? "") ||
      draftCorrectionForm.deliveryInstructions !== (draft.consigneeEnteredAddress.deliveryInstructions ?? "") ||
      JSON.stringify(comparableParcelForms(parcelForms))
        !== JSON.stringify(comparableParcelForms(normalizeParcelForms(draft.parcelList))) ||
      draftCorrectionForm.serviceType !== (draft.serviceType ?? "COURIER") ||
      draftCorrectionForm.serviceCode !== (draft.serviceCode ?? "") ||
      insuranceOptIn !== (draft.insuranceOptIn ?? false) ||
      forceGst !== (draft.forceGst ?? false)
    );
  }, [draft, draftCorrectionForm, forceGst, insuranceOptIn, parcelForms]);

  const addressChanged = useMemo(() => {
    if (!draft) return false;

    const address = draft.consigneeEnteredAddress;

    return (
      addressForm.addressLine1 !== (address.addressLine1 ?? "") ||
      addressForm.addressLine2 !== (address.addressLine2 ?? "") ||
      addressForm.townOrCity !== (address.townOrCity ?? "") ||
      addressForm.county !== (address.county ?? "") ||
      addressForm.countryCode !== (address.countryCode ?? "GB") ||
      addressForm.postcode !== (address.postcode ?? "")
    );
  }, [addressForm, draft]);

  // Whether this shipment gets a DPD carrier label at all. The server decides
  // this for itself from the same country code; here it only governs whether the
  // operator is offered a way to book without one.
  const dpdLabelDestination = isDpdLabelDestination(addressForm.countryCode);

  // Priced by the server, not here. The booking charges whatever this returns, so
  // there is deliberately no second implementation in the browser to drift from it.
  const estimateValues = useMemo<ShipmentCostEstimateInput>(() => ({
    countryCode: addressForm.countryCode,
    destinationPostcode: addressForm.postcode,
    serviceType: draftCorrectionForm.serviceType,
    csbType,
    insuranceOptIn,
    forceGst,
    parcels: deferredPricingParcels.map((parcel, index) => ({
      sequence: index + 1,
      weightKg: Number(parcel.weightKg) || 0,
      lengthCm: Number(parcel.lengthCm) || 0,
      widthCm: Number(parcel.widthCm) || 0,
      heightCm: Number(parcel.heightCm) || 0,
      // Carried so the insurance premium tracks the value being declared.
      items: parcel.items.map((item) => ({
        quantity: Number(item.quantity) || 0,
        unitRate: Number(item.unitRate) || 0
      }))
    }))
  }), [addressForm.countryCode, addressForm.postcode, csbType, deferredPricingParcels, draftCorrectionForm.serviceType, forceGst, insuranceOptIn]);

  const {
    estimate: costEstimate,
    loading: costEstimateLoading,
    error: costEstimateError,
    refresh: refreshCostEstimate,
    acceptEstimate
  } = useShipmentCostEstimate({
    shipmentDraftId: params.draftId,
    audience: "admin",
    values: estimateValues,
    enabled: Boolean(draft)
  });

  const draftPatch = useMemo<ShipmentDraftPatch>(() => ({
    consignorAddress: consignorFormToPatch(consignorForm),
    kycUseForAllParcels: kycUseForAll,
    consigneeEnteredAddress: {
      companyName: draftCorrectionForm.companyName,
      contactName: draftCorrectionForm.contactName,
      email: draftCorrectionForm.email,
      mobileCountryCode: draftCorrectionForm.mobileCountryCode,
      mobileNumber: draftCorrectionForm.mobileNumber,
      countryCode: addressForm.countryCode,
      countryName: addressForm.countryName || getCountryName(addressForm.countryCode),
      addressLine1: addressForm.addressLine1,
      addressLine2: addressForm.addressLine2,
      townOrCity: addressForm.townOrCity,
      county: addressForm.county,
      postcode: addressForm.postcode,
      deliveryInstructions: draftCorrectionForm.deliveryInstructions
    },
    parcelList: parcelForms.map((parcel, index) => ({
      sequence: index + 1,
      weightKg: Number(parcel.weightKg),
      lengthCm: parcel.lengthCm ? Number(parcel.lengthCm) : undefined,
      widthCm: parcel.widthCm ? Number(parcel.widthCm) : undefined,
      heightCm: parcel.heightCm ? Number(parcel.heightCm) : undefined,
      shipmentContentType: parcel.shipmentContentType,
      // Blank rows are dropped; quantity and rate go over the wire as numbers.
      items: parcel.items
        .filter((item) => item.description.trim() || item.hsnCode.trim())
        .map((item) => ({
          description: item.description,
          hsnCode: item.hsnCode,
          unitType: item.unitType,
          quantity: Number(item.quantity) || 0,
          unitRate: Number(item.unitRate) || 0
        })),
      contentsDescription: composeContentsDescription(parcel.items),
      shipmentReference1: parcel.shipmentReference1,
      shipmentReference2: parcel.shipmentReference2,
      aadhaarNumber: parcel.aadhaarNumber
    })),
    csbType,
    insuranceOptIn,
    forceGst,
    declarationNote,
    serviceType: draftCorrectionForm.serviceType,
    serviceCode: draftCorrectionForm.serviceCode
  }), [addressForm, consignorForm, csbType, declarationNote, draftCorrectionForm, forceGst, insuranceOptIn, kycUseForAll, parcelForms]);

  const draftPatchKey = useMemo(
    () => `${draft?._id ?? "unloaded"}:${JSON.stringify(draftPatch)}`,
    [draft?._id, draftPatch]
  );

  const consignorChanged = useMemo(
    () => (draft
      ? !consignorFormsMatch(consignorForm, draft.consignorAddress)
        || kycUseForAll !== (draft.kycUseForAllParcels ?? true)
      : false),
    [consignorForm, draft, kycUseForAll]
  );

  const consignorKycApi = useMemo(() => ({
    autocompleteConsignorAddress,
    getConsignorPlaceAddress,
    uploadKycDocument: uploadShipmentKycDocument,
    deleteKycDocument: deleteShipmentKycDocument,
    openKycDocument: openShipmentKycDocument,
    uploadParcelKycDocument: uploadShipmentParcelKycDocument,
    deleteParcelKycDocument: deleteShipmentParcelKycDocument,
    openParcelKycDocument: openShipmentParcelKycDocument
  }), []);

  const parcelKycStates = useMemo<ParcelKycState[]>(
    () => parcelForms.map((parcel) => ({
      sequence: parcel.sequence,
      aadhaarNumber: parcel.aadhaarNumber,
      kycDocuments: parcelKyc[parcel.sequence]
    })),
    [parcelForms, parcelKyc]
  );

  const draftChanged = correctionChanged
    || addressChanged
    || consignorChanged
    || (draft ? csbType !== normalizeCsbType(draft.csbType) : false)
    || (draft ? declarationNote !== (draft.declarationNote ?? defaultDeclarationNote) : false);

  const {
    status: draftAutosaveStatus,
    flush: flushDraftChanges
  } = useShipmentDraftAutosave({
    enabled: Boolean(draft && draftChanged && !busy && !addressBusy),
    changeKey: draftPatchKey,
    patch: draftPatch,
    save: async (patch) => {
      if (!draft) throw new Error("Shipment draft is not loaded.");
      const data = await updateShipmentDraft(draft._id, patch);
      return data.shipmentDraft;
    },
    onSaved: (nextDraft, isLatest) => {
      setDraft(nextDraft);
      if (!isLatest) return;
      syncDraftCorrectionForm(nextDraft, true);
      syncConsignorForm(nextDraft);
      syncAddressForm(nextDraft);
    },
    onError: (caughtError) => {
      setError(caughtError instanceof Error ? caughtError.message : "Shipment changes could not be saved.");
    }
  });

  // This form used to lose everything on navigation: nothing was stored until the
  // whole form validated, and there was no guard on the way out.
  useUnsavedChanges(draftChanged, {
    label: "this shipment",
    saveDraft: async () => {
      if (!draftChanged) return;
      await flushDraftChanges();
    }
  });

  const currentReviewIssues = useMemo(
    () => getReviewFormIssues(addressForm, draftCorrectionForm, parcelForms, csbType),
    [addressForm, csbType, draftCorrectionForm, parcelForms]
  );

  const consigneeContact = useMemo(
    () => consigneeContactFrom(draftCorrectionForm),
    [draftCorrectionForm]
  );
  const consignorReviewIssues = useMemo(
    () => getConsignorFormIssues(consignorForm, consigneeContact),
    [consignorForm, consigneeContact]
  );
  const consignorFieldIssues = useMemo(() => ({
    contactName: getFieldIssue(consignorReviewIssues, ["consignor contact name"])
      ?? getFieldIssue(consignorReviewIssues, ["contact names must"]),
    email: getFieldIssue(consignorReviewIssues, ["consignor email"])
      ?? getFieldIssue(consignorReviewIssues, ["email addresses must"]),
    mobileNumber: getFieldIssue(consignorReviewIssues, ["consignor mobile"])
      ?? getFieldIssue(consignorReviewIssues, ["mobile numbers must"]),
    aadhaarNumber: getFieldIssue(consignorReviewIssues, ["aadhaar"]),
    addressLine1: getFieldIssue(consignorReviewIssues, ["consignor address line 1"]),
    townOrCity: getFieldIssue(consignorReviewIssues, ["consignor town"]),
    county: getFieldIssue(consignorReviewIssues, ["consignor state"]),
    postcode: getFieldIssue(consignorReviewIssues, ["pin code"])
  }), [consignorReviewIssues]);
  const destinationCountries = useMemo(() => {
    const countries = new Map<string, string>();
    rates.forEach((rate) => countries.set(rate.countryCode, rate.countryName));
    if (addressForm.countryCode && addressForm.countryName) {
      countries.set(addressForm.countryCode, addressForm.countryName);
    }
    return [...countries].map(([code, name]) => ({ code, name }));
  }, [addressForm.countryCode, addressForm.countryName, rates]);

  const fieldIssues = useMemo(() => {
    const issues = currentReviewIssues;

    return {
      contactName: getFieldIssue(issues, ["contact name"]),
      mobileCountryCode: getFieldIssue(issues, ["mobile country code"]),
      mobileNumber: getFieldIssue(issues, ["mobile number"]),
      email: getFieldIssue(issues, ["email is required"]) ?? getFieldIssue(issues, ["valid email"]),
      addressLine1: getFieldIssue(issues, ["address line 1"]),
      townOrCity: getFieldIssue(issues, ["town or city"]),
      postcode: getFieldIssue(issues, ["postcode"]),
    };
  }, [currentReviewIssues]);

  function getParcelFieldIssue(index: number, patterns: string[]) {
    // The parcel number needs a trailing boundary: a plain substring search
    // lets `parcel 1` match `parcel 10`, painting box 1 red for box 10's
    // error. `parcel 1 item 2` still matches box 1, as it should.
    const parcelPattern = new RegExp(`parcel ${index + 1}(?!\\d)`);
    return currentReviewIssues.find((issue) => {
      const normalizedIssue = issue.toLowerCase();
      return parcelPattern.test(normalizedIssue)
        && patterns.some((pattern) => normalizedIssue.includes(pattern));
    });
  }

  function syncDraftCorrectionForm(nextDraft: ShipmentDraft, preserveLocalItemRows = false) {
    setDraftCorrectionForm({
      companyName: nextDraft.consigneeEnteredAddress.companyName ?? "",
      contactName: nextDraft.consigneeEnteredAddress.contactName ?? "",
      email: nextDraft.consigneeEnteredAddress.email ?? "",
      mobileCountryCode: nextDraft.consigneeEnteredAddress.mobileCountryCode || "+44",
      mobileNumber: nextDraft.consigneeEnteredAddress.mobileNumber ?? "",
      deliveryInstructions: nextDraft.consigneeEnteredAddress.deliveryInstructions ?? "",
      serviceType: nextDraft.serviceType ?? "COURIER",
      serviceCode: nextDraft.serviceCode ?? ""
    });
    const nextParcels = normalizeParcelForms(nextDraft.parcelList);
    setParcelForms((current) => preserveLocalItemRows
      ? nextParcels.map((parcel, index) => ({
          ...parcel,
          items: mergeSavedParcelItemsWithLocalRows(
            parcel.items,
            current[index]?.items ?? []
          )
        }))
      : nextParcels);
    setParcelCountInput(String(nextParcels.length));
    setCsbType(normalizeCsbType(nextDraft.csbType));
    setInsuranceOptIn(nextDraft.insuranceOptIn ?? false);
    setForceGst(nextDraft.forceGst ?? false);
    setDeclarationNote(nextDraft.declarationNote ?? defaultDeclarationNote);
  }

  function syncConsignorForm(nextDraft: ShipmentDraft) {
    setConsignorForm(consignorFormFromDraft(nextDraft.consignorAddress));
    setKycUseForAll(nextDraft.kycUseForAllParcels ?? true);
    setKycDocuments(nextDraft.kycDocuments ?? {});
    const parcelKycBySequence: Record<number, ShipmentKycDocuments> = {};
    nextDraft.parcelList.forEach((parcel) => {
      if (parcel.kycDocuments) parcelKycBySequence[parcel.sequence] = parcel.kycDocuments;
    });
    setParcelKyc(parcelKycBySequence);
  }

  function syncAddressForm(nextDraft: ShipmentDraft) {
    const address = nextDraft.consigneeValidatedAddress ?? nextDraft.consigneeSelectedAddress ?? nextDraft.consigneeEnteredAddress;
    setAddressForm({
      countryCode: address.countryCode ?? "GB",
      countryName: address.countryName ?? getCountryName(address.countryCode ?? "GB"),
      addressLine1: address.addressLine1 ?? "",
      addressLine2: address.addressLine2 ?? "",
      townOrCity: address.townOrCity ?? "",
      county: address.county ?? "",
      postcode: address.postcode ?? ""
    });
    setAddressQuery(address.postcode ?? "");
  }

  useEffect(() => {
    if (!user || !params.draftId) return;

    async function loadDraft() {
      setError("");

      try {
        const [data, rateData] = await Promise.all([
          getShipmentDraft(params.draftId),
          getDraftRateCardContext(params.draftId, "admin")
        ]);
        if (data.shipmentDraft.bookingState && data.shipmentDraft.bookingState !== "EDITABLE") {
          toast.info("This shipment is already locked for booking. Opening its shipment details.");
          router.replace(`/dashboard/shipments/${data.shipmentDraft._id}`);
          return;
        }
        setRates(rateData.rates);
        setShipmentImport(data.shipmentImport ?? null);
        setDraft(data.shipmentDraft);
        syncDraftCorrectionForm(data.shipmentDraft);
        syncConsignorForm(data.shipmentDraft);
        syncAddressForm(data.shipmentDraft);

        const shipmentData = await listDpdShipments(100);
        const existingShipment = shipmentData.shipments.find((item) => item.shipmentDraft?.id === params.draftId);
        setResult(existingShipment ? shipmentHistoryToResult(existingShipment) : null);
      } catch (caughtError) {
        setError(caughtError instanceof Error ? caughtError.message : "Unable to load shipment draft.");
      }
    }

    void loadDraft();
  }, [params.draftId, router, user]);

  useEffect(() => {
    let active = true;
    async function loadPauses() {
      try {
        const data = await listActiveBookingPauses();
        if (!active) return;
        setBookingPauses(data.pauses);
      } catch { /* non-blocking */ }
    }
    void loadPauses();
    const id = window.setInterval(() => void loadPauses(), 60_000);
    return () => { active = false; window.clearInterval(id); };
  }, []);

  function handleAddressFieldChange(field: keyof AddressForm) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setAddressForm((current) => ({
        ...current,
        [field]: event.target.value.toUpperCase()
      }));
      setManualAddressConfirmationRequired(false);
      setReviewIssues([]);
    };
  }

  function handleDestinationCountryChange(event: ChangeEvent<HTMLSelectElement>) {
    const countryCode = event.target.value;
    const countryName = destinationCountries.find((country) => country.code === countryCode)?.name
      ?? getCountryName(countryCode);
    setAddressForm((current) => ({
      ...current,
      countryCode,
      countryName
    }));
    // Keep the consignee dial code on the destination's code (a UK destination
    // gets +44): a code from another country is invalid for this lane anyway.
    const dialCode = getDialCodeForCountryCode(countryCode);
    if (dialCode) {
      setDraftCorrectionForm((current) => (
        current.mobileCountryCode === dialCode ? current : { ...current, mobileCountryCode: dialCode }
      ));
    }
    setManualAddressConfirmationRequired(false);
    setReviewIssues([]);
  }

  function handleCorrectionFieldChange(field: keyof DraftCorrectionForm) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const preserveCase = field === "email" || field === "serviceType" || field === "serviceCode";
      const nextValue = preserveCase ? event.target.value : event.target.value.toUpperCase();
      setDraftCorrectionForm((current) => (
        field === "companyName"
          ? { ...current, companyName: nextValue, contactName: nextContactNameOnCompanyChange(current.companyName, current.contactName, nextValue) }
          : { ...current, [field]: nextValue }
      ));
      setReviewIssues([]);
    };
  }

  function handleParcelFieldChange(index: number, field: keyof Omit<ParcelForm, "sequence">) {
    return (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setParcelForms((current) => current.map((parcel, parcelIndex) => (
        parcelIndex === index ? { ...parcel, [field]: event.target.value.toUpperCase() as ParcelForm[typeof field] } : parcel
      )));
      setReviewIssues([]);
    };
  }

  // contentsDescription is kept in step with the items so the value sent on save
  // always matches what is on screen.
  function handleParcelItemsChange(index: number, items: ParcelItem[]) {
    setParcelForms((current) => current.map((parcel, parcelIndex) => (
      parcelIndex === index
        ? { ...parcel, items, contentsDescription: composeContentsDescription(items) }
        : parcel
    )));
    setReviewIssues([]);
  }

  function handleParcelCountChange(event: ChangeEvent<HTMLInputElement>) {
    const nextValue = event.target.value;
    if (nextValue === "") {
      setParcelCountInput("");
      return;
    }

    if (!/^\d+$/.test(nextValue)) return;
    const nextCount = Number(nextValue);
    if (nextCount > maxParcelCount) return;

    setParcelCountInput(nextValue);
    if (!Number.isInteger(nextCount) || nextCount < 1) return;

    setParcelForms((current) => {
      if (nextCount > current.length) {
        return [
          ...current,
          ...Array.from({ length: nextCount - current.length }, (_, index) => (
            createEmptyParcelForm(current.length + index + 1)
          ))
        ];
      }

      const removedParcels = current.slice(nextCount);
      if (removedParcels.some((parcel) => !isParcelFormEmpty(parcel))) {
        const confirmed = window.confirm(`Reducing the parcel count will remove the details entered for Parcel ${nextCount + 1} to Parcel ${current.length}.`);
        if (!confirmed) return current;
      }

      return current.slice(0, nextCount).map((parcel, index) => ({ ...parcel, sequence: index + 1 }));
    });
    setReviewIssues([]);
  }

  function handleParcelCountBlur() {
    if (!/^[0-9]+$/.test(parcelCountInput)) {
      setParcelCountInput(String(parcelForms.length));
      return;
    }

    const nextCount = Number(parcelCountInput);
    if (!Number.isInteger(nextCount) || nextCount < 1 || nextCount > maxParcelCount) {
      setParcelCountInput(String(parcelForms.length));
    }
  }

  function removeParcel(index: number) {
    setParcelForms((current) => {
      if (index < 0 || index >= current.length) return current;
      const removedParcel = current[index];
      const shouldConfirm = !isParcelFormEmpty(removedParcel) || current.length > 1;
      if (shouldConfirm) {
        const confirmed = window.confirm(`Remove Parcel ${index + 1}? This will delete its details.`);
        if (!confirmed) return current;
      }

      const nextParcels = current.filter((_, parcelIndex) => parcelIndex !== index);
      const updated = nextParcels.map((parcel, parcelIndex) => ({ ...parcel, sequence: parcelIndex + 1 }));
      setParcelCountInput(String(updated.length));
      return updated;
    });
  }

  function removeAllParcels() {
    if (!parcelForms.length) return;
    const confirmed = window.confirm("Remove all boxes? This will clear every parcel entry.");
    if (!confirmed) return;

    setParcelForms([]);
    setParcelCountInput("");
  }

  async function saveDraftCorrectionsIfNeeded(): Promise<ShipmentDraft> {
    if (!draft) throw new Error("Shipment draft is not loaded.");
    if (!draftChanged) return draft;
    return flushDraftChanges();
  }

  /**
   * Stores whatever the form currently holds.
   *
   * Blank fields are kept as-is- that is the point of a draft, and booking
   * still refuses to proceed without them. Fields filled in wrongly are refused,
   * because a draft holding data the form rejects cannot be reopened cleanly.
   *
   * Returns whether anything was stored, so the leave prompt can keep the user
   * here when it was not.
   */
  async function handleSaveDraft({ silentWhenUnchanged = false } = {}): Promise<boolean> {
    if (!draft) return false;
    if (!draftChanged) {
      if (!silentWhenUnchanged) toast.info("No changes to save.");
      return true;
    }

    setPendingAction("DRAFT");
    setError("");
    setReviewIssues([]);

    try {
      const { invalid } = mergeShipmentFormIssues(
        getReviewFormIssueDetail(addressForm, draftCorrectionForm, parcelForms, csbType),
        getConsignorFormIssueDetail(consignorForm, consigneeContactFrom(draftCorrectionForm))
      );
      if (invalid.length) {
        setSubmitAttempted(true);
        setReviewIssues(invalid);
        toast.error(`Correct this before saving: ${invalid[0]}`);
        return false;
      }

      await saveDraftCorrectionsIfNeeded();
      setSubmitAttempted(false);
      toast.success("Shipment draft saved.");
      return true;
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Shipment changes could not be saved.");
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  async function handleAddressSearch() {
    if (!addressQuery.trim()) return;
    if (addressForm.countryCode !== "GB") {
      toast.info("Address search is available for United Kingdom destinations. Confirm other addresses manually before booking.");
      return;
    }

    setAddressBusy(true);
    setError("");
    setReviewIssues([]);

    try {
      const data = await autocompleteAddress(addressQuery);
      setPredictions(data.predictions);
    } catch (caughtError) {
      setPredictions([]);
      setError(caughtError instanceof Error ? caughtError.message : "No matching UK address was found.");
    } finally {
      setAddressBusy(false);
    }
  }

  async function handleSelectPrediction(prediction: AddressPrediction) {
    if (!draft) return;

    setAddressBusy(true);
    setError("");
    setReviewIssues([]);

    try {
      const data = await getPlaceAddress(prediction.placeId, draft._id);
      setAddressForm((current) => ({
        ...current,
        addressLine1: (data.place.address.addressLine1 || current.addressLine1).toUpperCase(),
        addressLine2: (data.place.address.addressLine2 || current.addressLine2).toUpperCase(),
        townOrCity: (data.place.address.townOrCity || current.townOrCity).toUpperCase(),
        county: (data.place.address.county || current.county).toUpperCase(),
        postcode: (data.place.address.postcode || current.postcode).toUpperCase()
      }));
      setPredictions([]);
      const refreshed = await getShipmentDraft(draft._id);
      setDraft(refreshed.shipmentDraft);
      syncAddressForm(refreshed.shipmentDraft);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to select address.");
    } finally {
      setAddressBusy(false);
    }
  }

  const currentCountryCode = draft?.consigneeEnteredAddress?.countryCode || addressForm.countryCode || "";
  const isCurrentCountryPaused = isCountryPaused(currentCountryCode, bookingPauses);

  async function handleCreateLabel(
   // Supplied when re-booking after a changed price was accepted.
   acceptedPricingHash = costEstimate?.pricingHash,
   // Set by the "without DPD label" button, which stands alongside the primary
   // action on a United Kingdom shipment and also appears once DPD has refused.
   skipDpdLabel = false
 ) {
  if (!draft) return;

  if (isCountryPaused(draft.consigneeEnteredAddress?.countryCode || addressForm.countryCode, bookingPauses)) {
    const msg = "Bookings for this destination are temporarily paused. Please check the booking pause notice for details.";
    setError(msg);
    toast.error(msg);
    return;
  }

  setPendingAction(skipDpdLabel ? "BOOKING_NO_DPD" : "BOOKING");
    // A new attempt supersedes the previous failure, so the fallback hides
    // until this one has also been refused.
    setDpdLabelError("");
  setError("");
  setReviewIssues([]);

  try {
    const preflightIssues = [
      ...getReviewFormIssues(addressForm, draftCorrectionForm, parcelForms, csbType),
      ...getConsignorFormIssues(
        consignorForm,
        consigneeContactFrom(draftCorrectionForm)
      ),
      ...getKycIssues({
        csbType,
        useForAll: kycUseForAll,
        sharedAadhaar: consignorForm.aadhaarNumber,
        sharedDocuments: kycDocuments,
        parcels: parcelKycStates
      })
    ];

    if (preflightIssues.length) {
      setSubmitAttempted(true);
      setReviewIssues(preflightIssues);
      toast.error(preflightIssues[0]);
      return;
    }

    const descriptionLimitMessage = getShipmentDescriptionLimitMessage(parcelForms);
    if (descriptionLimitMessage) {
      setError(descriptionLimitMessage);
      toast.error(descriptionLimitMessage);
      return;
    }

    // The server refuses these outright; catching it here names the box and
    // avoids a round trip that would only fail.
    const overweight = (costEstimate?.pricing.parcels ?? [])
      .map(maxBoxWeightIssue)
      .filter((issue) => issue !== null);
    if (overweight.length) {
      const boxes = overweight.map((issue) => issue.sequence).join(", ");
      const message = `Box ${boxes}: ${overweight[0]?.text}`;
      setError(message);
      toast.error(message);
      return;
    }
    if (costEstimate?.pricing.missingRate) {
      const message = `Rates are not available for ${
        addressForm.countryName || addressForm.countryCode
      } with ${
        draftCorrectionForm.serviceType === "CARGO" ? "Cargo" : "Courier"
      } service. Please contact the assigned branch to arrange this shipment.`;

      setError(message);
      toast.error(message);
      return;
    }

    // Booking before the first estimate lands would send no accepted price, which
    // the server would let through unchecked.
    if (!costEstimate) {
      toast.info("Charges are still being calculated. Try again in a moment.");
      return;
    }

    if (!costEstimate.funding.canFund) {
      setError(costEstimate.funding.message);
      toast.error(costEstimate.funding.message);
      return;
    }

    const savedDraft = await saveDraftCorrectionsIfNeeded();
    let draftForValidation = savedDraft;

    // Once an address is validated (including a manual "use as entered" confirmation)
    // the backend keeps that status unless a real address field changes, so editing
    // contact or parcel details no longer forces the manual approval to reappear.
    if (draftForValidation.addressValidationStatus !== "VALIDATED") {
      // Re-check is only warranted when the postcode does not fit the country.
      if (!isPostcodeValidForCountry(addressForm.countryCode, addressForm.postcode)) {
        setManualAddressConfirmationRequired(false);
        toast.error(
          addressForm.countryCode === "GB"
            ? "Enter a valid UK postcode (e.g. AB10 6DN) before creating the shipment."
            : `Enter a valid postcode for ${addressForm.countryName || addressForm.countryCode} before creating the shipment.`
        );
        return;
      }

      const addressValidation = await validateAddress({
        shipmentDraftId: draftForValidation._id,
        address: {
          ...addressForm,
          countryCode: addressForm.countryCode,
          countryName: addressForm.countryName
        }
      });

      if (addressValidation.validation.outcome !== "VALID") {
        setManualAddressConfirmationRequired(true);
        toast.info(
          "No automatic address match was found. Review the address and confirm it as entered."
        );
        return;
      }

      const refreshed = await getShipmentDraft(draftForValidation._id);
      draftForValidation = refreshed.shipmentDraft;
      setDraft(draftForValidation);
      syncDraftCorrectionForm(draftForValidation);
      syncAddressForm(draftForValidation);
    }

    const validation = await validateShipmentDraft(draftForValidation._id);

    setDraft(validation.shipmentDraft);
    syncDraftCorrectionForm(validation.shipmentDraft);

    if (!validation.readyForDpd) {
      const message =
        formatShipmentValidationIssues(validation.validationIssues) ||
        "Correct the highlighted details before creating the shipment.";

      toast.error(message);
      return;
    }

    // A walk-in has already paid into a company account, so how that happened is
    // recorded with the booking. Business shipments settle through credit and
    // send nothing here.
    const counterPayment = draftForValidation.customerType === "INDIVIDUAL"
      ? { method: counterMethod, reference: counterReference.trim(), note: "" }
      : undefined;

    const data = await createShipment(draftForValidation._id, counterPayment, acceptedPricingHash, skipDpdLabel);

    setPriceChange(null);
    setResult(data);
    toast.success(
      data.reused
        ? "Existing booked shipment opened."
        : "Shipment booked successfully."
    );
  } catch (caughtError) {
    // Nothing was booked or reserved. The change is shown for explicit approval
    // before this can be retried.
    if (caughtError instanceof ShipmentPriceChangedError) {
      setPriceChange(caughtError);
      return;
    }

    // Nothing was booked: no charge, no invoice, no tracking number consumed.
    // Surfacing it here is what reveals the option to go ahead without the
    // carrier label, which is safe precisely because nothing exists yet.
    if (caughtError instanceof DpdLabelUnavailableError) {
      const detail = caughtError.carrierErrors.length
        ? `${caughtError.message} ${caughtError.carrierErrors.join(" ")}`
        : caughtError.message;
      setDpdLabelError(detail);
      setError(detail);
      toast.error(detail);
      return;
    }

    const message =
      caughtError instanceof Error
        ? caughtError.message
        : "Shipment could not be created.";

    toast.error(message);
  } finally {
    setPendingAction(null);
  }
}

  async function handleCreateNewShipment() {
    // This action is only rendered after a successful business shipment. Keep
    // the guard here as well so it cannot be triggered by a stale event.
    if (!draft || !result || draft.customerType === "INDIVIDUAL") return;

    const businessAccountId = draft.businessAccountId.trim();
    const branchId = draft.branchId.trim();
    if (!businessAccountId || !branchId) {
      const message = "The previous shipment account or branch is unavailable. Start a new shipment from the selector.";
      setError(message);
      toast.error(message);
      return;
    }

    setCreatingNewShipment(true);
    setError("");

    try {
      const next = await createManualShipmentDraft({ businessAccountId, branchId });
      toast.success("New blank shipment draft created for the same account and branch.");
      router.push(`/dashboard/dpd-labels/${next.shipmentDraft._id}`);
    } catch (caughtError) {
      const message = caughtError instanceof Error
        ? caughtError.message
        : "Unable to create a new shipment for the same account and branch.";
      setError(message);
      toast.error(message);
    } finally {
      setCreatingNewShipment(false);
    }
  }

  /** Re-books at the price that has just been shown and approved. */
  async function handleAcceptChangedPrice() {
    if (!priceChange) return;

    if (costEstimate) {
      acceptEstimate({
        ...costEstimate,
        pricing: priceChange.pricing,
        pricingHash: priceChange.pricingHash
      });
    }
    setPriceChange(null);
    refreshCostEstimate();
    toast.success("New charges accepted. Review the updated summary, then create the shipment.");
  }

  async function handleConfirmEnteredAddress() {
    if (!draft) return;

    setPendingAction("ADDRESS");
    try {
      const data = await confirmAddress({
        shipmentDraftId: draft._id,
        decision: "KEEP_ENTERED"
      });
      setDraft(data.shipmentDraft);
      syncDraftCorrectionForm(data.shipmentDraft);
      syncAddressForm(data.shipmentDraft);
      setManualAddressConfirmationRequired(false);
      toast.success("Address confirmed. You can now create the shipment.");
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Address could not be confirmed.");
    } finally {
      setPendingAction(null);
    }
  }

  if (loading || !user) return <DashboardLoading />;

  return (
    <div className="xl:flex xl:h-full xl:min-h-0 xl:flex-col">
      {/* <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-950">Review Shipment</h1>
          <p className="mt-1 text-sm text-slate-500">Confirm consignee, destination, parcel, and charge details before booking.</p>
        </div>
        </div> */}

      {error ? (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          {error}
        </div>
      ) : null}

      <div className="mb-4">
        <BookingPausedNotice variant="staff" pauses={bookingPauses} countryCode={currentCountryCode} />
      </div>

      {!draft ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-sm">Loading draft...</div>
      ) : (
        <div className="grid gap-6 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-6 no-scrollbar xl:min-h-0 xl:overflow-y-auto xl:pr-2">
            <ShipmentImportBanner summary={shipmentImport} />

              {/* Customs route, first because CSB-V changes what is charged. */}
            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/60 px-4 py-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Shipment Type</h2>
              </div>
              <div className="p-4">
                <ShipmentCsbTypeField
                  value={csbType}
                  onChange={(next: CsbType) => { setCsbType(next); setReviewIssues([]); }}
                />
                {/* Printed as the NOTE block on the shipment (customs) invoice. */}
                <div className="mt-4">
                  <ShipmentTextField
                    label="Declaration Note"
                    placeholder="Optional note printed on the shipment invoice"
                    tooltip="Printed on the shipment invoice sent with the goods"
                    value={declarationNote}
                    onChange={(event) => { setDeclarationNote(event.target.value.toUpperCase()); setReviewIssues([]); }}
                    maxLength={500}
                  />
                </div>
              </div>
            </section>

            <ConsignorKycSection
              shipmentDraftId={draft._id}
              csbType={csbType}
              form={consignorForm}
              onFormChange={(next) => { setConsignorForm(next); setReviewIssues([]); }}
              fieldIssues={consignorFieldIssues}
              submitAttempted={submitAttempted}
              kycUseForAll={kycUseForAll}
              onKycUseForAllChange={(next) => { setKycUseForAll(next); setReviewIssues([]); }}
              sharedKycDocuments={kycDocuments}
              onSharedKycChange={setKycDocuments}
              parcels={parcelKycStates}
              savedParcelCount={draft.parcelList.length}
              onParcelAadhaarChange={(sequence, value) => {
                setParcelForms((current) => current.map((parcel) => (
                  parcel.sequence === sequence ? { ...parcel, aadhaarNumber: value } : parcel
                )));
                setReviewIssues([]);
              }}
              onParcelKycChange={(sequence, documents) => setParcelKyc((current) => ({ ...current, [sequence]: documents }))}
              api={consignorKycApi}
            />

            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/60 px-4 py-3">
                <div>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Consignee Details</h2>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <SourceBadge>From invoice</SourceBadge>
                    {draftChanged ? <SourceBadge>Manually changed</SourceBadge> : null}
                  </div>
                </div>
              </div>
              <div className="grid gap-4 p-4 md:grid-cols-2">
                <ShipmentTextField label="Consignee Company" value={draftCorrectionForm.companyName} onChange={handleCorrectionFieldChange("companyName")} />
                <ShipmentTextField label="Consignee Contact Name" required value={draftCorrectionForm.contactName} onChange={handleCorrectionFieldChange("contactName")} error={fieldIssues.contactName} revealError={submitAttempted} />
                <ShipmentTextField label="Consignee Email" required type="email" value={draftCorrectionForm.email} onChange={handleCorrectionFieldChange("email")} error={fieldIssues.email} revealError={submitAttempted} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <ShipmentPhoneCodeField
                    value={draftCorrectionForm.mobileCountryCode}
                    onChange={(value) => {
                      setDraftCorrectionForm((current) => ({ ...current, mobileCountryCode: value }));
                      setReviewIssues([]);
                    }}
                    error={fieldIssues.mobileCountryCode}
                    revealError={submitAttempted}
                    defaultDialCode="+44"
                  />
                  <ShipmentTextField label="Mobile Number" required type="tel" inputMode="tel" value={draftCorrectionForm.mobileNumber} onChange={handleCorrectionFieldChange("mobileNumber")} error={fieldIssues.mobileNumber} revealError={submitAttempted} />
                </div>
                <label className="block md:col-span-2">
                  <ShipmentFieldLabel>Delivery Instructions</ShipmentFieldLabel>
                  <textarea
                    value={draftCorrectionForm.deliveryInstructions}
                    onChange={handleCorrectionFieldChange("deliveryInstructions")}
                    rows={3}
                    className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                  />
                </label>
              </div>
            </section>

            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-200 bg-slate-50/60 px-4 py-3">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Address Search</h2>
              </div>
              <div className="space-y-4 p-4">
                {addressForm.countryCode === "GB" ? <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                  <label className="block">
                    <ShipmentFieldLabel>UK Postcode Search</ShipmentFieldLabel>
                    <input
                      value={addressQuery}
                      onChange={(event) => setAddressQuery(event.target.value.toUpperCase())}
                      placeholder="POST CODE AB10 6DN"
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 px-3 text-[13px] outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={handleAddressSearch}
                    disabled={addressBusy}
                    className="mt-7 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                  >
                    <FiSearch aria-hidden="true" className="h-4 w-4" />
                    Search
                  </button>
                </div> : null}

                {predictions.length ? (
                  <div className="max-h-85 overflow-y-auto rounded-xl border border-slate-200 scrollbar-thin [scrollbar-color:#94a3b8_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400">
                    {predictions.map((prediction) => (
                      <button
                        key={prediction.placeId}
                        type="button"
                        onClick={() => handleSelectPrediction(prediction)}
                        className="flex w-full items-start gap-3 border-b border-slate-100 px-3 py-3 text-left last:border-b-0 hover:bg-blue-50"
                      >
                        <FiMapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-blue-900" />
                        <span>
                          <span className="block text-sm font-semibold text-slate-950">
                            {prediction.mainText || prediction.text}
                          </span>
                          <span className="mt-1 block text-xs text-slate-500">
                            {prediction.secondaryText || prediction.text}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {manualAddressConfirmationRequired ? (
                  <div ref={manualAddressConfirmationRef} className="flex scroll-mt-8 flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-amber-950">No automatic address match was found.</p>
                      <p className="mt-1 text-sm text-amber-800">Review the delivery address below before confirming it as entered.</p>
                    </div>
                    <button type="button" onClick={handleConfirmEnteredAddress} disabled={busy} className="inline-flex h-11 items-center justify-center rounded-xl bg-amber-700 px-4 text-sm font-semibold text-white transition hover:bg-amber-800 disabled:cursor-not-allowed disabled:bg-amber-400">
                      Use Address As Entered
                    </button>
                  </div>
                ) : null}

                <div className="grid gap-4 md:grid-cols-2">
                  <ShipmentSelectField label="Destination Country" required value={addressForm.countryCode} onChange={handleDestinationCountryChange} error={getFieldIssue(currentReviewIssues, ["country is required"])} revealError={submitAttempted} flagCountryCode={addressForm.countryCode}>
                      <option value="" disabled>Select destination country</option>
                      {destinationCountries.map((country) => (
                        <option key={country.code} value={country.code}>
                          {country.name}
                        </option>
                      ))}
                  </ShipmentSelectField>
                  <ShipmentTextField label="Delivery Address Line 1" required value={addressForm.addressLine1} onChange={handleAddressFieldChange("addressLine1")} error={fieldIssues.addressLine1} revealError={submitAttempted} />
                  <ShipmentTextField label="Delivery Address Line 2" value={addressForm.addressLine2} onChange={handleAddressFieldChange("addressLine2")} />
                  <ShipmentTextField label="Delivery Town / City" required value={addressForm.townOrCity} onChange={handleAddressFieldChange("townOrCity")} error={fieldIssues.townOrCity} revealError={submitAttempted} />
                  <ShipmentTextField label="Delivery State / County" value={addressForm.county} onChange={handleAddressFieldChange("county")} />
                  <ShipmentTextField label="Delivery Postcode" required value={addressForm.postcode} onChange={handleAddressFieldChange("postcode")} error={fieldIssues.postcode} revealError={submitAttempted} />
                </div>
              </div>
            </section>

            <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/60 px-4 py-3">
                <div>
                  <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-600">Parcel Details</h2>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    <SourceBadge>From invoice</SourceBadge>
                    <SourceBadge>Account default</SourceBadge>
                  </div>
                </div>
              </div>
              <div className="space-y-3 p-3 sm:p-4">
                <div className="grid items-end gap-3 sm:grid-cols-[minmax(150px,180px)_minmax(0,1fr)]">
                  <label className="block">
                    <ShipmentFieldLabel required>Number of Boxes</ShipmentFieldLabel>
                    <input
                      type="number"
                      min="1"
                      max={maxParcelCount}
                      step="1"
                      value={parcelCountInput}
                      onChange={handleParcelCountChange}
                      onBlur={handleParcelCountBlur}
                      className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 px-3 text-[13px] outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
              <div className="rounded-lg border border-slate-200 bg-slate-50/70 p-2.5">
  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    {/* Summary */}
    <div className="flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[#0D1282]/10 text-[#0D1282]">
         <FiPackage className="h-4 w-4" />
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Total Parcels
          </p>
          <p className="text-base font-bold text-slate-900">
            {parcelForms.length}
          </p>
        </div>
      </div>

      <div className="hidden h-7 w-px bg-slate-200 sm:block" />

      <div className="flex items-center gap-2.5">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[#0D1282]/10 text-[#0D1282]">
           <FaWeight className="h-4 w-4" />
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
            Total Weight
          </p>
          <p className="text-base font-bold text-slate-900">
            {parcelForms
              .reduce((total, parcel) => total + (Number(parcel.weightKg) || 0), 0)
              .toFixed(2)}
            <span className="ml-1 text-[12px] font-semibold text-slate-500">kg</span>
          </p>
        </div>
      </div>
    </div>

    {/* Action */}
    <button
      type="button"
      onClick={removeAllParcels}
      disabled={!parcelForms.length}
      className="inline-flex h-9 items-center justify-center rounded-lg border border-red-200 bg-red-50 px-3 text-[12px] font-semibold text-red-600 transition hover:bg-red-100 hover:border-red-300 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-red-700"
    >
      Remove All Boxes
    </button>
  </div>
</div>
                </div>

                {parcelForms.map((parcel, index) => (
                  <div key={parcel.sequence} style={parcelRenderStyle} className="overflow-hidden rounded-lg border border-slate-200">
                    <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      <span>Parcel {index + 1} of {parcelForms.length}</span>
                       <button
                        type="button"
                        onClick={() => removeParcel(index)}
                         className="inline-flex h-7 w-7 items-center justify-center rounded-md text-red-400 transition hover:bg-red-50 hover:text-red-600"
                      >
                      <FaRegWindowClose/>
                      </button>
                    </div>
                    <div className="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-4">
                      <ShipmentTextField label="Actual Weight KG" required type="number" inputMode="decimal" max={costEstimate?.pricing.routeMaxBoxKg ?? undefined} value={parcel.weightKg} onChange={handleParcelFieldChange(index, "weightKg")} error={getParcelFieldIssue(index, ["weight"])} revealError={submitAttempted} />
                      <ShipmentTextField label="Length CM" required type="number" inputMode="decimal" value={parcel.lengthCm} onChange={handleParcelFieldChange(index, "lengthCm")} error={getParcelFieldIssue(index, ["length"])} revealError={submitAttempted} />
                      <ShipmentTextField label="Width CM" required type="number" inputMode="decimal" value={parcel.widthCm} onChange={handleParcelFieldChange(index, "widthCm")} error={getParcelFieldIssue(index, ["width"])} revealError={submitAttempted} />
                      <ShipmentTextField label="Height CM" required type="number" inputMode="decimal" value={parcel.heightCm} onChange={handleParcelFieldChange(index, "heightCm")} error={getParcelFieldIssue(index, ["height"])} revealError={submitAttempted} />
                      {/* Oversized parcels are accepted, not refused- the sender is told what
                          it will cost before they commit. */}
                      {exceedsStandardParcelSize(parcel) ? (
                        <p className="col-span-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-900">
                          These dimensions exceed the standard parcel size of {standardParcelDimensionsLabel}. This box will be charged on its volumetric weight, so additional charges apply.
                        </p>
                      ) : null}
                      <ShipmentSelectField label="Content Type" required value={parcel.shipmentContentType} onChange={handleParcelFieldChange(index, "shipmentContentType")} error={getParcelFieldIssue(index, ["content type"])} revealError={submitAttempted}>
                          {shipmentContentTypeOptions.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                      </ShipmentSelectField>
                      <ShipmentTextField label="Reference" required tooltip="Can be a company name or a unique identifier of the shipment" value={parcel.shipmentReference1} onChange={handleParcelFieldChange(index, "shipmentReference1")} error={getParcelFieldIssue(index, ["reference"])} revealError={submitAttempted} />
                      {/* One row per distinct good, each with its own HSN code. */}
                      <div className="col-span-full">
                        <ParcelItemsEditor
                          items={parcel.items}
                          onChange={(items: ParcelItem[]) => handleParcelItemsChange(index, items)}
                          parcelLabel={`Parcel ${index + 1}`}
                          revealError={submitAttempted}
                          requireHsnCode={csbType === "CSB_V"}
                        />
                      </div>
                    </div>
                  </div>
                ))}

                <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  Enter the actual parcel contents. Incorrect or mismatched descriptions may result in inspection and additional penalty charges.
                </p>

                <div className="grid max-w-sm gap-3">
                  <ShipmentSelectField label="Service Type" required value={draftCorrectionForm.serviceType} onChange={handleCorrectionFieldChange("serviceType")}>
                      <option value="COURIER">Courier</option>
                      <option value="CARGO">Cargo</option>
                  </ShipmentSelectField>
                </div>
              </div>
            </section>
          </div>

          <aside className="space-y-4 no-scrollbar xl:min-h-0 xl:overflow-y-auto xl:pr-2">
            <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              {draft?.customerType === "INDIVIDUAL" ? (
                <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-900">
                    Payment Received
                  </p>
                  <p className="mt-1 text-xs text-amber-800">
                    This customer pays before the shipment is booked. Record how the
                    money reached the company account.
                  </p>
                <div className="relative mt-3">
  <select
    value={counterMethod}
    onChange={(event) => setCounterMethod(event.target.value as CounterPaymentInput["method"])}
    className="h-10 w-full appearance-none rounded-lg border border-amber-300 bg-white pl-3 pr-9 text-[13px] outline-none focus:border-amber-500"
  >
    <option value="CASH">Cash</option>
    <option value="UPI">UPI</option>
    <option value="BANK_TRANSFER">Bank transfer</option>
    <option value="CARD">Card</option>
    <option value="CHEQUE">Cheque</option>
  </select>
  <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 size-4 text-amber-600" />
</div>
                  <input
                    value={counterReference}
                    onChange={(event) => setCounterReference(event.target.value.toUpperCase())}
                    placeholder="UTR, receipt or cheque number"
                    className="mt-1.5 h-10 w-full rounded-lg border border-amber-300 bg-white px-3 text-[13px] outline-none focus:border-amber-500"
                  />
                </div>
              ) : null}
              {isCurrentCountryPaused ? (
                <div className="mb-3 rounded-xl border border-[#D71313]/20 bg-[#FFF1F1] px-3 py-2 text-xs font-semibold text-[#991B1B]">
                  Bookings for this destination are paused - booking is disabled.
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => void handleCreateLabel()}
                disabled={busy || isCurrentCountryPaused}
                title={isCurrentCountryPaused ? "Booking paused for this destination" : undefined}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-blue-900 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                <FiTruck aria-hidden="true" className="h-4 w-4" />
                {pendingAction === "BOOKING" ? "Creating..." : "Create Shipment"}
              </button>
              {/* Staff-only by virtue of the page: admin and operations are the only
                  roles that reach it, and the server guards the booking route with the
                  same pair. Shown wherever a DPD label would be produced, so the
                  operator can decline one deliberately, and kept on any destination
                  where DPD has already refused. */}
              {dpdLabelDestination || dpdLabelError ? (
                <button
                  type="button"
                  onClick={() => void handleCreateLabel(undefined, true)}
                  disabled={busy || isCurrentCountryPaused}
                  title={isCurrentCountryPaused ? "Booking paused for this destination" : undefined}
                  className="mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-amber-500 bg-amber-50 px-4 text-sm font-semibold text-amber-900 transition hover:bg-amber-100 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-amber-800"
                >
                  {/* <FiTruck aria-hidden="true" className="h-4 w-4" /> */}
                  {pendingAction === "BOOKING_NO_DPD" ? "Creating..." : "Create Shipment Without DPD Label"}
                </button>
              ) : null}
              {/* Sits with the booking action rather than in its own bar: this is
                  where the operator already looks to finish the shipment, and
                  saving for later is the alternative to booking it now. */}
              <button
                type="button"
                onClick={() => void handleSaveDraft()}
                disabled={busy || !draftChanged || draftAutosaveStatus === "saving"}
                className="mt-2 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 transition hover:border-slate-900 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
              >
                <FiSave aria-hidden="true" className="h-4 w-4" />
                {pendingAction === "DRAFT" ? "Saving..." : "Save as Draft"}
              </button>
              {draftAutosaveStatus === "saving" ? (
                <p className="mt-2 text-center text-xs font-semibold text-blue-700">Saving draft...</p>
              ) : draftAutosaveStatus === "failed" ? (
                <p className="mt-2 text-center text-xs font-semibold text-red-700">Autosave failed. Use Save as Draft to retry.</p>
              ) : draftChanged ? (
                <p className="mt-2 text-center text-xs font-semibold text-amber-700">Unsaved changes</p>
              ) : draftAutosaveStatus === "saved" ? (
                <p className="mt-2 text-center text-xs font-semibold text-emerald-700">Draft saved automatically.</p>
              ) : null}
              <ShipmentCostEstimatePanel
                estimate={costEstimate}
                loading={costEstimateLoading}
                error={costEstimateError}
                serviceType={draftCorrectionForm.serviceType}
                countryCode={addressForm.countryCode}
                countryName={addressForm.countryName}
                forceGst={forceGst}
                onForceGstChange={setForceGst}
                busy={busy}
              />
              <div className="mt-4 rounded-xl border border-red-400 bg-amber-50 p-3">
                <h3 className="text-sm font-semibold text-amber-900">Prohibited Items Reminder</h3>
                <ul className="mt-2 text-xs font-medium text-amber-800">
                  {prohibitedItems.map((item) => (
                    <li key={item}>- {item}</li>
                  ))}
                </ul>
              </div>
            </section>

            {result ? (
              <section className="overflow-hidden rounded-2xl border border-emerald-200 bg-emerald-50 shadow-sm">
                <div className="flex items-start gap-3 border-b border-emerald-200 px-4 py-4">
                  <FiCheckCircle aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700" />
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-emerald-950">Shipment Booked</h2>
                    <p className="mt-1 text-sm text-emerald-800">
                      {result.reused ? "This shipment was already booked. Its documents are ready below." : "The shipment, invoice, and parcel labels are ready."}
                    </p>
                  </div>
                </div>
                {/* <dl className="grid gap-px bg-emerald-200 sm:grid-cols-2">
                  <ResultValue className="sm:col-span-2" label="AWB / Tracking No." value={result.bookingConfirmation?.swiftlineTrackingNumber ?? result.dpdShipment.swiftlineTrackingNumber} />
                  <ResultValue className="sm:col-span-2" label="Carrier Shipment" value={result.bookingConfirmation?.carrierShipmentId ?? result.dpdShipment.dpdShipmentId} />
                  <ResultValue label="Parcels" value={result.bookingConfirmation
                    ? `${result.bookingConfirmation.parcelCount} / ${result.bookingConfirmation.totalActualWeightKg.toFixed(2)} kg`
                    : String(result.dpdShipment.parcelNumbers.length)} />
                  <ResultValue label="Total Charge" value={result.bookingConfirmation ? formatMoney(result.bookingConfirmation.totalAmountMinor / 100) : result.shipmentInvoice ? formatMoney(result.shipmentInvoice.totalAmountMinor / 100) : "Pending"} />
                  <ResultValue label="Swiftline Tax Invoice No." value={result.shipmentInvoice?.invoiceNumber ?? "Tax Invoice Pending"} />
                  <ResultValue
                    label="Funding"
                    value={result.bookingConfirmation
                      ? `Advance ${formatMoney(result.bookingConfirmation.advanceAmountMinor / 100)} / Credit ${formatMoney(result.bookingConfirmation.creditAmountMinor / 100)}`
                      : "Pending"}
                  />
                </dl> */}

                <div className="bg-white">
                  <ShipmentLabelsPanel
                    labels={result.labels}
                    compact
                    getAccessUrl={(labelId, disposition) => getDpdLabelAccessUrl(result.dpdShipment.id, labelId, disposition)}
                  />
                </div>
                {draft.customerType === "INDIVIDUAL" ? null : (
                  <p className="border-t border-emerald-200 bg-emerald-50 px-4 py-3 text-xs font-medium text-emerald-900">
                    The next shipment will use this shipment&apos;s same business account and sender branch.
                  </p>
                )}
                <div className="grid gap-2 border-t border-emerald-200 p-4 sm:grid-cols-3">
                  <Link
                    href={`/dashboard/shipments/${draft._id}`}
                    className="inline-flex h-11 items-center justify-center text-center gap-2 rounded-xl border border-emerald-300 bg-white px-3 text-xs py-1 font-semibold text-emerald-800 transition hover:border-emerald-600"
                  >
                    Open Shipment
                  </Link>
                  {result.shipmentInvoice ? (
                    <Link
                      href={`/dashboard/shipments/${draft._id}/invoice`}
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-emerald-300 bg-white px-3 text-xs py-1 font-semibold text-emerald-800 transition hover:border-emerald-600"
                    >
                      View Invoice
                    </Link>
                  ) : null}
                  {draft.customerType === "INDIVIDUAL" ? (
                    <Link
                      href="/dashboard/dpd-labels"
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-emerald-300 bg-white px-3 text-xs py-1 font-semibold text-emerald-800 transition hover:border-emerald-600"
                    >
                      Create New Shipment
                    </Link>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleCreateNewShipment()}
                      disabled={busy || creatingNewShipment}
                      title="Create a blank shipment for the same business account and sender branch"
                      className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-emerald-300 bg-white px-3 py-1 text-xs font-semibold text-emerald-800 transition hover:border-emerald-600 disabled:cursor-not-allowed disabled:border-emerald-200 disabled:text-emerald-400"
                    >
                      {creatingNewShipment ? "Creating..." : "Create New Shipment"}
                    </button>
                  )}
                </div>
              </section>
            ) : null}

          </aside>
        </div>
      )}

      {priceChange ? (
        <ShipmentPriceChangeDialog
          previousPricing={costEstimate?.pricing ?? null}
          currentPricing={priceChange.pricing}
          message={priceChange.message}
          busy={busy}
          onAccept={() => void handleAcceptChangedPrice()}
          onCancel={() => {
            setPriceChange(null);
            refreshCostEstimate();
          }}
        />
      ) : null}
    </div>
  );
}
