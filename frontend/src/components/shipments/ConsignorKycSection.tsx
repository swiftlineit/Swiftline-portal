"use client";

import { ChangeEvent, type KeyboardEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { FiCheck, FiChevronDown, FiFileText, FiMapPin, FiSearch, FiTrash2, FiUploadCloud } from "react-icons/fi";
import { toast } from "react-toastify";
import {
  ShipmentFieldLabel,
  ShipmentFixedCountryField,
  ShipmentTextField
} from "@/components/shipments/ShipmentFormControls";
import { formatAadhaarNumber, isValidAadhaarNumber, normalizeAadhaarNumber } from "@/lib/aadhaar";
import type {
  AddressPrediction,
  ShipmentKycDocument,
  ShipmentKycDocumentType,
  ShipmentKycDocuments
} from "@/lib/dpdLabels";
import {
  requiredShipmentKycDocumentTypes,
  shipmentKycDocumentLabels,
  shipmentKycDocumentSlots
} from "@/lib/dpdLabels";
import type { CsbType } from "@/lib/csbType";
import { indiaStates, normalizeIndiaState } from "@/lib/indiaStates";
import type { ConsignorForm, ParcelKycState } from "@/lib/shipmentConsignor";
import { nextContactNameOnCompanyChange } from "@/lib/shipmentConsignor";

type ConsignorFieldIssues = Partial<Record<keyof ConsignorForm, string>>;

export type ConsignorKycApi = {
  autocompleteConsignorAddress: (input: string) => Promise<{ predictions: AddressPrediction[] }>;
  getConsignorPlaceAddress: (placeId: string, shipmentDraftId: string) => Promise<{
    place: { address: { addressLine1: string; addressLine2: string; townOrCity: string; county: string; postcode: string } };
  }>;
  uploadKycDocument: (input: { shipmentDraftId: string; type: ShipmentKycDocumentType; file: File; documentLabel?: string }) => Promise<{ kycDocuments: ShipmentKycDocuments }>;
  deleteKycDocument: (shipmentDraftId: string, type: ShipmentKycDocumentType) => Promise<{ kycDocuments: ShipmentKycDocuments }>;
  openKycDocument: (shipmentDraftId: string, type: ShipmentKycDocumentType) => Promise<Blob>;
  uploadParcelKycDocument: (input: { shipmentDraftId: string; sequence: number; type: ShipmentKycDocumentType; file: File; documentLabel?: string }) => Promise<{ kycDocuments: ShipmentKycDocuments }>;
  deleteParcelKycDocument: (shipmentDraftId: string, sequence: number, type: ShipmentKycDocumentType) => Promise<{ kycDocuments: ShipmentKycDocuments }>;
  openParcelKycDocument: (shipmentDraftId: string, sequence: number, type: ShipmentKycDocumentType) => Promise<Blob>;
};

type SlotConfig = {
  type: ShipmentKycDocumentType;
  title: string;
  required: boolean;
  needsLabel: boolean;
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
  headerAction
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
  onParcelKycChange: (sequence: number, documents: ShipmentKycDocuments) => void;
  api: ConsignorKycApi;
  headerAction?: ReactNode;
}) {
  const [addressQuery, setAddressQuery] = useState("");
  const [predictions, setPredictions] = useState<AddressPrediction[]>([]);
  const [addressBusy, setAddressBusy] = useState(false);

  // Every slot the route offers is rendered; only CSB-V marks them required.
  const requiredTypes = requiredShipmentKycDocumentTypes(csbType);
  const kycSlots: SlotConfig[] = [
    ...shipmentKycDocumentSlots(csbType).map((type) => ({
      type,
      title: shipmentKycDocumentLabels[type],
      required: requiredTypes.includes(type),
      needsLabel: false
    })),
    // Always last and optional for both routes. Its typed label identifies what
    // the additional document contains when it is viewed later.
    {
      type: "other",
      title: "Other Document",
      required: false,
      needsLabel: true
    }
  ];

  function setField(field: keyof ConsignorForm) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = field === "email" ? event.target.value : event.target.value.toUpperCase();
      if (field === "companyName") {
        return onFormChange({
          ...form,
          companyName: nextValue,
          contactName: nextContactNameOnCompanyChange(form.companyName, form.contactName, nextValue)
        });
      }
      return onFormChange({
        ...form,
        [field]: nextValue
      });
    };
  }

  async function handleAddressSearch() {
    if (!addressQuery.trim()) return;
    setAddressBusy(true);
    try {
      const data = await api.autocompleteConsignorAddress(addressQuery.trim());
      setPredictions(data.predictions);
      if (!data.predictions.length) toast.info("No matching Indian address was found. Enter the address manually.");
    } catch (error) {
      setPredictions([]);
      toast.error(error instanceof Error ? error.message : "Address search is unavailable right now.");
    } finally {
      setAddressBusy(false);
    }
  }

  async function handleSelectPrediction(prediction: AddressPrediction) {
    setAddressBusy(true);
    try {
      const data = await api.getConsignorPlaceAddress(prediction.placeId, shipmentDraftId);
      const resolvedState = normalizeIndiaState(data.place.address.county || form.county);
      onFormChange({
        ...form,
        addressLine1: (data.place.address.addressLine1 || form.addressLine1).toUpperCase(),
        addressLine2: (data.place.address.addressLine2 || form.addressLine2).toUpperCase(),
        townOrCity: (data.place.address.townOrCity || form.townOrCity).toUpperCase(),
        // The provider returns this as `county`, while the form stores the
        // Indian state. Resolve it to the same option used by the combobox so
        // selecting a searched address also selects its state.
        county: resolvedState.toUpperCase(),
        postcode: data.place.address.postcode || form.postcode
      });
      setPredictions([]);
      setAddressQuery("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to select this address.");
    } finally {
      setAddressBusy(false);
    }
  }

  // The Aadhaar number identifies the sender and is required on every route.
  // Only the document uploads follow the CSB checklist.
  const aadhaarRequired = true;
  const aadhaarError = (value: string) => {
    if (!submitAttempted) return undefined;
    if (!value.trim()) return "Aadhaar number is required";
    return isValidAadhaarNumber(value) ? undefined : "Enter a valid 12 digit Aadhaar number";
  };
  const sharedAadhaarError = kycUseForAll ? aadhaarError(form.aadhaarNumber) : undefined;

  return (
    <>
      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/60 px-4 py-2.5">
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-600">Consignor Details</h2>
            <p className="mt-0.5 text-[11px] text-slate-500">Indian sender · Country and code are fixed.</p>
          </div>
          {headerAction}
        </div>
        <div className="grid gap-3 p-3 sm:p-4 md:grid-cols-2">
          <ShipmentTextField label="Consignor Company" value={form.companyName} onChange={setField("companyName")} readOnly={readOnly} />
          <ShipmentTextField label="Consignor Contact Name" required value={form.contactName} onChange={setField("contactName")} error={fieldIssues.contactName} revealError={submitAttempted} readOnly={readOnly} />
          <ShipmentTextField label="Consignor Email" required type="email" inputMode="email" value={form.email} onChange={setField("email")} error={fieldIssues.email} revealError={submitAttempted} readOnly={readOnly} />
          <div className="grid gap-4 sm:grid-cols-[minmax(0,150px)_minmax(0,1fr)]">
            <ShipmentFixedCountryField label="Code" mode="dial" />
            <ShipmentTextField label="Mobile Number" required type="tel" inputMode="tel" value={form.mobileNumber} onChange={(event) => onFormChange({ ...form, mobileNumber: event.target.value.replace(/\D/g, "").slice(0, 10) })} error={fieldIssues.mobileNumber} revealError={submitAttempted} readOnly={readOnly} />
          </div>
        </div>
      </section>

      <section className="relative z-20 overflow-visible rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 bg-slate-50/60 px-4 py-2.5">
          <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-600">Consignor Pickup Address</h2>
          <p className="mt-0.5 text-[11px] text-slate-500">Search an Indian address, then adjust the fields as needed.</p>
        </div>
        <div className="space-y-3 p-3 sm:p-4">
          {!readOnly ? (
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto]">
              <label className="block">
                <ShipmentFieldLabel>Search Indian Address</ShipmentFieldLabel>
                <input
                  value={addressQuery}
                  onChange={(event) => setAddressQuery(event.target.value.toUpperCase())}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleAddressSearch();
                    }
                  }}
                  placeholder="Building, street, area or PIN code"
                  className="mt-1.5 h-10 w-full rounded-lg border border-slate-300 px-3 text-[13px] outline-none transition focus:border-blue-900 focus:ring-2 focus:ring-blue-100"
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
                  <FiMapPin aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-blue-900" />
                  <span>
                    <span className="block text-[13px] font-semibold text-slate-950">{prediction.mainText || prediction.text}</span>
                    <span className="mt-1 block text-xs text-slate-500">{prediction.secondaryText || prediction.text}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}

          <div className="grid gap-4 md:grid-cols-2">
            <ShipmentFixedCountryField label="Consignor Country" />
            <ShipmentTextField label="Pickup Address Line 1" required value={form.addressLine1} onChange={setField("addressLine1")} error={fieldIssues.addressLine1} revealError={submitAttempted} readOnly={readOnly} />
            <ShipmentTextField label="Pickup Address Line 2" value={form.addressLine2} onChange={setField("addressLine2")} readOnly={readOnly} />
            <ShipmentTextField label="Town / City" required value={form.townOrCity} onChange={setField("townOrCity")} error={fieldIssues.townOrCity} revealError={submitAttempted} readOnly={readOnly} />
            <IndianStateAutocompleteField
              value={form.county}
              onChange={(value) => onFormChange({ ...form, county: value })}
              error={fieldIssues.county}
              revealError={submitAttempted}
              readOnly={readOnly}
            />
            <ShipmentTextField label="PIN Code" required inputMode="numeric" value={form.postcode} onChange={(event) => onFormChange({ ...form, postcode: event.target.value.replace(/\D/g, "").slice(0, 6) })} error={fieldIssues.postcode} revealError={submitAttempted} readOnly={readOnly} />
            <label className="block md:col-span-2">
              <ShipmentFieldLabel>Pickup Instructions</ShipmentFieldLabel>
              <textarea
                value={form.pickupInstructions}
                onChange={(event) => onFormChange({ ...form, pickupInstructions: event.target.value.toUpperCase() })}
                readOnly={readOnly}
                rows={3}
                className={`mt-1.5 w-full rounded-lg border px-3 py-2 text-[13px] outline-none transition focus:ring-2 ${readOnly ? "cursor-not-allowed border-slate-200 bg-slate-100 text-slate-500" : "border-slate-300 focus:border-blue-900 focus:ring-blue-100"}`}
              />
            </label>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-slate-50/70 px-4 py-2.5">
          <div>
            <h2 className="text-[13px] font-semibold uppercase tracking-wide text-slate-600">KYC Documents</h2>
            <p className="mt-0.5 max-w-3xl text-[11px] leading-4 text-slate-500">
              {csbType === "CSB_V"
                ? "Complete all customs documents for CSB-V."
                : "PAN and Aadhaar are optional for CSB-IV. Attach them to keep them on file."} PDF, JPG or PNG up to 5 MB.
            </p>
          </div>
          <span className="rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] font-bold uppercase tracking-wide text-blue-900">
            {csbType === "CSB_V" ? "CSB-V · 9 REQUIRED" : "CSB-IV · ALL OPTIONAL"}
          </span>
        </div>

        <div className="space-y-3 p-3 sm:p-4">
          <div className="grid items-start gap-3 rounded-lg border border-slate-200 bg-slate-50/70 p-2.5 sm:p-3 lg:grid-cols-[minmax(0,1fr)_minmax(220px,300px)]">
          <label className={`flex min-h-10 items-center gap-2.5 rounded-md border px-2.5 py-2 transition ${kycUseForAll ? "border-blue-300 bg-blue-50/70" : "border-slate-200 bg-white"}`}>
            <input
              type="checkbox"
              checked={kycUseForAll}
              disabled={readOnly}
              onChange={(event) => onKycUseForAllChange(event.target.checked)}
              className="h-4 w-4 shrink-0 accent-blue-900"
            />
            <span className="min-w-0">
              <span className="block text-[12px] font-semibold text-slate-900">Use the same KYC for every parcel</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-slate-500">
                {kycUseForAll
                  ? "One Aadhaar and document set applies to all parcels."
                  : "Each parcel uses its own Aadhaar and documents."}
              </span>
            </span>
          </label>

          {kycUseForAll ? (
            <ShipmentTextField
              label="Aadhaar Number"
              required={aadhaarRequired}
              inputMode="numeric"
              value={formatAadhaarNumber(form.aadhaarNumber)}
              onChange={(event) => onFormChange({ ...form, aadhaarNumber: normalizeAadhaarNumber(event.target.value) })}
              error={sharedAadhaarError}
              revealError={submitAttempted}
              readOnly={readOnly}
              placeholder="1234 5678 9012"
            />
          ) : null}
          </div>

          {kycUseForAll ? (
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Shared documents</p>
              <KycSlotRow
                slots={kycSlots}
                documents={sharedKycDocuments}
                submitAttempted={submitAttempted}
                readOnly={readOnly}
                disabled={false}
                onUpload={async (type, file, documentLabel) => {
                  const data = await api.uploadKycDocument({ shipmentDraftId, type, file, documentLabel });
                  onSharedKycChange(data.kycDocuments);
                }}
                onDelete={async (type) => {
                  const data = await api.deleteKycDocument(shipmentDraftId, type);
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
                  <div key={parcel.sequence} className="overflow-hidden rounded-lg border border-slate-200">
                    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      <span>Parcel {index + 1}</span>
                      <span className="font-medium normal-case tracking-normal text-slate-400">{saved ? "Saved" : "Save shipment to upload"}</span>
                    </div>
                    <div className="space-y-3 p-3">
                      <div className="max-w-xs">
                        <ShipmentTextField
                          label="Aadhaar Number"
                          required={aadhaarRequired}
                          inputMode="numeric"
                          value={formatAadhaarNumber(parcel.aadhaarNumber)}
                          onChange={(event) => onParcelAadhaarChange(parcel.sequence, normalizeAadhaarNumber(event.target.value))}
                          error={aadhaarError(parcel.aadhaarNumber)}
                          revealError={submitAttempted}
                          readOnly={readOnly}
                          placeholder="1234 5678 9012"
                        />
                      </div>
                      <div>
                        <KycSlotRow
                          slots={kycSlots}
                          documents={parcel.kycDocuments}
                          submitAttempted={submitAttempted}
                          readOnly={readOnly}
                          disabled={!saved}
                          onUpload={async (type, file, documentLabel) => {
                            const data = await api.uploadParcelKycDocument({ shipmentDraftId, sequence: parcel.sequence, type, file, documentLabel });
                            onParcelKycChange(parcel.sequence, data.kycDocuments);
                          }}
                          onDelete={async (type) => {
                            const data = await api.deleteParcelKycDocument(shipmentDraftId, parcel.sequence, type);
                            onParcelKycChange(parcel.sequence, data.kycDocuments);
                          }}
                          onOpen={(type) => api.openParcelKycDocument(shipmentDraftId, parcel.sequence, type)}
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
  readOnly
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
    return indiaStates.filter((state) => state.toLocaleLowerCase("en-IN").includes(search));
  }, [query]);
  const activeIndex = Math.min(highlighted, Math.max(suggestions.length - 1, 0));
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
      setHighlighted(Math.min(activeIndex + 1, Math.max(suggestions.length - 1, 0)));
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
        <ShipmentFieldLabel required>State / Union Territory</ShipmentFieldLabel>
      </label>
      <div className="relative mt-1.5">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && suggestions[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
          aria-invalid={Boolean(error && showError)}
          autoComplete="off"
          value={open ? query : value}
          disabled={readOnly}
          placeholder="Search state or union territory"
          onFocus={openPicker}
          onClick={() => { if (!open) openPicker(); }}
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
          className={`h-10 w-full rounded-xl border bg-white px-3 pr-10 text-[13px] outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-500 ${
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
          {suggestions.length ? suggestions.map((state, index) => (
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
                index === activeIndex ? "bg-blue-50 text-blue-950" : "text-slate-700 hover:bg-slate-50"
              }`}
            >
              <span className="truncate">{state}</span>
              {selectedState === state ? <FiCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-blue-800" /> : null}
            </button>
          )) : <p className="px-3 py-3 text-[13px] text-slate-500">No Indian state or union territory found.</p>}
        </div>
      ) : null}
    </div>
  );
}

