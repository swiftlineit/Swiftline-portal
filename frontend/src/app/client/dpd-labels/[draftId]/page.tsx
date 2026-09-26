"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ChangeEvent, type ReactNode, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { FiArrowLeft, FiMapPin, FiSave, FiSearch, FiTruck,FiPackage } from "react-icons/fi";
import { FaRegWindowClose, FaWeight } from "react-icons/fa";
import { toast } from "react-toastify";
import { exceedsStandardParcelSize, standardParcelDimensionsLabel } from "@/lib/shipmentPricing";
import {
  ClientDashboardLoading,
  ClientShellUser
} from "@/components/client/ClientDashboardShell";
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
import { CsbVBookingFields } from "@/components/shipments/CsbVBookingFields";
import { ShipmentConsigneeStateFields } from "@/components/shipments/ShipmentConsigneeStateFields";
import { apiUrl } from "@/lib/api";
import { getAccessToken, logout, refreshAccessToken } from "@/lib/auth";
import {
  autocompleteClientAddress,
  autocompleteClientConsignorAddress,
  confirmClientAddress,
  createClientShipment,
  deleteClientShipmentKycDocument,
  deleteClientShipmentParcelKycDocument,
  getClientConsignorPlaceAddress,
  getClientPlaceAddress,
  getClientShipmentDraft,
  openClientShipmentKycDocument,
  openClientShipmentParcelKycDocument,
  updateClientShipmentDraft,
  uploadClientShipmentKycDocument,
  uploadClientShipmentParcelKycDocument,
  validateClientAddress
} from "@/lib/clientDashboard";
import { getDraftRateCardContext, type ClientCountryRateCard } from "@/lib/countryRateCards";
import { findRestrictedCategories } from "@/lib/restrictedGoods";
import { normalizeCsbType, type CsbType } from "@/lib/csbType";
import { getCsbVBookingIssues, type CsbVBookingDetails } from "@/lib/csbVBooking";
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
  getShipmentMobileError
} from "@/lib/shipmentContactValidation";
import {
  AddressPrediction,
  ShipmentContentType,
  ShipmentDraft,
  type ShipmentDraftPatch,
  ShipmentKycDocuments,
  ShipmentServiceType,
  isDpdLabelDestination,
  shipmentContentTypeOptions,
  type ShipmentImportSummary
} from "@/lib/dpdLabels";
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
import ShipmentCostEstimatePanel from "@/components/shipments/ShipmentCostEstimatePanel";
import ShipmentPriceChangeDialog from "@/components/shipments/ShipmentPriceChangeDialog";
import {
  DpdLabelUnavailableError,
  ShipmentPriceChangedError,
  maxBoxWeightIssue,
  type ShipmentCostEstimateInput
} from "@/lib/shipmentCostEstimate";
import { useShipmentCostEstimate } from "@/lib/useShipmentCostEstimate";
import AddressBookPicker from "@/components/address-book/AddressBookPicker";
import { getAddressBookEntry, prepareAddressBookEntryForShipment, type AddressBookEntryType, type AddressBookSelection } from "@/lib/addressBook";
import BookingPausedNotice from "@/components/booking/BookingPausedNotice";
import { isCountryPaused, listClientBookingPauses, type BookingPause } from "@/lib/bookingPause";

/** The booking-panel action currently running; the two booking values are the
 *  provider each button books with. Null when the page is idle. */
type PendingAction = "BOOKING" | "BOOKING_NO_DPD" | "DRAFT" | "ADDRESS" | null;
const parcelRenderStyle = { contentVisibility: "auto", containIntrinsicSize: "auto 360px" } as const;
type AddressForm = {
  countryCode: string;
  countryName: string;
  addressLine1: string;
  addressLine2: string;
  townOrCity: string;
  county: string;
  stateCode: string;
  postcode: string;
};

