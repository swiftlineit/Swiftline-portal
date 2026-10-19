"use client";

import Image from "next/image";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import {
  FiAlertTriangle,
  FiArchive,
  FiCamera,
  FiCheck,
  FiDownload,
  FiEdit2,
  FiPlus,
  FiSearch,
  FiSmartphone,
  FiTrash2,
  FiWifi,
  FiWifiOff,
  FiX,
} from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import AlsCarrierReconciliationForm from "@/components/shipments/AlsCarrierReconciliationForm";
import {
  createOperationsBag,
  createDirectOperationsScanSession,
  createOperationsScanSession,
  closeAllOperationsBags,
  reopenAllOperationsBags,
  disconnectOperationsScanSession,
  downloadOperationsManifest,
  getActiveOperationsScanSession,
  getOperationsManifest,
  getOperationsScanSession,
  removeOperationsScan,
  runBagAction,
  runManifestAction,
  scanOperationsParcel,
  setOperationsParcelDisposition,
  updateOperationsManifest,
  type ManifestDetail,
  type ManifestHeader,
  type OperationsBag,
  type OperationsConsignment,
  type OperationsParcelDisposition,
  type OperationsScanSession,
} from "@/lib/operationsManifests";
import { buildOperationsBagViews, outstandingParcels, parcelBagId, searchOperationsBagViews, type BagView } from "@/lib/operationsManifestView";
import {
  reconcileManualAlsBooking,
  type ManualAlsBookingReconciliationInput,
} from "@/lib/dpdLabels";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
import { useDialog } from "@/lib/useDialog";
import { IoMdSend } from "react-icons/io";

const isEditable = (status?: string) =>
  ["DRAFT", "PACKING", "READY_TO_SEAL"].includes(status ?? "");
const OPERATIONS_BAG_MAX_WEIGHT_KG = 32;
const UK_OPERATIONS_BAG_MAX_PIECES = 5;
const formatMoney = (minor?: number | null) =>
  typeof minor === "number"
    ? new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency: "INR",
      }).format(minor / 100)
    : "Required";
const formatParcelWeight = (weight?: number | null) =>
  typeof weight === "number" && Number.isFinite(weight)
    ? `${weight.toFixed(3)} kg`
    : "Weight unavailable";

type PendingReason = {
  title: string;
  run: (reason: string) => Promise<unknown>;
};

