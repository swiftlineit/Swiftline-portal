"use client";

import {
  DragEvent,
  FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FiCalendar,
  FiChevronDown,
  FiFileText,
  FiMapPin,
  FiPackage,
  FiTruck,
  FiUploadCloud,
} from "react-icons/fi";
import { toast } from "react-toastify";
import { AddressAutocompleteField } from "@/components/business-accounts/AddressAutocompleteField";
import ClientPickupDetail from "@/components/pickups/ClientPickupDetail";
import { PickupStatusBadge } from "@/components/pickups/PickupStatusBadge";
import { TableToolbar } from "@/components/ui/TableToolbar";
import {
  CLIENT_PICKUPS_PATH,
  createClientPickup,
  formatPickupWeightKg,
  getClientPickupFormContext,
  listClientPickups,
  listEligiblePickupShipments,
  pickupListParams,
  pickupTransportCompanies,
  pickupViews,
  type EligiblePickupShipment,
  type PickupAddress,
  type PickupBusinessOption,
  type PickupCourierAddress,
  type PickupDetail,
  type PickupSummary,
} from "@/lib/pickups";

const emptyAddress: PickupAddress = {
  addressLine1: "",
  addressLine2: "",
  townOrCity: "",
  county: "",
  postcode: "",
  countryCode: "IN",
  countryName: "India",
  googlePlaceId: "",
};
const addressLine = (value: Record<string, string>) =>
  [
    value.addressLine1,
    value.addressLine2,
    value.townOrCity,
    value.county,
    value.postcode,
  ]
    .filter(Boolean)
    .join(", ");
const istToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(
    new Date(),
  );
const istNowDateTime = () =>
  new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 16);
const displayDateTime = (value: string) =>
  new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(value));
const arrivalWindows = [
  { value: "MORNING", label: "Morning · 06:00–12:00" },
  { value: "AFTERNOON", label: "Afternoon · 12:00–17:00" },
  { value: "EVENING", label: "Evening · 17:00–22:00" },
  { value: "EXACT", label: "Exact time" },
] as const;
const safeDocumentTypes = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];
type SelectedPickupDocument = { id: number; file: File };
const inputClass =
  "h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-[#0D1282] focus:ring-2 focus:ring-blue-100";
const labelClass =
  "block text-xs font-semibold uppercase tracking-wide text-slate-500";

function SectionHeading({
  number,
  title,
  hint,
}: {
  number: string;
  title: string;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h2 className="font-semibold text-slate-950">{title}</h2>
        {hint ? <p className="mt-1 text-sm text-slate-500">{hint}</p> : null}
      </div>
      <span
        aria-hidden="true"
        className="shrink-0 text-xs font-semibold tabular-nums text-slate-400"
      >
        {number}
      </span>
    </div>
  );
}

function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-red-600">
      {" "}
      *
    </span>
  );
}

function ShipmentLoading() {
  return (
    <div className="space-y-3" aria-label="Loading eligible booked shipments">
      {[1, 2, 3].map((item) => (
        <div
          key={item}
          className="h-20 animate-pulse rounded-xl bg-slate-100"
        />
      ))}
    </div>
  );
}

