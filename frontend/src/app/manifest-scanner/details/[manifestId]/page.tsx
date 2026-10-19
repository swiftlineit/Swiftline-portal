"use client";

import Image from "next/image";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { BarcodeFormat, BrowserMultiFormatOneDReader } from "@zxing/browser";
import { FiArrowLeft, FiCamera, FiRefreshCw, FiSearch, FiZap, FiZapOff } from "react-icons/fi";
import { DashboardLoading } from "@/components/DashboardShell";
import { getOperationsParcelDetails, getOperationsScanDetailsContext, type OperationsParcelDetails, type OperationsScanDetailsContext } from "@/lib/operationsManifests";
import { createNativeBarcodeDetector, drawScanRegion } from "@/lib/parcelBarcodeCamera";
import { OPERATIONS_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

type CameraConstraintSet = MediaTrackConstraintSet & { focusMode?: string; torch?: boolean };

function money(minor: number | null) {
  return minor == null ? "Not available" : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" }).format(minor / 100);
}

function consigneeParts(consignee: OperationsParcelDetails["consignee"]) {
  const lines = (consignee.formatted ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const name = consignee.name?.trim() || lines[0] || "Not available";
  return { name, address: (lines[0]?.toLocaleLowerCase() === name.toLocaleLowerCase() ? lines.slice(1) : lines).join(", ") };
}

export default function OperationsParcelDetailsScanner() {
  const { manifestId } = useParams<{ manifestId: string }>();
  const router = useRouter();
  const { user, loading, error: authError } = useAdminUser(OPERATIONS_AREA);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const busyRef = useRef(false);
  const recentCodeRef = useRef({ code: "", at: 0 });
  const [manifest, setManifest] = useState<OperationsScanDetailsContext | null>(null);
  const [result, setResult] = useState<OperationsParcelDetails | null>(null);
  const [manualCode, setManualCode] = useState("");
  const [error, setError] = useState("");
  const [cameraRunning, setCameraRunning] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void getOperationsScanDetailsContext(manifestId)
      .then((response) => { if (active) setManifest(response.manifest); })
      .catch((caught) => { if (active) setError(caught instanceof Error ? caught.message : "Manifest could not be loaded."); });
    return () => { active = false; };
  }, [manifestId, user]);

  const stopCamera = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraRunning(false);
    setTorchOn(false);
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  const lookUp = useCallback(async (rawCode: string, force = false) => {
    const code = rawCode.trim().toUpperCase();
    if (!code || busyRef.current) return;
    const now = Date.now();
    if (!force && recentCodeRef.current.code === code && now - recentCodeRef.current.at < 1800) return;
    recentCodeRef.current = { code, at: now };
    busyRef.current = true;
    setLookingUp(true);
    setError("");
    try {
      const response = await getOperationsParcelDetails(manifestId, code);
      setResult(response.parcel);
      setManualCode("");
      navigator.vibrate?.(70);
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : "Parcel details could not be found.");
      navigator.vibrate?.([100, 80, 100]);
    } finally {
      busyRef.current = false;
      setLookingUp(false);
    }
  }, [manifestId]);

  async function startCamera() {
    const video = videoRef.current;
    if (!video || streamRef.current) return;
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
          advanced: [{ focusMode: "continuous" } as CameraConstraintSet],
        },
      });
      streamRef.current = stream;
      video.srcObject = stream;
      await video.play();
      const canvas = canvasRef.current ?? document.createElement("canvas");
      canvasRef.current = canvas;
      const detector = await createNativeBarcodeDetector();
      const reader = detector ? null : new BrowserMultiFormatOneDReader();
      if (reader) reader.possibleFormats = [BarcodeFormat.CODE_128];
      const readFrame = async () => {
        if (!streamRef.current) return;
        try {
          if (!busyRef.current && drawScanRegion(video, canvas)) {
            const code = detector ? (await detector.detect(canvas))[0]?.rawValue : reader?.decodeFromCanvas(canvas).getText();
            if (code) void lookUp(code);
          }
        } catch {
          // A frame without a readable Code 128 barcode is expected.
        }
        timerRef.current = window.setTimeout(() => void readFrame(), detector ? 40 : 70);
      };
      void readFrame();
      setCameraRunning(true);
    } catch (caught) {
      stopCamera();
      setError(caught instanceof Error ? caught.message : "Camera unavailable. Enter the parcel number below.");
    }
  }

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as CameraConstraintSet] });
      setTorchOn(!torchOn);
    } catch {
      setError("Torch is not available on this phone.");
    }
  }

  function goBack() {
    stopCamera();
    const returnTo = new URLSearchParams(window.location.search).get("returnTo");
    const safeScannerReturn = returnTo && /^\/manifest-scanner\/[a-f\d]{24}$/i.test(returnTo);
    router.push(safeScannerReturn ? returnTo : `/dashboard/operations-manifests/${manifestId}`);
  }

  if (loading || !user) return authError ? <p className="p-6 text-sm text-red-700">{authError}</p> : <DashboardLoading />;
  const consignee = result ? consigneeParts(result.consignee) : null;
  const statusLabel = result?.packed ? "Scanned and packed" : result?.disposition === "DEFERRED_TO_NEXT_MANIFEST"
    ? "Not scanned · Next manifest" : result?.disposition === "HELD" ? "Not scanned · Held"
      : result?.disposition === "CANCELLED" ? "Not scanned · Cancelled" : "Not scanned";

  return (
    <main className="min-h-dvh bg-slate-950 px-3 pb-6 text-white sm:px-5">
      <header className="sticky top-0 z-10 -mx-3 mb-4 flex items-center justify-between gap-3 bg-[#0D1282] px-3 py-3 shadow-lg sm:-mx-5 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <Image src="/Slogo.png" alt="Swiftline" width={36} height={36} className="h-9 w-9 shrink-0 rounded-lg object-contain" />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Scan Details</h1>
            <p className="truncate text-xs text-white/75">{manifest?.manifestNumber ?? "Loading manifest"} · Read-only</p>
          </div>
        </div>
        <button type="button" onClick={goBack} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-white/15 px-3 text-xs font-semibold hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#F0DE36]">
          <FiArrowLeft /> Back
        </button>
      </header>

      <div className="mx-auto max-w-2xl space-y-3">
        {manifest ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/10 px-3 py-2.5 text-xs ring-1 ring-white/10">
            <span className="font-semibold">{manifest.manifestNumber} · {manifest.status.replaceAll("_", " ")}</span>
            <span className="text-white/75">{manifest.totalBags} bags · {manifest.totalPhysicalParcels} packed parcels</span>
          </div>
        ) : null}
        <section aria-label="Parcel barcode camera" className="rounded-xl bg-slate-900 p-2 ring-1 ring-white/10">
          <div className="relative h-36 overflow-hidden rounded-lg border-2 border-[#F0DE36] bg-black sm:h-44">
            <video ref={videoRef} playsInline muted autoPlay className="h-full w-full object-cover" />
            {!cameraRunning ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950/90 px-3 text-center">
                <FiCamera className="text-xl text-[#F0DE36]" />
                <p className="text-xs text-white/80">Fit the whole parcel barcode inside the yellow box.</p>
                <button type="button" disabled={!manifest} onClick={() => void startCamera()} className="h-9 rounded-lg bg-[#F0DE36] px-4 text-xs font-semibold text-[#0D1282] disabled:opacity-50">Start Camera</button>
              </div>
            ) : null}
          </div>
          <p className="mt-2 text-center text-xs text-white/70">Looking up a parcel never adds it to a bag. You can scan it again.</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={cameraRunning ? stopCamera : () => void startCamera()} disabled={!manifest} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-white/10 text-xs font-semibold hover:bg-white/15 disabled:opacity-50"><FiCamera />{cameraRunning ? "Stop camera" : "Camera"}</button>
            <button type="button" onClick={() => void toggleTorch()} disabled={!cameraRunning} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-white/10 text-xs font-semibold hover:bg-white/15 disabled:opacity-50">{torchOn ? <FiZapOff /> : <FiZap />} Torch</button>
          </div>
        </section>

        <form onSubmit={(event: FormEvent) => { event.preventDefault(); void lookUp(manualCode, true); }} className="flex gap-2">
          <label className="min-w-0 flex-1"><span className="sr-only">Parcel number</span><input value={manualCode} onChange={(event) => setManualCode(event.target.value)} placeholder="Enter parcel number" autoComplete="off" className="h-11 w-full rounded-lg border border-slate-500 bg-slate-900 px-3 text-sm text-white outline-none placeholder:text-slate-400 focus:border-[#F0DE36] focus:ring-2 focus:ring-[#F0DE36]/30" /></label>
          <button type="submit" disabled={!manifest || lookingUp || !manualCode.trim()} className="inline-flex h-11 items-center gap-2 rounded-lg bg-[#F0DE36] px-4 text-sm font-semibold text-[#0D1282] disabled:opacity-50"><FiSearch /> Find</button>
        </form>

        {error ? <p role="alert" className="rounded-lg border border-red-400/40 bg-red-950/50 px-3 py-2.5 text-sm text-red-100">{error}</p> : null}
        {lookingUp ? <p role="status" className="inline-flex items-center gap-2 text-xs text-white/75"><FiRefreshCw className="animate-spin" /> Looking up parcel...</p> : null}
        {result ? (
          <section aria-label="Parcel details" aria-live="polite" className="overflow-hidden rounded-xl bg-white text-slate-900">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-200 px-4 py-3">
              <div className="min-w-0"><h2 className="break-all font-mono text-sm font-semibold text-[#0D1282]">{result.parcelNumber}</h2><p className="mt-1 text-xs text-slate-600"><Link href={`/dashboard/shipments/${result.shipmentDraftId}`} className="text-[#0D1282] underline decoration-1 underline-offset-2 hover:decoration-2 focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0D1282]">{result.consignmentNumber}</Link> · {result.serviceInfo}</p></div>
              <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${result.packed ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-950"}`}>{statusLabel}</span>
            </div>
            <div className="grid gap-4 px-4 py-4 sm:grid-cols-2">
              <div><h3 className="text-xs font-semibold uppercase text-slate-600">Location</h3><p className="mt-1 text-sm font-semibold">{result.bag ? `Bag ${result.bag.bagNumber}` : "Not assigned to a bag"}</p><p className="mt-1 text-xs text-slate-600">{result.manifest.manifestNumber} · {result.manifest.status.replaceAll("_", " ")}{result.bag ? ` · ${result.bag.status}` : ""}</p>{result.otherShipmentBags.length ? <p className="mt-1 text-xs text-slate-600">Other bags for this shipment: {result.otherShipmentBags.join(", ")}</p> : null}</div>
              <div><h3 className="text-xs font-semibold uppercase text-slate-600">Consignee</h3><p className="mt-1 text-sm font-semibold">{consignee?.name}</p><p className="mt-1 whitespace-pre-line text-xs leading-5 text-slate-700">{consignee?.address || "Address not available"}</p></div>
              <div className="sm:col-span-2"><h3 className="text-xs font-semibold uppercase text-slate-600">Contents</h3><p className="mt-1 text-sm leading-5">{result.items.map((item) => item.description).filter(Boolean).join(", ") || result.contentsDescription || "Parcel contents unavailable"}</p></div>
              <div className="sm:col-span-2 flex flex-wrap gap-x-8 gap-y-2 border-t border-slate-100 pt-3 text-sm"><p><span className="text-slate-600">Parcel weight </span><strong>{result.weightKg == null ? "Not available" : `${result.weightKg.toFixed(3)} kg`}</strong></p><p><span className="text-slate-600">Goods value </span><strong>{money(result.valueMinor)}</strong></p></div>
              {result.dispositionReason ? <p className="sm:col-span-2 text-xs text-amber-900">Reason: {result.dispositionReason}</p> : null}
            </div>
          </section>
        ) : !error ? <p className="px-2 py-3 text-center text-xs text-white/65">Scan or enter a parcel to see its details here.</p> : null}
      </div>
    </main>
  );
}