type ContactForm = {
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

async function loadCurrentUser() {
  let token = getAccessToken() ?? await refreshAccessToken();
  if (!token) return null;

  let response = await fetch(apiUrl("/api/v1/auth/me"), {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (response.status === 401) {
    token = await refreshAccessToken();
    if (!token) return null;
    response = await fetch(apiUrl("/api/v1/auth/me"), {
      headers: { Authorization: `Bearer ${token}` }
    });
  }

  const data = await response.json();
  return data.success ? data.user as ClientShellUser : null;
}

function createEmptyParcel(sequence: number): ParcelForm {
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

function normalizeParcels(draft: ShipmentDraft): ParcelForm[] {
  const parcels: ShipmentDraft["parcelList"] = draft.parcelList.length
    ? draft.parcelList
    : [{ sequence: 1, weightKg: 0, shipmentContentType: "PARCEL", contentsDescription: "" }];
  return parcels.map((parcel, index) => ({
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

function isParcelEmpty(parcel: ParcelForm) {
  return !parcel.weightKg && !parcel.lengthCm && !parcel.widthCm && !parcel.heightCm
    && parcel.shipmentContentType === "PARCEL"
    && !parcel.contentsDescription && !parcel.shipmentReference1 && !parcel.shipmentReference2
    && !parcel.aadhaarNumber;
}

/**
 * Review-form problems split into blank fields and wrongly filled ones.
 *
 * A blank field is deferrable: it is stored in the draft and blocks only at
 * booking. A wrongly filled one is refused, because a draft that holds data the
 * form rejects cannot be reopened cleanly.
 */
function getReviewIssueDetail(
  addressForm: AddressForm,
  contactForm: ContactForm,
  parcelForms: ParcelForm[],
  csbType: CsbType,
  csbVDetails: CsbVBookingDetails = { gstin: "", accountNumber: "", invoiceNumber: "" }
): ShipmentFormIssues {
  const missing: string[] = [];
  const invalid: string[] = [];

  if (!contactForm.contactName.trim()) missing.push("Contact name is required");
  if (!contactForm.email.trim()) {
    missing.push("Email is required");
  } else {
    const emailError = getShipmentEmailError(contactForm.email);
    if (emailError) invalid.push(emailError);
  }
  if (!contactForm.mobileCountryCode.trim()) missing.push("Mobile country code is required");
  if (!contactForm.mobileNumber.trim()) {
    missing.push("Mobile number is required");
  } else {
    const mobileError = getShipmentMobileError(contactForm.mobileCountryCode, contactForm.mobileNumber);
    if (mobileError) invalid.push(mobileError);
  }
  // The dial code must belong to the destination country (GB goes with +44),
  // so a number that is valid elsewhere still fails here.
  const countryCodeMismatchError = getShipmentMobileCountryMismatchError(addressForm.countryCode, contactForm.mobileCountryCode);
  if (countryCodeMismatchError) invalid.push(countryCodeMismatchError);
  if (!addressForm.countryCode.trim()) missing.push("Country is required");
  if (!addressForm.addressLine1.trim()) missing.push("Address line 1 is required");
  if (!addressForm.townOrCity.trim()) missing.push("Town or city is required");
  if (!addressForm.county.trim()) missing.push("Consignee state is required");
  if (csbType === "CSB_V" && !addressForm.stateCode.trim()) missing.push("Consignee state code is required");
  const csbVIssues = getCsbVBookingIssues(csbVDetails, csbType);
  Object.values(csbVIssues).forEach((issue) => { if (issue) (issue.includes("required") ? missing : invalid).push(issue); });
  if (!addressForm.postcode.trim()) {
    missing.push("Postcode is required");
  } else {
    const postcodeError = getPostcodeError(addressForm.countryCode, addressForm.postcode);
    if (postcodeError) invalid.push(postcodeError);
  }
  if (!parcelForms.length) missing.push("At least one parcel is required");
  if (parcelForms.length > maxParcelCount) invalid.push(`Number of Parcels (PCS) must be ${maxParcelCount} or fewer`);
  parcelForms.forEach((parcel, index) => {
    const label = `Parcel ${index + 1}`;
    const weight = Number(parcel.weightKg);
    if (!parcel.weightKg.trim()) {
      missing.push(`${label}: weight is required`);
    } else if (!Number.isFinite(weight) || weight <= 0) {
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
        if (restricted.length) invalid.push(`${itemLabel}: ${restricted.join(", ")} is a restricted item and cannot be shipped`);
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
function getReviewIssues(
  addressForm: AddressForm,
  contactForm: ContactForm,
  parcelForms: ParcelForm[],
  csbType: CsbType,
  csbVDetails: CsbVBookingDetails
) {
  return allShipmentFormIssues(getReviewIssueDetail(addressForm, contactForm, parcelForms, csbType, csbVDetails));
}

function patternMatches(normalizedIssue: string, pattern: string) {
  // Parcel labels need a trailing boundary so `parcel 1` never matches
  // `parcel 10` (which wrongly painted box 1 red), while `parcel 1 item 2`
  // still matches box 1, as it should.
  if (/^parcel \d+$/.test(pattern)) {
    return new RegExp(`${pattern}(?!\\d)`).test(normalizedIssue);
  }
  return normalizedIssue.includes(pattern);
}

function findIssue(issues: string[], patterns: string[]) {
  return issues.find((issue) => patterns.every((pattern) => patternMatches(issue.toLowerCase(), pattern)));
}

export default function ClientDpdDraftReviewPage() {
  const params = useParams<{ draftId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const addressBookEntryId = searchParams.get("addressBookEntryId") ?? "";
  const appliedAddressBookEntryRef = useRef("");
  const [user, setUser] = useState<ClientShellUser | null>(null);
  const [draft, setDraft] = useState<ShipmentDraft | null>(null);
  const [rates, setRates] = useState<ClientCountryRateCard[]>([]);
  const [addressForm, setAddressForm] = useState<AddressForm>({
    countryCode: "GB",
    countryName: "United Kingdom",
    addressLine1: "",
    addressLine2: "",
    townOrCity: "",
    county: "",
    stateCode: "",
    postcode: ""
  });
  const [contactForm, setContactForm] = useState<ContactForm>({
    companyName: "",
    contactName: "",
    email: "",
    mobileCountryCode: "",
    mobileNumber: "",
    deliveryInstructions: "",
    serviceType: "COURIER",
    serviceCode: ""
  });
  const [consignorForm, setConsignorForm] = useState<ConsignorForm>(createEmptyConsignorForm());
  const [kycUseForAll, setKycUseForAll] = useState(true);
  const [kycDocuments, setKycDocuments] = useState<ShipmentKycDocuments>({});
  const [parcelKyc, setParcelKyc] = useState<Record<number, ShipmentKycDocuments>>({});
  const [parcelForms, setParcelForms] = useState<ParcelForm[]>([createEmptyParcel(1)]);
  const deferredPricingParcels = useDeferredValue(parcelForms);
  const [parcelCountInput, setParcelCountInput] = useState(String(parcelForms.length));

  // Customs route for the shipment. Drafts saved before CSB selection existed
  // read as CSB-IV, matching how the backend prices them.
  const [csbType, setCsbType] = useState<CsbType>("CSB_IV");
  const [csbVDetails, setCsbVDetails] = useState<CsbVBookingDetails>({ gstin: "", accountNumber: "", invoiceNumber: "" });
  // Optional transit cover. Off unless the customer asks for it.
  const [insuranceOptIn, setInsuranceOptIn] = useState(false);
  const [forceGst, setForceGst] = useState(false);
  // Set when the server refuses a booking because the price moved after it was
  // quoted. Holds the new breakdown until the customer accepts or cancels.
  const [priceChange, setPriceChange] = useState<ShipmentPriceChangedError | null>(null);
  // Which button opened the price change dialog, so accepting re-books the same way.
  // Present only on drafts created from an uploaded invoice.
  const [shipmentImport, setShipmentImport] = useState<ShipmentImportSummary | null>(null);
  // Printed as the NOTE block on the shipment (customs) invoice.
  const [declarationNote, setDeclarationNote] = useState(defaultDeclarationNote);
  const [addressQuery, setAddressQuery] = useState("");
  const [predictions, setPredictions] = useState<AddressPrediction[]>([]);
  const [loading, setLoading] = useState(true);
  // Which action is in flight, not merely whether one is. Every action button
  // locks while any of them runs- booking is irreversible, so a second click
  // anywhere must not land- but only the one that was clicked shows progress.
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const busy = pendingAction !== null;
  const [addressBusy, setAddressBusy] = useState(false);
  const [error, setError] = useState("");
  const [bookingPauses, setBookingPauses] = useState<BookingPause[]>([]);
  const [notice, setNotice] = useState("");
  const [, setReviewIssues] = useState<string[]>([]);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [manualAddressConfirmationRequired, setManualAddressConfirmationRequired] = useState(false);
  const [addressBookPicker, setAddressBookPicker] = useState<AddressBookEntryType | null>(null);
  const manualAddressConfirmationRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!manualAddressConfirmationRequired) return;

    manualAddressConfirmationRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }, [manualAddressConfirmationRequired]);

  const applySavedAddress = useCallback((entry: AddressBookSelection, confirmReplacement: boolean) => {
    const targetHasValues = entry.type === "SENDER"
      ? Boolean(consignorForm.contactName || consignorForm.addressLine1 || consignorForm.postcode)
      : Boolean(contactForm.contactName || addressForm.addressLine1 || addressForm.postcode);
    if (confirmReplacement && targetHasValues && !window.confirm(`Replace the current ${entry.type === "SENDER" ? "sender" : "recipient"} contact and address fields with “${entry.label}”?`)) {
      return false;
    }

    if (entry.type === "SENDER") {
      setConsignorForm((current) => ({
        ...current,
        companyName: entry.companyName,
        contactName: entry.contactName,
        email: entry.email,
        mobileNumber: entry.mobileNumber,
        aadhaarNumber: entry.aadhaarNumber,
        addressLine1: entry.addressLine1,
        addressLine2: entry.addressLine2,
        townOrCity: entry.townOrCity,
        county: entry.county,
        postcode: entry.postcode,
        pickupInstructions: entry.instructions
      }));
    } else {
      setContactForm((current) => ({
        ...current,
        companyName: entry.companyName,
        contactName: entry.contactName,
        email: entry.email,
        mobileCountryCode: entry.mobileCountryCode,
        mobileNumber: entry.mobileNumber,
        deliveryInstructions: entry.instructions
      }));
      setAddressForm({
        countryCode: entry.countryCode,
        countryName: entry.countryName,
        addressLine1: entry.addressLine1,
        addressLine2: entry.addressLine2,
        townOrCity: entry.townOrCity,
        county: entry.county,
        stateCode: "",
        postcode: entry.postcode
      });
      setAddressQuery(entry.postcode);
      setPredictions([]);
      setManualAddressConfirmationRequired(false);
    }
    setReviewIssues([]);
    setAddressBookPicker(null);
    toast.success(`${entry.label} added to this shipment draft.`);
    return true;
  }, [addressForm.addressLine1, addressForm.postcode, consignorForm.addressLine1, consignorForm.contactName, consignorForm.postcode, contactForm.contactName]);

  const currentReviewIssues = useMemo(
    () => getReviewIssues(addressForm, contactForm, parcelForms, csbType, csbVDetails),
    [addressForm, contactForm, csbType, csbVDetails, parcelForms]
  );

  const consignorChanged = useMemo(
    () => (draft
      ? !consignorFormsMatch(consignorForm, draft.consignorAddress)
        || kycUseForAll !== (draft.kycUseForAllParcels ?? true)
      : false),
    [consignorForm, draft, kycUseForAll]
  );
  const consignorReviewIssues = useMemo(
    () => getConsignorFormIssues(consignorForm, consigneeContactFrom(contactForm)),
    [consignorForm, contactForm]
  );
  const consignorFieldIssues = useMemo(() => ({
    contactName: findIssue(consignorReviewIssues, ["consignor contact name"]) ?? findIssue(consignorReviewIssues, ["contact names must"]),
    email: findIssue(consignorReviewIssues, ["consignor email"]) ?? findIssue(consignorReviewIssues, ["email addresses must"]),
    mobileNumber: findIssue(consignorReviewIssues, ["consignor mobile"]) ?? findIssue(consignorReviewIssues, ["mobile numbers must"]),
    aadhaarNumber: findIssue(consignorReviewIssues, ["aadhaar"]),
    addressLine1: findIssue(consignorReviewIssues, ["consignor address line 1"]),
    townOrCity: findIssue(consignorReviewIssues, ["consignor town"]),
    county: findIssue(consignorReviewIssues, ["consignor state"]),
    postcode: findIssue(consignorReviewIssues, ["pin code"])
  }), [consignorReviewIssues]);

  const consignorKycApi = useMemo(() => ({
    autocompleteConsignorAddress: autocompleteClientConsignorAddress,
    getConsignorPlaceAddress: getClientConsignorPlaceAddress,
    uploadKycDocument: uploadClientShipmentKycDocument,
    deleteKycDocument: deleteClientShipmentKycDocument,
    openKycDocument: openClientShipmentKycDocument,
    uploadParcelKycDocument: uploadClientShipmentParcelKycDocument,
    deleteParcelKycDocument: deleteClientShipmentParcelKycDocument,
    openParcelKycDocument: openClientShipmentParcelKycDocument
  }), []);

  const parcelKycStates = useMemo<ParcelKycState[]>(
    () => parcelForms.map((parcel) => ({
      sequence: parcel.sequence,
      aadhaarNumber: parcel.aadhaarNumber,
      kycDocuments: parcelKyc[parcel.sequence]
    })),
    [parcelForms, parcelKyc]
  );
  const destinationCountries = useMemo(() => {
    const countries = new Map<string, string>();
    rates.forEach((rate) => countries.set(rate.countryCode, rate.countryName));
    if (addressForm.countryCode && addressForm.countryName) {
      countries.set(addressForm.countryCode, addressForm.countryName);
    }
    return [...countries].map(([code, name]) => ({ code, name }));
  }, [addressForm.countryCode, addressForm.countryName, rates]);
  const totalWeight = parcelForms.reduce((total, parcel) => total + (Number(parcel.weightKg) || 0), 0);

  // Priced by the server, not here. The booking charges whatever this returns, so
  // there is deliberately no second implementation in the browser to drift from it.
  const estimateValues = useMemo<ShipmentCostEstimateInput>(() => ({
    countryCode: addressForm.countryCode,
    destinationPostcode: addressForm.postcode,
    serviceType: contactForm.serviceType,
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
  }), [addressForm.countryCode, addressForm.postcode, contactForm.serviceType, csbType, deferredPricingParcels, forceGst, insuranceOptIn]);

  const {
    estimate: costEstimate,
    loading: costEstimateLoading,
    error: costEstimateError,
    refresh: refreshCostEstimate,
    acceptEstimate
  } = useShipmentCostEstimate({
    shipmentDraftId: params.draftId,
    audience: "client",
    values: estimateValues,
    enabled: Boolean(draft)
  });

  const draftPatch = useMemo<ShipmentDraftPatch>(() => ({
    consignorAddress: consignorFormToPatch(consignorForm),
    kycUseForAllParcels: kycUseForAll,
    consigneeEnteredAddress: {
      companyName: contactForm.companyName,
      contactName: contactForm.contactName,
      email: contactForm.email,
      mobileCountryCode: contactForm.mobileCountryCode,
      mobileNumber: contactForm.mobileNumber,
      countryCode: addressForm.countryCode,
      countryName: addressForm.countryName,
      addressLine1: addressForm.addressLine1,
      addressLine2: addressForm.addressLine2,
      townOrCity: addressForm.townOrCity,
      county: addressForm.county,
      stateCode: addressForm.stateCode,
      postcode: addressForm.postcode,
      deliveryInstructions: contactForm.deliveryInstructions
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
    csbVGstin: csbVDetails.gstin,
    csbVAccountNumber: csbVDetails.accountNumber,
    csbVInvoiceNumber: csbVDetails.invoiceNumber,
    insuranceOptIn,
    forceGst,
    declarationNote,
    serviceType: contactForm.serviceType,
    serviceCode: contactForm.serviceCode
  }), [addressForm, consignorForm, contactForm, csbType, csbVDetails, declarationNote, forceGst, insuranceOptIn, kycUseForAll, parcelForms]);

  const draftPatchKey = useMemo(
    () => `${draft?._id ?? "unloaded"}:${JSON.stringify(draftPatch)}`,
    [draft?._id, draftPatch]
  );

  const draftChanged = useMemo(() => {
    if (!draft) return false;
    return consignorChanged
      || insuranceOptIn !== (draft.insuranceOptIn ?? false)
      || forceGst !== (draft.forceGst ?? false)
      || csbType !== normalizeCsbType(draft.csbType)
      || csbVDetails.gstin !== (draft.csbVGstin ?? "")
      || csbVDetails.accountNumber !== (draft.csbVAccountNumber ?? "")
      || csbVDetails.invoiceNumber !== (draft.csbVInvoiceNumber ?? "")
      || declarationNote !== (draft.declarationNote ?? defaultDeclarationNote)
      || JSON.stringify(comparableParcelForms(parcelForms))
        !== JSON.stringify(comparableParcelForms(normalizeParcels(draft)))
      || contactForm.companyName !== (draft.consigneeEnteredAddress.companyName ?? "")
      || contactForm.contactName !== (draft.consigneeEnteredAddress.contactName ?? "")
      || contactForm.email !== (draft.consigneeEnteredAddress.email ?? "")
      || contactForm.mobileCountryCode !== (draft.consigneeEnteredAddress.mobileCountryCode ?? "")
      || contactForm.mobileNumber !== (draft.consigneeEnteredAddress.mobileNumber ?? "")
      || contactForm.deliveryInstructions !== (draft.consigneeEnteredAddress.deliveryInstructions ?? "")
      || contactForm.serviceType !== (draft.serviceType ?? "COURIER")
      || contactForm.serviceCode !== (draft.serviceCode ?? "")
      || addressForm.countryCode !== (draft.consigneeEnteredAddress.countryCode ?? "GB")
      || addressForm.addressLine1 !== (draft.consigneeEnteredAddress.addressLine1 ?? "")
      || addressForm.addressLine2 !== (draft.consigneeEnteredAddress.addressLine2 ?? "")
      || addressForm.townOrCity !== (draft.consigneeEnteredAddress.townOrCity ?? "")
      || addressForm.county !== (draft.consigneeEnteredAddress.county ?? "")
      || addressForm.stateCode !== (draft.consigneeEnteredAddress.stateCode ?? "")
      || addressForm.postcode !== (draft.consigneeEnteredAddress.postcode ?? "");
  }, [addressForm, consignorChanged, contactForm, csbType, csbVDetails, declarationNote, draft, forceGst, insuranceOptIn, parcelForms]);

  const {
    status: draftAutosaveStatus,
    flush: flushDraftChanges
  } = useShipmentDraftAutosave({
    enabled: Boolean(draft && draftChanged && !busy && !addressBusy),
    changeKey: draftPatchKey,
    patch: draftPatch,
    save: async (patch) => {
      if (!draft) throw new Error("Shipment draft is not loaded.");
      const data = await updateClientShipmentDraft(draft._id, patch);
      return data.shipmentDraft;
    },
    onSaved: (nextDraft, isLatest) => {
      // A response for an older edit advances the server baseline without
      // replacing newer text that is still on screen.
      if (isLatest) syncDraft(nextDraft, true);
      else setDraft(nextDraft);
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

  function syncDraft(nextDraft: ShipmentDraft, preserveLocalItemRows = false) {
    const address = nextDraft.consigneeEnteredAddress;
    setDraft(nextDraft);
    setAddressForm({
      countryCode: address.countryCode ?? "GB",
      countryName: address.countryName ?? getCountryName(address.countryCode ?? "GB"),
      addressLine1: address.addressLine1 ?? "",
      addressLine2: address.addressLine2 ?? "",
      townOrCity: address.townOrCity ?? "",
      county: address.county ?? "",
      stateCode: address.stateCode ?? "",
      postcode: address.postcode ?? ""
    });
    setAddressQuery(address.postcode ?? "");
    setContactForm({
      companyName: address.companyName ?? "",
      contactName: address.contactName ?? "",
      email: address.email ?? "",
      mobileCountryCode: address.mobileCountryCode ?? "",
      mobileNumber: address.mobileNumber ?? "",
      deliveryInstructions: address.deliveryInstructions ?? "",
      serviceType: nextDraft.serviceType ?? "COURIER",
      serviceCode: nextDraft.serviceCode ?? ""
    });
    setCsbType(normalizeCsbType(nextDraft.csbType));
    setCsbVDetails({ gstin: nextDraft.csbVGstin ?? "", accountNumber: nextDraft.csbVAccountNumber ?? "", invoiceNumber: nextDraft.csbVInvoiceNumber ?? "" });
    setInsuranceOptIn(nextDraft.insuranceOptIn ?? false);
    setForceGst(nextDraft.forceGst ?? false);
    setDeclarationNote(nextDraft.declarationNote ?? defaultDeclarationNote);
    setConsignorForm(consignorFormFromDraft(nextDraft.consignorAddress));
    setKycUseForAll(nextDraft.kycUseForAllParcels ?? true);
    setKycDocuments(nextDraft.kycDocuments ?? {});
    const parcelKycBySequence: Record<number, ShipmentKycDocuments> = {};
    nextDraft.parcelList.forEach((parcel) => {
      if (parcel.kycDocuments) parcelKycBySequence[parcel.sequence] = parcel.kycDocuments;
    });
    setParcelKyc(parcelKycBySequence);
    const nextParcels = normalizeParcels(nextDraft);
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
  }

  useEffect(() => {
    let mounted = true;

    async function loadDraft() {
      setLoading(true);
      setError("");

      try {
        const currentUser = await loadCurrentUser();
        if (!currentUser) {
          await logout();
          router.replace("/");
          return;
        }

        if (currentUser.role !== "client") {
          router.replace("/dashboard");
          return;
        }

        const [data, rateData] = await Promise.all([
          getClientShipmentDraft(params.draftId),
          getDraftRateCardContext(params.draftId, "client")
        ]);
        if (!mounted) return;

        if (data.shipmentDraft.bookingState && data.shipmentDraft.bookingState !== "EDITABLE") {
          toast.info("This shipment is already locked for booking. Opening its shipment details.");
          router.replace(`/client/shipments/${data.shipmentDraft._id}`);
          return;
        }

        setUser(currentUser);
        setRates(rateData.rates);
        setShipmentImport(data.shipmentImport ?? null);
        syncDraft(data.shipmentDraft);
      } catch (caughtError) {
        if (!mounted) return;
        setError(caughtError instanceof Error ? caughtError.message : "Unable to load shipment draft.");
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void loadDraft();
    return () => {
      mounted = false;
    };
  }, [params.draftId, router]);

  useEffect(() => {
    let active = true;
    async function loadPauses() {
      try {
        const data = await listClientBookingPauses();
        if (!active) return;
        setBookingPauses(data.pauses);
      } catch { /* non-blocking */ }
    }
    void loadPauses();
    const id = window.setInterval(() => void loadPauses(), 60_000);
    return () => { active = false; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    if (!draft || !addressBookEntryId || appliedAddressBookEntryRef.current === addressBookEntryId) return;
    appliedAddressBookEntryRef.current = addressBookEntryId;
    void getAddressBookEntry(addressBookEntryId)
      .then(({ entry }) => prepareAddressBookEntryForShipment(entry))
      .then((entry) => applySavedAddress(entry, false))
      .catch((caught) => toast.error(caught instanceof Error ? caught.message : "The saved address could not be applied."));
  }, [addressBookEntryId, applySavedAddress, draft]);

  function handleContactChange(field: keyof ContactForm) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      const preserveCase = field === "email" || field === "serviceType" || field === "serviceCode";
      const nextValue = preserveCase ? event.target.value : event.target.value.toUpperCase();
      setContactForm((current) => (
        field === "companyName"
          ? { ...current, companyName: nextValue, contactName: nextContactNameOnCompanyChange(current.companyName, current.contactName, nextValue) }
          : { ...current, [field]: nextValue }
      ));
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
      countryName,
      stateCode: ""
    }));
    // Keep the consignee dial code on the destination's code (a UK destination
    // gets +44): a code from another country is invalid for this lane anyway.
    const dialCode = getDialCodeForCountryCode(countryCode);
    if (dialCode) {
      setContactForm((current) => (
        current.mobileCountryCode === dialCode ? current : { ...current, mobileCountryCode: dialCode }
      ));
    }
    setManualAddressConfirmationRequired(false);
    setReviewIssues([]);
  }

  function handleAddressChange(field: keyof AddressForm) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      setAddressForm((current) => ({
        ...current,
        [field]: event.target.value.toUpperCase()
      }));
      if (field === "postcode") setAddressQuery(event.target.value.toUpperCase());
      setManualAddressConfirmationRequired(false);
      setReviewIssues([]);
    };
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
      const data = await autocompleteClientAddress(addressQuery);
      setPredictions(data.predictions);
    } catch (caughtError) {
      setPredictions([]);
      setError(caughtError instanceof Error ? caughtError.message : "No matching UK address was found.");
    } finally {
      setAddressBusy(false);
    }
  }

  async function handleSelectPrediction(prediction: AddressPrediction) {
    setAddressBusy(true);
    setError("");
    setReviewIssues([]);

    try {
      const data = await getClientPlaceAddress(prediction.placeId, draft?._id);
      setAddressForm((current) => ({
        countryCode: current.countryCode,
        countryName: current.countryName,
        addressLine1: (data.place.address.addressLine1 || current.addressLine1).toUpperCase(),
        addressLine2: (data.place.address.addressLine2 || current.addressLine2).toUpperCase(),
        townOrCity: (data.place.address.townOrCity || current.townOrCity).toUpperCase(),
        county: (data.place.address.county || current.county).toUpperCase(),
        stateCode: current.stateCode,
        postcode: (data.place.address.postcode || current.postcode).toUpperCase()
      }));
      setAddressQuery((data.place.address.postcode || prediction.mainText || prediction.text).toUpperCase());
      setPredictions([]);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Unable to select address.");
    } finally {
      setAddressBusy(false);
    }
  }

  function handleParcelChange(index: number, field: keyof Omit<ParcelForm, "sequence">) {
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
          ...Array.from({ length: nextCount - current.length }, (_, index) => createEmptyParcel(current.length + index + 1))
        ];
      }

      const removedParcels = current.slice(nextCount);
      if (removedParcels.some((parcel) => !isParcelEmpty(parcel))) {
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
      const shouldConfirm = !isParcelEmpty(removedParcel) || current.length > 1;
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

  async function saveDraftChanges() {
    if (!draft) return null;
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

    const { invalid } = mergeShipmentFormIssues(
      getReviewIssueDetail(addressForm, contactForm, parcelForms, csbType, csbVDetails),
      getConsignorFormIssueDetail(consignorForm, consigneeContactFrom(contactForm))
    );
    if (invalid.length) {
      setSubmitAttempted(true);
      setReviewIssues(invalid);
      setError(`Correct this before saving: ${invalid[0]}`);
      toast.error(`Correct this before saving: ${invalid[0]}`);
      return false;
    }

    setPendingAction("DRAFT");
    setError("");
    setNotice("");
    setReviewIssues([]);

    try {
      await saveDraftChanges();
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

  const currentCountryCode = draft?.consigneeEnteredAddress?.countryCode || addressForm.countryCode || "";
  const isCurrentCountryPaused = isCountryPaused(currentCountryCode, bookingPauses);
  const dpdLabelDestination = isDpdLabelDestination(addressForm.countryCode);

  async function handleCreateLabel(
    // Supplied when re-booking after the customer accepted a changed price.
    acceptedPricingHash = costEstimate?.pricingHash,
    // Set by the explicit "without DPD label" action.
    skipDpdLabel = false
  ) {
    if (!draft) return;

    if (isCountryPaused(draft.consigneeEnteredAddress?.countryCode || addressForm.countryCode, bookingPauses)) {
      const msg = "Bookings for this destination are temporarily paused. Please check the booking pause notice for details.";
      setError(msg);
      toast.error(msg);
      return;
    }

    const issues = [
      ...getReviewIssues(addressForm, contactForm, parcelForms, csbType, csbVDetails),
      ...getConsignorFormIssues(consignorForm, consigneeContactFrom(contactForm)),
      ...getKycIssues({
        csbType,
        useForAll: kycUseForAll,
        sharedAadhaar: consignorForm.aadhaarNumber,
        sharedDocuments: kycDocuments,
        parcels: parcelKycStates
      })
    ];
    if (issues.length) {
      setSubmitAttempted(true);
      setReviewIssues(issues);
      setError("Correct the highlighted details before creating a label.");
      toast.error(issues[0]);
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
      const message = `Rates are not available for ${addressForm.countryName || addressForm.countryCode} with ${contactForm.serviceType === "CARGO" ? "Cargo" : "Courier"} service. Please contact your assigned branch to arrange this shipment.`;
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

    setPendingAction(skipDpdLabel ? "BOOKING_NO_DPD" : "BOOKING");
    setError("");
    setNotice("");
    setReviewIssues([]);

    try {
      const currentDraft = draftChanged ? await saveDraftChanges() : draft;
      if (!currentDraft) return;

      if (currentDraft.addressValidationStatus !== "VALIDATED") {
        const addressValidation = await validateClientAddress({
          shipmentDraftId: currentDraft._id,
          address: addressForm
        });

        if (addressValidation.validation.outcome !== "VALID") {
          setManualAddressConfirmationRequired(true);
          toast.info("No automatic address match was found. Review the address and confirm it as entered.");
          return;
        }
      }

      const result = await createClientShipment(currentDraft._id, acceptedPricingHash, skipDpdLabel);
      setPriceChange(null);
      setNotice(result.reused ? "Existing shipment label found for this draft." : "Shipment request created.");
      toast.success(result.reused ? "Existing booked shipment opened." : "Shipment booked successfully.");
      router.push(`/client/shipments/${currentDraft._id}`);
    } catch (caughtError) {
      // Nothing was booked or reserved. The customer is shown what moved and has
      // to accept the new price explicitly before this can be retried.
      if (caughtError instanceof ShipmentPriceChangedError) {
        setPriceChange(caughtError);
        return;
      }

      // Nothing was booked: no charge, no invoice, no tracking number consumed.
      // The no-DPD option is always available for DPD destinations, so this
      // error only reports the failed labelled-booking attempt.
      if (caughtError instanceof DpdLabelUnavailableError) {
        const detail = caughtError.carrierErrors.length
          ? `${caughtError.message} ${caughtError.carrierErrors.join(" ")}`
          : caughtError.message;
        setError(detail);
        toast.error(detail);
        return;
      }

      const message = caughtError instanceof Error ? caughtError.message : "Unable to create shipment.";
      toast.error(message);
    } finally {
      setPendingAction(null);
    }
  }

  /** Re-books at the price the customer has just been shown and accepted. */
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
      const data = await confirmClientAddress({
        shipmentDraftId: draft._id,
        decision: "KEEP_ENTERED"
      });
      syncDraft(data.shipmentDraft);
      setManualAddressConfirmationRequired(false);
      toast.success("Address confirmed. You can now create the shipment.");
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Address could not be confirmed.");
    } finally {
      setPendingAction(null);
    }
  }

  if (loading || !user) return <ClientDashboardLoading />;

  return (
      <div className="lg:flex lg:h-full lg:min-h-0 lg:flex-col">
        {/* <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold text-slate-950">Review Shipment Draft</h1>
            <p className="mt-1 text-sm text-slate-500">Review consignee, address, and parcel details before shipment creation is enabled.</p>
          </div>
          </div> */}

        {error ? (
          <div className="mb-5 border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div>
        ) : null}

        <div className="mb-5">
          <BookingPausedNotice variant="client" pauses={bookingPauses} countryCode={currentCountryCode} />
        </div>

        {notice ? (
          <div className="mb-5 border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-900">{notice}</div>
        ) : null}

        {!draft ? (
          <div className="border border-slate-200 bg-white p-6 text-sm font-semibold text-slate-500">Draft not found.</div>
        ) : (
          <div className="grid gap-5 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-5 no-scrollbar lg:min-h-0 lg:overflow-y-auto lg:pr-2">
              <ShipmentImportBanner summary={shipmentImport} />

              {/* Customs route, first because CSB-V changes what is charged. */}
              <section className="border border-slate-200 bg-white rounded-2xl">
                <SectionHeader title="Shipment Type" />
                <div className="p-4">
                  <ShipmentCsbTypeField
                    value={csbType}
                    onChange={(next: CsbType) => { setCsbType(next); setReviewIssues([]); }}
                  />
                  {csbType === "CSB_V" ? (
                    <div className="mt-4">
                      <CsbVBookingFields
                        value={csbVDetails}
                        onChange={(next) => { setCsbVDetails(next); setReviewIssues([]); }}
                        issues={getCsbVBookingIssues(csbVDetails, csbType)}
                        revealError={submitAttempted}
                      />
                    </div>
                  ) : null}
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
                headerAction={(
                  <button type="button" onClick={() => setAddressBookPicker("SENDER")} className="inline-flex h-9 items-center gap-2 rounded-xl border border-[#0D1282]/25 bg-white px-3 text-xs font-semibold text-[#0D1282] hover:border-[#0D1282]">
                    <FiMapPin className="h-4 w-4" /> Choose Saved Sender
                  </button>
                )}
              />

              <section className="border border-slate-200 bg-white rounded-2xl">
                <SectionHeader title="Consignee Details" action={(
                  <button type="button" onClick={() => setAddressBookPicker("RECIPIENT")} className="inline-flex h-9 items-center gap-2 rounded-xl border border-[#0D1282]/25 bg-white px-3 text-xs font-semibold text-[#0D1282] hover:border-[#0D1282]">
                    <FiMapPin className="h-4 w-4" /> Choose Saved Recipient
                  </button>
                )} />
                <div className="grid gap-4 p-4 md:grid-cols-2">
                  <ShipmentTextField label="Consignee Company" value={contactForm.companyName} onChange={handleContactChange("companyName")} />
                  <ShipmentTextField label="Consignee Contact Name" required value={contactForm.contactName} onChange={handleContactChange("contactName")} error={findIssue(currentReviewIssues, ["contact name"])} revealError={submitAttempted} />
                  <ShipmentTextField label="Consignee Email" required type="email" value={contactForm.email} onChange={handleContactChange("email")} error={findIssue(currentReviewIssues, ["email"])} revealError={submitAttempted} />
                  <div className="grid gap-4 sm:grid-cols-2">
                    <ShipmentPhoneCodeField
                      value={contactForm.mobileCountryCode}
                      onChange={(value) => {
                        setContactForm((current) => ({ ...current, mobileCountryCode: value }));
                        setReviewIssues([]);
                      }}
                      error={findIssue(currentReviewIssues, ["mobile country code"])}
                      revealError={submitAttempted}
                    />
                    <ShipmentTextField label="Mobile Number" required type="tel" inputMode="tel" value={contactForm.mobileNumber} onChange={handleContactChange("mobileNumber")} error={findIssue(currentReviewIssues, ["mobile number"])} revealError={submitAttempted} />
                  </div>
                  <label className="block md:col-span-2">
                    <ShipmentFieldLabel>Delivery Instructions</ShipmentFieldLabel>
                    <textarea
                      value={contactForm.deliveryInstructions}
                      onChange={handleContactChange("deliveryInstructions")}
                      rows={3}
                      className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] outline-none focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                    />
                  </label>
                </div>
              </section>

              <section className="border border-slate-200 bg-white rounded-2xl">
                <SectionHeader title="Address" />
                <div className="space-y-4 p-4">
                  {addressForm.countryCode === "GB" ? <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
                    <label className="block">
                      <ShipmentFieldLabel>UK Postcode Search</ShipmentFieldLabel>
                      <input
                        value={addressQuery}
                        onChange={(event) => setAddressQuery(event.target.value.toUpperCase())}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            void handleAddressSearch();
                          }
                        }}
                        placeholder="POST CODE AB10 6DN"
                        className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 px-3 text-[13px] outline-none focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={handleAddressSearch}
                      disabled={addressBusy}
                      className="mt-6 inline-flex h-10 items-center justify-center gap-2 bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                      <FiSearch aria-hidden="true" className="h-4 w-4" />
                      Search
                    </button>
                  </div> : null}

                  {predictions.length ? (
                    <div className="max-h-85 overflow-y-auto border border-slate-200 scrollbar-thin [scrollbar-color:#94a3b8_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400">
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
                    <div ref={manualAddressConfirmationRef} className="flex scroll-mt-8 flex-wrap items-center justify-between gap-3 border border-amber-300 bg-amber-50 px-4 py-3">
                      <div>
                        <p className="text-sm font-semibold text-amber-950">No automatic address match was found.</p>
                        <p className="mt-1 text-sm text-amber-800">Review the delivery address below before confirming it as entered.</p>
                      </div>
                      <button type="button" onClick={handleConfirmEnteredAddress} disabled={busy} className="inline-flex h-10 items-center rounded-4xl justify-center bg-amber-700 px-4 text-sm font-semibold text-white hover:bg-amber-800 disabled:cursor-not-allowed disabled:bg-amber-400">
                        Use Address As Entered
                      </button>
                    </div>
                  ) : null}

                  <div className="grid gap-4 md:grid-cols-2">
                    <ShipmentSelectField label="Destination Country" required value={addressForm.countryCode} onChange={handleDestinationCountryChange} error={findIssue(currentReviewIssues, ["country is required"])} revealError={submitAttempted} flagCountryCode={addressForm.countryCode}>
                      <option value="" disabled>Select destination country</option>
                      {destinationCountries.map((country) => (
                          <option key={country.code} value={country.code}>
                            {country.name}
                          </option>
                        ))}
                    </ShipmentSelectField>
                    <ShipmentTextField label="Delivery Address Line 1" required value={addressForm.addressLine1} onChange={handleAddressChange("addressLine1")} error={findIssue(currentReviewIssues, ["address line 1"])} revealError={submitAttempted} />
                    <ShipmentTextField label="Delivery Address Line 2" value={addressForm.addressLine2} onChange={handleAddressChange("addressLine2")} />
                    <ShipmentTextField label="Delivery Town / City" required value={addressForm.townOrCity} onChange={handleAddressChange("townOrCity")} error={findIssue(currentReviewIssues, ["town or city"])} revealError={submitAttempted} />
                    <ShipmentConsigneeStateFields
                      countryName={addressForm.countryName}
                      state={addressForm.county}
                      stateCode={addressForm.stateCode}
                      onStateChange={(value) => setAddressForm((current) => ({ ...current, county: value }))}
                      onStateCodeChange={(value) => setAddressForm((current) => ({ ...current, stateCode: value }))}
                      requiredStateCode={csbType === "CSB_V"}
                      stateError={findIssue(currentReviewIssues, ["consignee state is"])}
                      stateCodeError={findIssue(currentReviewIssues, ["state code"])}
                      revealError={submitAttempted}
                    />
                    <ShipmentTextField label="Delivery Postcode" required value={addressForm.postcode} onChange={handleAddressChange("postcode")} error={findIssue(currentReviewIssues, ["postcode"])} revealError={submitAttempted} />
                  </div>
                </div>
              </section>

              <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <SectionHeader title="Parcel Details" />
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
                        className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 px-3 text-[13px] outline-none focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
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
            Total Boxes
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
            {totalWeight.toFixed(2)} kg
          </p>
        </div>
      </div>
    </div>

    {/* Action */}
    <button
      type="button"
      onClick={removeAllParcels}
      disabled={!parcelForms.length}
      className="inline-flex h-9 items-center justify-center rounded-lg border border-red-200 bg-red-50 px-3 text-[12px] font-semibold text-red-600 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-red-700"
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
                        <ShipmentTextField label="Actual Weight KG" required type="number" inputMode="decimal" max={costEstimate?.pricing.routeMaxBoxKg ?? undefined} value={parcel.weightKg} onChange={handleParcelChange(index, "weightKg")} error={findIssue(currentReviewIssues, [`parcel ${index + 1}`, "weight"])} revealError={submitAttempted} />
                        <ShipmentTextField label="Length CM" required type="number" inputMode="decimal" value={parcel.lengthCm} onChange={handleParcelChange(index, "lengthCm")} error={findIssue(currentReviewIssues, [`parcel ${index + 1}`, "length"])} revealError={submitAttempted} />
                        <ShipmentTextField label="Width CM" required type="number" inputMode="decimal" value={parcel.widthCm} onChange={handleParcelChange(index, "widthCm")} error={findIssue(currentReviewIssues, [`parcel ${index + 1}`, "width"])} revealError={submitAttempted} />
                        <ShipmentTextField label="Height CM" required type="number" inputMode="decimal" value={parcel.heightCm} onChange={handleParcelChange(index, "heightCm")} error={findIssue(currentReviewIssues, [`parcel ${index + 1}`, "height"])} revealError={submitAttempted} />
                        {/* Oversized parcels are accepted, not refused- the sender is told what
                            it will cost before they commit. */}
                        {exceedsStandardParcelSize(parcel) ? (
                          <p className="col-span-full rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] font-medium text-amber-900">
                            These dimensions exceed the standard parcel size of {standardParcelDimensionsLabel}. This box will be charged on its volumetric weight, so additional charges apply.
                          </p>
                        ) : null}
                        <ShipmentSelectField label="Content Type" required value={parcel.shipmentContentType} onChange={handleParcelChange(index, "shipmentContentType")} error={findIssue(currentReviewIssues, [`parcel ${index + 1}`, "content type"])} revealError={submitAttempted}>
                            {shipmentContentTypeOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                        </ShipmentSelectField>
                        <ShipmentTextField label="Reference" required tooltip="Can be a company name or a unique identifier of the shipment" value={parcel.shipmentReference1} onChange={handleParcelChange(index, "shipmentReference1")} error={findIssue(currentReviewIssues, [`parcel ${index + 1}`, "reference"])} revealError={submitAttempted} />
                        {/* One row per distinct good, each with its own HSN code. */}
                        <div className="col-span-full">
                          <ParcelItemsEditor
                            items={parcel.items}
                            onChange={(items) => handleParcelItemsChange(index, items)}
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
                    <ShipmentSelectField label="Service Type" required value={contactForm.serviceType} onChange={handleContactChange("serviceType")}>
                        <option value="COURIER"> Swiftline Courier</option>
                        <option value="CARGO"> Swiftline Cargo</option>
                    </ShipmentSelectField>
                  </div>
                </div>
              </section>
            </div>

            <aside className="space-y-4 no-scrollbar lg:min-h-0 lg:overflow-y-auto lg:pr-2">
              <section className="border border-slate-200 bg-white p-4 rounded-2xl">
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
                  className="inline-flex h-10 w-full rounded-xl items-center justify-center gap-2 bg-blue-900 px-4 text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                >
                  <FiTruck aria-hidden="true" className="h-4 w-4" />
                  {pendingAction === "BOOKING" ? "Processing..." : "Create Shipment"}
                </button>
                {/* Available as an explicit alternative for destinations where DPD labels apply. */}
                {dpdLabelDestination ? (
                  <button
                    type="button"
                    onClick={() => void handleCreateLabel(undefined, true)}
                    disabled={busy || isCurrentCountryPaused}
                    title={isCurrentCountryPaused ? "Booking paused for this destination" : undefined}
                    className="mt-2 inline-flex h-10 w-full rounded-xl items-center justify-center gap-2 border border-amber-500 bg-amber-50 px-4 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-not-allowed disabled:border-slate-300 disabled:text-amber-800"
                  >
                    {/* <FiTruck aria-hidden="true" className="h-4 w-4" /> */}
                    {pendingAction === "BOOKING_NO_DPD" ? "Processing..." : "Create Shipment Without DPD Label"}
                  </button>
                ) : null}
                {/* Sits with the booking action rather than in its own bar: this
                    is where the customer already looks to finish the shipment, and
                    saving for later is the alternative to booking it now. */}
                <button
                  type="button"
                  onClick={() => void handleSaveDraft()}
                  disabled={busy || !draftChanged || draftAutosaveStatus === "saving"}
                  className="mt-2 inline-flex rounded-xl h-10 w-full items-center justify-center gap-2 border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 hover:border-slate-900 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
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
                  serviceType={contactForm.serviceType}
                  countryCode={addressForm.countryCode}
                  countryName={addressForm.countryName}
                  forceGst={forceGst}
                  onForceGstChange={setForceGst}
                  busy={busy}
                />
                <div className="mt-4 border border-red-400 bg-amber-50 p-3 rounded-2xl">
 <h3 className="text-sm font-semibold text-amber-900 ">Prohibited Items Reminder</h3>
                <ul className="mt-2 text-xs font-medium text-amber-800">
                    {prohibitedItems.map((item) => (
                      <li key={item}>- {item}</li>
                    ))}
                  </ul>
                </div>
              </section>
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

        {draft && addressBookPicker ? (
          <AddressBookPicker
            open
            businessAccountId={draft.businessAccountId}
            type={addressBookPicker}
            onClose={() => setAddressBookPicker(null)}
            onSelect={(entry) => { applySavedAddress(entry, true); }}
          />
        ) : null}
      </div>
  );
}

function SectionHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-2.5">
      <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-600">{title}</h2>
      {action}
    </div>
  );
}
