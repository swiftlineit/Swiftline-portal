"use client";

import Script from "next/script";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "react-toastify";
import { FiCheck, FiCreditCard, FiMapPin, FiPackage } from "react-icons/fi";
import { isValidAadhaarNumber } from "@/lib/aadhaar";
import { getCsbVBookingIssues } from "@/lib/csbVBooking";
import {
  getPostcodeError,
  getShipmentMobileCountryMismatchError,
  getShipmentMobileError,
  isAcceptableShipmentEmail,
} from "@/lib/shipmentContactValidation";
import {
  confirmPublicPayment,
  createPublicPaymentOrder,
  loadPublicBooking,
  loadPublicBookingPolicies,
  requestPublicQuote,
  savePublicBookingDraft,
  startPublicBooking,
  uploadPublicKycDocument,
  type PublicBooking,
  type PublicQuote,
  type PublicShipmentFormData,
} from "@/lib/publicShipmentBooking";
import AddressStep from "./AddressStep";
import { PublicBookingStateCard } from "./PublicBookingStatus";
import ProhibitedGoodsModal from "./ProhibitedGoodsModal";
import ReviewPaymentStep from "./ReviewPaymentStep";
import ShipmentDetailsStep, {
  emptyParcel,
  KYC_DOCUMENTS,
  type KycDocumentLabels,
  type SelectedKycFiles,
} from "./ShipmentDetailsStep";

const RECAPTCHA_SITE_KEY = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY || "";
const requiredCsbVDocuments = KYC_DOCUMENTS.filter(
  ([type]) => type !== "other",
).map(([type]) => type);

const emptyAddress = {
  entityType: "INDIVIDUAL" as const,
  companyName: "",
  contactName: "",
  email: "",
  mobileCountryCode: "+44",
  mobileNumber: "",
  countryCode: "",
  countryName: "",
  postcode: "",
  addressLine1: "",
  addressLine2: "",
  townOrCity: "",
  county: "",
  stateCode: "",
  deliveryInstructions: "",
};
const initialData: PublicShipmentFormData = {
  sender: {
    ...emptyAddress,
    mobileCountryCode: "+91",
    countryCode: "IN",
    countryName: "India",
    aadhaarNumber: "",
  },
  consignee: { ...emptyAddress },
  serviceType: "COURIER",
  csbType: "CSB_IV",
  csbVGstin: "",
  csbVAccountNumber: "",
  csbVInvoiceNumber: "",
  kycUseForAllParcels: true,
  parcels: [emptyParcel("WEB-1")],
};

const stepLabels = ["From & To", "Shipment", "Review"];
const stepDescriptions = [
  "Sender and receiver",
  "Parcel details",
  "Quote and payment",
];
const stepIcons = [FiMapPin, FiPackage, FiCreditCard] as const;