export default function OperationsManifestWorkspace() {
  const { manifestId } = useParams<{ manifestId: string }>();
  const router = useRouter();
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [data, setData] = useState<ManifestDetail | null>(null);
  const [editDetailsOpen, setEditDetailsOpen] = useState(false);
  const [editHeader, setEditHeader] = useState<ManifestHeader | null>(null);
  const [editReason, setEditReason] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);
  const [busy, setBusy] = useState(true);
  const [activeBagId, setActiveBagId] = useState("");
  const [barcode, setBarcode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [detailSearch, setDetailSearch] = useState("");
  const [pendingReason, setPendingReason] = useState<PendingReason | null>(
    null,
  );
  const [reconciliationTarget, setReconciliationTarget] =
    useState<OperationsConsignment | null>(null);
  const [phoneSession, setPhoneSession] =
    useState<OperationsScanSession | null>(null);
  const [pairingQr, setPairingQr] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const [directPhoneBusy, setDirectPhoneBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastPhoneScanRef = useRef<string | null>(null);
  const phoneSessionId = phoneSession?.id ?? "";
  const phoneSessionStatus = phoneSession?.status ?? "";
  const editDetailsDialogRef = useDialog<HTMLFormElement>(editDetailsOpen, () => {
    if (!savingDetails) setEditDetailsOpen(false);
  });

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const result = await getOperationsManifest(manifestId);
      setData(result);
      // Prefer the newest open bag while packing, but keep a closed/ready bag
      // selectable so its consignments and omitted-parcel decisions remain
      // visible after physical packing finishes.
      setActiveBagId((current) =>
        current &&
        result.bags.some(
          (bag) => bag.id === current && bag.status !== "CANCELLED",
        )
          ? current
          : (() => {
              const activeBags = result.bags.filter((bag) => bag.status !== "CANCELLED");
              return (
                [...activeBags]
                  .reverse()
                  .find((bag) => ["OPEN", "REOPENED"].includes(bag.status))?.id ??
                activeBags.at(-1)?.id ??
                ""
              );
            })(),
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Manifest could not be loaded.",
      );
    } finally {
      setBusy(false);
    }
  }, [manifestId]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void Promise.resolve().then(() => {
      if (active) return load();
    });
    return () => {
      active = false;
    };
  }, [load, user]);

  useEffect(() => {
    const onOpsWarnings = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) toast.warning(`OPS EDI downloaded with warnings. ${detail}`);
    };
    const onMhbsWarnings = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) toast.warning(`MHBS downloaded with warnings. ${detail}`);
    };
    const onCsbVWarnings = (event: Event) => {
      const detail = (event as CustomEvent<string>).detail;
      if (detail) toast.warning(`CSB-V EDI downloaded with missing historical fields. ${detail}`);
    };
    window.addEventListener("swiftline:ops-edi-warnings", onOpsWarnings);
    window.addEventListener("swiftline:mhbs-warnings", onMhbsWarnings);
    window.addEventListener("swiftline:csb-v-edi-warnings", onCsbVWarnings);
    return () => {
      window.removeEventListener("swiftline:ops-edi-warnings", onOpsWarnings);
      window.removeEventListener("swiftline:mhbs-warnings", onMhbsWarnings);
      window.removeEventListener("swiftline:csb-v-edi-warnings", onCsbVWarnings);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void getActiveOperationsScanSession(manifestId)
      .then((result) => {
        if (!active || !result.session) return;
        setPhoneSession(result.session);
        lastPhoneScanRef.current = result.session.lastScanAt;
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [manifestId, user]);

  useEffect(() => {
    if (!phoneSessionId || phoneSessionStatus === "ENDED") return;
    let active = true;
    async function pollPhone() {
      // A background tab cannot show updates, so skipping keeps the station well
      // inside its request allowance while the packer works on the phone.
      if (document.hidden) return;
      try {
        const result = await getOperationsScanSession(phoneSessionId);
        if (!active) return;
        setPhoneSession(result.session);
        if (
          result.session.lastScanAt &&
          result.session.lastScanAt !== lastPhoneScanRef.current
        ) {
          lastPhoneScanRef.current = result.session.lastScanAt;
          await load();
        }
      } catch {
        // A temporary poll failure is shown by the next successful status update.
      }
    }
    const interval = window.setInterval(() => void pollPhone(), 1500);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [load, phoneSessionId, phoneSessionStatus]);

  useEffect(() => {
    if (!scanning && !pendingReason) inputRef.current?.focus();
  }, [activeBagId, data?.scans.length, pendingReason, scanning]);

  if (loading || !user) return <DashboardLoading />;
  if (!data)
    return (
      <div className="p-10 text-center text-slate-500">
        {busy ? "Loading manifest..." : "Manifest is unavailable."}
      </div>
    );

  const currentData = data;
  const manifest = data.manifest;
  const activeBag = data.bags.find((bag) => bag.id === activeBagId);
  const canEdit = isEditable(manifest.status);
  const allBagViews = buildOperationsBagViews(data);
  const bagViews = searchOperationsBagViews(allBagViews, detailSearch);
  const activeBagView = allBagViews.find((view) => view.bag.id === activeBagId);
  const attentionConsignments = data.consignments.filter((item) =>
    item.expectedParcelNumbers.some((parcel) => !item.scannedParcelNumbers.includes(parcel))
    || item.carrierReconciliationRequired
    || item.dpdStatus === "DPD_STATUS_UNKNOWN"
  );
  const bagNumbersByShipmentReference = new Map(
    data.consignments.map((consignment) => [
      consignment.consignmentNumber,
      [...new Set(consignment.bagNumbers.filter(Boolean))],
    ]),
  );

  async function refreshAction(
    action: () => Promise<unknown>,
    success?: string,
  ) {
    try {
      await action();
      if (success) toast.success(success);
      await load();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The action could not be completed.",
      );
    }
  }

  async function handleScan(event: FormEvent) {
    event.preventDefault();
    if (!barcode.trim()) return;
    setScanning(true);
    try {
      const result = await scanOperationsParcel(
        manifestId,
        barcode,
        crypto.randomUUID(),
      );
      setBarcode("");
      setActiveBagId(result.scanResult.bag.id);
      if (result.scanResult.message.includes("label"))
        toast.info(result.scanResult.message);
      else toast.success(result.scanResult.message || "Parcel added.");
      // Confirmation is intentionally compact and fast. Refresh the workspace in
      // the background without holding the barcode input behind a full reload.
      void getOperationsManifest(manifestId)
        .then((detail) => setData(detail))
        .catch(() => undefined);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "This parcel could not be scanned.",
      );
    } finally {
      setScanning(false);
    }
  }

  async function connectPhone() {
    setPhoneBusy(true);
    try {
      const result = await createOperationsScanSession(manifestId);
      setPhoneSession(result.session);
      setPairingQr(result.qrDataUri);
      lastPhoneScanRef.current = result.session.lastScanAt;
    } catch (caughtError) {
      toast.error(
        caughtError instanceof Error
          ? caughtError.message
          : "A phone pairing code could not be created.",
      );
    } finally {
      setPhoneBusy(false);
    }
  }

  async function openScannerOnThisPhone() {
    setDirectPhoneBusy(true);
    try {
      const result = await createDirectOperationsScanSession(manifestId);
      setPhoneSession(result.session);
      setPairingQr("");
      lastPhoneScanRef.current = result.session.lastScanAt;
      router.push(
        `/manifest-scanner/${result.session.id}?returnTo=${encodeURIComponent(`/dashboard/operations-manifests/${manifestId}`)}`,
      );
    } catch (caughtError) {
      toast.error(
        caughtError instanceof Error
          ? caughtError.message
          : "This phone could not open the manifest scanner.",
      );
    } finally {
      setDirectPhoneBusy(false);
    }
  }

  async function disconnectPhone() {
    if (!phoneSession) return;
    setPhoneBusy(true);
    try {
      const result = await disconnectOperationsScanSession(
        manifestId,
        phoneSession.id,
      );
      setPhoneSession(result.session);
      setPairingQr("");
      toast.success("Phone scanner disconnected.");
    } catch (caughtError) {
      toast.error(
        caughtError instanceof Error
          ? caughtError.message
          : "The phone scanner could not be disconnected.",
      );
    } finally {
      setPhoneBusy(false);
    }
  }

  async function exportFile(format: "xlsx" | "pdf" | "edi" | "opsEdi" | "mhbs" | "csbVEdi" | "csbVEdi2" | "uk", view = false) {
    try {
      await downloadOperationsManifest(
        manifestId,
        format,
        view,
        data?.manifest.manifestNumber,
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Export unavailable.",
      );
    }
  }

  async function submitManualAlsRebooking(
    input: Omit<ManualAlsBookingReconciliationInput, "manifestId" | "swiftlineTrackingNumber">
  ) {
    if (!reconciliationTarget) return;
    const result = await reconcileManualAlsBooking(reconciliationTarget.shipmentDraftId, {
      ...input,
      manifestId: String(manifestId),
      swiftlineTrackingNumber: reconciliationTarget.consignmentNumber,
    });
    setReconciliationTarget(null);
    toast.success(result.message);
    await load();
  }

  // Bags are closed and reopened one after another so each recalculation settles
  // before the next one starts.
  async function bulkBagAction(action: "close" | "reopen") {
    const targets = currentData.bags.filter((bag) =>
      action === "close"
        ? ["OPEN", "REOPENED"].includes(bag.status)
        : bag.status === "CLOSED",
    );
    if (!targets.length)
      return toast.info(
        action === "close"
          ? "Every bag is already closed."
          : "Every bag is already open.",
      );
    await refreshAction(
      async () => {
        if (action === "close") {
          await closeAllOperationsBags(manifestId);
          return;
        }
        await reopenAllOperationsBags(manifestId);
      },
      `${targets.length} bag${targets.length === 1 ? "" : "s"} ${action === "close" ? "closed" : "reopened"}.`,
    );
  }

  function requestReason(
    title: string,
    run: (reason: string) => Promise<unknown>,
  ) {
    setPendingReason({ title, run });
  }

  function requestParcelRemoval(parcelNumber: string, scanId: string | undefined) {
    const resolvedScanId = scanId ?? data?.scans.find(
      (scan) => scan.parcelNumber === parcelNumber && scan.status === "ACCEPTED",
    )?.id;
    if (!resolvedScanId)
      return toast.error(
        "The active parcel scan could not be found. Contact support with this manifest and parcel number.",
      );
    requestReason(`Remove ${parcelNumber} from this bag`, (reason) =>
      removeOperationsScan(manifestId, resolvedScanId, reason),
    );
  }

  function requestParcelDisposition(
    consignmentId: string,
    parcelNumber: string,
    disposition: OperationsParcelDisposition,
  ) {
    const action = disposition === "HELD"
      ? "Hold"
      : disposition === "DEFERRED_TO_NEXT_MANIFEST"
        ? "Move to next manifest"
        : "Cancel parcel";
    requestReason(`${action}: ${parcelNumber}`, (reason) =>
      setOperationsParcelDisposition(
        manifestId,
        consignmentId,
        parcelNumber,
        disposition,
        reason,
      ),
    );
  }

  async function handleSeal() {
    const mixedDestinations = currentData.destinationSummary.length > 1;
    if (mixedDestinations) {
      const countries = currentData.destinationSummary
        .map((item) => `${item.countryName} (${item.parcels} parcel${item.parcels === 1 ? "" : "s"})`)
        .join(", ");
      const confirmed = window.confirm(
        `This manifest contains multiple final destination countries: ${countries}. `
        + "Confirm they are travelling under this MAWB and routing hub before sealing."
      );
      if (!confirmed) return;
    }
    await refreshAction(
      () => runManifestAction(
        manifestId,
        "seal",
        "",
        { confirmMixedDestinations: mixedDestinations }
      ),
      "Manifest sealed."
    );
  }

  function beginEditDetails() {
    if (!data) return;
    setEditHeader({ ...data.manifest.header });
    setEditReason("");
    setEditDetailsOpen(true);
  }

  async function saveManifestDetails(event: FormEvent) {
    event.preventDefault();
    if (!editHeader) return;
    if (editReason.trim().length < 5) return toast.error("Enter a clear correction reason of at least 5 characters.");
    setSavingDetails(true);
    try {
      await updateOperationsManifest(manifestId, { header: editHeader, reason: editReason.trim() });
      setEditDetailsOpen(false);
      toast.success("Manifest and linked flight details updated.");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Manifest details could not be updated.");
    } finally {
      setSavingDetails(false);
    }
  }

  return (
    <>
      <div className="mx-auto max-w-8xl">
        <ManifestHeader
          data={data}
          busy={busy}
          onEditDetails={beginEditDetails}
          onExport={(format, view) => void exportFile(format, view)}
          onSeal={() => void handleSeal()}
          sealBlocked={data.sealingIssues.length > 0}
          onDispatch={() =>
            void refreshAction(
              () => runManifestAction(manifestId, "dispatch", "", { method: "BUTTON" }),
              "Manifest dispatched.",
            )
          }
          scanDetailsHref={`/manifest-scanner/details/${manifestId}`}
        />

        {data.sealingIssues.length && canEdit ? (
          <section className="mb-5 flex items-start gap-3 rounded-lg border border-[#F0DE36] bg-[#F0DE36]/15 p-4">
            {/* <FiAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#0D1282]" /> */}
            <div className="min-w-0">
              {/* <h2 className="text-sm font-semibold text-[#0D1282]">
                Complete these before sealing
              </h2> */}
              <ul className="mt-1.5 grid gap-x-6 gap-y-1 text-sm text-slate-700 md:grid-cols-2 xl:grid-cols-3">
                {data.sealingIssues.map((issue) => {
                  const shipmentReference = issue.split(": ", 1)[0];
                  const bagNumbers = bagNumbersByShipmentReference.get(shipmentReference);
                  const unscannedIssueMatch = issue.match(
                    /^(.+?: )?Choose Held, Deferred to next manifest, or Cancelled for (\d+) unscanned parcels?\.$/,
                  );
                  const displayIssue = unscannedIssueMatch
                    ? `${unscannedIssueMatch[1] ?? ""}${unscannedIssueMatch[2]} unscanned parcel${unscannedIssueMatch[2] === "1" ? "" : "s"}: Held, Deferred, or Cancelled.`
                    : issue;
                  return (
                    <li
                      key={issue}
                      className="flex min-w-0 items-start gap-2 text-sm leading-5"
                    >
                      <span className="shrink-0 text-red-600">!</span>
                      <span className="min-w-0">
                        {displayIssue}
                        {bagNumbers?.length ? (
                          <span className="ml-2 inline-flex rounded-full bg-[#0D1282]/10 px-2 py-0.5 text-xs font-semibold text-[#0D1282]">
                            Bag {bagNumbers.join(", ")}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        ) : null}

        {data.destinationSummary.length > 1 && canEdit ? (
          <section className="mb-5 flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950">
            <FiAlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">Mixed final destinations</h2>
              <p className="mt-1 text-sm">
                {data.destinationSummary.map((item) => `${item.countryName}: ${item.parcels} parcel${item.parcels === 1 ? "" : "s"}`).join(" · ")}
              </p>
              <p className="mt-1 text-xs text-amber-800">
                These parcels are allowed, but sealing requires confirmation that they travel under this MAWB and routing hub.
              </p>
            </div>
          </section>
        ) : null}

        {data.manifest.status === "SEALED" && data.dispatchIssues.length ? (
          <section className="mb-5 rounded-2xl border border-amber-300 bg-amber-50 p-4 sm:p-5">
            <h2 className="text-sm font-semibold text-amber-950">Dispatch is waiting on shipment updates</h2>
            <p className="mt-1 text-sm leading-6 text-amber-800">
              Complete the missing milestones below. The manifest will stay sealed until every shipment is ready.
            </p>
            <ul className="mt-3 grid gap-2 md:grid-cols-2">
              {data.dispatchIssues.map((issue) => (
                <li key={`${issue.shipmentDraftId}-${issue.reason}`} className="rounded-xl border border-amber-200 bg-white px-3 py-2.5 text-sm text-slate-700">
                  <span className="font-semibold text-slate-950">{issue.reference}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-amber-800">{issue.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Bag contents</h2>
            <p className="text-xs text-slate-600">Parcels are shown in the bag they were actually scanned into.</p>
          </div>
          <label className="relative block w-full sm:max-w-sm">
            <span className="sr-only">Search bag contents</span>
            <FiSearch aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={detailSearch}
              onChange={(event) => {
                const nextSearch = event.target.value;
                setDetailSearch(nextSearch);
                if (canEdit && nextSearch.trim()) {
                  const matches = searchOperationsBagViews(buildOperationsBagViews(data), nextSearch);
                  if (matches.length && !matches.some((view) => view.bag.id === activeBagId)) {
                    setActiveBagId(matches[0].bag.id);
                  }
                }
              }}
              placeholder="Search bag, parcel, shipment, consignee or item"
              className="h-10 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20"
            />
          </label>
        </div>

        {canEdit ? (
          <div className="grid items-start gap-4 xl:grid-cols-[236px_minmax(0,1fr)]">
            <aside className="overflow-hidden rounded-lg border border-[#EEEDED] bg-white shadow-sm xl:sticky xl:top-4">
              <div className="border-b border-[#EEEDED] bg-[#EEEDED]/70 px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold text-[#0D1282]">Bags</h2>
                  <button
                    onClick={() =>
                      void refreshAction(
                        () => createOperationsBag(manifestId),
                        "Bag created.",
                      )
                    }
                    title="Create bag"
                    className="flex h-8 w-8 items-center justify-center rounded  text-green-600 hover:bg-green-200 hover:text-black"
                  >
                    <FiPlus className="text-2xl" />
                  </button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-1.5">
                  <button
                    onClick={() => void bulkBagAction("close")}
                    className="h-7 rounded-4xl border border-[#0D1282]/25 bg-white text-[11px] font-semibold text-[#0D1282] hover:bg-white/70"
                  >
                    Close All
                  </button>
                  <button
                    onClick={() => void bulkBagAction("reopen")}
                    className="h-7 rounded-4xl border border-[#0D1282]/25 bg-white text-[11px] font-semibold text-[#0D1282] hover:bg-white/70"
                  >
                    Open All
                  </button>
                </div>
              </div>
              <div className="max-h-140 space-y-1.5 overflow-y-auto p-2">
                {data.bags
                  .filter((bag) => bag.status !== "CANCELLED")
                  .map((bag) => (
                    <BagButton
                      key={bag.id}
                      bag={bag}
                      active={bag.id === activeBagId}
                      onSelect={() => setActiveBagId(bag.id)}
                      // Bag handling is physical work, so none of these ask for a reason.
                      onAction={(action) =>
                        void refreshAction(
                          () => runBagAction(manifestId, bag.id, action),
                          action === "close"
                            ? "Bag closed."
                            : action === "reopen"
                              ? "Bag reopened."
                              : `${bag.bagNumber} cancelled and its parcels released.`,
                        )
                      }
                    />
                  ))}
                {!data.bags.length ? (
                  <p className="p-4 text-center text-xs text-slate-500">
                    Create the first bag to begin scanning.
                  </p>
                ) : null}
              </div>
            </aside>

            <div className="min-w-0 space-y-4">
              <section className="rounded-lg border border-[#EEEDED] bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
                  <div>
                    <p className="text-xs font-semibold uppercase text-[#0D1282]">
                      Bag View
                    </p>
                    <h2 className="mt-0.5 text-lg font-semibold text-slate-950">
                      {activeBag?.bagNumber ?? "Automatic allocation"}
                    </h2>
                  </div>
                  <span className="text-sm font-semibold text-slate-600">
                    {activeBag?.totalWeightKg.toFixed(3) ?? "0.000"} / {OPERATIONS_BAG_MAX_WEIGHT_KG.toFixed(3)} kg
                  </span>
                </div>
                <p className="mt-1 text-xs text-slate-600">
                  {activeBag?.totalPhysicalParcels ?? 0} parcels in this bag · Goods value {formatMoney(activeBagView?.recordedValueMinor ?? 0)}
                  {activeBagView?.valueIncomplete ? " (incomplete)" : ""}
                </p>
                <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-[#EEEDED]">
                  <div
                    className="h-full rounded-full bg-[#F0DE36] transition-all"
                    style={{
                      width: `${Math.min(100, ((activeBag?.totalWeightKg ?? 0) / OPERATIONS_BAG_MAX_WEIGHT_KG) * 100)}%`,
                    }}
                  />
                </div>
                <form onSubmit={handleScan} className="mt-3 flex gap-2">
                  <input
                    ref={inputRef}
                    value={barcode}
                    onChange={(event) =>
                      setBarcode(event.target.value.toUpperCase())
                    }
                    disabled={scanning}
                    placeholder="Scan Swiftline parcel barcode"
                    className="h-11 min-w-0 flex-1 rounded-2xl border-2 border-[#0D1282] px-4 font-mono text-base font-semibold uppercase outline-none focus:ring-1 "
                  />
                  <button
                    disabled={scanning || !barcode.trim()}
                    className="h-11 shrink-0 rounded-4xl bg-[#0D1282] px-5 text-sm font-semibold text-white hover:bg-[#0D1282]/90 disabled:opacity-50"
                  >
                    {scanning ? "Adding..." : "Add Parcel"}
                  </button>
                </form>
                <p className="mt-2 text-xs text-slate-500">
                  Bags are selected automatically by available capacity and shipment grouping. Click a bag only to inspect it.
                  {data.manifest.header.destinationCountryCode === "GB"
                    ? ` UK bags also stop at ${UK_OPERATIONS_BAG_MAX_PIECES} parcels.`
                    : ""}
                </p>
              </section>

              <PhoneScannerPanel
                session={phoneSession}
                qrDataUri={pairingQr}
                busy={phoneBusy}
                directBusy={directPhoneBusy}
                onConnect={() => void connectPhone()}
                onDirectScan={() => void openScannerOnThisPhone()}
                onDisconnect={() => void disconnectPhone()}
              />

              {/* A consignment split across bags belongs to each bag holding one of its parcels. */}
              <ConsignmentTable
                rows={data.consignments.filter(
                  (item) =>
                    (item.bagIds?.includes(activeBagId) ?? item.bagId === activeBagId)
                    && (!detailSearch.trim() || bagViews.some((view) =>
                      view.bag.id === activeBagId && view.parcels.some((row) => row.consignment.id === item.id)
                    )),
                )}
                activeBagId={activeBagId}
                canRemove={canEdit}
                canDecide={canEdit}
                canReconcileAlsBooking={manifest.status === "SEALED"}
                onRemove={requestParcelRemoval}
                onDisposition={requestParcelDisposition}
                onReconcileAlsBooking={setReconciliationTarget}
                manifestId={manifestId}
                onReconciled={load}
              />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <BagContentsTable views={bagViews} searchActive={Boolean(detailSearch.trim())} />
            {attentionConsignments.length ? (
              <section aria-label="Shipment actions" className="space-y-2">
                <h2 className="text-sm font-semibold text-slate-900">Shipments needing attention</h2>
                <ShipmentAttentionList
                  rows={attentionConsignments}
                  canAct={manifest.status === "SEALED"}
                  onDisposition={requestParcelDisposition}
                  onReconcileAlsBooking={setReconciliationTarget}
                  manifestId={manifestId}
                  onReconciled={load}
                />
              </section>
            ) : null}
          </div>
        )}

        {canEdit ? (
          <div className="mt-5 flex justify-end">
            <button
              onClick={() =>
                requestReason("Cancel this manifest", (reason) =>
                  runManifestAction(manifestId, "cancel", reason),
                )
              }
              className="inline-flex h-10 items-center gap-2 rounded-4xl border border-[#D71313] bg-white px-4 text-sm font-semibold text-[#D71313] hover:bg-[#D71313]/5"
            >
              <FiTrash2 />
              Cancel Manifest
            </button>
          </div>
        ) : null}
      </div>

      {pendingReason ? (
        <ReasonDialog
          title={pendingReason.title}
          onClose={() => setPendingReason(null)}
          onConfirm={async (reason) => {
            await refreshAction(() => pendingReason.run(reason));
            setPendingReason(null);
          }}
        />
      ) : null}
      {reconciliationTarget ? (
        <ManualAlsRebookingDialog
          manifestNumber={manifest.manifestNumber}
          trackingNumber={reconciliationTarget.consignmentNumber}
          onClose={() => setReconciliationTarget(null)}
          onSubmit={submitManualAlsRebooking}
        />
      ) : null}
      {editDetailsOpen && editHeader ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-3 sm:p-5">
          <form
            ref={editDetailsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-manifest-details-title"
            tabIndex={-1}
            onSubmit={(event) => void saveManifestDetails(event)}
            className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none"
          >
            <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-4 sm:px-6">
              <h2 id="edit-manifest-details-title" className="text-lg font-semibold text-slate-950">Edit manifest details</h2>
              <p className="mt-1 text-sm leading-5 text-slate-600">Corrections are audited. Shared flight details update on the linked flight and future manifest downloads.</p>
            </div>
            <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
              <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
                Destination agent details
                <textarea maxLength={1000} rows={4} value={editHeader.destinationAgent} onChange={(event) => setEditHeader({ ...editHeader, destinationAgent: event.target.value })} className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15" />
              </label>
              <EditManifestField label="Destination country" value={editHeader.destinationCountryName} maxLength={100} onChange={(value) => setEditHeader({ ...editHeader, destinationCountryName: value })} />
              <EditManifestField label="Destination country code" value={editHeader.destinationCountryCode} maxLength={2} onChange={(value) => setEditHeader({ ...editHeader, destinationCountryCode: value.toUpperCase() })} />
              <EditManifestField label="Flight number" value={editHeader.flightNumber} maxLength={20} onChange={(value) => setEditHeader({ ...editHeader, flightNumber: value.toUpperCase() })} />
              <label className="block text-sm font-medium text-slate-700">
                Departure date (IST)
                <input required type="date" value={editHeader.departureDate} onChange={(event) => setEditHeader({ ...editHeader, departureDate: event.target.value })} className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15" />
              </label>
              <EditManifestField label="MAWB number" value={editHeader.mawbNumber} maxLength={40} onChange={(value) => setEditHeader({ ...editHeader, mawbNumber: value.toUpperCase() })} />
              <EditManifestField label="Origin IATA" value={editHeader.originIataCode} maxLength={3} onChange={(value) => setEditHeader({ ...editHeader, originIataCode: value.toUpperCase() })} />
              <EditManifestField label="Destination IATA" value={editHeader.destinationIataCode} maxLength={3} onChange={(value) => setEditHeader({ ...editHeader, destinationIataCode: value.toUpperCase() })} />
              <EditManifestField label="Value type" value={editHeader.valueType} maxLength={20} onChange={(value) => setEditHeader({ ...editHeader, valueType: value.toUpperCase() })} />
              <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-xs leading-5 text-slate-600 sm:col-span-2">Changing the date keeps the linked flight&apos;s existing scheduled IST time. It does not alter recorded shipment events or actual flight times.</p>
              <label className="block text-sm font-medium text-slate-700 sm:col-span-2">
                Correction reason
                <textarea required minLength={5} maxLength={500} rows={3} value={editReason} onChange={(event) => setEditReason(event.target.value)} placeholder="Explain why these details need correction" className="mt-1.5 w-full rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15" />
              </label>
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-4 sm:px-6">
              <button type="button" disabled={savingDetails} onClick={() => setEditDetailsOpen(false)} className="h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-60">Cancel</button>
              <button type="submit" disabled={savingDetails} className="h-10 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#0A0F6D] disabled:cursor-not-allowed disabled:opacity-60">{savingDetails ? "Saving..." : "Save details"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </>
  );
}

function EditManifestField({ label, value, maxLength, onChange }: { label: string; value: string; maxLength: number; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm font-medium text-slate-700">
      {label}
      <input maxLength={maxLength} value={value} onChange={(event) => onChange(event.target.value)} className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/15" />
    </label>
  );
}

function PhoneScannerPanel({
  session,
  qrDataUri,
  busy,
  directBusy,
  onConnect,
  onDirectScan,
  onDisconnect,
}: {
  session: OperationsScanSession | null;
  qrDataUri: string;
  busy: boolean;
  directBusy: boolean;
  onConnect: () => void;
  onDirectScan: () => void;
  onDisconnect: () => void;
}) {
  const connected = session?.status === "ACTIVE";
  const pending = session?.status === "PENDING";
  return (
    <div className="rounded-lg border border-[#EEEDED] bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 ">
        <div className="flex items-start gap-3 ">
           {/* <span className="flex h-10 w-10 rounded shrink-0 items-center justify-center">
            <FiSmartphone />
          </span>  */}
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-slate-950">
                Phone Camera Scanner
              </h3>
              {connected ? (
                <FiWifi className="text-emerald-600" />
              ) : (
                <FiWifiOff className="text-slate-400" />
              )}
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {connected
                ? "Connected to this manifest. Each parcel is assigned to the best available bag automatically."
                : pending
                  ? "Scan this pairing QR with the phone's normal camera."
                  : "Use a phone as the camera while this laptop remains the manifest workspace."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!connected && !pending ? (
          <button
            onClick={onConnect}
            disabled={busy || directBusy}
            className="inline-flex h-10 items-center rounded-4xl gap-2 bg-[#0D1282] px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            <FiSmartphone />
            {busy ? "Preparing..." : "Connect Phone"}
          </button>
          ) : null}
          {!connected ? (
            <button
              onClick={onDirectScan}
              disabled={busy || directBusy}
              className="inline-flex h-10 items-center rounded-4xl border border-[#0D1282] bg-white px-4 text-sm font-semibold text-[#0D1282] disabled:opacity-50 md:hidden"
            >
              <FiCamera className="mr-2" />
              {directBusy ? "Opening..." : "Scan on this phone"}
            </button>
          ) : null}
          {connected || pending ? (
            <button
              onClick={onDisconnect}
              disabled={busy || directBusy}
              className="h-10 rounded-4xl border border-red-300 bg-white px-4 text-sm font-semibold text-red-700 disabled:opacity-50"
            >
              Disconnect
            </button>
          ) : null}
        </div>
      </div>
      {pending && qrDataUri ? (
        <div className="mt-4 flex flex-col items-center gap-3 border-t border-[#0D1282]/15 pt-4 sm:flex-row sm:items-start">
          <Image
            src={qrDataUri}
            alt="Temporary phone scanner pairing code"
            width={180}
            height={180}
            unoptimized
            className="h-45 w-45 border border-slate-200 bg-white p-2"
          />
          <div className="text-xs leading-5 text-slate-600">
            <p className="font-semibold text-slate-900">On the phone:</p>
            <p>1. Open the normal camera.</p>
            <p>2. Point it at this QR code.</p>
            <p>3. Open the Swiftline link and sign in if requested.</p>
            <p className="mt-2 font-semibold text-amber-700">
              This pairing code expires in two minutes.
            </p>
         

          </div>
        </div>
      ) : null}
      {session?.status === "ENDED" && session.endedReason ? (
        <p className="mt-3 border-t border-slate-200 pt-3 text-xs font-semibold text-slate-600">
          {session.endedReason}
        </p>
      ) : null}
    </div>
  );
}

function ManifestHeader({
  data,
  busy,
  onEditDetails,
  onExport,
  onSeal,
  onDispatch,
  scanDetailsHref,
  sealBlocked,
}: {
  data: ManifestDetail;
  busy: boolean;
  onEditDetails: () => void;
  onExport: (format: "xlsx" | "pdf" | "edi" | "opsEdi" | "mhbs" | "csbVEdi" | "csbVEdi2" | "uk", view?: boolean) => void;
  onSeal: () => void;
  onDispatch: () => void;
  scanDetailsHref: string;
  sealBlocked: boolean;
}) {
  const { manifest } = data;
  const csbVEligible = data.consignments.length > 0 && data.consignments.every((consignment) => consignment.csbType === "CSB_V");
  const csbVTooltip = csbVEligible
    ? undefined
    : "Only CSB-V shipments should be in this manifest.";
  return (
    <section className="mb-5 overflow-hidden rounded-2xl border border-[#EEEDED] bg-white shadow-sm">
      <div className="p-4 sm:p-5">
        <div className="flex min-w-0 flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h1 className="text-2xl font-semibold leading-tight text-slate-950">
                {manifest.manifestNumber}
              </h1>
              <span className="rounded-md border border-[#0D1282]/25 bg-[#0D1282]/5 px-2.5 py-1 text-xs font-semibold text-[#0D1282]">
                {manifest.status.replaceAll("_", " ")}
              </span>
            </div>
            <p className="mt-1.5 text-sm text-slate-600">
              {manifest.branch?.name} ({manifest.branch?.code}) |{" "}
              {manifest.header.originIataCode || "Origin"} to{" "}
              {manifest.header.destinationIataCode ||
                manifest.header.destinationCountryName ||
                "Destination"}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 md:justify-end">
            <a href={scanDetailsHref} className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg border border-[#0D1282]/30 bg-white px-3 text-sm font-semibold text-[#0D1282] transition hover:bg-[#0D1282]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30">
              <FiCamera /> Scan Details
            </a>
            <button type="button" onClick={onEditDetails} disabled={busy} className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg border border-[#CDD5DF] bg-white px-3 text-sm font-semibold text-slate-700 transition hover:border-[#0D1282] hover:text-[#0D1282] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 disabled:opacity-50">
              <FiEdit2 /> Edit details
            </button>
            {manifest.status === "READY_TO_SEAL" ? (
              <button
                onClick={onSeal}
                disabled={busy || sealBlocked}
                title={sealBlocked ? "Resolve the sealing requirements shown below first." : undefined}
                className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-[#F0DE36] px-3.5 text-sm font-semibold text-[#0D1282] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FiCheck />
                Seal Manifest
              </button>
            ) : null}
            {manifest.status === "SEALED" ? (
              <button
                onClick={onDispatch}
                disabled={busy || data.dispatchIssues.length > 0}
                title={data.dispatchIssues.length ? "Complete all missing shipment milestones before dispatch." : undefined}
                className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-[#0D1282] px-3.5 text-sm font-semibold text-white hover:bg-[#0D1282]/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                <IoMdSend />
                Confirm Dispatch
              </button>
            ) : null}
          </div>
        </div>

        {["SEALED", "DISPATCHED"].includes(manifest.status) ? (
          <div className="mt-4 border-t border-slate-200 pt-3">
            <div className="flex flex-wrap gap-2">
              <ActionButton
                onClick={() => onExport("xlsx")}
                icon={<FiDownload />}
                label="Manifest Excel"
              />
              <ActionButton
                onClick={() => onExport("pdf")}
                icon={<FiDownload />}
                label="Manifest PDF"
              />
              <ActionButton
                onClick={() => onExport("edi")}
                icon={<FiDownload />}
                label="EDI"
              />
              <ActionButton
                onClick={() => onExport("opsEdi")}
                icon={<FiDownload />}
                label="OPS EDI"
              />
              <ActionButton
                onClick={() => onExport("mhbs")}
                icon={<FiDownload />}
                label="MHBS"
              />
              <ActionButton
                onClick={() => onExport("csbVEdi")}
                icon={<FiDownload />}
                label="CSB-V EDI"
                disabled={!csbVEligible}
                title={csbVTooltip}
              />
              <ActionButton
                onClick={() => onExport("csbVEdi2")}
                icon={<FiDownload />}
                label="CSB-V EDI2"
                disabled={!csbVEligible}
                title={csbVTooltip}
              />
              {manifest.header.destinationCountryCode === "GB" ? (
                <ActionButton
                  onClick={() => onExport("uk")}
                  icon={<FiDownload />}
                  label="UK Manifest"
                />
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-2.5 border-t border-[#EEEDED] bg-slate-50/80 p-3 sm:gap-3 sm:p-4 lg:grid-cols-4">
        <ManifestMetricCard label="Bags" value={manifest.totalBags} />
        <ManifestMetricCard label="Consignments" value={manifest.totalConsignments} />
        <ManifestMetricCard
          label="Parcels Scanned"
          value={manifest.totalPhysicalParcels}
        />
        <ManifestMetricCard
          label="Manifest Weight"
          value={`${manifest.totalWeightKg.toFixed(3)} kg`}
        />
      </div>
    </section>
  );
}

function ActionButton({
  onClick,
  icon,
  label,
  disabled = false,
  title,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <span title={disabled ? title : undefined}>
      <button
        onClick={onClick}
        disabled={disabled}
        title={disabled ? undefined : title}
        className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-lg border border-[#0D1282]/20 bg-white px-3 text-sm font-semibold text-[#0D1282] transition hover:bg-[#EEEDED] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400"
      >
        {icon}
        {label}
      </button>
    </span>
  );
}
function ManifestMetricCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="min-w-0 text-left">
      <p className="text-xl font-semibold leading-6 tabular-nums text-slate-950 sm:text-2xl">
        {value}
      </p>
      <p className="mt-1 text-xs font-medium leading-4 text-slate-600 sm:text-sm">
        {label}
      </p>
    </div>
  );
}

function BagButton({
  bag,
  active,
  onSelect,
  onAction,
}: {
  bag: OperationsBag;
  active: boolean;
  onSelect: () => void;
  onAction: (action: "close" | "reopen" | "cancel") => void;
}) {
  const open = ["OPEN", "REOPENED"].includes(bag.status);
  const statusLabel = bag.status === "READY" ? "READY" : open ? "OPEN" : "CLOSED";
  return (
    <div
      className={`rounded border p-2.5 transition ${active ? "border-[#0D1282] bg-[#EEEDED]/70" : "border-[#EEEDED] hover:border-[#0D1282]/30"}`}
    >
      <button type="button" onClick={onSelect} className="w-full text-left">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-sm font-semibold text-[#0D1282]">
            {bag.bagNumber}
          </span>
          <span
            className={`shrink-0  px-1.5 py-0.5 text-[10px] font-semibold ${open ? " text-emerald-700" : " text-slate-600"}`}
          >
            {statusLabel}
          </span>
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">
          {bag.totalPhysicalParcels} parcels
        </p>
        <p className="text-xs font-semibold text-slate-800">
          {bag.totalWeightKg.toFixed(3)} / {OPERATIONS_BAG_MAX_WEIGHT_KG} kg
        </p>
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[#EEEDED]">
          <div
            className="h-full rounded-full bg-[#F0DE36]"
            style={{
              width: `${Math.min(100, (bag.totalWeightKg / OPERATIONS_BAG_MAX_WEIGHT_KG) * 100)}%`,
            }}
          />
        </div>
      </button>
      <div className="mt-2 flex gap-1.5">
        <button
          onClick={() => onAction(open ? "close" : "reopen")}
          className="h-7 flex-1 rounded-4xl border border-[#0D1282]/25 bg-white text-[11px] font-semibold text-[#0D1282]"
        >
          {open ? "Close" : "Reopen"}
        </button>
        <button
          onClick={() => onAction("cancel")}
          title="Cancel bag"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-[#D71313] hover:bg-[#D71313]/5"
        >
          <FiX />
        </button>
      </div>
    </div>
  );
}

function ConsignmentTable({
  rows,
  activeBagId,
  canRemove,
  canDecide,
  canReconcileAlsBooking,
  onRemove,
  onDisposition,
  onReconcileAlsBooking,
  manifestId,
  onReconciled,
}: {
  rows: OperationsConsignment[];
  activeBagId?: string;
  canRemove: boolean;
  canDecide: boolean;
  canReconcileAlsBooking: boolean;
  onRemove: (parcel: string, scanId: string | undefined) => void;
  onDisposition: (
    consignmentId: string,
    parcel: string,
    disposition: OperationsParcelDisposition,
  ) => void;
  onReconcileAlsBooking: (consignment: OperationsConsignment) => void;
  manifestId: string;
  onReconciled: () => Promise<void>;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-[#EEEDED] bg-white shadow-sm">
      <table className="w-full min-w-170 text-left text-sm">
        <thead className="bg-slate-200 text-xs uppercase text-slate-600">
          <tr>
            <th className="px-3 py-4">Consignment</th>
            <th className="px-3 py-4">Consignee</th>
            <th className="px-3 py-4">Contents</th>
            <th className="px-3 py-4">Parcels</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#EEEDED]">
          {rows.map((item) => {
            const packedHere = activeBagId
              ? item.scannedParcelNumbers.filter((parcel) => parcelBagId(item, parcel) === activeBagId)
              : item.scannedParcelNumbers;
            const unscannedParcels = item.expectedParcelNumbers.filter(
              (parcel) => !item.scannedParcelNumbers.includes(parcel),
            );
            return (
              <tr key={item.id} className="align-top hover:bg-[#EEEDED]/35">
              <td className="px-3 py-3">
                <Link href={`/dashboard/shipments/${item.shipmentDraftId}`} className="font-mono text-xs font-semibold text-[#0D1282] underline decoration-1 underline-offset-2 hover:decoration-2 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">
                  {item.displayConsignmentNumber || item.consignmentNumber}
                </Link>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {item.serviceInfo}
                </p>
                {item.dpdWarning ? (
                  <p className="mt-1 text-[11px] text-amber-700">Swiftline label incomplete</p>
                ) : null}
                {canReconcileAlsBooking && item.carrierReconciliationRequired && item.dpdStatus === "DPD_CREATED" && item.carrierBookingReconciled ? (
                  <>
                    <p className="mt-1 text-[11px] font-semibold text-amber-800">DPD label missing</p>
                    <AlsCarrierReconciliationForm
                      shipmentDraftId={item.shipmentDraftId}
                      swiftlineTrackingNumber={item.consignmentNumber}
                      manifestId={manifestId}
                      onComplete={onReconciled}
                    />
                  </>
                ) : null}
                {item.dpdStatus === "DPD_STATUS_UNKNOWN" ? (
                  <p className="mt-1 text-[11px] font-semibold text-amber-800">
                    Outcome unconfirmed
                  </p>
                ) : null}
                {canReconcileAlsBooking
                && item.dpdStatus === "DPD_STATUS_UNKNOWN"
                && item.dpdStage === "DPD_LABEL_ONLY" ? (
                  <button
                    type="button"
                    onClick={() => onReconcileAlsBooking(item)}
                    className="mt-2 inline-flex min-h-8 items-center rounded-lg border border-[#0D1282]/25 bg-white px-2.5 py-1 text-left text-[11px] font-semibold text-[#0D1282] transition hover:bg-[#0D1282]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30"
                  >
                    Reconcile manual ALS booking
                  </button>
                ) : null}
              </td>
              <td className="max-w-50 whitespace-pre-line px-3 py-3 text-[11px] leading-4 text-slate-700">
                {item.consigneeSnapshot.formatted}
              </td>
              <td className="max-w-40 px-3 py-3 text-xs text-slate-700">
                {activeBagId
                  ? packedHere.map((parcel) => {
                      const snapshot = item.parcelWeightSnapshots?.find((entry) => entry.parcelNumber === parcel);
                      return snapshot?.items?.map((entry) => entry.description).filter(Boolean).join(", ")
                        || snapshot?.contentsDescription || "Parcel contents unavailable";
                    }).join(" · ")
                  : item.description}
              </td>
              <td className="min-w-52.5 px-3 py-3">
                {/* A held-back box is normal, so this count is a record rather than a warning. */}
                <p className="mb-1.5 text-[11px] font-semibold text-slate-600">
                  {activeBagId
                    ? `${packedHere.length} in this bag · ${item.scannedParcelNumbers.length} of ${item.expectedParcelNumbers.length} scanned overall`
                    : `${item.scannedParcelNumbers.length} of ${item.expectedParcelNumbers.length} scanned`}
                </p>
                <div className="space-y-1">
                  {packedHere.map((parcel) => {
                    const parcelValue =
                      item.parcelValues?.find(
                        (value) => value.parcelNumber === parcel,
                      )?.valueMinor ?? null;
                    const parcelWeight = item.parcelWeightSnapshots?.find(
                      (snapshot) => snapshot.parcelNumber === parcel,
                    )?.weightKg ?? null;
                    return (
                      <div
                        key={parcel}
                        className="flex min-w-0 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50/50 px-2.5 py-1.5"
                      >
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] font-medium text-slate-800">
                          {parcel}
                        </span>
                        <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px]">
                          <span className="font-semibold text-slate-600">
                            {formatParcelWeight(parcelWeight)}
                          </span>
                          <span aria-hidden="true" className="text-slate-300">•</span>
                          {/* Each box carries its own customs value. */}
                          <span className={`font-semibold ${parcelValue ? "text-slate-700" : "text-[#D71313]"}`}>
                            {parcelValue ? formatMoney(parcelValue) : "Goods value unavailable"}
                          </span>
                          {canRemove ? (
                            <button
                              type="button"
                              onClick={() => onRemove(parcel, item.activeParcelScans?.find((scan) => scan.parcelNumber === parcel)?.scanId)}
                              title="Remove parcel from bag"
                              aria-label={`Remove parcel ${parcel} from bag`}
                              className="ml-1 flex h-6 w-6 items-center justify-center rounded text-[#D71313] hover:bg-[#D71313]/5"
                            >
                              <FiTrash2 />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  {unscannedParcels.map((parcel) => {
                    const parcelWeight = item.parcelWeightSnapshots?.find(
                      (snapshot) => snapshot.parcelNumber === parcel,
                    )?.weightKg ?? null;
                    const recorded = item.parcelDispositions?.find(
                      (entry) => entry.parcelNumber === parcel,
                    );
                    const statusLabel = recorded?.disposition === "HELD"
                      ? "Held"
                      : recorded?.disposition === "DEFERRED_TO_NEXT_MANIFEST"
                        ? "Next manifest"
                        : recorded?.disposition === "CANCELLED"
                          ? "Cancelled"
                          : "Decision required";
                    return (
                      <div
                        key={parcel}
                        className="rounded border border-amber-300 bg-amber-50 px-2 py-2"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-800">
                            {parcel}
                          </span>
                          <div className="flex shrink-0 items-center gap-1.5 whitespace-nowrap text-[10px]">
                            <span className="font-semibold text-slate-600">
                              {formatParcelWeight(parcelWeight)}
                            </span>
                            <span aria-hidden="true" className="text-amber-400">•</span>
                            <span className={`font-semibold ${recorded ? "text-amber-800" : "text-[#D71313]"}`}>
                              {statusLabel}
                            </span>
                          </div>
                        </div>
                        {recorded?.reason ? (
                          <p className="mt-1 text-[10px] leading-4 text-slate-600">
                            {recorded.reason}
                          </p>
                        ) : null}
                        {canDecide && (!recorded || canRemove) ? (
                          <div className="mt-2 grid grid-cols-3 gap-1">
                            {([
                              ["HELD", "Hold"],
                              ["DEFERRED_TO_NEXT_MANIFEST", "Next"],
                              ["CANCELLED", "Cancel"],
                            ] as const).map(([disposition, label]) => (
                              <button
                                key={disposition}
                                type="button"
                                aria-pressed={recorded?.disposition === disposition}
                                onClick={() => onDisposition(item.id, parcel, disposition)}
                                className={`min-h-7 rounded border px-1 text-[10px] font-semibold transition ${recorded?.disposition === disposition ? "border-[#0D1282] bg-[#0D1282] text-white" : "border-slate-300 bg-white text-slate-700 hover:border-[#0D1282] hover:text-[#0D1282]"}`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </td>
              </tr>
            );
          })}
          {!rows.length ? (
            <tr>
              <td
                colSpan={4}
                className="px-4 py-12 text-center text-sm text-slate-500"
              >
                <FiArchive className="mx-auto mb-2 h-6 w-6 text-[#0D1282]" />
                No consignments in this bag.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

function BagContentsTable({ views, searchActive }: { views: BagView[]; searchActive: boolean }) {
  if (!views.length) return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-600">
      {searchActive ? "No bag contents match this search." : "No bags or packed parcels to show yet."}
    </div>
  );

  return (
    <div className="space-y-3">
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block">
        <table className="w-full min-w-225 text-left text-sm">
          <thead className="bg-slate-100 text-xs font-semibold uppercase text-slate-600">
            <tr>
              <th className="px-3 py-3">Bag number</th>
              <th className="px-3 py-3">Parcel / shipment</th>
              <th className="px-3 py-3">Consignee</th>
              <th className="px-3 py-3">Contents</th>
              <th className="px-3 py-3 text-right">Parcel weight</th>
              <th className="px-3 py-3 text-right">Parcel value</th>
            </tr>
          </thead>
          {views.map((view) => (
            <tbody key={view.bag.id} className="border-t border-slate-200">
              <tr className="bg-[#0D1282]/5 text-slate-900">
                <th scope="rowgroup" className="px-3 py-3 font-mono text-xs font-semibold text-[#0D1282]">
                  {view.bag.bagNumber}
                  <span className="mt-0.5 block font-sans text-[11px] font-medium text-slate-600">{view.bag.status.replaceAll("_", " ")}</span>
                </th>
                <td colSpan={5} className="px-3 py-3 text-xs text-slate-700">
                  <span className="font-semibold">{view.bag.totalPhysicalParcels} parcels</span>
                  <span className="mx-2 text-slate-400">·</span>
                  Bag weight <span className="font-semibold">{formatParcelWeight(view.bag.totalWeightKg)}</span>
                  <span className="mx-2 text-slate-400">·</span>
                  Bag goods value <span className="font-semibold">{formatMoney(view.recordedValueMinor)}</span>
                  {view.valueIncomplete ? <span className="ml-1 font-semibold text-amber-800">(incomplete)</span> : null}
                </td>
              </tr>
              {view.parcels.map((row) => (
                <tr key={`${view.bag.id}-${row.parcelNumber}`} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-3 text-xs text-slate-500">{view.bag.bagNumber}</td>
                  <td className="px-3 py-3">
                    <span className="block break-all font-mono text-xs font-semibold text-[#0D1282]">{row.parcelNumber}</span>
                    <Link href={`/dashboard/shipments/${row.consignment.shipmentDraftId}`} className="mt-0.5 block w-fit text-xs text-[#0D1282] underline decoration-1 underline-offset-2 hover:decoration-2 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">{row.consignment.displayConsignmentNumber || row.consignment.consignmentNumber}</Link>
                  </td>
                  <td className="max-w-52 whitespace-pre-line px-3 py-3 text-xs leading-5 text-slate-700">{row.consignment.consigneeSnapshot.formatted}</td>
                  <td className="max-w-72 px-3 py-3 text-xs leading-5 text-slate-700">{row.contents}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap text-xs font-medium">{formatParcelWeight(row.weightKg)}</td>
                  <td className="px-3 py-3 text-right whitespace-nowrap text-xs font-medium">{formatMoney(row.valueMinor)}</td>
                </tr>
              ))}
              {!view.parcels.length ? <tr><td colSpan={6} className="px-3 py-4 text-xs text-slate-500">No parcels are packed in this bag.</td></tr> : null}
              {outstandingParcels(view).length ? (
                <tr className="border-t border-amber-100 bg-amber-50/60">
                  <td colSpan={6} className="px-3 py-2 text-xs leading-5 text-amber-950">
                    <span className="font-semibold">Not in this bag:</span>{" "}
                    {outstandingParcels(view).map((item, index) => (
                      <span key={`${item.shipmentDraftId}-${item.parcel}`}>
                        {index ? " · " : ""}{item.parcel} ({item.label}, <Link href={`/dashboard/shipments/${item.shipmentDraftId}`} className="text-[#0D1282] underline decoration-1 underline-offset-2 hover:decoration-2 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">{item.consignmentNumber}</Link>)
                      </span>
                    ))}
                  </td>
                </tr>
              ) : null}
            </tbody>
          ))}
        </table>
      </div>

      <div className="space-y-3 md:hidden">
        {views.map((view) => (
          <section key={view.bag.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white" aria-label={`Bag ${view.bag.bagNumber}`}>
            <div className="bg-[#0D1282]/5 px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="break-all font-mono text-sm font-semibold text-[#0D1282]">{view.bag.bagNumber}</h3>
                <span className="text-xs font-medium text-slate-600">{view.bag.status.replaceAll("_", " ")}</span>
              </div>
              <p className="mt-1 text-xs text-slate-700">{view.bag.totalPhysicalParcels} parcels · {formatParcelWeight(view.bag.totalWeightKg)} · {formatMoney(view.recordedValueMinor)} value{view.valueIncomplete ? " (incomplete)" : ""}</p>
            </div>
            {view.parcels.map((row) => (
              <div key={row.parcelNumber} className="border-t border-slate-100 px-3 py-3 text-xs">
                <p className="break-all font-mono font-semibold text-[#0D1282]">{row.parcelNumber}</p>
                <p className="mt-1 text-slate-600"><Link href={`/dashboard/shipments/${row.consignment.shipmentDraftId}`} className="text-[#0D1282] underline decoration-1 underline-offset-2 hover:decoration-2 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">{row.consignment.displayConsignmentNumber || row.consignment.consignmentNumber}</Link> · {row.consignment.consigneeSnapshot.name || row.consignment.consigneeSnapshot.formatted?.split("\n")[0]}</p>
                <p className="mt-1 leading-5 text-slate-700">{row.contents}</p>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 font-semibold text-slate-800">
                  <span>{formatParcelWeight(row.weightKg)}</span><span>{formatMoney(row.valueMinor)}</span>
                </div>
              </div>
            ))}
            {!view.parcels.length ? <p className="px-3 py-4 text-xs text-slate-500">No parcels packed in this bag.</p> : null}
            {outstandingParcels(view).length ? (
              <p className="border-t border-amber-100 bg-amber-50/60 px-3 py-2 text-xs leading-5 text-amber-950">
                <span className="font-semibold">Not in this bag:</span>{" "}
                {outstandingParcels(view).map((item) => `${item.parcel} (${item.label})`).join(" · ")}
              </p>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

function ShipmentAttentionList({
  rows,
  canAct,
  onDisposition,
  onReconcileAlsBooking,
  manifestId,
  onReconciled,
}: {
  rows: OperationsConsignment[];
  canAct: boolean;
  onDisposition: (consignmentId: string, parcel: string, disposition: OperationsParcelDisposition) => void;
  onReconcileAlsBooking: (consignment: OperationsConsignment) => void;
  manifestId: string;
  onReconciled: () => Promise<void>;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {rows.map((item) => {
        const unscanned = item.expectedParcelNumbers.filter((parcel) => !item.scannedParcelNumbers.includes(parcel));
        return (
          <div key={item.id} className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
            <h3 className="break-all font-mono text-xs font-semibold"><Link href={`/dashboard/shipments/${item.shipmentDraftId}`} className="text-[#0D1282] underline decoration-1 underline-offset-2 hover:decoration-2 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">{item.displayConsignmentNumber || item.consignmentNumber}</Link></h3>
            {item.dpdWarning ? <p className="mt-1 text-xs text-amber-800">Swiftline label incomplete</p> : null}
            {item.dpdStatus === "DPD_STATUS_UNKNOWN" ? <p className="mt-1 text-xs font-semibold text-amber-800">Carrier outcome unconfirmed</p> : null}
            {canAct && item.carrierReconciliationRequired && item.dpdStatus === "DPD_CREATED" && item.carrierBookingReconciled ? (
              <div className="mt-2">
                <p className="text-xs font-semibold text-amber-800">DPD label missing</p>
                <AlsCarrierReconciliationForm shipmentDraftId={item.shipmentDraftId} swiftlineTrackingNumber={item.consignmentNumber} manifestId={manifestId} onComplete={onReconciled} />
              </div>
            ) : null}
            {canAct && item.dpdStatus === "DPD_STATUS_UNKNOWN" && item.dpdStage === "DPD_LABEL_ONLY" ? (
              <button type="button" onClick={() => onReconcileAlsBooking(item)} className="mt-2 rounded-lg border border-[#0D1282]/25 px-2.5 py-1.5 text-xs font-semibold text-[#0D1282] hover:bg-[#0D1282]/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30">
                Reconcile manual ALS booking
              </button>
            ) : null}
            {unscanned.length ? (
              <div className="mt-3 space-y-2">
                <p className="text-xs font-semibold text-slate-700">Not scanned in this manifest</p>
                {unscanned.map((parcel) => {
                  const recorded = item.parcelDispositions.find((entry) => entry.parcelNumber === parcel);
                  const label = recorded?.disposition === "DEFERRED_TO_NEXT_MANIFEST" ? "Next manifest"
                    : recorded?.disposition === "HELD" ? "Held" : recorded?.disposition === "CANCELLED" ? "Cancelled" : "Decision required";
                  return (
                    <div key={parcel} className="rounded-lg bg-amber-50 px-2.5 py-2 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <span className="break-all font-mono font-semibold text-slate-800">{parcel}</span>
                        <span className="font-semibold text-amber-900">{label}</span>
                      </div>
                      {recorded?.reason ? <p className="mt-1 text-slate-600">{recorded.reason}</p> : null}
                      {canAct && !recorded ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {([ ["HELD", "Hold"], ["DEFERRED_TO_NEXT_MANIFEST", "Next manifest"], ["CANCELLED", "Cancel"] ] as const).map(([disposition, text]) => (
                            <button key={disposition} type="button" onClick={() => onDisposition(item.id, parcel, disposition)} className="min-h-8 rounded-md border border-slate-300 bg-white px-2 text-xs font-semibold text-slate-700 hover:border-[#0D1282] hover:text-[#0D1282] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0D1282]/30">{text}</button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ManualAlsRebookingDialog({
  manifestNumber,
  trackingNumber,
  onClose,
  onSubmit,
}: {
  manifestNumber: string;
  trackingNumber: string;
  onClose: () => void;
  onSubmit: (
    input: Omit<ManualAlsBookingReconciliationInput, "manifestId" | "swiftlineTrackingNumber">
  ) => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const dialogRef = useDialog<HTMLFormElement>(true, () => {
    if (!saving) onClose();
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    const values = new FormData(event.currentTarget);
    const input: Omit<ManualAlsBookingReconciliationInput, "manifestId" | "swiftlineTrackingNumber"> = {
      carrierAwbNumber: String(values.get("carrierAwbNumber") ?? "").trim(),
      carrierForwardingNumber: String(values.get("carrierForwardingNumber") ?? "").trim(),
      originalAlsAttemptVoided: true,
      replacementBookingVerified: true,
      confirmationNote: String(values.get("confirmationNote") ?? "").trim(),
    };
    setSaving(true);
    try {
      await onSubmit(input);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The manual ALS booking could not be recorded.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-3 sm:p-5"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="manual-als-rebooking-title"
        aria-describedby="manual-als-rebooking-description"
        tabIndex={-1}
        onSubmit={(event) => void submit(event)}
        className="max-h-[92vh] w-full max-w-xl overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-2xl outline-none"
      >
        <div className="border-b border-slate-200 px-5 py-4 sm:px-6">
          <h2 id="manual-als-rebooking-title" className="text-lg font-semibold text-slate-950">
            Reconcile manual ALS booking
          </h2>
          <p id="manual-als-rebooking-description" className="mt-1 text-sm leading-5 text-slate-600">
            Use this only after the original uncertain ALS attempt has been voided and Operations has verified the replacement booking against this shipment. The ALS label will not be imported into the portal.
          </p>
        </div>

        <div className="space-y-4 p-5 sm:p-6">
          <div className="grid gap-3 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2">
            <div>
              <p className="text-xs font-medium text-slate-500">Manifest</p>
              <p className="mt-0.5 font-semibold text-slate-800">{manifestNumber}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500">Swiftline tracking number</p>
              <p className="mt-0.5 break-all font-mono text-xs font-semibold text-slate-800">{trackingNumber}</p>
            </div>
          </div>

          <label className="block text-sm font-medium text-slate-700">
            Replacement ALS AWB <span className="text-red-600">*</span>
            <input
              required
              name="carrierAwbNumber"
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6,20}"
              maxLength={20}
              autoComplete="off"
              placeholder="Enter the numeric ALS AWB"
              className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20"
            />
          </label>

          <label className="block text-sm font-medium text-slate-700">
            ALS forwarding number <span className="text-red-600">*</span>
            <input
              required
              name="carrierForwardingNumber"
              type="text"
              maxLength={120}
              autoComplete="off"
              placeholder="Enter the forwarding number from ALS"
              className="mt-1.5 h-11 w-full rounded-lg border border-slate-300 px-3 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20"
            />
          </label>

          <fieldset className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3.5">
            <legend className="px-1 text-sm font-semibold text-slate-800">Required verification</legend>
            <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-5 text-slate-700">
              <input required name="originalAlsAttemptVoided" type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[#0D1282]" />
              <span>I confirm Operations voided the original uncertain ALS attempt.</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 text-sm leading-5 text-slate-700">
              <input required name="replacementBookingVerified" type="checkbox" className="mt-0.5 h-4 w-4 shrink-0 accent-[#0D1282]" />
              <span>I verified the replacement booking and its label in ALS against this shipment’s consignee, service, and parcels.</span>
            </label>
          </fieldset>

          <label className="block text-sm font-medium text-slate-700">
            Confirmation note <span className="text-red-600">*</span>
            <textarea
              required
              name="confirmationNote"
              minLength={10}
              maxLength={500}
              rows={3}
              placeholder="Include the replacement ALS booking reference and void confirmation details"
              className="mt-1.5 w-full resize-y rounded-lg border border-slate-300 px-3 py-2.5 text-sm outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#0D1282]/20"
            />
          </label>
        </div>

        <div className="flex flex-col-reverse gap-2 border-t border-slate-200 px-5 py-4 sm:flex-row sm:justify-end sm:px-6">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="h-10 rounded-lg bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#0D1282]/90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? "Recording…" : "Record replacement booking"}
          </button>
        </div>
      </form>
    </div>
  );
}

function ReasonDialog({
  title,
  onClose,
  onConfirm,
}: {
  title: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (reason.trim().length < 5)
      return toast.error("Enter a clear reason of at least 5 characters.");
    setSaving(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      setSaving(false);
    }
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-lg rounded-lg border border-[#EEEDED] bg-white shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[#EEEDED] px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase text-[#0D1282]">
              Correction Reason
            </p>
            <h2 className="mt-1 font-semibold text-slate-950">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-[#EEEDED]"
            title="Close"
          >
            <FiX />
          </button>
        </div>
        <div className="p-5">
          <label className="text-xs font-semibold uppercase text-slate-600">
            Reason *
            <textarea
              autoFocus
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
              placeholder="Explain why this correction is required"
              className="mt-2 w-full resize-none rounded-md border border-slate-300 p-3 text-sm normal-case text-slate-950 outline-none focus:border-[#0D1282] focus:ring-2 focus:ring-[#F0DE36]"
            />
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-[#EEEDED] px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            className="h-10 rounded-md border border-slate-300 px-4 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            disabled={saving}
            className="h-10 rounded-md bg-[#D71313] px-4 text-sm font-semibold text-white disabled:opacity-60"
          >
            {saving ? "Applying..." : "Confirm Correction"}
          </button>
        </div>
      </form>
    </div>
  );
}
