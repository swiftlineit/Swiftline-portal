"use client";

import Image from "next/image";
import { useParams } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import ParcelScanner from "@/components/driver/ParcelScanner";
import {
  FiAlertTriangle,
  FiArchive,
  FiCheck,
  FiDownload,
  FiPlus,
  FiPrinter,
  FiSmartphone,
  FiTrash2,
  FiWifi,
  FiWifiOff,
  FiX,
} from "react-icons/fi";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import {
  createOperationsBag,
  createOperationsScanSession,
  closeAllOperationsBags,
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
  type ManifestDetail,
  type OperationsBag,
  type OperationsConsignment,
  type OperationsParcelDisposition,
  type OperationsScanSession,
} from "@/lib/operationsManifests";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";
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

type PendingReason = {
  title: string;
  run: (reason: string) => Promise<unknown>;
};

export default function OperationsManifestWorkspace() {
  const { manifestId } = useParams<{ manifestId: string }>();
  const { user, loading } = useAdminUser(OPERATIONS_AREA);
  const [data, setData] = useState<ManifestDetail | null>(null);
  const [busy, setBusy] = useState(true);
  const [activeBagId, setActiveBagId] = useState("");
  const [barcode, setBarcode] = useState("");
  const [scanning, setScanning] = useState(false);
  const [pendingReason, setPendingReason] = useState<PendingReason | null>(
    null,
  );
  const [phoneSession, setPhoneSession] =
    useState<OperationsScanSession | null>(null);
  const [pairingQr, setPairingQr] = useState("");
  const [phoneBusy, setPhoneBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastPhoneScanRef = useRef<string | null>(null);
  const phoneSessionId = phoneSession?.id ?? "";
  const phoneSessionStatus = phoneSession?.status ?? "";

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

  async function exportFile(format: "xlsx" | "pdf" | "edi" | "uk", view = false) {
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
        for (const bag of targets)
          await runBagAction(manifestId, bag.id, action);
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

  function requestParcelRemoval(parcelNumber: string) {
    const scan = currentData.scans.find(
      (item) =>
        item.parcelNumber === parcelNumber && item.status === "ACCEPTED",
    );
    if (!scan)
      return toast.error(
        "The active parcel scan could not be found. Refresh the manifest and try again.",
      );
    requestReason(`Remove ${parcelNumber} from this bag`, (reason) =>
      removeOperationsScan(manifestId, scan.id, reason),
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

  return (
    <>
      <div className="mx-auto max-w-375">
        <ManifestHeader
          data={data}
          busy={busy}
          onExport={(format, view) => void exportFile(format, view)}
          onSeal={() => void handleSeal()}
          sealBlocked={data.sealingIssues.length > 0}
          onDispatch={() =>
            void refreshAction(
              () => runManifestAction(manifestId, "dispatch", "", { method: "BUTTON" }),
              "Manifest dispatched.",
            )
          }
        />

        {data.sealingIssues.length && canEdit ? (
          <section className="mb-5 flex items-start gap-3 rounded-lg border border-[#F0DE36] bg-[#F0DE36]/15 p-4">
            {/* <FiAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-[#0D1282]" /> */}
            <div className="min-w-0">
              {/* <h2 className="text-sm font-semibold text-[#0D1282]">
                Complete these before sealing
              </h2> */}
              <ul className="mt-1.5 grid gap-x-6 gap-y-1 text-sm text-slate-700 md:grid-cols-2 xl:grid-cols-3">
                {data.sealingIssues.map((issue) => (
                  <li key={issue}><span className="text-red-600 mr-2">!</span>{issue}</li>
                ))}
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

        <div className="mb-5 grid grid-cols-2 overflow-hidden rounded-xl border border-[#EEEDED] bg-white shadow-sm md:grid-cols-4">
          <Metric label="Bags" value={manifest.totalBags} />
          <Metric label="Consignments" value={manifest.totalConsignments} />
          <Metric
            label="Parcels Scanned"
            value={manifest.totalPhysicalParcels}
          />
          <Metric
            label="Manifest Weight"
            value={`${manifest.totalWeightKg.toFixed(3)} kg`}
          />
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
                onConnect={() => void connectPhone()}
                onDisconnect={() => void disconnectPhone()}
              />

              {/* A consignment split across bags belongs to each bag holding one of its parcels. */}
              <ConsignmentTable
                rows={data.consignments.filter(
                  (item) =>
                    item.bagIds?.includes(activeBagId) ??
                    item.bagId === activeBagId,
                )}
                canRemove={canEdit}
                canDecide={canEdit}
                onRemove={requestParcelRemoval}
                onDisposition={requestParcelDisposition}
              />
            </div>
          </div>
        ) : (
          <ConsignmentTable
            rows={data.consignments}
            canRemove={false}
            canDecide={manifest.status === "SEALED"}
            onRemove={requestParcelRemoval}
            onDisposition={requestParcelDisposition}
          />
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
    </>
  );
}

function PhoneScannerPanel({
  session,
  qrDataUri,
  busy,
  onConnect,
  onDisconnect,
}: {
  session: OperationsScanSession | null;
  qrDataUri: string;
  busy: boolean;
  onConnect: () => void;
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
        {connected || pending ? (
          <button
            onClick={onDisconnect}
            disabled={busy}
            className="h-10 border border-red-300 rounded-4xl bg-white px-4 text-sm font-semibold text-red-700 disabled:opacity-50"
          >
            Disconnect
          </button>
        ) : (
          <button
            onClick={onConnect}
            disabled={busy}
            className="inline-flex h-10 items-center rounded-4xl gap-2 bg-[#0D1282] px-4 text-sm font-semibold text-white disabled:opacity-50"
          >
            <FiSmartphone />
            {busy ? "Preparing..." : "Connect Phone"}
          </button>
        )}
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
  onExport,
  onSeal,
  onDispatch,
  sealBlocked,
}: {
  data: ManifestDetail;
  busy: boolean;
  onExport: (format: "xlsx" | "pdf" | "edi" | "uk", view?: boolean) => void;
  onSeal: () => void;
  onDispatch: () => void;
  sealBlocked: boolean;
}) {
  const { manifest } = data;
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4 rounded-lg border border-[#EEEDED] bg-white p-5 shadow-sm">
      <div>
       
        <div className=" flex items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-950">
            {manifest.manifestNumber}
          </h1>
          <span className="rounded border border-[#0D1282]/25 bg-[#EEEDED] px-2.5 py-1 text-xs font-semibold text-[#0D1282]">
            {manifest.status.replaceAll("_", " ")}
          </span>
        </div>
        <p className="mt-1 text-sm text-slate-500">
          {manifest.branch?.name} ({manifest.branch?.code}) |{" "}
          {manifest.header.originIataCode || "Origin"} to{" "}
          {manifest.header.destinationIataCode ||
            manifest.header.destinationCountryName ||
            "Destination"}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
    
        {["SEALED", "DISPATCHED"].includes(manifest.status) ? (
          <>
            <ActionButton
              onClick={() => onExport("pdf", true)}
              icon={<FiPrinter />}
              label="View Manifest PDF"
            />
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
            {manifest.header.destinationCountryCode === "GB" ? (
              <ActionButton
                onClick={() => onExport("uk")}
                icon={<FiDownload />}
                label="UK Manifest"
              />
            ) : null}
          </>
        ) : null}
        {manifest.status === "READY_TO_SEAL" ? (
          <button
            onClick={onSeal}
            disabled={busy || sealBlocked}
            title={sealBlocked ? "Resolve the sealing requirements shown below first." : undefined}
            className="inline-flex h-10 items-center gap-2 rounded-4xl bg-[#F0DE36] px-4 text-sm font-semibold text-[#0D1282] hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
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
            className="inline-flex h-10 items-center gap-2 rounded-4xl bg-[#0D1282] px-4 text-sm font-semibold text-white hover:bg-[#0D1282]/90 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            < IoMdSend />
            Confirm Dispatch
          </button>
        ) : null}
      </div>
    </div>
  );
}

function ActionButton({
  onClick,
  icon,
  label,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex h-10 items-center gap-2 rounded-4xl border border-[#0D1282]/20 bg-white px-4 text-sm font-semibold text-[#0D1282] hover:bg-[#EEEDED]"
    >
      {icon}
      {label}
    </button>
  );
}
function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border-r border-[#EEEDED] p-4 last:border-r-0">
      <p className="text-xs font-semibold uppercase text-[#0D1282]">{label}</p>
      <p className="mt-2 text-xl font-semibold text-slate-950">{value}</p>
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
  canRemove,
  canDecide,
  onRemove,
  onDisposition,
}: {
  rows: OperationsConsignment[];
  canRemove: boolean;
  canDecide: boolean;
  onRemove: (parcel: string) => void;
  onDisposition: (
    consignmentId: string,
    parcel: string,
    disposition: OperationsParcelDisposition,
  ) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-[#EEEDED] bg-white shadow-sm">
      <table className="w-full min-w-205 text-left text-sm">
        <thead className="bg-slate-200 text-xs uppercase text-slate-600">
          <tr>
            <th className="px-3 py-4">Consignment</th>
            <th className="px-3 py-4">Consignee</th>
            <th className="px-3 py-4">Contents</th>
            <th className="px-3 py-4">Parcels</th>
            <th className="px-3 py-4 text-right">Weight</th>
            <th className="px-3 py-4 text-right">Total Value</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[#EEEDED]">
          {rows.map((item) => {
            const unscannedParcels = item.expectedParcelNumbers.filter(
              (parcel) => !item.scannedParcelNumbers.includes(parcel),
            );
            return (
              <tr key={item.id} className="align-top hover:bg-[#EEEDED]/35">
              <td className="px-3 py-3">
                <span className="font-mono text-xs font-semibold text-[#0D1282]">
                  {item.displayConsignmentNumber || item.consignmentNumber}
                </span>
                <p className="mt-0.5 text-[11px] text-slate-500">
                  {item.serviceInfo}
                </p>
                {item.dpdWarning ? (
                  <p className="mt-1 text-[11px] text-amber-700">
                    No label
                  </p>
                ) : null}
              </td>
              <td className="max-w-50 whitespace-pre-line px-3 py-3 text-[11px] leading-4 text-slate-700">
                {item.consigneeSnapshot.formatted}
              </td>
              <td className="max-w-40 px-3 py-3 text-xs text-slate-700">
                {item.description}
              </td>
              <td className="min-w-52.5 px-3 py-3">
                {/* A held-back box is normal, so this count is a record rather than a warning. */}
                <p className="mb-1.5 text-[11px] font-semibold text-slate-600">
                  {item.scannedParcelNumbers.length} of{" "}
                  {item.expectedParcelNumbers.length} scanned
                </p>
                <div className="space-y-1">
                  {item.scannedParcelNumbers.map((parcel) => {
                    const parcelValue =
                      item.parcelValues?.find(
                        (value) => value.parcelNumber === parcel,
                      )?.valueMinor ?? null;
                    return (
                      <div
                        key={parcel}
                        className="flex items-center justify-between gap-1.5 rounded border border-[#EEEDED] px-2 py-1"
                      >
                        <span className="truncate font-mono text-[10px]">
                          {parcel}
                        </span>
                        <div className="flex shrink-0 items-center gap-1">
                          {/* Each box carries its own customs value. */}
                          <span className={`text-[10px] font-semibold ${parcelValue ? "text-slate-600" : "text-[#D71313]"}`}>
                            {parcelValue ? formatMoney(parcelValue) : "Goods value unavailable"}
                          </span>
                          {canRemove ? (
                            <button
                              type="button"
                              onClick={() => onRemove(parcel)}
                              title="Remove parcel from bag"
                              className="rounded p-1 text-[#D71313] hover:bg-[#D71313]/5"
                            >
                              <FiTrash2 />
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                  {unscannedParcels.map((parcel) => {
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
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-[10px] text-slate-800">
                            {parcel}
                          </span>
                          <span className={`text-[10px] font-semibold ${recorded ? "text-amber-800" : "text-[#D71313]"}`}>
                            {statusLabel}
                          </span>
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
              <td className="px-3 py-3 text-right text-xs font-semibold">
                {item.weightKg.toFixed(3)} kg
              </td>
              <td className="px-3 py-3 text-right">
                <span
                  className={`text-xs font-semibold ${item.goodsValueRequired ? "text-[#D71313]" : "text-slate-900"}`}
                >
                  {formatMoney(item.declaredValueMinor)}
                </span>
                {item.goodsValueRequired ? (
                  <p className="mt-0.5 text-[10px] text-[#D71313]">
                    Value needed per parcel
                  </p>
                ) : null}
              </td>
              </tr>
            );
          })}
          {!rows.length ? (
            <tr>
              <td
                colSpan={6}
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