function validateAddressStep(data: PublicShipmentFormData) {
  const errors: Record<string, string> = {};
  for (const [prefix, address] of [
    ["sender", data.sender],
    ["consignee", data.consignee],
  ] as const) {
    if (address.entityType === "COMPANY" && !address.companyName.trim())
      errors[`${prefix}.companyName`] = "Company name is required.";
    if (!address.contactName.trim())
      errors[`${prefix}.contactName`] = "Contact name is required.";
    if (!address.email.trim() || !isAcceptableShipmentEmail(address.email))
      errors[`${prefix}.email`] =
        "Enter a valid Gmail, Yahoo or business email address.";
    const mobileError = getShipmentMobileError(
      address.mobileCountryCode,
      address.mobileNumber,
    );
    if (!address.mobileNumber.trim() || mobileError)
      errors[`${prefix}.mobileNumber`] =
        prefix === "sender"
          ? "Enter a valid 10 digit Indian mobile number."
          : mobileError || "Enter a valid mobile number.";
    // The receiver dial code must belong to the destination country. The
    // sender side is fixed to IN / +91, so only the consignee can mismatch.
    if (prefix === "consignee") {
      const countryCodeError = getShipmentMobileCountryMismatchError(
        address.countryCode,
        address.mobileCountryCode,
      );
      if (countryCodeError) errors[`${prefix}.mobileCountryCode`] = countryCodeError;
    }
    const postcodeError =
      prefix === "sender"
        ? !/^[1-9]\d{5}$/.test(address.postcode)
          ? "Enter a valid 6 digit PIN code."
          : ""
        : getPostcodeError(address.countryCode, address.postcode);
    if (!address.postcode.trim() || postcodeError)
      errors[`${prefix}.postcode`] =
        postcodeError || "Postal code is required.";
    if (!address.addressLine1.trim())
      errors[`${prefix}.addressLine1`] = "Address line 1 is required.";
    if (!address.townOrCity.trim())
      errors[`${prefix}.townOrCity`] = "Town or city is required.";
    if (!address.county.trim())
      errors[`${prefix}.county`] = "State or county is required.";
    if (prefix === "consignee" && data.csbType === "CSB_V" && !address.stateCode.trim())
      errors["consignee.stateCode"] = "State code is required for CSB-V.";
    if (
      prefix === "consignee" &&
      (!address.countryCode || address.countryCode === "IN")
    )
      errors[`${prefix}.countryCode`] = "Select an international destination.";
  }
  if (!isValidAadhaarNumber(data.sender.aadhaarNumber))
    errors["sender.aadhaarNumber"] = "Enter a valid 12 digit Aadhaar number.";
  if (
    data.sender.contactName.trim().toLowerCase() ===
      data.consignee.contactName.trim().toLowerCase() &&
    data.sender.contactName.trim()
  )
    errors["consignee.contactName"] =
      "Sender and receiver contact names must be different.";
  if (
    data.sender.email.trim().toLowerCase() ===
      data.consignee.email.trim().toLowerCase() &&
    data.sender.email.trim()
  )
    errors["consignee.email"] =
      "Sender and receiver email addresses must be different.";
  const senderPhone =
    `${data.sender.mobileCountryCode}${data.sender.mobileNumber}`
      .replace(/\D/g, "")
      .slice(-10);
  const receiverPhone =
    `${data.consignee.mobileCountryCode}${data.consignee.mobileNumber}`
      .replace(/\D/g, "")
      .slice(-10);
  if (senderPhone && senderPhone === receiverPhone)
    errors["consignee.mobileNumber"] =
      "Sender and receiver mobile numbers must be different.";
  return errors;
}

function validateShipmentStep(
  data: PublicShipmentFormData,
  files: SelectedKycFiles,
  documentLabels: KycDocumentLabels,
) {
  const errors: Record<string, string> = {};
  for (const [index, parcel] of data.parcels.entries()) {
    for (const [key, label, value] of [
      ["weightKg", "Weight", parcel.weightKg],
      ["lengthCm", "Length", parcel.lengthCm],
      ["widthCm", "Width", parcel.widthCm],
      ["heightCm", "Height", parcel.heightCm],
    ] as const)
      if (!(value > 0) || value > 1000)
        errors[`parcels.${index}.${key}`] =
          `${label} must be greater than zero and no more than 1000.`;
    if (!parcel.shipmentReference1.trim())
      errors[`parcels.${index}.shipmentReference1`] =
        `Enter a reference for parcel ${index + 1}.`;
    for (const [itemIndex, item] of parcel.items.entries()) {
      const path = `parcels.${index}.items.${itemIndex}`;
      if (!item.description.trim())
        errors[`${path}.description`] =
          `Enter a description for item ${itemIndex + 1} in parcel ${index + 1}.`;
      if (!(item.quantity > 0) || item.quantity > 100000)
        errors[`${path}.quantity`] = "Quantity must be greater than zero.";
      if (!(item.unitRate > 0) || item.unitRate > 100000000)
        errors[`${path}.unitRate`] = "Unit value must be greater than zero.";
      if (
        (data.csbType === "CSB_V" || item.hsnCode) &&
        !/^\d{4}(?:\d{2}(?:\d{2}(?:\d{2})?)?)?$/.test(item.hsnCode)
      )
        errors[`${path}.hsnCode`] =
          `Enter a valid 4, 6, 8 or 10 digit HS code for item ${itemIndex + 1}.`;
    }
  }
  const selectedFiles = Object.values(files).filter(Boolean) as File[];
  if (selectedFiles.some((file) => file.size > 5 * 1024 * 1024))
    errors.documents = "Each KYC document must be 5 MB or smaller.";
  for (const [key, file] of Object.entries(files)) {
    if (file && key.endsWith(":other") && !documentLabels[key]?.trim())
      errors[key] = "Enter a name for each other KYC document.";
  }
  if (data.csbType === "CSB_V") {
    const csbVIssues = getCsbVBookingIssues({
      gstin: data.csbVGstin,
      accountNumber: data.csbVAccountNumber,
      invoiceNumber: data.csbVInvoiceNumber
    }, data.csbType);
    Object.entries(csbVIssues).forEach(([field, message]) => {
      if (message) errors[`csbV${field[0]?.toUpperCase() ?? ""}${field.slice(1)}`] = message;
    });
    const scopes = data.kycUseForAllParcels
      ? ["shared"]
      : data.parcels.map((_, index) => `parcel-${index + 1}`);
    for (const scope of scopes)
      for (const type of requiredCsbVDocuments)
        if (!files[`${scope}:${type}`])
          errors[`${scope}:${type}`] =
            `${KYC_DOCUMENTS.find(([key]) => key === type)?.[1]} is required for ${scope === "shared" ? "this CSB-V booking" : scope.replace("-", " ")}.`;
  }
  return errors;
}