export default function ClientPickupsPage() {
  const [eligible, setEligible] = useState<EligiblePickupShipment[]>([]);
  const [businesses, setBusinesses] = useState<PickupBusinessOption[]>([]);
  const [courierAddresses, setCourierAddresses] = useState<PickupCourierAddress[]>([]);
  const [pickups, setPickups] = useState<PickupSummary[]>([]);
  const [eligibleLoading, setEligibleLoading] = useState(true);
  const [contextLoading, setContextLoading] = useState(true);
  const [pickupsLoading, setPickupsLoading] = useState(true);
  const [businessAccountId, setBusinessAccountId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [contact, setContact] = useState({ name: "", phone: "" });
  const [pickupAddress, setPickupAddress] =
    useState<PickupAddress>(emptyAddress);
  const [dispatchAt, setDispatchAt] = useState("");
  const dispatchInputRef = useRef<HTMLInputElement>(null);
  const documentInputRef = useRef<HTMLInputElement>(null);
  const [arrivalDate, setArrivalDate] = useState("");
  const [arrivalWindow, setArrivalWindow] = useState("");
  const [arrivalExactTime, setArrivalExactTime] = useState("");
  const [transportCompany, setTransportCompany] = useState("");
  const [customTransportCompany, setCustomTransportCompany] = useState("");
  const [manualBoxes, setManualBoxes] = useState("");
  const [manualWeight, setManualWeight] = useState("");
  const [handlingRemarks, setHandlingRemarks] = useState("");
  const [documents, setDocuments] = useState<SelectedPickupDocument[]>([]);
  const nextDocumentIdRef = useRef(0);
  const [isDraggingDocuments, setIsDraggingDocuments] = useState(false);
  const [documentError, setDocumentError] = useState("");
  const [detailId, setDetailId] = useState("");
  const [view, setView] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (dispatchInputRef.current)
      dispatchInputRef.current.min = istNowDateTime();
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.allSettled([
      getClientPickupFormContext(),
      listEligiblePickupShipments(),
    ])
      .then(([contextResult, shipmentsResult]) => {
        if (!active) return;
        if (contextResult.status === "fulfilled") {
          const context = contextResult.value;
          setBusinesses(context.businesses);
          setCourierAddresses(context.courierAddresses ?? []);
          const initialBusiness =
            context.businesses.find(
              (business) => business.canRequestStandalone,
            ) ?? context.businesses[0];
          setBusinessAccountId(initialBusiness?.businessAccountId ?? "");
        } else {
          setError(
            contextResult.reason instanceof Error
              ? contextResult.reason.message
              : "Business account details could not be loaded.",
          );
        }
        if (shipmentsResult.status === "fulfilled")
          setEligible(shipmentsResult.value.shipments);
        else
          setError(
            shipmentsResult.reason instanceof Error
              ? shipmentsResult.reason.message
              : "Booked shipments could not be loaded. You can still enter volume manually.",
          );
      })
      .finally(() => {
        if (active) {
          setContextLoading(false);
          setEligibleLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    void Promise.resolve().then(async () => {
      try {
        const result = await listClientPickups({ view });
        if (active) setPickups(result.pickups);
      } catch (caught) {
        if (active)
          setError(
            caught instanceof Error
              ? caught.message
              : "Unable to load pickup requests.",
          );
      } finally {
        if (active) setPickupsLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, [view]);

  const selectedRows = useMemo(
    () => eligible.filter((item) => selected.includes(item.shipmentDraftId)),
    [eligible, selected],
  );
  const selectedAccount = businesses.find(
    (item) => item.businessAccountId === businessAccountId,
  );
  const selectedBranchKey = selectedRows[0]
    ? `${selectedRows[0].businessAccountId}|${selectedRows[0].branchId}`
    : "";
  const selectedBoxes = selectedRows.reduce(
    (sum, item) => sum + item.parcelCount,
    0,
  );
  const selectedWeight = selectedRows.reduce(
    (sum, item) => sum + item.totalWeightKg,
    0,
  );
  const resolvedTransport =
    transportCompany === "OTHER"
      ? customTransportCompany.trim()
      : transportCompany;
  const pickupBranchId = selectedRows[0]?.branchId ?? selectedAccount?.branchId ?? "";
  const availableTransportCompanies = [
    ...new Set([
      ...pickupTransportCompanies,
      ...courierAddresses.filter((item) => item.branchId === pickupBranchId).map((item) => item.companyName),
    ]),
  ].filter((company, index, companies) =>
    companies.findIndex((value) => value.trim().toUpperCase() === company.trim().toUpperCase()) === index,
  );

  function applyCourierProfile(company: string, branchId: string) {
    const profile = courierAddresses.find((item) =>
      item.branchId === branchId && item.companyName.trim().toUpperCase() === company.trim().toUpperCase(),
    );
    setPickupAddress(profile ? { ...profile.address } : { ...emptyAddress });
    setContact(profile ? { ...profile.contact, phone: profile.contact.phone.replace(/\D/g, "") } : { name: "", phone: "" });
  }

  function toggleShipment(item: EligiblePickupShipment) {
    if (selected.includes(item.shipmentDraftId)) {
      setSelected((current) =>
        current.filter((id) => id !== item.shipmentDraftId),
      );
      if (selected.length === 1) {
        const defaultBusiness =
          businesses.find((business) => business.canRequestStandalone) ??
          businesses[0];
        if (defaultBusiness && defaultBusiness.businessAccountId !== businessAccountId) {
          setBusinessAccountId(defaultBusiness.businessAccountId);
        }
        applyCourierProfile(resolvedTransport, defaultBusiness?.branchId ?? "");
      }
      return;
    }
    if (
      selectedBranchKey &&
      selectedBranchKey !== `${item.businessAccountId}|${item.branchId}`
    )
      return;
    setSelected((current) => [...current, item.shipmentDraftId]);
    setBusinessAccountId(item.businessAccountId);
    if (!selected.length) applyCourierProfile(resolvedTransport, item.branchId);
  }

  function addDocuments(incoming: File[]) {
    if (documents.length + incoming.length > 5) {
      setDocumentError("Choose no more than five documents.");
      return;
    }
    if (
      incoming.some(
        (file) =>
          !safeDocumentTypes.includes(file.type) || file.size > 8 * 1024 * 1024,
      )
    ) {
      setDocumentError(
        "Documents must be PDF, JPG, PNG, or WebP files no larger than 8 MB each.",
      );
      return;
    }
    setDocumentError("");
    const selectedDocuments = incoming.map((file) => ({
      id: nextDocumentIdRef.current++,
      file,
    }));
    setDocuments((current) => [...current, ...selectedDocuments]);
  }

  async function reloadPickups() {
    setPickupsLoading(true);
    try {
      setPickups((await listClientPickups({ view })).pickups);
    } finally {
      setPickupsLoading(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const [dispatchDate, dispatchTime] = dispatchAt.split("T");
    if (!dispatchDate || !dispatchTime) {
      setError("Choose a dispatch date and time.");
      return;
    }
    if (!businessAccountId) {
      setError("No active business account is available for this login.");
      return;
    }
    if (transportCompany === "OTHER" && !customTransportCompany.trim()) {
      setError("Enter the transport or courier company name.");
      return;
    }
    setBusy(true);
    try {
      const result = await createClientPickup({
        businessAccountId,
        shipmentDraftIds: selected,
        dispatchDate,
        dispatchTime,
        expectedDelhiArrival: {
          date: arrivalDate,
          window: arrivalWindow as
            | "MORNING"
            | "AFTERNOON"
            | "EVENING"
            | "EXACT",
          ...(arrivalWindow === "EXACT" ? { exactTime: arrivalExactTime } : {}),
        },
        transportCompany: resolvedTransport,
        contact,
        pickupAddress,
        ...(!selected.length
          ? {
              totalBoxes: Number(manualBoxes),
              totalWeightKg: Number(manualWeight),
            }
          : {}),
        handlingRemarks,
        documents: documents.map(({ file }) => file),
      });
      toast.success(`${result.pickup.requestNumber} submitted.`);
      setSelected([]);
      setDispatchAt("");
      setArrivalDate("");
      setArrivalWindow("");
      setArrivalExactTime("");
      setTransportCompany("");
      setCustomTransportCompany("");
      setManualBoxes("");
      setManualWeight("");
      setHandlingRemarks("");
      setDocuments([]);
      setDocumentError("");
      setPickupAddress(emptyAddress);
      setContact({ name: "", phone: "" });
      setDetailId(result.pickup.id);
      const [pickupReload, shipmentReload] = await Promise.allSettled([
        reloadPickups(),
        listEligiblePickupShipments().then((response) =>
          setEligible(response.shipments),
        ),
      ]);
      if (
        pickupReload.status === "rejected" ||
        shipmentReload.status === "rejected"
      )
        setError(
          "Pickup was submitted. Some list data could not be refreshed; use Refresh or reopen this page.",
        );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Unable to request pickup.",
      );
    } finally {
      setBusy(false);
    }
  }

  function updatePickup(updated: PickupDetail) {
    setPickups((current) =>
      current.map((item) => (item.id === updated.id ? updated : item)),
    );
    void listEligiblePickupShipments()
      .then((result) => setEligible(result.shipments))
      .catch(() => undefined);
  }

  return (
    <div className="space-y-7 pb-8">
      <header className="px-1 py-2 sm:py-3">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-2xl font-bold text-slate-950 sm:text-3xl">
              Book a pickup
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Tell us where to collect, when to dispatch, and when you expect
              the parcels at Delhi hub. You can add booked shipments or enter
              the volume manually.
            </p>
          </div>
        </div>
      </header>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-semibold text-red-700"
        >
          {error}
        </div>
      ) : null}

      <form onSubmit={submit} className="space-y-5">
        <div className="grid items-stretch gap-5 xl:grid-cols-2">
          <section className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <SectionHeading
              number="01"
              title="Shipments and volume"
              hint="Link booked shipments or enter the pickup volume, then add any supporting documents."
            />
            <div className="mt-5 flex flex-1 flex-col">
              {businesses.length === 0 && !contextLoading ? (
                <p className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
                  An active business account with an assigned branch is needed
                  to request a pickup.
                </p>
              ) : null}
              {selectedAccount &&
              !selectedAccount.canRequestStandalone &&
              !selected.length ? (
                <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  Manual volume pickups use the business account’s assigned
                  branch. Your account access allows pickups through eligible
                  booked shipments, so link a shipment to continue.
                </p>
              ) : null}

              <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      Link booked shipments
                    </h3>
                    <p className="mt-1 text-xs text-slate-500">
                      Optional · choose shipments for the same account and
                      branch.
                    </p>
                  </div>
                  <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600">
                    {selected.length} selected
                  </span>
                </div>
                <div className="mt-3 grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2 [scrollbar-width:thin] [scrollbar-color:#94a3b8_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-400">
                  {eligibleLoading ? (
                    <div className="sm:col-span-2">
                      <ShipmentLoading />
                    </div>
                  ) : (
                    eligible.map((item) => {
                      const key = item.businessAccountId + "|" + item.branchId;
                      const disabled = Boolean(
                        ((selectedBranchKey && key !== selectedBranchKey) ||
                          selected.length >= 100) &&
                        !selected.includes(item.shipmentDraftId),
                      );
                      const checked = selected.includes(item.shipmentDraftId);
                      return (
                        <label
                          key={item.shipmentDraftId}
                          className={[
                            "flex min-w-0 cursor-pointer items-start gap-3 rounded-xl border p-3 transition",
                            checked
                              ? "border-[#0D1282] bg-blue-50"
                              : "border-slate-200 bg-white hover:border-blue-300",
                            disabled ? "cursor-not-allowed opacity-50" : "",
                          ].join(" ")}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={disabled}
                            onChange={() => toggleShipment(item)}
                            className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300 text-[#0D1282] focus:ring-[#0D1282]"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-semibold text-slate-900">
                              {item.trackingNumber}
                            </span>
                            <span className="mt-0.5 block text-xs text-slate-500">
                              {item.parcelCount} boxes ·{" "}
                              {item.totalWeightKg.toFixed(2)} kg
                            </span>
                            <span className="mt-1 flex items-start gap-1 text-xs text-slate-600">

                              {addressLine(item.pickupAddress)}
                            </span>
                          </span>

                        </label>
                      );
                    })
                  )}
                  {!eligibleLoading && eligible.length === 0 ? (
                    <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-center text-sm text-slate-500 sm:col-span-2">
                      No eligible booked shipments.
                      {selectedAccount?.canRequestStandalone
                        ? " You can still request a pickup with manual volume."
                        : " Manual volume pickups are unavailable for this account’s assigned branch."}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="mt-5 flex flex-1 flex-col gap-5">
                <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-sm font-semibold text-slate-950">
                    Shipment volume
                  </h3>
                  {selected.length ? (
                    <div className="mt-4 grid grid-cols-2 gap-3">
                      <div className="rounded-xl bg-blue-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-blue-800">
                          Total boxes
                        </p>
                        <p className="mt-2 text-2xl font-bold text-slate-950">
                          {selectedBoxes}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          From {selected.length} linked shipment
                          {selected.length === 1 ? "" : "s"}
                        </p>
                      </div>
                      <div className="rounded-xl bg-blue-50 p-4">
                        <p className="text-xs font-semibold uppercase tracking-wide text-blue-800">
                          Gross weight
                        </p>
                        <p className="mt-2 text-2xl font-bold text-slate-950">
                          {selectedWeight.toFixed(2)}{" "}
                          <span className="text-sm font-semibold">kg</span>
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Calculated from booked shipment parcels
                        </p>
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 grid gap-3 sm:grid-cols-2">
                      <label className={labelClass}>
                        Total boxes
                        <RequiredMark />
                        <input
                          required
                          min={1}
                          max={10000}
                          type="number"
                          step={1}
                          value={manualBoxes}
                          onChange={(event) =>
                            setManualBoxes(event.target.value)
                          }
                          className={inputClass + " mt-1 normal-case"}
                        />
                      </label>
                      <label className={labelClass}>
                        Total gross weight (kg)
                        <RequiredMark />
                        <input
                          required
                          min={0.01}
                          max={100000}
                          type="number"
                          step="0.01"
                          value={manualWeight}
                          onChange={(event) =>
                            setManualWeight(event.target.value)
                          }
                          className={inputClass + " mt-1 normal-case"}
                        />
                      </label>
                    </div>
                  )}
                </div>

                <div className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4">
                  <h3 className="text-sm font-semibold text-slate-950">
                    Supporting documents{" "}
                    <span className="font-normal text-slate-500">
                      (optional)
                    </span>
                  </h3>
                  <p className="mt-1 text-xs text-slate-500">
                    Up to five PDF, JPG, PNG, or WebP files, 8 MB each.
                  </p>
                  <button
                    type="button"
                    disabled={documents.length >= 5}
                    onClick={() => documentInputRef.current?.click()}
                    data-pickup-document-dropzone
                    data-dragging={isDraggingDocuments ? "true" : undefined}
                    onDragOver={(event: DragEvent<HTMLButtonElement>) => {
                      event.preventDefault();
                      setIsDraggingDocuments(true);
                    }}
                    onDragLeave={(event: DragEvent<HTMLButtonElement>) => {
                      const relatedTarget = event.relatedTarget;
                      if (
                        !(relatedTarget instanceof Node) ||
                        !event.currentTarget.contains(relatedTarget)
                      ) {
                        setIsDraggingDocuments(false);
                      }
                    }}
                    onDrop={(event: DragEvent<HTMLButtonElement>) => {
                      event.preventDefault();
                      setIsDraggingDocuments(false);
                      const files = Array.from(event.dataTransfer.files);
                      if (files.length) addDocuments(files);
                    }}
                    className="mt-4 flex min-h-36 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-blue-300 p-4 text-center transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white text-lg text-[#0D1282] shadow-sm">
                      <FiUploadCloud aria-hidden="true" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-900">
                        Choose documents to upload or drop files here
                      </span>
                      <span className="mt-1 block text-xs text-slate-500">
                        {documents.length} of 5 selected · Stored privately
                      </span>
                    </span>
                  </button>
                  <input
                    ref={documentInputRef}
                    type="file"
                    multiple
                    accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
                    disabled={documents.length >= 5}
                    onChange={(event) => {
                      const files = Array.from(event.currentTarget.files ?? []);
                      event.currentTarget.value = "";
                      if (files.length) addDocuments(files);
                    }}
                    hidden
                  />
                  {documentError ? (
                    <p
                      role="alert"
                      className="mt-3 text-sm font-medium text-red-700"
                    >
                      {documentError}
                    </p>
                  ) : null}
                  {documents.length ? (
                    <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                      {documents.map(({ id, file }, index) => (
                        <li
                          key={id}
                          className="flex min-w-0 items-center gap-2 rounded-xl border border-slate-200 p-2"
                        >
                          <FiFileText
                            aria-hidden="true"
                            className="shrink-0 text-[#0D1282]"
                          />
                          <span className="min-w-0 flex-1 truncate text-xs text-slate-700">
                            {file.name}
                          </span>
                          <button
                            type="button"
                            onClick={() =>
                              setDocuments((current) =>
                                current.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                              )
                            }
                            className="rounded-lg px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50"
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          <section className="relative z-20 flex flex-col overflow-visible rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <SectionHeading
              number="02"
              title="Dispatch, Delhi arrival and collection"
              hint="Set when the parcels leave, when they should reach Delhi hub, and where we should collect them."
            />
            <div className="mt-5 flex flex-1 flex-col">
              <div className="mb-3 flex items-center gap-2.5">
                <span data-pickup-subsection-icon className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-[#0D1282]">
                  <FiCalendar aria-hidden="true" className="h-4 w-4" />
                </span>
                <h3 className="text-sm font-semibold text-slate-900">
                  Dispatch and Delhi arrival
                </h3>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className={labelClass}>
                  Dispatch date and time
                  <RequiredMark />
                  <input
                    ref={dispatchInputRef}
                    required
                    type="datetime-local"
                    value={dispatchAt}
                    onChange={(event) => setDispatchAt(event.target.value)}
                    className={inputClass + " mt-1 normal-case"}
                  />
                </label>
                <label className={labelClass}>
                  Expected Delhi arrival date
                  <RequiredMark />
                  <input
                    required
                    type="date"
                    min={dispatchAt.slice(0, 10) || istToday()}
                    value={arrivalDate}
                    onChange={(event) => setArrivalDate(event.target.value)}
                    className={inputClass + " mt-1 normal-case"}
                  />
                </label>
                <label className={labelClass}>
                  Expected arrival window
                  <RequiredMark />
                  <span className="relative mt-1 block">
                    <select
                      required
                      value={arrivalWindow}
                      onChange={(event) => {
                        setArrivalWindow(event.target.value);
                        if (event.target.value !== "EXACT")
                          setArrivalExactTime("");
                      }}
                      className={
                        inputClass + " appearance-none pr-11 normal-case"
                      }
                    >
                      <option value="">Choose an arrival window</option>
                      {arrivalWindows.map((window) => (
                        <option key={window.value} value={window.value}>
                          {window.label}
                        </option>
                      ))}
                    </select>
                    <FiChevronDown
                      aria-hidden="true"
                      className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-500"
                    />
                  </span>
                </label>
                <label className={labelClass}>
                  Transport / courier company
                  <RequiredMark />
                  <span className="relative mt-1 block">
                    <select
                      required
                      value={transportCompany}
                      onChange={(event) => {
                        setTransportCompany(event.target.value);
                        setCustomTransportCompany("");
                        applyCourierProfile(event.target.value === "OTHER" ? "" : event.target.value, pickupBranchId);
                      }}
                      className={
                        inputClass + " appearance-none pr-11 normal-case"
                      }
                    >
                      <option value="">Choose a transport company</option>
                      {availableTransportCompanies.map((company) => (
                        <option key={company} value={company}>
                          {company}
                        </option>
                      ))}
                      <option value="OTHER">Other company</option>
                    </select>
                    <FiChevronDown
                      aria-hidden="true"
                      className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-slate-500"
                    />
                  </span>
                </label>
                {arrivalWindow === "EXACT" || transportCompany === "OTHER" ? (
                  <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
                    {arrivalWindow === "EXACT" ? (
                      <label
                        className={
                          labelClass +
                          (transportCompany === "OTHER" ? "" : " sm:col-span-2")
                        }
                      >
                        Exact expected arrival time
                        <RequiredMark />
                        <input
                          required
                          type="time"
                          value={arrivalExactTime}
                          onChange={(event) =>
                            setArrivalExactTime(event.target.value)
                          }
                          className={inputClass + " mt-1 normal-case"}
                        />
                      </label>
                    ) : null}
                    {transportCompany === "OTHER" ? (
                      <label
                        className={
                          labelClass +
                          (arrivalWindow === "EXACT" ? "" : " sm:col-span-2")
                        }
                      >
                        Company name
                        <RequiredMark />
                        <input
                          required
                          maxLength={120}
                          value={customTransportCompany}
                          onChange={(event) => {
                            setCustomTransportCompany(event.target.value);
                            applyCourierProfile(event.target.value, pickupBranchId);
                          }}
                          placeholder="Enter transport or courier company"
                          className={inputClass + " mt-1 normal-case"}
                        />
                      </label>
                    ) : null}
                  </div>
                ) : null}
              </div>

              <div className="mt-6 border-t border-slate-200 pt-5">
                <div className="mb-4 flex items-center gap-2.5">
                  <span data-pickup-subsection-icon className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-[#0D1282]">
                    <FiMapPin aria-hidden="true" className="h-4 w-4" />
                  </span>
                  <h3 className="text-sm font-semibold text-slate-900">
                    Collection address and contact
                  </h3>
                </div>
                <div className="grid gap-4">
                  <AddressAutocompleteField
                    label="Collection address"
                    value={pickupAddress.addressLine1}
                    countryName="India"
                    required
                    onChange={(value) =>
                      setPickupAddress((current) => ({
                        ...current,
                        addressLine1: value,
                        googlePlaceId: "",
                      }))
                    }
                    onAddressSelected={(value) =>
                      setPickupAddress({
                        addressLine1: value.addressLine1,
                        addressLine2: value.addressLine2,
                        townOrCity: value.city,
                        county: value.state,
                        postcode: value.postalCode,
                        countryCode: value.countryCode,
                        countryName: value.countryName,
                        googlePlaceId: "",
                      })
                    }
                  />
                  <label className={labelClass}>
                    Building, floor, unit or landmark{" "}
                    <span className="font-normal normal-case text-slate-400">
                      (optional)
                    </span>
                    <input
                      value={pickupAddress.addressLine2 || ""}
                      onChange={(event) =>
                        setPickupAddress((current) => ({
                          ...current,
                          addressLine2: event.target.value,
                        }))
                      }
                      className={inputClass + " mt-1 normal-case"}
                    />
                  </label>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className={labelClass}>
                      City
                      <RequiredMark />
                      <input
                        required
                        value={pickupAddress.townOrCity}
                        onChange={(event) =>
                          setPickupAddress((current) => ({
                            ...current,
                            townOrCity: event.target.value,
                          }))
                        }
                        className={inputClass + " mt-1 normal-case"}
                      />
                    </label>
                    <label className={labelClass}>
                      State
                      <input
                        value={pickupAddress.county || ""}
                        onChange={(event) =>
                          setPickupAddress((current) => ({
                            ...current,
                            county: event.target.value,
                          }))
                        }
                        className={inputClass + " mt-1 normal-case"}
                      />
                    </label>
                    <label className={labelClass}>
                      PIN code
                      <RequiredMark />
                      <input
                        required
                        value={pickupAddress.postcode}
                        onChange={(event) =>
                          setPickupAddress((current) => ({
                            ...current,
                            postcode: event.target.value,
                          }))
                        }
                        className={inputClass + " mt-1 normal-case"}
                      />
                    </label>
                  </div>
                  <div className="grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
                    <label className={labelClass}>
                      Contact name
                      <RequiredMark />
                      <input
                        required
                        maxLength={120}
                        value={contact.name}
                        onChange={(event) =>
                          setContact((current) => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                        className={inputClass + " mt-1 normal-case"}
                      />
                    </label>
                    <label className={labelClass}>
                      Phone number
                      <RequiredMark />
                      <input
                        required
                        type="tel"
                        inputMode="numeric"
                        pattern="[0-9]{6,30}"
                        title="Enter 6 to 30 digits only"
                        minLength={6}
                        maxLength={30}
                        value={contact.phone}
                        onChange={(event) =>
                          setContact((current) => ({
                            ...current,
                            phone: event.target.value.replace(/\D/g, ""),
                          }))
                        }
                        placeholder="919876543210"
                        className={inputClass + " mt-1 normal-case"}
                      />
                    </label>
                  </div>
                  <label className={labelClass}>
                    Handling remarks or instructions{" "}
                    <span className="font-normal normal-case text-slate-400">
                      (optional)
                    </span>
                    <textarea
                      maxLength={500}
                      rows={2}
                      value={handlingRemarks}
                      onChange={(event) =>
                        setHandlingRemarks(event.target.value)
                      }
                      placeholder="Fragile items, access instructions, loading notes…"
                      className="mt-1 w-full rounded-xl border border-slate-300 p-3 text-sm font-normal normal-case outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-blue-100"
                    />
                    <span className="mt-1 block text-right text-xs font-normal normal-case text-slate-400">
                      {handlingRemarks.length}/500
                    </span>
                  </label>
                </div>
              </div>
            </div>
            <div
              data-pickup-submit-footer
              className="mt-auto flex flex-col gap-3 border-t border-slate-200 pt-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-900">
                  Ready to request pickup
                </p>
                <p className="mt-1 text-sm text-slate-600">
                  {selected.length
                    ? selected.length +
                      " shipment" +
                      (selected.length === 1 ? "" : "s") +
                      " · " +
                      selectedBoxes +
                      " boxes · " +
                      selectedWeight.toFixed(2) +
                      " kg"
                    : (manualBoxes || "0") +
                      " boxes · " +
                      (manualWeight || "0") +
                      " kg entered manually"}
                </p>
              </div>
              <button
                type="submit"
                disabled={
                  busy ||
                  contextLoading ||
                  !businessAccountId ||
                  (!selected.length &&
                    selectedAccount?.canRequestStandalone === false) ||
                  !dispatchAt ||
                  !arrivalDate ||
                  !arrivalWindow ||
                  !resolvedTransport ||
                  !contact.name.trim() ||
                  !contact.phone.trim()
                }
                className="inline-flex h-12 shrink-0 self-end items-center justify-center gap-2 rounded-xl bg-[#0D1282] px-5 text-sm font-bold text-white shadow-sm transition hover:bg-blue-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300 disabled:text-slate-500 sm:self-auto sm:px-6"
              >
                <FiTruck aria-hidden="true" />
                {busy ? "Submitting request…" : "Submit pickup request"}
              </button>
            </div>
          </section>
        </div>
      </form>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-end sm:justify-between">
          <div className="flex items-center gap-3">
            <div>
              <h2 className="font-semibold text-slate-950">
                Your pickup requests
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Follow each request through dispatch and Delhi hub receipt.
              </p>
            </div>
          </div>
          <TableToolbar
            exportPath={CLIENT_PICKUPS_PATH}
            exportParams={pickupListParams({ view })}
            exportName="pickups"
          />
        </div>
        <div className="mt-4 flex gap-5 overflow-x-auto border-b border-slate-100">
          {pickupViews.map((item) => (
            <button
              key={item.key || "all"}
              type="button"
              onClick={() => setView(item.key)}
              className={`relative shrink-0 pb-3 text-sm font-semibold ${view === item.key ? "text-[#0D1282]" : "text-slate-500 hover:text-slate-800"}`}
            >
              {item.label}
              {view === item.key ? (
                <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-[#0D1282]" />
              ) : null}
            </button>
          ))}
        </div>
        {pickupsLoading ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[1, 2, 3].map((item) => (
              <div
                key={item}
                className="h-28 animate-pulse rounded-xl bg-slate-100"
              />
            ))}
          </div>
        ) : pickups.length ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {pickups.map((pickup) => (
              <button
                type="button"
                key={pickup.id}
                onClick={() => setDetailId(pickup.id)}
                className="rounded-2xl border border-slate-200 p-4 text-left transition hover:border-[#0D1282] hover:shadow-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong className="text-slate-950">
                    {pickup.requestNumber}
                  </strong>
                  <PickupStatusBadge status={pickup.status} />
                </div>
                <p className="mt-3 text-sm font-medium text-slate-700">
                  {pickup.businessAccountName || pickup.pickupContact.name}
                </p>
                <p className="mt-1 flex items-center gap-1 text-xs text-slate-500">
                  <FiCalendar />
                  Dispatch{" "}
                  {displayDateTime(
                    pickup.dispatchAt || pickup.requestedWindow.startAt,
                  )}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  {pickup.totalBoxes ?? pickup.parcelCount} boxes ·{" "}
                  {formatPickupWeightKg(pickup.totalWeightKg)}
                </p>
                <p className="mt-3 text-xs font-bold text-[#0D1282]">
                  View pickup details →
                </p>
              </button>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-xl border border-dashed border-slate-300 p-8 text-center">
            <FiPackage className="mx-auto h-7 w-7 text-slate-400" />
            <p className="mt-2 text-sm font-semibold text-slate-700">
              No pickup requests in this view
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Submitted pickups will appear here with their latest status.
            </p>
          </div>
        )}
      </section>

      {detailId ? (
        <ClientPickupDetail
          pickupId={detailId}
          onClose={() => setDetailId("")}
          onUpdated={updatePickup}
        />
      ) : null}
    </div>
  );
}