function KycSlotRow({
  slots,
  documents,
  submitAttempted,
  readOnly,
  disabled,
  onUpload,
  onDelete,
  onOpen
}: {
  slots: SlotConfig[];
  documents: ShipmentKycDocuments | undefined;
  submitAttempted: boolean;
  readOnly: boolean;
  disabled: boolean;
  onUpload: (type: ShipmentKycDocumentType, file: File, documentLabel?: string) => Promise<void>;
  onDelete: (type: ShipmentKycDocumentType) => Promise<void>;
  onOpen: (type: ShipmentKycDocumentType) => Promise<Blob>;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
      {slots.map((slot) => (
        <KycSlot
          key={slot.type}
          slot={slot}
          document={documents?.[slot.type] ?? null}
          submitAttempted={submitAttempted}
          readOnly={readOnly}
          disabled={disabled}
          onUpload={(file, label) => onUpload(slot.type, file, label)}
          onDelete={() => onDelete(slot.type)}
          onOpen={() => onOpen(slot.type)}
        />
      ))}
    </div>
  );
}

function KycSlot({
  slot,
  document,
  submitAttempted,
  readOnly,
  disabled,
  onUpload,
  onDelete,
  onOpen
}: {
  slot: SlotConfig;
  document: ShipmentKycDocument | null;
  submitAttempted: boolean;
  readOnly: boolean;
  disabled: boolean;
  onUpload: (file: File, documentLabel?: string) => Promise<void>;
  onDelete: () => Promise<void>;
  onOpen: () => Promise<Blob>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [documentLabel, setDocumentLabel] = useState("");
  const [busy, setBusy] = useState(false);

  const missing = slot.required && !document;
  const labelReady = !slot.needsLabel || Boolean(documentLabel.trim());

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (slot.needsLabel && !documentLabel.trim()) {
      toast.info("Type what the other document is before uploading it.");
      return;
    }
    setBusy(true);
    try {
      await onUpload(file, slot.needsLabel ? documentLabel.trim().toUpperCase() : undefined);
      setDocumentLabel("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove() {
    setBusy(true);
    try {
      await onDelete();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove the document.");
    } finally {
      setBusy(false);
    }
  }

  async function handleOpen() {
    try {
      openBlobInNewTab(await onOpen());
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the document.");
    }
  }

  return (
    <div className={`flex min-h-28 flex-col gap-2 rounded-lg border p-2.5 text-[11px] transition ${missing && submitAttempted ? "border-red-300 bg-red-50" : document ? "border-emerald-200 bg-emerald-50/60" : "border-slate-200 bg-slate-50/70"}`}>
      <span className="flex items-start justify-between gap-2 font-semibold uppercase tracking-wide text-slate-700">
        <span>
          {slot.title}
          {slot.required ? <span className="ml-0.5 text-red-600">*</span> : null}
        </span>
        {document ? <FiCheck aria-hidden="true" className="h-4 w-4 shrink-0 text-emerald-600" /> : null}
      </span>

      {slot.needsLabel && !document && !readOnly ? (
        <input
          value={documentLabel}
          onChange={(event) => setDocumentLabel(event.target.value.toUpperCase())}
          placeholder="Document name"
          disabled={disabled}
          maxLength={80}
          className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-[11px] outline-none focus:border-blue-900 focus:ring-1 focus:ring-blue-100 disabled:bg-slate-100"
        />
      ) : null}

      {document ? (
        <div className="flex flex-1 flex-col justify-between gap-3">
          <button type="button" onClick={handleOpen} className="flex min-w-0 items-center gap-1.5 text-left">
            <FiFileText aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-blue-900" />
            <span className="min-w-0 truncate font-medium text-blue-900 hover:underline">{document.documentLabel || document.originalName}</span>
          </button>
          {!readOnly ? (
            <button type="button" onClick={handleRemove} disabled={busy} className="inline-flex w-fit shrink-0 items-center gap-1 font-semibold text-red-600 hover:text-red-700 disabled:opacity-50">
              <FiTrash2 aria-hidden="true" className="h-3 w-3" />
              Remove
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <input ref={inputRef} type="file" accept="application/pdf,image/jpeg,image/png" className="hidden" onChange={handleFile} />
          {!readOnly ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy || disabled || !labelReady}
              className="mt-auto inline-flex h-8 w-full items-center justify-center gap-1.5 rounded-md border border-slate-300 bg-white px-2 font-semibold text-slate-700 transition hover:border-blue-900 hover:text-blue-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FiUploadCloud aria-hidden="true" className="h-3.5 w-3.5" />
              {busy ? "..." : "Upload"}
            </button>
          ) : (
            <span className="text-slate-400">Not uploaded</span>
          )}
        </>
      )}
    </div>
  );
}