function firstError(errors: Record<string, string>, fallback: string) {
  return Object.values(errors)[0] || fallback;
}
function requestErrorMessage(error: unknown, fallback: string) {
  if (!(error instanceof Error)) return fallback;
  const details = (
    error as Error & {
      details?: {
        validationIssues?: string[];
        issues?: Array<{ message?: string }>;
      };
    }
  ).details;
  return (
    details?.validationIssues?.[0] ||
    details?.issues?.[0]?.message ||
    error.message ||
    fallback
  );
}

async function recaptchaToken() {
  if (!RECAPTCHA_SITE_KEY || !window.grecaptcha) return undefined;
  try {
    return await new Promise<string>((resolve, reject) =>
      window.grecaptcha!.ready(() =>
        window
          .grecaptcha!.execute(RECAPTCHA_SITE_KEY, {
            action: "public_shipment_quote",
          })
          .then(resolve, reject),
      ),
    );
  } catch {
    return undefined;
  }
}

export default function PublicShipmentBookingForm() {
  const [step, setStep] = useState(1);
  const [data, setData] = useState(initialData);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [booking, setBooking] = useState<PublicBooking | null>(null);
  const [quote, setQuote] = useState<PublicQuote | null>(null);
  const [files, setFiles] = useState<SelectedKycFiles>({});
  const [documentLabels, setDocumentLabels] = useState<KycDocumentLabels>({});
  const [consent, setConsent] = useState({
    terms: false,
    cancellation: false,
    prohibited: false,
  });
  const [prohibited, setProhibited] = useState<string[]>([
    "Alcohol / Liquor",
    "Cash / Currency",
    "Arms / Ammunition / Weapons",
    "Explosives / Fireworks",
    "Flammable Items",
    "Loose Battery / Power Bank",
  ]);
  const [modalOpen, setModalOpen] = useState(false);
  const [revealAddressErrors, setRevealAddressErrors] = useState(false);
  const [revealShipmentErrors, setRevealShipmentErrors] = useState(false);
  const addressErrors = useMemo(
    () => validateAddressStep(data),
    [data],
  );
  const shipmentErrors = useMemo(
    () => validateShipmentStep(data, files, documentLabels),
    [data, files, documentLabels],
  );

  useEffect(() => {
    loadPublicBookingPolicies()
      .then((result) => setProhibited(result.prohibitedGoods))
      .catch(() => undefined);
    loadPublicBooking()
      .then((result) => {
        if (result.booking.state === "BOOKED") {
          // Completed bookings have their own no-hero status page. Keeping the
          // form route focused on new bookings also prevents an old cookie from
          // reopening the success card above the booking form.
          window.location.replace("/book-shipment-online/status");
          return;
        }
        setBooking(result.booking);
      })
      .catch(() => undefined);
  }, []);
  const ensureSession = useCallback(async () => {
    if (booking) return booking;
    const started = await startPublicBooking();
    setBooking(started.booking);
    return started.booking;
  }, [booking]);

  async function continueFromAddresses() {
    setRevealAddressErrors(true);
    if (Object.keys(addressErrors).length) {
      toast.error(
        firstError(addressErrors, "Check the highlighted address details."),
      );
      return;
    }
    setMessage("");
    setStep(2);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function continueFromShipment() {
    setRevealShipmentErrors(true);
    if (Object.keys(shipmentErrors).length) {
      toast.error(
        firstError(shipmentErrors, "Check the highlighted shipment details."),
      );
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await ensureSession();
      let saved = await savePublicBookingDraft(data);
      setBooking(saved.booking);
      for (const [key, file] of Object.entries(files)) {
        if (!file) continue;
        const [scope, type] = key.split(":");
        const sequence = scope?.startsWith("parcel-")
          ? Number(scope.slice(7))
          : undefined;
        await uploadPublicKycDocument(
          type!,
          file,
          sequence,
          documentLabels[key],
        );
      }
      // Revalidate the persisted draft after uploads. The first save may
      // legitimately report missing CSB-V documents because those files are
      // attached only after the draft has an id.
      saved = await savePublicBookingDraft(data);
      if (saved.validationIssues.length)
        throw Object.assign(new Error(saved.validationIssues[0]), {
          details: { validationIssues: saved.validationIssues },
        });
      setBooking(saved.booking);
      toast.success("Shipment details saved and validated.");
      setStep(3);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      toast.error(
        requestErrorMessage(error, "Shipment details could not be saved."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function calculateQuote() {
    setBusy(true);
    setMessage("");
    try {
      const result = await requestPublicQuote(await recaptchaToken());
      setBooking(result.booking);
      setQuote(result.quote);
      toast.success("Your final quote is ready.");
    } catch (error) {
      toast.error(
        requestErrorMessage(error, "The quote could not be calculated."),
      );
    } finally {
      setBusy(false);
    }
  }

  async function pay() {
    if (!(quote || booking?.quote) || !window.Razorpay) {
      toast.error(
        "Secure payment is still loading. Please try again in a moment.",
      );
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const { order } = await createPublicPaymentOrder();
      new window.Razorpay({
        key: order.keyId,
        amount: order.amountMinor,
        currency: order.currency,
        order_id: order.id,
        name: "Swiftline Cargo",
        description: `Online shipment ${order.bookingReference}`,
        prefill: {
          name: data.sender.companyName || data.sender.contactName,
          email: data.sender.email,
          contact: data.sender.mobileNumber,
        },
        theme: { color: "#0D1282" },
        handler: async (payment) => {
          try {
            const completed = await confirmPublicPayment({
              razorpayOrderId: payment.razorpay_order_id,
              razorpayPaymentId: payment.razorpay_payment_id,
              razorpaySignature: payment.razorpay_signature,
            });
            if (completed.booking.state === "BOOKED") {
              window.location.replace("/book-shipment-online/status");
              return;
            }
            setBooking(completed.booking);
          } catch (error) {
            const nextMessage = requestErrorMessage(
              error,
              "Payment needs Swiftline review.",
            );
            setMessage(nextMessage);
            toast.error(nextMessage);
            loadPublicBooking()
              .then((result) => setBooking(result.booking))
              .catch(() => undefined);
          } finally {
            setBusy(false);
          }
        },
        modal: { ondismiss: () => setBusy(false) },
      }).open();
    } catch (error) {
      toast.error(requestErrorMessage(error, "Payment could not be started."));
      setBusy(false);
    }
  }

  if (
    booking &&
    [
      "PAYMENT_PENDING",
      "PAYMENT_REVIEW_REQUIRED",
      "FULFILLING",
      "REVIEW_REQUIRED",
      "REFUND_PENDING",
      "REFUNDED",
    ].includes(booking.state)
  ) {
    return (
      <PublicBookingStateCard
        booking={booking}
        message={message}
        onResumePayment={booking.state === "PAYMENT_PENDING" ? pay : undefined}
        busy={busy}
      />
    );
  }

  return (
    <>
      {RECAPTCHA_SITE_KEY ? (
        <Script
          src={`https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`}
          strategy="afterInteractive"
        />
      ) : null}
      <Script
        src="https://checkout.razorpay.com/v1/checkout.js"
        strategy="afterInteractive"
      />
      <div className="mx-auto w-full max-w-7xl px-4 pb-14 sm:px-6 lg:px-8">
        <ol
          aria-label="Booking progress"
          className="mb-6 grid grid-cols-3 gap-2 rounded-lg  p-1  sm:p-1.5"
        >
          {stepLabels.map((label, index) => {
            const number = index + 1;
            const active = number === step;
            const complete = number < step;
            const StepIcon = stepIcons[index];
            return (
              <li
                key={label}
                aria-current={active ? "step" : undefined}
                className={`relative flex min-w-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-2 py-2.5 text-center transition-colors first:border-l-0 sm:flex-row sm:justify-start sm:gap-3 sm:px-4 sm:py-3 sm:text-left ${active ? "bg-[#0D1282]/5" : complete ? "bg-emerald-50/60" : "bg-transparent"}`}
              >
                <span
                  className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${active ? "bg-[#0D1282] text-white" : complete ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-500"}`}
                >
                  <StepIcon aria-hidden="true" className="h-4 w-4" />
                  {complete ? (
                    <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-emerald-600 text-white ring-2 ring-white">
                      <FiCheck aria-hidden="true" className="h-2 w-2" />
                    </span>
                  ) : null}
                </span>
                <span className="min-w-0">
                  <span
                    className={`block truncate text-[11px] font-semibold sm:text-sm ${active ? "text-[#0D1282]" : complete ? "text-emerald-800" : "text-slate-600"}`}
                  >
                    {label}
                  </span>
                  <span className="mt-0.5 hidden truncate text-[11px] text-slate-500 sm:block">
                    {stepDescriptions[index]}
                  </span>
                </span>
              </li>
            );
          })}
        </ol>
        {step === 1 ? (
          <AddressStep
            sender={data.sender}
            consignee={data.consignee}
            onSender={(sender) =>
              setData((current) => ({ ...current, sender }))
            }
            onConsignee={(consignee) =>
              setData((current) => ({ ...current, consignee }))
            }
            errors={addressErrors}
            revealErrors={revealAddressErrors}
            csbType={data.csbType}
          />
        ) : null}
        {step === 2 ? (
          <ShipmentDetailsStep
            data={data}
            onChange={setData}
            files={files}
            labels={documentLabels}
            errors={shipmentErrors}
            revealErrors={revealShipmentErrors}
            onFile={(key, file) =>
              setFiles((current) => ({ ...current, [key]: file }))
            }
            onLabel={(key, value) =>
              setDocumentLabels((current) => ({ ...current, [key]: value }))
            }
            onOpenProhibited={() => setModalOpen(true)}
          />
        ) : null}
        {step === 3 ? (
          <ReviewPaymentStep
            data={data}
            booking={booking}
            quote={quote}
            consent={consent}
            onConsent={(key, value) =>
              setConsent((current) => ({ ...current, [key]: value }))
            }
            onQuote={calculateQuote}
            onPay={pay}
            busy={busy}
            error=""
          />
        ) : null}
        {step < 3 ? (
          <div className="mt-6 flex items-center justify-between gap-3">
            {step > 1 ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setMessage("");
                  setStep(step - 1);
                }}
                className="h-11 rounded-lg border border-slate-300 bg-white px-5 text-sm font-bold text-slate-700 hover:bg-slate-50"
              >
                Back
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              disabled={busy}
              onClick={
                step === 1 ? continueFromAddresses : continueFromShipment
              }
              className="h-11 rounded-lg bg-[#0D1282] px-6 text-sm font-bold text-white hover:bg-[#080d64] disabled:opacity-50"
            >
              {busy ? "Saving securely…" : "Continue"}
            </button>
          </div>
        ) : (
          <div className="mt-6">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setQuote(null);
                setMessage("");
                setStep(2);
              }}
              className="h-11 rounded-lg border border-slate-300 bg-white px-5 text-sm font-bold text-slate-700 hover:bg-slate-50"
            >
              Back to shipment details
            </button>
          </div>
        )}
      </div>
      <ProhibitedGoodsModal
        open={modalOpen}
        items={prohibited}
        onClose={() => setModalOpen(false)}
      />
    </>
  );
}
