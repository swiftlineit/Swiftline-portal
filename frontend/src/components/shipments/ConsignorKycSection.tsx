"use client";

import {
  ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Image from "next/image";
import { createPortal } from "react-dom";
import {
  FiCheck,
  FiChevronDown,
  FiFileText,
  FiInfo,
  FiMapPin,
  FiSearch,
  FiTrash2,
  FiUploadCloud,
} from "react-icons/fi";
import { toast } from "react-toastify";
import InfoTooltip from "@/components/ui/InfoTooltip";
import {
  ShipmentFieldLabel,
  ShipmentFixedCountryField,
  ShipmentTextField,
} from "@/components/shipments/ShipmentFormControls";
import {
  formatAadhaarNumber,
  isValidAadhaarNumber,
  normalizeAadhaarNumber,
} from "@/lib/aadhaar";
import type {
  AadhaarOcrResult,
  AadhaarOcrScope,
  AadhaarOcrPrefill,
  AadhaarOcrUploadInput,
  AddressPrediction,
  ShipmentKycDocument,
  ShipmentKycDocumentType,
  ShipmentKycDocuments,
} from "@/lib/dpdLabels";
import {
  requiredShipmentKycDocumentTypes,
  shipmentKycDocumentLabels,
  shipmentKycDocumentSlots,
} from "@/lib/dpdLabels";
import type { CsbType } from "@/lib/csbType";
import { indiaStates, normalizeIndiaState } from "@/lib/indiaStates";
import type { ConsignorForm, ParcelKycState } from "@/lib/shipmentConsignor";
import { nextContactNameOnCompanyChange } from "@/lib/shipmentConsignor";
import { getAadhaarOcrFeatureStatus } from "@/lib/operationsAdvisory";

type ConsignorFieldIssues = Partial<Record<keyof ConsignorForm, string>>;

export type ConsignorKycApi = {
  autocompleteConsignorAddress: (
    input: string,
  ) => Promise<{ predictions: AddressPrediction[] }>;
  getConsignorPlaceAddress: (
    placeId: string,
    shipmentDraftId: string,
  ) => Promise<{
    place: {
      address: {
        addressLine1: string;
        addressLine2: string;
        townOrCity: string;
        county: string;
        postcode: string;
      };
    };
  }>;
  uploadKycDocument: (input: {
    shipmentDraftId: string;
    type: ShipmentKycDocumentType;
    file: File;
    documentLabel?: string;
  }) => Promise<{ kycDocuments: ShipmentKycDocuments }>;
  deleteKycDocument: (
    shipmentDraftId: string,
    type: ShipmentKycDocumentType,
  ) => Promise<{ kycDocuments: ShipmentKycDocuments }>;
  openKycDocument: (
    shipmentDraftId: string,
    type: ShipmentKycDocumentType,
  ) => Promise<Blob>;
  uploadParcelKycDocument: (input: {
    shipmentDraftId: string;
    sequence: number;
    type: ShipmentKycDocumentType;
    file: File;
    documentLabel?: string;
  }) => Promise<{ kycDocuments: ShipmentKycDocuments }>;
  deleteParcelKycDocument: (
    shipmentDraftId: string,
    sequence: number,
    type: ShipmentKycDocumentType,
  ) => Promise<{ kycDocuments: ShipmentKycDocuments }>;
  openParcelKycDocument: (
    shipmentDraftId: string,
    sequence: number,
    type: ShipmentKycDocumentType,
  ) => Promise<Blob>;
  ocrAadhaar?: (input: AadhaarOcrUploadInput) => Promise<AadhaarOcrResult>;
};

type SlotConfig = {
  type: ShipmentKycDocumentType;
  title: string;
  required: boolean;
  needsLabel: boolean;
  helpText: string;
};

function openBlobInNewTab(blob: Blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank", "noopener,noreferrer");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ConsignorKycSection({
  shipmentDraftId,
  csbType,
  form,
  onFormChange,
  fieldIssues,
  submitAttempted,
  readOnly = false,
  kycUseForAll,
  onKycUseForAllChange,
  sharedKycDocuments,
  onSharedKycChange,
  parcels,
  savedParcelCount,
  onParcelAadhaarChange,
  onParcelKycChange,
  api,
  headerAction,
  enableAadhaarOcr = false,
}: {
  shipmentDraftId: string;
  csbType: CsbType;
  form: ConsignorForm;
  onFormChange: (next: ConsignorForm) => void;
  fieldIssues: ConsignorFieldIssues;
  submitAttempted: boolean;
  readOnly?: boolean;
  kycUseForAll: boolean;
  onKycUseForAllChange: (next: boolean) => void;
  sharedKycDocuments: ShipmentKycDocuments;
  onSharedKycChange: (next: ShipmentKycDocuments) => void;
  parcels: ParcelKycState[];
  savedParcelCount: number;
  onParcelAadhaarChange: (sequence: number, value: string) => void;
  onParcelKycChange: (
    sequence: number,
    documents: ShipmentKycDocuments,
  ) => void;
  api: ConsignorKycApi;
  headerAction?: ReactNode;
  enableAadhaarOcr?: boolean;
}) {
  const [addressQuery, setAddressQuery] = useState("");
  const [predictions, setPredictions] = useState<AddressPrediction[]>([]);
  const [addressBusy, setAddressBusy] = useState(false);
  const [aadhaarOcrFeatureEnabled, setAadhaarOcrFeatureEnabled] = useState(false);

  useEffect(() => {
    if (!enableAadhaarOcr || !api.ocrAadhaar || readOnly) return;

    let active = true;
    const refreshStatus = async () => {
      try {
        const status = await getAadhaarOcrFeatureStatus();
        if (active) setAadhaarOcrFeatureEnabled(status.enabled && status.providerConfigured);
      } catch {
        if (active) setAadhaarOcrFeatureEnabled(false);
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshStatus();
    };

    void refreshStatus();
    const intervalId = window.setInterval(() => void refreshStatus(), 30_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [enableAadhaarOcr, api.ocrAadhaar, readOnly]);

  // Every slot the route offers is rendered; only CSB-V marks them required.
  const requiredTypes = requiredShipmentKycDocumentTypes(csbType);
  const kycSlots: SlotConfig[] = [
    ...shipmentKycDocumentSlots(csbType).map((type) => {
      const required = requiredTypes.includes(type);
      const helpText =
        type === "aadhaar" && csbType === "CSB_IV"
          ? "Optional for CSB-IV. Upload one PDF with both sides, or a front image and optionally add the back image. PDF, JPG or PNG up to 5 MB."
          : `${required ? "Required" : "Optional"} for ${csbType === "CSB_V" ? "CSB-V" : "CSB-IV"}. Upload the document in PDF, JPG or PNG format (up to 5 MB).`;

      return {
        type,
        title: shipmentKycDocumentLabels[type],
        required,
        needsLabel: false,
        helpText,
      };
    }),
    // Always last and optional for both routes. Its typed label identifies what
    // the additional document contains when it is viewed later.
    {
      type: "other",
      title: "Other Document",
      required: false,
      needsLabel: true,
      helpText:
        "Optional for CSB-IV and CSB-V. Enter a document name before uploading. PDF, JPG or PNG up to 5 MB.",
    },
  ];

  function setField(field: keyof ConsignorForm) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue =
        field === "email"
          ? event.target.value
          : event.target.value.toUpperCase();
      if (field === "companyName") {
        return onFormChange({
          ...form,
          companyName: nextValue,
          contactName: nextContactNameOnCompanyChange(
            form.companyName,
            form.contactName,
            nextValue,
          ),
        });
      }
      return onFormChange({
        ...form,
        [field]: nextValue,
      });
    };
  }

  async function handleAddressSearch() {
    if (!addressQuery.trim()) return;
    setAddressBusy(true);
    try {
      const data = await api.autocompleteConsignorAddress(addressQuery.trim());
      setPredictions(data.predictions);
      if (!data.predictions.length)
        toast.info(
          "No matching Indian address was found. Enter the address manually.",
        );
    } catch (error) {
      setPredictions([]);
      toast.error(
        error instanceof Error
          ? error.message
          : "Address search is unavailable right now.",
      );
    } finally {
      setAddressBusy(false);
    }
  }

  async function handleSelectPrediction(prediction: AddressPrediction) {
    setAddressBusy(true);
    try {
      const data = await api.getConsignorPlaceAddress(
        prediction.placeId,
        shipmentDraftId,
      );
      const resolvedState = normalizeIndiaState(
        data.place.address.county || form.county,
      );
      onFormChange({
        ...form,
        addressLine1: (
          data.place.address.addressLine1 || form.addressLine1
        ).toUpperCase(),
        addressLine2: (
          data.place.address.addressLine2 || form.addressLine2
        ).toUpperCase(),
        townOrCity: (
          data.place.address.townOrCity || form.townOrCity
        ).toUpperCase(),
        // The provider returns this as `county`, while the form stores the
        // Indian state. Resolve it to the same option used by the combobox so
        // selecting a searched address also selects its state.
        county: resolvedState.toUpperCase(),
        postcode: data.place.address.postcode || form.postcode,
      });
      setPredictions([]);
      setAddressQuery("");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Unable to select this address.",
      );
    } finally {
      setAddressBusy(false);
    }
  }

  // CSB-V requires the card but keeps the number optional. CSB-IV's existing
  // number requirement remains independent of its optional document upload.
  const aadhaarRequired = csbType !== "CSB_V";
  const aadhaarError = (value: string) => {
    if (!submitAttempted) return undefined;
    if (!value.trim()) return aadhaarRequired ? "Aadhaar number is required" : undefined;
    return isValidAadhaarNumber(value)
      ? undefined
      : "Enter a valid 12 digit Aadhaar number";
  };
  const sharedAadhaarError =
    kycUseForAll && aadhaarRequired
      ? aadhaarError(form.aadhaarNumber)
      : undefined;

  return (
    <>
      <section className="overflow-visible rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-xl border-b border-slate-200 bg-slate-50/60 px-4 py-2.5">
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-600">
              Consignor Details
            </h2>
            <p className="mt-0.5 text-[11px] text-slate-500">
              Indian sender · Country and code are fixed.
            </p>
          </div>
          {headerAction}
        </div>
        {enableAadhaarOcr && aadhaarOcrFeatureEnabled && api.ocrAadhaar && !readOnly ? (
          <div className="px-3 pt-3 sm:px-4">
            <AadhaarOcrControl
              shipmentDraftId={shipmentDraftId}
              form={form}
              onFormChange={onFormChange}
              csbType={csbType}
              kycScope={kycUseForAll ? "shared" : "parcel"}
              parcels={parcels}
              savedParcelCount={savedParcelCount}
              onParcelAadhaarChange={onParcelAadhaarChange}
              onKycDocumentsChange={(documents, parcelSequence) => {
                if (kycUseForAll) onSharedKycChange(documents);
                else if (parcelSequence) onParcelKycChange(parcelSequence, documents);
              }}
              api={api.ocrAadhaar}
            />
          </div>
        ) : null}
        <div className="grid gap-3 p-3 sm:p-4 md:grid-cols-2">
          <ShipmentTextField
            label="Consignor Company"
            value={form.companyName}
            onChange={setField("companyName")}
            readOnly={readOnly}
          />
          <ShipmentTextField
            label="Consignor Contact Name"
            required
            value={form.contactName}
            onChange={setField("contactName")}
            error={fieldIssues.contactName}
            revealError={submitAttempted}
            readOnly={readOnly}
          />
          <ShipmentTextField
            label="Consignor Email"
            required
            type="email"
            inputMode="email"
            value={form.email}
            onChange={setField("email")}
            error={fieldIssues.email}
            revealError={submitAttempted}
            readOnly={readOnly}
          />
          <div className="grid gap-4 sm:grid-cols-[minmax(0,150px)_minmax(0,1fr)]">
            <ShipmentFixedCountryField label="Code" mode="dial" />
            <ShipmentTextField
              label="Mobile Number"
              required
              type="tel"
              inputMode="tel"
              value={form.mobileNumber}
              onChange={(event) =>
                onFormChange({
                  ...form,
                  mobileNumber: event.target.value
                    .replace(/\D/g, "")
                    .slice(0, 10),
                })
              }
              error={fieldIssues.mobileNumber}
              revealError={submitAttempted}
              readOnly={readOnly}
            />
          </div>
        </div>
      </section>

      <section className="relative z-20 overflow-visible rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50/60 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-600">
            Consignor Pickup Address
          </h2>
          <p className="mt-0.5 text-[11px] text-slate-500">
            Search an Indian address, then adjust the fields as needed.
          </p>
        </div>
        <div className="space-y-3 p-3 sm:p-4">
          {!readOnly ? (
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
              <label className="block">
                <ShipmentFieldLabel>Search Indian Address</ShipmentFieldLabel>
                <input
                  value={addressQuery}
                  onChange={(event) =>
                    setAddressQuery(event.target.value.toUpperCase())
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleAddressSearch();
                    }
                  }}
                  placeholder="Building, street, area or PIN code"
                  className="mt-1.5 h-10 w-full rounded border border-slate-300 px-3 text-[13px] outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
                />
              </label>
              <button
                type="button"
                onClick={handleAddressSearch}
                disabled={addressBusy}
                className="mt-7 inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-[13px] font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                <FiSearch aria-hidden="true" className="h-4 w-4" />
                Search
              </button>
            </div>
          ) : null}

          {predictions.length ? (
            <div className="max-h-85 overflow-y-auto rounded-xl border border-slate-200">
              {predictions.map((prediction) => (
                <button
                  key={prediction.placeId}
                  type="button"
                  onClick={() => handleSelectPrediction(prediction)}
                  className="flex w-full items-start gap-3 border-b border-slate-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-blue-50"
                >
                  <FiMapPin
                    aria-hidden="true"
                    className="mt-0.5 h-4 w-4 shrink-0 text-blue-900"
                  />
                  <span>
                    <span className="block text-[13px] font-semibold text-slate-950">
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

          <div className="grid gap-4 md:grid-cols-2">
            <ShipmentFixedCountryField label="Consignor Country" />
            <ShipmentTextField
              label="Pickup Address Line 1"
              required
              value={form.addressLine1}
              onChange={setField("addressLine1")}
              error={fieldIssues.addressLine1}
              revealError={submitAttempted}
              readOnly={readOnly}
            />
            <ShipmentTextField
              label="Pickup Address Line 2"
              value={form.addressLine2}
              onChange={setField("addressLine2")}
              readOnly={readOnly}
            />
            <ShipmentTextField
              label="Town / City"
              required
              value={form.townOrCity}
              onChange={setField("townOrCity")}
              error={fieldIssues.townOrCity}
              revealError={submitAttempted}
              readOnly={readOnly}
            />
            <IndianStateAutocompleteField
              value={form.county}
              onChange={(value) => onFormChange({ ...form, county: value })}
              error={fieldIssues.county}
              revealError={submitAttempted}
              readOnly={readOnly}
            />
            <ShipmentTextField
              label="PIN Code"
              required
              inputMode="numeric"
              value={form.postcode}
              onChange={(event) =>
                onFormChange({
                  ...form,
                  postcode: event.target.value.replace(/\D/g, "").slice(0, 6),
                })
              }
              error={fieldIssues.postcode}
              revealError={submitAttempted}
              readOnly={readOnly}
            />
            <label className="block md:col-span-2">
              <ShipmentFieldLabel>Pickup Instructions</ShipmentFieldLabel>
              <textarea
                value={form.pickupInstructions}
                onChange={(event) =>
                  onFormChange({
                    ...form,
                    pickupInstructions: event.target.value.toUpperCase(),
                  })
                }
                readOnly={readOnly}
                rows={3}
                className={`mt-1.5 w-full rounded border px-3 py-2 text-[13px] outline-none transition focus:ring-2 ${readOnly ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-500" : "border-slate-300 focus:border-blue-900 focus:ring-blue-100"}`}
              />
            </label>
          </div>
        </div>
      </section>

      <section className="overflow-visible rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-t-xl border-b border-slate-200 bg-slate-50/70 px-4 py-2.5">
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-600">
              KYC Documents
            </h2>
            <p className="mt-0.5 max-w-3xl text-[11px] leading-4 text-slate-500">
              {csbType === "CSB_V"
                ? "Add the required customs documents for this shipment."
                : "PAN and Aadhaar are optional for CSB-IV. Attach them to keep them on file."}{" "}
              Drop a file onto a card or select its upload icon.
            </p>
          </div>
          <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-blue-900">
            {csbType === "CSB_V"
              ? `CSB-V · ${requiredTypes.length} required`
              : "CSB-IV · all optional"}
          </span>
        </div>

        <div className="space-y-3 p-3 sm:p-4">
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,300px)]">
            <label
              className={`flex min-h-10 items-center gap-2.5 rounded-md border px-2.5 py-2 transition ${kycUseForAll ? "border-blue-300 bg-blue-50/70" : "border-slate-200 bg-white"}`}
            >
              <input
                type="checkbox"
                checked={kycUseForAll}
                disabled={readOnly}
                onChange={(event) => onKycUseForAllChange(event.target.checked)}
                className="h-4 w-4 shrink-0 accent-blue-900"
              />
              <span className="min-w-0">
                <span className="block text-[12px] font-semibold text-slate-900">
                  Use the same KYC for every parcel
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
                  {kycUseForAll
                    ? csbType === "CSB_V"
                      ? "One document set applies to all parcels."
                      : "One Aadhaar number and document set applies to all parcels."
                    : csbType === "CSB_V"
                      ? "Each parcel uses its own documents."
                      : "Each parcel uses its own Aadhaar number and documents."}
                </span>
              </span>
            </label>

            {kycUseForAll && (aadhaarRequired || enableAadhaarOcr) ? (
              <AadhaarNumberField
                label="Aadhaar Number"
                required={aadhaarRequired}
                value={form.aadhaarNumber}
                onValueChange={(value) =>
                  onFormChange({
                    ...form,
                    aadhaarNumber: value,
                  })
                }
                error={sharedAadhaarError}
                revealError={submitAttempted}
                readOnly={readOnly}
              />
            ) : null}
          </div>

          {kycUseForAll ? (
            <div>
              <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Shared documents
              </p>
              <KycSlotRow
                slots={kycSlots}
                csbType={csbType}
                documents={sharedKycDocuments}
                showStoredAadhaarBack={enableAadhaarOcr}
                submitAttempted={submitAttempted}
                readOnly={readOnly}
                disabled={false}
                onUpload={async (type, file, documentLabel) => {
                  const data = await api.uploadKycDocument({
                    shipmentDraftId,
                    type,
                    file,
                    documentLabel,
                  });
                  onSharedKycChange(data.kycDocuments);
                }}
                onDelete={async (type) => {
                  const data = await api.deleteKycDocument(
                    shipmentDraftId,
                    type,
                  );
                  onSharedKycChange(data.kycDocuments);
                }}
                onOpen={(type) => api.openKycDocument(shipmentDraftId, type)}
              />
            </div>
          ) : (
            <div className="space-y-2.5">
              {parcels.map((parcel, index) => {
                const saved = parcel.sequence <= savedParcelCount;
                return (
                  <div
                    key={parcel.sequence}
                    className="rounded-lg border border-slate-200"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-t-lg border-b border-slate-100 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      <span>Parcel {index + 1}</span>
                      <span className="font-medium normal-case tracking-normal text-slate-400">
                        {saved ? "Saved" : "Save shipment to upload"}
                      </span>
                    </div>
                    <div className="space-y-3 p-3">
                      {aadhaarRequired || enableAadhaarOcr ? (
                        <div className="max-w-xs">
                          <AadhaarNumberField
                            label="Aadhaar Number"
                            required={aadhaarRequired}
                            value={parcel.aadhaarNumber}
                            onValueChange={(value) =>
                              onParcelAadhaarChange(parcel.sequence, value)
                            }
                            error={aadhaarError(parcel.aadhaarNumber)}
                            revealError={submitAttempted}
                            readOnly={readOnly}
                          />
                        </div>
                      ) : null}
                      <div>
                        <KycSlotRow
                          slots={kycSlots}
                          csbType={csbType}
                          documents={parcel.kycDocuments}
                          showStoredAadhaarBack={enableAadhaarOcr}
                          submitAttempted={submitAttempted}
                          readOnly={readOnly}
                          disabled={!saved}
                          onUpload={async (type, file, documentLabel) => {
                            const data = await api.uploadParcelKycDocument({
                              shipmentDraftId,
                              sequence: parcel.sequence,
                              type,
                              file,
                              documentLabel,
                            });
                            onParcelKycChange(
                              parcel.sequence,
                              data.kycDocuments,
                            );
                          }}
                          onDelete={async (type) => {
                            const data = await api.deleteParcelKycDocument(
                              shipmentDraftId,
                              parcel.sequence,
                              type,
                            );
                            onParcelKycChange(
                              parcel.sequence,
                              data.kycDocuments,
                            );
                          }}
                          onOpen={(type) =>
                            api.openParcelKycDocument(
                              shipmentDraftId,
                              parcel.sequence,
                              type,
                            )
                          }
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function IndianStateAutocompleteField({
  value,
  onChange,
  error,
  revealError,
  readOnly,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  revealError: boolean;
  readOnly: boolean;
}) {
  const inputId = useId();
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlighted, setHighlighted] = useState(0);
  const [touched, setTouched] = useState(false);

  const suggestions = useMemo(() => {
    const search = query.trim().toLocaleLowerCase("en-IN");
    if (!search) return [...indiaStates];
    return indiaStates.filter((state) =>
      state.toLocaleLowerCase("en-IN").includes(search),
    );
  }, [query]);
  const activeIndex = Math.min(
    highlighted,
    Math.max(suggestions.length - 1, 0),
  );
  const selectedState = normalizeIndiaState(value);
  const showError = touched || revealError;

  function openPicker() {
    if (readOnly) return;
    // Opening the field starts with the full list; typing then narrows it.
    // This keeps an existing selected state from hiding every other option.
    setQuery("");
    setHighlighted(0);
    setOpen(true);
  }

  function selectState(state: string) {
    // Consignor text fields are stored in uppercase throughout the booking
    // form. Keep that existing payload convention while showing readable
    // canonical names in the options.
    onChange(state.toUpperCase());
    setQuery("");
    setHighlighted(0);
    setOpen(false);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      setQuery("");
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlighted(
        Math.min(activeIndex + 1, Math.max(suggestions.length - 1, 0)),
      );
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlighted(Math.max(activeIndex - 1, 0));
      return;
    }

    if (event.key === "Enter" && open && suggestions[activeIndex]) {
      event.preventDefault();
      selectState(suggestions[activeIndex]);
    }
  }

  return (
    <div className="relative block min-w-0">
      <label htmlFor={inputId} className="block">
        <ShipmentFieldLabel required>
          State / Union Territory
        </ShipmentFieldLabel>
      </label>
      <div className="relative mt-1.5">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            open && suggestions[activeIndex]
              ? `${listboxId}-${activeIndex}`
              : undefined
          }
          aria-invalid={Boolean(error && showError)}
          autoComplete="off"
          value={open ? query : value}
          disabled={readOnly}
          placeholder="Search state or union territory"
          onFocus={openPicker}
          onClick={() => {
            if (!open) openPicker();
          }}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlighted(0);
            setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            setTouched(true);
            setOpen(false);
            setQuery("");
            if (error && value.trim()) toast.error(error, { toastId: error });
          }}
          className={`h-10 w-full rounded border bg-white px-3 pr-10 text-[13px] outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-500 ${
            error && showError
              ? "border-red-400 focus:border-red-500 focus:ring-red-100"
              : "border-slate-300 focus:border-blue-900 focus:ring-blue-100"
          }`}
        />
        <FiChevronDown
          aria-hidden="true"
          className={`pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 transition ${open ? "rotate-180" : ""}`}
        />
      </div>

      {open ? (
        <div
          id={listboxId}
          role="listbox"
          className="absolute left-0 right-0 z-30 mt-1 max-h-64 overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white p-1 shadow-lg [scrollbar-width:thin]"
        >
          {suggestions.length ? (
            suggestions.map((state, index) => (
              <button
                key={state}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={selectedState === state}
                onMouseDown={(event) => {
                  // Keep the input focused long enough for the option to be
                  // selected before the blur handler closes the list.
                  event.preventDefault();
                  selectState(state);
                }}
                onMouseEnter={() => setHighlighted(index)}
                className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[13px] ${
                  index === activeIndex
                    ? "bg-blue-50 text-blue-950"
                    : "text-slate-700 hover:bg-slate-50"
                }`}
              >
                <span className="truncate">{state}</span>
                {selectedState === state ? (
                  <FiCheck
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-blue-800"
                  />
                ) : null}
              </button>
            ))
          ) : (
            <p className="px-3 py-3 text-[13px] text-slate-500">
              No Indian state or union territory found.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function AadhaarNumberField({
  label,
  value,
  onValueChange,
  error,
  revealError,
  required,
  readOnly,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  revealError: boolean;
  required: boolean;
  readOnly: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const digits = normalizeAadhaarNumber(value);
  const showMaskedValue = digits.length === 12 && !focused;

  return (
    <ShipmentTextField
      label={label}
      required={required}
      type={showMaskedValue ? "text" : "password"}
      autoComplete="off"
      inputMode="numeric"
      value={showMaskedValue ? `XXXX XXXX ${digits.slice(-4)}` : formatAadhaarNumber(digits)}
      onChange={(event) => onValueChange(normalizeAadhaarNumber(event.target.value))}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      error={error}
      revealError={revealError}
      readOnly={readOnly}
      placeholder="Enter 12-digit Aadhaar number"
      maxLength={14}
    />
  );
}

function AadhaarOcrControl({
  shipmentDraftId,
  form,
  onFormChange,
  csbType,
  kycScope,
  parcels,
  savedParcelCount,
  onParcelAadhaarChange,
  onKycDocumentsChange,
  api,
}: {
  shipmentDraftId: string;
  form: ConsignorForm;
  onFormChange: (next: ConsignorForm) => void;
  csbType: CsbType;
  kycScope: AadhaarOcrScope;
  parcels: ParcelKycState[];
  savedParcelCount: number;
  onParcelAadhaarChange: (sequence: number, value: string) => void;
  onKycDocumentsChange: (documents: ShipmentKycDocuments, parcelSequence?: number) => void;
  api: NonNullable<ConsignorKycApi["ocrAadhaar"]>;
}) {
  const [frontFile, setFrontFile] = useState<File | null>(null);
  const [backFile, setBackFile] = useState<File | null>(null);
  const [parcelSequence, setParcelSequence] = useState(parcels[0]?.sequence ?? 1);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [prefill, setPrefill] = useState<AadhaarOcrPrefill | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [dropTarget, setDropTarget] = useState<"front" | "back" | null>(null);
  const frontInputRef = useRef<HTMLInputElement>(null);
  const backInputRef = useRef<HTMLInputElement>(null);
  const latestValues = useRef({ form, parcels });
  useEffect(() => {
    latestValues.current = { form, parcels };
  }, [form, parcels]);
  const selectedParcel = parcels.find((parcel) => parcel.sequence === parcelSequence);
  const selectedParcelSaved = Boolean(selectedParcel && parcelSequence <= savedParcelCount);
  const currentAadhaarNumber = kycScope === "shared"
    ? form.aadhaarNumber
    : selectedParcel?.aadhaarNumber ?? "";

  function acceptFile(file: File | undefined, side: "front" | "back") {
    setError("");
    setPrefill(null);
    setConfirmReplace(false);
    if (!file) {
      if (side === "front") setFrontFile(null);
      else setBackFile(null);
      return;
    }
    if (!new Set(["application/pdf", "image/jpeg", "image/png"]).has(file.type)) {
      setError("Choose a PDF, JPG, or PNG file.");
      if (side === "front") setFrontFile(null);
      else setBackFile(null);
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Each Aadhaar file must be 5 MB or smaller.");
      if (side === "front") setFrontFile(null);
      else setBackFile(null);
      return;
    }
    if (side === "front") setFrontFile(file);
    else setBackFile(file);
  }

  function readFile(event: ChangeEvent<HTMLInputElement>, side: "front" | "back") {
    acceptFile(event.target.files?.[0], side);
    event.target.value = "";
  }

  function handleDragOver(event: ReactDragEvent<HTMLDivElement>, side: "front" | "back") {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = busy ? "none" : "copy";
    if (!busy) setDropTarget(side);
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>, side: "front" | "back") {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    setDropTarget(null);
    if (busy) return;
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      setError("Drop one file into this upload area.");
      return;
    }
    acceptFile(files[0], side);
  }

  async function scan() {
    const isCompletePdf = Boolean(frontFile?.type === "application/pdf" && !backFile);
    const upload = isCompletePdf && frontFile
      ? { pdf: frontFile }
      : (frontFile && backFile ? { front: frontFile, back: backFile } : null);
    if (!upload || !consent) return;
    setBusy(true);
    setError("");
    setPrefill(null);
    try {
      const result = await api({
        shipmentDraftId,
        ...upload,
        kycScope,
        parcelSequence: kycScope === "parcel" ? parcelSequence : undefined,
      });
      const current = latestValues.current;
      const currentNumber = kycScope === "shared"
        ? current.form.aadhaarNumber
        : current.parcels.find((parcel) => parcel.sequence === parcelSequence)?.aadhaarNumber ?? "";
      applyExtractedDetails(result.prefill, current.form, currentNumber, false);
      setPrefill(result.prefill);
      onKycDocumentsChange(result.kycDocuments, result.parcelSequence);
      setFrontFile(null);
      setBackFile(null);
      if (frontInputRef.current) frontInputRef.current.value = "";
      if (backInputRef.current) backInputRef.current.value = "";
      toast.success(isCompletePdf ? "Aadhaar PDF saved to this booking KYC." : "Aadhaar front and back saved to this booking KYC.");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "Aadhaar scanning failed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const safeValue = (value: string, maxLength: number) =>
    value.trim() && value.trim().length <= maxLength ? value.trim() : "";
  function applyExtractedDetails(
    extracted: AadhaarOcrPrefill,
    currentForm: ConsignorForm,
    currentNumber: string,
    replaceExisting: boolean,
  ) {
    const fill = (incoming: string, current: string, maxLength: number, uppercase = true) => {
      const value = safeValue(incoming, maxLength);
      if (!value || (!replaceExisting && current.trim())) return current;
      return uppercase ? value.toUpperCase() : value;
    };
    const number = isValidAadhaarNumber(extracted.aadhaarNumber) ? extracted.aadhaarNumber : "";
    const nextForm: ConsignorForm = {
      ...currentForm,
      contactName: fill(extracted.fullName, currentForm.contactName, 120),
      addressLine1: fill(extracted.address.addressLine1, currentForm.addressLine1, 120),
      addressLine2: fill(extracted.address.addressLine2, currentForm.addressLine2, 120),
      townOrCity: fill(extracted.address.townOrCity, currentForm.townOrCity, 80),
      county: fill(normalizeIndiaState(extracted.address.county), currentForm.county, 80),
      postcode: fill(extracted.address.postcode, currentForm.postcode, 20, false),
      aadhaarNumber: kycScope === "shared" && number && (replaceExisting || !currentForm.aadhaarNumber.trim())
        ? number
        : currentForm.aadhaarNumber,
    };
    if ((Object.keys(nextForm) as Array<keyof ConsignorForm>).some((key) => nextForm[key] !== currentForm[key])) {
      onFormChange(nextForm);
    }
    if (kycScope === "parcel" && number && number !== currentNumber && (replaceExisting || !currentNumber.trim())) {
      onParcelAadhaarChange(parcelSequence, number);
    }
  }
  const stateValue = prefill ? normalizeIndiaState(prefill.address.county) : "";
  const extractedAadhaarNumber = prefill && isValidAadhaarNumber(prefill.aadhaarNumber)
    ? prefill.aadhaarNumber
    : "";
  const candidateChanges = prefill ? [
    [safeValue(prefill.fullName, 120), form.contactName],
    [safeValue(prefill.address.addressLine1, 120), form.addressLine1],
    [safeValue(prefill.address.addressLine2, 120), form.addressLine2],
    [safeValue(prefill.address.townOrCity, 80), form.townOrCity],
    [safeValue(stateValue, 80), form.county],
    [safeValue(prefill.address.postcode, 20), form.postcode],
    [extractedAadhaarNumber, currentAadhaarNumber],
  ] : [];
  const hasExistingValuesToReplace = candidateChanges.some(([incoming, current]) =>
    Boolean(incoming && current.trim() && incoming.toLocaleLowerCase() !== current.trim().toLocaleLowerCase()),
  );
  const hasOverlengthValues = Boolean(prefill && (
    prefill.fullName.length > 120
    || prefill.address.addressLine1.length > 120
    || prefill.address.addressLine2.length > 120
    || prefill.address.townOrCity.length > 80
    || stateValue.length > 80
    || prefill.address.postcode.length > 20
  ));

  function applyPrefill() {
    if (!prefill || !hasExistingValuesToReplace) return;
    if (!confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    applyExtractedDetails(prefill, form, currentAadhaarNumber, true);
    setPrefill(null);
    setConfirmReplace(false);
  }

  const canScan = Boolean(
    frontFile && (frontFile.type === "application/pdf" && !backFile || backFile)
      && consent && !busy && (kycScope === "shared" || selectedParcelSaved),
  );

  return (
    <section className="overflow-visible rounded-md border border-slate-200 bg-white shadow-sm" aria-label="Aadhaar OCR and KYC upload">
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-t-md border-b border-blue-100 bg-blue-50/50 px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-white text-blue-900 shadow-sm ring-1 ring-blue-100">
            <FiFileText aria-hidden="true" className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-900">Scan Aadhaar</h3>
            <p className="mt-0.5 text-[11px] leading-4 text-slate-600">Scan to fill consignor details.</p>
          </div>
        </div>
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[10px] font-semibold ${csbType === "CSB_V" ? "border-blue-200 bg-white text-blue-900" : "border-slate-200 bg-white text-slate-600"}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${csbType === "CSB_V" ? "bg-blue-700" : "bg-slate-400"}`} />
          {csbType === "CSB_V" ? "Required for CSB-V" : "Optional for CSB-IV"}
        </span>
      </header>

      {kycScope === "parcel" ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-3 py-2.5 sm:px-4">
          <label htmlFor="aadhaar-ocr-parcel" className="text-[11px] font-semibold text-slate-700">Save to parcel</label>
          <select
            id="aadhaar-ocr-parcel"
            value={parcelSequence}
            onChange={(event) => setParcelSequence(Number(event.target.value))}
            disabled={busy || Boolean(prefill) || parcels.length === 0}
            className="h-8 rounded-md border border-slate-300 bg-white px-2.5 text-[11px] text-slate-800 outline-none focus:border-blue-800 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100"
          >
            {parcels.map((parcel, index) => (
              <option key={parcel.sequence} value={parcel.sequence}>
                Parcel {index + 1}{parcel.sequence > savedParcelCount ? " · save first" : ""}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="grid gap-3 p-3 sm:p-4 xl:grid-cols-[minmax(210px,0.78fr)_minmax(0,2fr)]">
        <aside className="flex flex-col justify-between gap-3" aria-label="Masked Aadhaar example">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold text-slate-800">Masked Aadhaar</h4>
          </div>
          <Image
            src="/images/aadhaar-sample-card.webp"
            alt="Fictional sample card showing the masked number XXXX XXXX 1234."
            width={900}
            height={600}
            sizes="(min-width: 1024px) 260px, 100vw"
            className="mx-auto h-auto w-full max-w-[260px] rounded-md border border-slate-200"
          />
        </aside>

        <div className="grid content-start gap-3">
          <div className="flex items-center gap-2">
            <h4 className="text-xs font-semibold text-slate-800">Upload Aadhaar</h4>
            <InfoTooltip
              className="shrink-0"
              placement="left"
              text="Scans fill consignor details and save the file to KYC. Upload a one-page PDF with both sides, a two-page PDF (front then back), or separate front and back files. PDF, JPG, or PNG, up to 5 MB per file."
            />
          </div>

          <div className="grid gap-2.5 sm:grid-cols-2">
            <div
              onDragOver={(event) => handleDragOver(event, "front")}
              onDragLeave={(event) => {
                if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null);
              }}
              onDrop={(event) => handleDrop(event, "front")}
              className={`flex min-h-[104px] min-w-0 flex-col justify-between gap-3 rounded-md border border-dashed p-3 transition ${dropTarget === "front" ? "border-blue-500 bg-blue-50 ring-2 ring-blue-100" : frontFile ? "border-emerald-300 bg-emerald-50/50" : "border-slate-300 bg-white hover:border-blue-400 hover:bg-blue-50/30"} ${busy ? "opacity-60" : ""}`}
            >
              <input ref={frontInputRef} type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" disabled={busy} onChange={(event) => readFile(event, "front")} className="sr-only" aria-label="Choose Aadhaar front image or complete PDF" tabIndex={-1} aria-hidden="true" />
              <div className="flex min-w-0 items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block text-[11px] font-semibold text-slate-800">Front side or complete PDF</span>
                </span>
              </div>
              <button type="button" onClick={() => frontInputRef.current?.click()} disabled={busy} className="flex min-h-9 w-full min-w-0 items-center justify-between gap-2 border-t border-slate-100 pt-2 text-left text-[10px] text-slate-600 transition hover:text-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
                <span className="min-w-0 truncate" title={frontFile?.name}>{frontFile?.name || "Drop front image or full PDF"}</span>
                {frontFile ? <FiCheck aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-emerald-700" /> : <FiUploadCloud aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
              </button>
            </div>

            <div
              onDragOver={(event) => handleDragOver(event, "back")}
              onDragLeave={(event) => {
                if (!event.relatedTarget || !event.currentTarget.contains(event.relatedTarget as Node)) setDropTarget(null);
              }}
              onDrop={(event) => handleDrop(event, "back")}
              className={`flex min-h-[104px] min-w-0 flex-col justify-between gap-3 rounded-md border border-dashed p-3 transition ${dropTarget === "back" ? "border-blue-500 bg-blue-50 ring-2 ring-blue-100" : backFile ? "border-emerald-300 bg-emerald-50/50" : "border-slate-300 bg-white hover:border-blue-400 hover:bg-blue-50/30"} ${busy ? "opacity-60" : ""}`}
            >
              <input ref={backInputRef} type="file" accept="application/pdf,image/jpeg,image/png,.pdf,.jpg,.jpeg,.png" disabled={busy} onChange={(event) => readFile(event, "back")} className="sr-only" aria-label="Choose Aadhaar back file" tabIndex={-1} aria-hidden="true" />
              <div className="flex min-w-0 items-start justify-between gap-2">
                <span className="min-w-0">
                  <span className="block text-[11px] font-semibold text-slate-800">Back side</span>
                  <span className="mt-0.5 block text-[10px] text-slate-500">Address side</span>
                </span>
              </div>
              <button type="button" onClick={() => backInputRef.current?.click()} disabled={busy} className="flex min-h-9 w-full min-w-0 items-center justify-between gap-2 border-t border-slate-100 pt-2 text-left text-[10px] text-slate-600 transition hover:text-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50">
                <span className="min-w-0 truncate" title={backFile?.name}>{backFile?.name || "Drop the back side here"}</span>
                {backFile ? <FiCheck aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-emerald-700" /> : <FiUploadCloud aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-slate-400" />}
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-2.5 border-t border-slate-100 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] font-medium text-slate-700">
              <input type="checkbox" checked={consent} disabled={busy} onChange={(event) => setConsent(event.target.checked)} className="h-4 w-4 shrink-0 accent-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2" />
              <span className="font-semibold text-slate-800">I have the Aadhaar holder’s consent</span>
            </label>
            <button type="button" onClick={() => void scan()} disabled={!canScan} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-md bg-blue-900 px-4 text-[11px] font-semibold text-white shadow-sm transition hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-blue-900 disabled:shadow-none">
              <FiFileText aria-hidden="true" className="h-4 w-4" />
              {busy ? "Scanning..." : "Scan and save KYC"}
            </button>
          </div>
        </div>

        <div className="grid gap-2 xl:col-span-2">
          {kycScope === "parcel" && !selectedParcelSaved ? <p className="text-[11px] text-amber-800">Save this parcel before scanning its Aadhaar.</p> : null}
          {error ? <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[11px] font-medium text-red-800">{error}</p> : null}

        {prefill ? (
          <section className="overflow-hidden rounded-md border border-blue-200 bg-white" aria-live="polite">
            <header className="border-b border-blue-100 bg-blue-50/60 px-3 py-2.5 sm:px-4">
              <div className="min-w-0">
                <h4 className="text-[12px] font-semibold text-slate-900">Review extracted details</h4>
              </div>
            </header>

            <dl className="grid gap-2.5 p-3 text-[12px] sm:grid-cols-2 sm:p-4">
              <div className="rounded-md bg-slate-50 px-3 py-2">
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Full name</dt>
                <dd className="mt-1 break-words font-medium text-slate-900">{prefill.fullName || "Not detected"}</dd>
              </div>
              <div className="rounded-md bg-slate-50 px-3 py-2">
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Aadhaar number</dt>
                <dd className="mt-1 font-semibold tracking-wide text-slate-900">{extractedAadhaarNumber ? `XXXX XXXX ${extractedAadhaarNumber.slice(-4)}` : "Not safely extracted"}</dd>
              </div>
              <div className="rounded-md bg-slate-50 px-3 py-2 sm:col-span-2">
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Full address</dt>
                <dd className="mt-1 break-words leading-5 text-slate-900">{prefill.address.fullAddress || "Not detected"}</dd>
              </div>
              <div className="rounded-md bg-slate-50 px-3 py-2">
                <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Town / city</dt>
                <dd className="mt-1 break-words font-medium text-slate-900">{prefill.address.townOrCity || "Review manually"}</dd>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md bg-slate-50 px-3 py-2">
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">State</dt>
                  <dd className="mt-1 break-words font-medium text-slate-900">{prefill.address.county || "-"}</dd>
                </div>
                <div className="rounded-md bg-slate-50 px-3 py-2">
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">PIN</dt>
                  <dd className="mt-1 font-medium text-slate-900">{prefill.address.postcode || "-"}</dd>
                </div>
              </div>
            </dl>

            <div className="mx-3 mb-3 flex gap-1.5 rounded-md border border-blue-100 bg-blue-50 px-2.5 py-2 text-[11px] leading-4 text-blue-900 sm:mx-4">
              <FiInfo aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <p>
                Please verify the scanned details against the Aadhaar document and correct any errors before booking.
                {hasOverlengthValues ? " Enter values that do not fit the form manually." : ""}
                {hasExistingValuesToReplace ? confirmReplace
                  ? " Confirm only if you want to replace details you entered."
                  : " Some existing values differ; review them before choosing to replace them."
                  : ""}
              </p>
            </div>

            <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-3 py-2.5 sm:px-4">
              <button type="button" onClick={() => { setPrefill(null); setConfirmReplace(false); }} className="inline-flex h-8 items-center justify-center rounded-md border border-blue-200 bg-blue-50 px-3 text-[11px] font-semibold text-blue-900 transition hover:border-blue-300 hover:bg-blue-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2">
                Dismiss
              </button>
              {hasExistingValuesToReplace ? (
                <>
                  {confirmReplace ? <button type="button" onClick={() => setConfirmReplace(false)} className="inline-flex h-8 items-center justify-center rounded-md border border-slate-300 bg-white px-3 text-[11px] font-semibold text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700">Keep existing</button> : null}
                  <button type="button" onClick={applyPrefill} className="inline-flex h-8 items-center justify-center rounded-md bg-blue-900 px-3.5 text-[11px] font-semibold text-white transition hover:bg-blue-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2">
                    {confirmReplace ? "Confirm replacement" : "Replace existing details"}
                  </button>
                </>
              ) : null}
            </footer>
          </section>
        ) : null}
        </div>
      </div>
    </section>
  );
}

function KycSlotRow({
  slots,
  csbType,
  documents,
  showStoredAadhaarBack = false,
  submitAttempted,
  readOnly,
  disabled,
  onUpload,
  onDelete,
  onOpen,
}: {
  slots: SlotConfig[];
  csbType: CsbType;
  documents: ShipmentKycDocuments | undefined;
  showStoredAadhaarBack?: boolean;
  submitAttempted: boolean;
  readOnly: boolean;
  disabled: boolean;
  onUpload: (
    type: ShipmentKycDocumentType,
    file: File,
    documentLabel?: string,
  ) => Promise<void>;
  onDelete: (type: ShipmentKycDocumentType) => Promise<void>;
  onOpen: (type: ShipmentKycDocumentType) => Promise<Blob>;
}) {
  return (
    <div
      className="grid items-stretch gap-3"
      style={{
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 15rem), 1fr))",
      }}
    >
      {slots.map((slot) => {
        const supportsOptionalAadhaarBack =
          csbType === "CSB_IV" && slot.type === "aadhaar";
        const showsAadhaarBack =
          supportsOptionalAadhaarBack || (showStoredAadhaarBack && slot.type === "aadhaar");

        return (
          <KycSlot
            key={slot.type}
            slot={slot}
            document={documents?.[slot.type] ?? null}
            secondaryDocument={showsAadhaarBack ? (documents?.aadhaarBack ?? null) : null}
            submitAttempted={submitAttempted}
            readOnly={readOnly}
            disabled={disabled}
            onUpload={(file, label) => onUpload(slot.type, file, label)}
            onDelete={() => onDelete(slot.type)}
            onOpen={() => onOpen(slot.type)}
            onUploadSecondary={
              supportsOptionalAadhaarBack
                ? (file) => onUpload("aadhaarBack", file)
                : undefined
            }
            onDeleteSecondary={showsAadhaarBack ? () => onDelete("aadhaarBack") : undefined}
            onOpenSecondary={showsAadhaarBack ? () => onOpen("aadhaarBack") : undefined}
          />
        );
      })}
    </div>
  );
}

function KycSlot({
  slot,
  document,
  secondaryDocument,
  submitAttempted,
  readOnly,
  disabled,
  onUpload,
  onDelete,
  onOpen,
  onUploadSecondary,
  onDeleteSecondary,
  onOpenSecondary,
}: {
  slot: SlotConfig;
  document: ShipmentKycDocument | null;
  secondaryDocument: ShipmentKycDocument | null;
  submitAttempted: boolean;
  readOnly: boolean;
  disabled: boolean;
  onUpload: (file: File, documentLabel?: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onOpen: () => Promise<Blob>;
  onUploadSecondary?: (file: File) => Promise<void>;
  onDeleteSecondary?: () => Promise<void>;
  onOpenSecondary?: () => Promise<Blob>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const secondaryInputRef = useRef<HTMLInputElement>(null);
  const secondaryDropRef = useRef<HTMLDivElement>(null);
  const [documentLabel, setDocumentLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [dropTarget, setDropTarget] = useState<"primary" | "secondary" | null>(
    null,
  );

  const missing = slot.required && !document;
  const labelReady =
    !slot.needsLabel ||
    Boolean(documentLabel.trim() || document?.documentLabel);

  async function uploadPrimaryFile(file: File) {
    if (readOnly || disabled || busy) return;
    const label = documentLabel.trim() || document?.documentLabel || "";
    if (slot.needsLabel && !label) {
      toast.info("Type what the other document is before uploading it.");
      return;
    }
    setBusy(true);
    try {
      await onUpload(file, slot.needsLabel ? label.toUpperCase() : undefined);
      setDocumentLabel("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadSecondaryFile(file: File) {
    if (!onUploadSecondary || readOnly || disabled || busy) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      toast.error("The Aadhaar back side must be a JPG or PNG image.");
      return;
    }

    setBusy(true);
    try {
      await onUploadSecondary(file);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await uploadPrimaryFile(file);
  }

  async function handleSecondaryFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) await uploadSecondaryFile(file);
  }

  function isFileDrag(event: ReactDragEvent<HTMLDivElement>) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function isSecondaryTarget(target: EventTarget | null) {
    return Boolean(
      target && secondaryDropRef.current?.contains(target as Node),
    );
  }

  function handleDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    if (readOnly || disabled || busy) {
      event.dataTransfer.dropEffect = "none";
      setDropTarget(null);
      return;
    }
    setDropTarget(isSecondaryTarget(event.target) ? "secondary" : "primary");
  }

  function handleDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect =
      readOnly || disabled || busy ? "none" : "copy";
    if (readOnly || disabled || busy) {
      setDropTarget(null);
      return;
    }
    setDropTarget(isSecondaryTarget(event.target) ? "secondary" : "primary");
  }

  function handleDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    if (
      !event.relatedTarget ||
      !event.currentTarget.contains(event.relatedTarget as Node)
    ) {
      setDropTarget(null);
    }
  }

  async function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    const files = Array.from(event.dataTransfer.files);
    const secondary = isSecondaryTarget(event.target);
    setDropTarget(null);
    if (readOnly || disabled || busy || !files.length) return;
    if (files.length !== 1) {
      toast.info("Drop one document at a time.");
      return;
    }
    if (secondary) {
      await uploadSecondaryFile(files[0]);
      return;
    }
    await uploadPrimaryFile(files[0]);
  }

  async function handleRemove() {
    setBusy(true);
    try {
      await onDelete();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not remove the document.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen() {
    try {
      openBlobInNewTab(await onOpen());
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not open the document.",
      );
    }
  }

  async function handleRemoveSecondary() {
    if (!onDeleteSecondary) return;
    setBusy(true);
    try {
      await onDeleteSecondary();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not remove the back image.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleOpenSecondary() {
    if (!onOpenSecondary) return;
    try {
      openBlobInNewTab(await onOpenSecondary());
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not open the back image.",
      );
    }
  }

  const primaryIsImage =
    document?.mimeType === "image/jpeg" || document?.mimeType === "image/png";
  const showSecondaryControl = Boolean(
    secondaryDocument || (onUploadSecondary && primaryIsImage && !readOnly),
  );
  const dropAllowed = !readOnly && !disabled && !busy;

  return (
    <div
      data-kyc-dropzone={slot.type}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative z-0 flex min-h-[204px] min-w-0 flex-col gap-3 rounded-xl border bg-white p-3 text-[11px] shadow-sm transition hover:z-40 focus-within:z-40 ${
        dropTarget
          ? "border-blue-500 bg-blue-50/50 ring-2 ring-blue-200"
          : missing && submitAttempted
            ? "border-red-300"
            : "border-slate-200 hover:border-slate-300"
      }`}
    >
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/jpeg,image/png"
        className="hidden"
        onChange={handleFile}
      />
      {onUploadSecondary ? (
        <input
          ref={secondaryInputRef}
          type="file"
          accept="image/jpeg,image/png"
          className="hidden"
          onChange={handleSecondaryFile}
        />
      ) : null}

      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[12px] font-semibold text-slate-800">
            {slot.title}
          </span>
          {slot.required ? (
            <span className="shrink-0 rounded-full bg-rose-50 px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-rose-700">
              Required
            </span>
          ) : (
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-slate-500">
              Optional
            </span>
          )}
        </div>
        <KycHelpTooltip title={slot.title} text={slot.helpText} />
      </div>

      {slot.needsLabel && !readOnly ? (
        <label className="block">
          <span className="sr-only">Other document name</span>
          <input
            value={documentLabel}
            onChange={(event) =>
              setDocumentLabel(event.target.value.toUpperCase())
            }
            placeholder={document?.documentLabel || "Name this document"}
            disabled={disabled || busy}
            maxLength={80}
            className="h-9 w-full rounded border border-slate-300 bg-white px-2.5 text-[12px] text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-800 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-100"
          />
        </label>
      ) : null}

      {document ? (
        <div className="flex min-h-[94px] flex-1 flex-col justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50/80 p-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-900">
              <FiFileText aria-hidden="true" className="h-4 w-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                Uploaded
              </span>
              <button
                type="button"
                onClick={handleOpen}
                className="block max-w-full truncate text-left text-[11px] font-medium text-slate-800 hover:text-blue-900 hover:underline"
                title={document.documentLabel || document.originalName}
              >
                {document.documentLabel || document.originalName}
              </button>
            </span>
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-slate-200 pt-2">
            <span className="min-w-0 truncate text-[10px] text-slate-500">
              {readOnly
                ? "View only"
                : disabled
                  ? "Save shipment to replace"
                  : "Drop a file to replace"}
            </span>
            {!readOnly ? (
              <span className="flex shrink-0 items-center gap-2">
                <button
                  type="button"
                  aria-label={`Replace ${slot.title} document`}
                  onClick={() => inputRef.current?.click()}
                  disabled={busy || disabled || !labelReady}
                  className="font-semibold text-blue-900 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Replace
                </button>
                <button
                  type="button"
                  onClick={handleRemove}
                  disabled={busy}
                  className="inline-flex items-center gap-1 font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
                >
                  <FiTrash2 aria-hidden="true" className="h-3 w-3" />
                  Remove
                </button>
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <div
          className={`flex min-h-[94px] flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-3 text-center transition ${dropTarget === "primary" ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-slate-50/50"} ${!dropAllowed ? "opacity-70" : ""}`}
        >
          {!readOnly ? (
            <button
              type="button"
              aria-label={`Upload ${slot.title} document`}
              title={`Upload ${slot.title} document`}
              onClick={() => inputRef.current?.click()}
              disabled={busy || disabled || !labelReady}
              className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-blue-900 transition hover:border-blue-800 hover:bg-blue-50 hover:text-blue-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FiUploadCloud aria-hidden="true" className="h-5 w-5" />
            </button>
          ) : null}
          <span className="text-[11px] leading-4 text-slate-600">
            {disabled
              ? "Save shipment to upload"
              : readOnly
                ? "No document uploaded"
                : busy
                  ? "Uploading..."
                  : dropTarget === "primary"
                    ? "Release to upload"
                    : "Drop a file here"}
          </span>
        </div>
      )}

      {showSecondaryControl ? (
        <div
          ref={secondaryDropRef}
          className={`flex min-w-0 items-center justify-between gap-2 rounded-lg border border-dashed px-2.5 py-2 transition ${dropTarget === "secondary" ? "border-emerald-500 bg-emerald-50" : "border-emerald-200 bg-emerald-50/40"}`}
        >
          {secondaryDocument ? (
            <>
              <button
                type="button"
                onClick={handleOpenSecondary}
                className="flex min-w-0 items-center gap-1.5 text-left text-emerald-900 hover:underline"
              >
                <FiFileText
                  aria-hidden="true"
                  className="h-3.5 w-3.5 shrink-0"
                />
                <span className="min-w-0 truncate font-medium">
                  Back: {secondaryDocument.originalName}
                </span>
              </button>
              {!readOnly ? (
                <span className="flex shrink-0 items-center gap-2">
                  {onUploadSecondary ? (
                    <button
                      type="button"
                      aria-label="Replace Aadhaar back side"
                      onClick={() => secondaryInputRef.current?.click()}
                      disabled={busy || disabled}
                      className="font-semibold text-emerald-800 hover:underline disabled:opacity-50"
                    >
                      Replace
                    </button>
                  ) : null}
                  {onDeleteSecondary ? (
                    <button
                      type="button"
                      onClick={handleRemoveSecondary}
                      disabled={busy}
                      className="inline-flex items-center gap-1 font-semibold text-red-600 hover:text-red-700 disabled:opacity-50"
                    >
                      <FiTrash2 aria-hidden="true" className="h-3 w-3" />
                      Remove
                    </button>
                  ) : null}
                </span>
              ) : null}
            </>
          ) : (
            <>
              <span className="min-w-0 text-[10px] font-medium text-emerald-900">
                Drop back side here or choose a file
              </span>
              {!readOnly ? (
                <button
                  type="button"
                  aria-label="Browse Aadhaar back side image"
                  onClick={() => secondaryInputRef.current?.click()}
                  disabled={busy || disabled}
                  className="shrink-0 font-semibold text-emerald-800 hover:underline disabled:opacity-50"
                >
                  Browse
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function KycHelpTooltip({ title, text }: { title: string; text: string }) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const hideTimeoutRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);

  function cancelHide() {
    if (hideTimeoutRef.current !== null) {
      window.clearTimeout(hideTimeoutRef.current);
      hideTimeoutRef.current = null;
    }
  }

  function show() {
    cancelHide();
    setOpen(true);
  }

  function scheduleHide() {
    cancelHide();
    hideTimeoutRef.current = window.setTimeout(() => {
      setOpen(false);
      hideTimeoutRef.current = null;
    }, 150);
  }

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      const tooltip = tooltipRef.current;
      if (!trigger || !tooltip) return;

      const anchor = trigger.getBoundingClientRect();
      const width = Math.max(0, Math.min(256, window.innerWidth - 16));
      tooltip.style.width = `${width}px`;
      tooltip.style.maxHeight = `${Math.max(0, window.innerHeight - 16)}px`;

      const height = tooltip.getBoundingClientRect().height;
      const left = Math.max(
        8,
        Math.min(
          anchor.left + anchor.width / 2 - width / 2,
          window.innerWidth - width - 8,
        ),
      );
      let top = anchor.bottom + 8;
      if (top + height > window.innerHeight - 8 && anchor.top >= height + 16) {
        top = anchor.top - height - 8;
      }
      top = Math.max(8, Math.min(top, window.innerHeight - height - 8));

      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !triggerRef.current?.contains(target) &&
        !tooltipRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      cancelHide();
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`${title} upload guidance`}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        onMouseEnter={show}
        onMouseLeave={scheduleHide}
        onFocus={show}
        onBlur={scheduleHide}
        onClick={show}
        className="ml-auto inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-500 outline-none transition hover:text-blue-900 focus-visible:ring-2 focus-visible:ring-blue-700 focus-visible:ring-offset-2"
      >
        <FiInfo aria-hidden="true" className="h-3 w-3" />
      </button>
      {open && typeof document !== "undefined"
        ? createPortal(
            <span
              data-portal-theme-scope
              ref={tooltipRef}
              id={tooltipId}
              role="tooltip"
              onMouseEnter={cancelHide}
              onMouseLeave={scheduleHide}
              style={{ left: -10_000, top: -10_000, width: 256 }}
              className="fixed z-[100] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 px-3 py-2.5 text-left text-[11px] font-normal normal-case leading-4 tracking-normal text-white shadow-lg"
            >
              <span className="mb-1 block font-semibold text-white">
                {title}
              </span>
              <span className="block">{text}</span>
            </span>,
            document.body,
          )
        : null}
    </>
  );
}
