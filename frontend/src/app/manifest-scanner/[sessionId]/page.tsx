"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";

import { useParams, useRouter } from "next/navigation";

import Image from "next/image";

import { BarcodeFormat, BrowserMultiFormatOneDReader } from "@zxing/browser";

import {
  FiActivity,
  FiCamera,
  FiCheckCircle,
  FiClipboard,
  FiLogOut,
  FiPackage,
  FiRefreshCw,
  FiTrash2,
  FiZap,
  FiZapOff,
  FiXCircle,
} from "react-icons/fi";

import { getAccessToken, refreshAccessToken } from "@/lib/auth";

import {
  disconnectOperationsScanSession,
  getOperationsScanSession,
  removeOperationsScan,
  scanOperationsParcel,
  type OperationsScanResult,
  type OperationsScanSession,
} from "@/lib/operationsManifests";

type ScanResult = {
  accepted: boolean;

  code: string;

  message: string;

  scan?: OperationsScanResult;
};

// `focusMode` and `torch` are camera capabilities the DOM typings do not model yet.

type CameraConstraintSet = MediaTrackConstraintSet & {
  focusMode?: string;

  torch?: boolean;
};

type DetectedBarcode = { rawValue: string };

type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]>;
};

type BarcodeDetectorConstructor = {
  new (options?: { formats?: string[] }): BarcodeDetectorLike;

  getSupportedFormats?: () => Promise<string[]>;
};

const SCAN_OUTPUT_WIDTH = 960;

const OPERATIONS_BAG_MAX_WEIGHT_KG = 32;

const UK_OPERATIONS_BAG_MAX_PIECES = 5;

function getScannerReturnPath(value: string | null) {
  if (
    !value ||
    !value.startsWith("/dashboard/operations-manifests/") ||
    value.startsWith("//") ||
    value.includes("\\\\")
  ) {
    return "/";
  }

  try {
    const url = new URL(value, window.location.origin);

    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith("/dashboard/operations-manifests/")
    )
      return "/";

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

/**

 * Copies exactly the camera area visible inside the yellow frame. The video is

 * rendered with object-cover, so matching its element aspect ratio here keeps

 * the decoder crop and the operator's visible crop identical on every phone.

 */

function drawScanRegion(video: HTMLVideoElement, canvas: HTMLCanvasElement) {
  const videoWidth = video.videoWidth;

  const videoHeight = video.videoHeight;

  if (!videoWidth || !videoHeight) return false;

  const frameAspectRatio =
    video.clientWidth > 0 && video.clientHeight > 0
      ? video.clientWidth / video.clientHeight
      : 3;

  const videoAspectRatio = videoWidth / videoHeight;

  const sourceWidth = Math.round(
    videoAspectRatio > frameAspectRatio
      ? videoHeight * frameAspectRatio
      : videoWidth,
  );

  const sourceHeight = Math.round(
    videoAspectRatio > frameAspectRatio
      ? videoHeight
      : videoWidth / frameAspectRatio,
  );

  const sourceX = Math.round((videoWidth - sourceWidth) / 2);

  const sourceY = Math.round((videoHeight - sourceHeight) / 2);

  // 960px retains crisp Code 128 bars while materially reducing the fallback

  // ZXing luminance and binarisation work on mid-range phones.

  const outputWidth = Math.min(SCAN_OUTPUT_WIDTH, sourceWidth);

  const outputHeight = Math.max(
    1,

    Math.round((outputWidth * sourceHeight) / sourceWidth),
  );

  if (canvas.width !== outputWidth || canvas.height !== outputHeight) {
    canvas.width = outputWidth;

    canvas.height = outputHeight;
  }

  const context = canvas.getContext("2d", { alpha: false });

  if (!context) return false;

  context.drawImage(
    video,

    sourceX,

    sourceY,

    sourceWidth,

    sourceHeight,

    0,

    0,

    outputWidth,

    outputHeight,
  );

  return true;
}

// Consignment parties are stored as a single formatted block: company on the first

// line, then contact and address. The phone shows the name and address separately.

function partyLines(snapshot?: { name?: string; formatted?: string }) {
  const lines = (snapshot?.formatted ?? "")

    .split("\n")

    .map((line) => line.trim())

    .filter(Boolean);

  const explicitName = snapshot?.name?.trim() ?? "";

  return {
    name: explicitName || lines[0] || "Not available",

    address: (explicitName ? lines : lines.slice(1)).join(", "),
  };
}

async function createNativeBarcodeDetector() {
  const detectorConstructor = (
    window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }
  ).BarcodeDetector;

  if (!detectorConstructor) return null;

  try {
    const supported = (await detectorConstructor.getSupportedFormats?.()) ?? [];

    if (!supported.includes("code_128")) return null;

    return new detectorConstructor({ formats: ["code_128"] });
  } catch {
    return null;
  }
}

function feedbackTone(accepted: boolean) {
  try {
    const AudioContextType = window.AudioContext;

    const context = new AudioContextType();

    const oscillator = context.createOscillator();

    const gain = context.createGain();

    oscillator.frequency.value = accepted ? 880 : 220;

    gain.gain.setValueAtTime(0.12, context.currentTime);

    gain.gain.exponentialRampToValueAtTime(
      0.001,

      context.currentTime + (accepted ? 0.12 : 0.3),
    );

    oscillator.connect(gain);

    gain.connect(context.destination);

    oscillator.start();

    oscillator.stop(context.currentTime + (accepted ? 0.12 : 0.3));

    oscillator.onended = () => void context.close();
  } catch {
    // Sound feedback is optional on browsers that block Web Audio.
  }

  navigator.vibrate?.(accepted ? 80 : [120, 80, 120]);
}

export default function ManifestPhoneScannerPage() {
  const { sessionId } = useParams<{ sessionId: string }>();

  const router = useRouter();

  const videoRef = useRef<HTMLVideoElement>(null);

  const scanCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const streamRef = useRef<MediaStream | null>(null);

  const decodeTimerRef = useRef<number | null>(null);

  const busyRef = useRef(false);

  const sessionRef = useRef<OperationsScanSession | null>(null);

  const recentCodeRef = useRef<{ code: string; at: number }>({
    code: "",

    at: 0,
  });

  const [session, setSession] = useState<OperationsScanSession | null>(null);

  const [loading, setLoading] = useState(true);

  const [cameraRunning, setCameraRunning] = useState(false);

  const [torchOn, setTorchOn] = useState(false);

  const [manualCode, setManualCode] = useState("");

  const [result, setResult] = useState<ScanResult | null>(null);

  const [error, setError] = useState("");

  const [removingLastScan, setRemovingLastScan] = useState(false);

  const loadSession = useCallback(async () => {
    const token = getAccessToken() ?? (await refreshAccessToken());

    if (!token) {
      router.replace(
        `/?next=${encodeURIComponent(`/manifest-scanner/${sessionId}`)}`,
      );

      return null;
    }

    try {
      const response = await getOperationsScanSession(sessionId);

      sessionRef.current = response.session;

      setSession(response.session);

      if (response.session.status === "ENDED") {
        if (decodeTimerRef.current !== null)
          window.clearTimeout(decodeTimerRef.current);

        decodeTimerRef.current = null;

        streamRef.current?.getTracks().forEach((track) => track.stop());

        streamRef.current = null;

        if (videoRef.current) videoRef.current.srcObject = null;

        setTorchOn(false);

        setCameraRunning(false);
      }

      return response.session;
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Scanner session could not be loaded.",
      );

      return null;
    } finally {
      setLoading(false);
    }
  }, [router, sessionId]);

  useEffect(() => {
    void Promise.resolve().then(loadSession);

    // Scans themselves keep the session alive. A slower status heartbeat avoids

    // competing with camera acknowledgements on weak mobile connections.

    const interval = window.setInterval(() => {
      if (!document.hidden) void loadSession();
    }, 10000);

    return () => {
      window.clearInterval(interval);

      if (decodeTimerRef.current !== null)
        window.clearTimeout(decodeTimerRef.current);

      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [loadSession]);

  const submitCode = useCallback(
    async (rawCode: string, scanSource: "CAMERA" | "MANUAL" = "CAMERA") => {
      const code = rawCode.trim().toUpperCase();

      const currentSession = sessionRef.current;

      if (!code || currentSession?.status !== "ACTIVE" || busyRef.current)
        return;

      const now = Date.now();

      if (
        recentCodeRef.current.code === code &&
        now - recentCodeRef.current.at < 3000
      )
        return;

      recentCodeRef.current = { code, at: now };

      busyRef.current = true;

      setError("");

      try {
        const response = await scanOperationsParcel(
          currentSession.manifestId,

          code,

          crypto.randomUUID(),

          { scanSource, sessionId },
        );

        const scan = response.scanResult;

        setResult({
          accepted: true,

          code,

          message: scan.message || "Parcel added.",

          scan,
        });

        setManualCode("");

        feedbackTone(true);

        const nextSession = {
          ...currentSession,

          lastScanAt: new Date().toISOString(),

          manifest: currentSession.manifest
            ? {
                ...currentSession.manifest,

                totalBags: scan.manifestTotals.totalBags,

                totalConsignments: scan.manifestTotals.totalConsignments,

                totalPhysicalParcels: scan.manifestTotals.totalPhysicalParcels,

                totalWeightKg: scan.manifestTotals.totalWeightKg,
              }
            : null,

          activeBag: scan.bag,

          lastScannedParcel: {
            scanId: scan.scanId,

            parcelNumber: scan.parcelNumber,

            bagNumber: scan.bag.bagNumber,

            scannedAt: new Date().toISOString(),
          },
        };

        sessionRef.current = nextSession;

        setSession(nextSession);
      } catch (caughtError) {
        const message =
          caughtError instanceof Error
            ? caughtError.message
            : "This parcel could not be scanned.";

        setResult({ accepted: false, code, message });

        feedbackTone(false);

        void loadSession();
      } finally {
        busyRef.current = false;
      }
    },

    [loadSession, sessionId],
  );

  async function startCamera() {
    const video = videoRef.current;

    if (!video || cameraRunning) return;

    setError("");

    try {
      // A 1280px stream keeps Code 128 bars crisp without paying the continuous

      // full-HD decode cost that made the previous scanner feel delayed.

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

      const canvas = scanCanvasRef.current ?? document.createElement("canvas");

      scanCanvasRef.current = canvas;

      const detector = await createNativeBarcodeDetector();

      // The fallback reader is restricted to one-dimensional barcodes and then

      // to Code 128, avoiding the cost of trying QR and unrelated formats.

      const reader = detector ? null : new BrowserMultiFormatOneDReader();

      if (reader) reader.possibleFormats = [BarcodeFormat.CODE_128];

      const readFrame = async () => {
        if (!streamRef.current) return;

        try {
          // Do not decode behind an in-flight server request. It wastes battery

          // and can keep the camera from settling its continuous focus.

          if (!busyRef.current && drawScanRegion(video, canvas)) {
            const value = detector
              ? (await detector.detect(canvas))[0]?.rawValue
              : reader?.decodeFromCanvas(canvas).getText();

            if (value) {
              void submitCode(value, "CAMERA");
            }
          }
        } catch {
          // Not-found is expected while the operator aligns the label.
        }

        decodeTimerRef.current = window.setTimeout(
          () => void readFrame(),

          detector ? 40 : 70,
        );
      };

      void readFrame();

      setCameraRunning(true);
    } catch (caughtError) {
      stopCamera();

      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "Camera access was denied. Use manual entry below.",
      );
    }
  }

  function stopCamera() {
    if (decodeTimerRef.current !== null) {
      window.clearTimeout(decodeTimerRef.current);

      decodeTimerRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());

    streamRef.current = null;

    if (videoRef.current) videoRef.current.srcObject = null;

    setCameraRunning(false);

    setTorchOn(false);
  }

  async function toggleTorch() {
    const next = !torchOn;

    const track = streamRef.current?.getVideoTracks()[0];

    try {
      // Torch is a Chromium-on-Android capability. iOS Safari has no equivalent.

      if (!track) throw new Error("Start the camera before using the torch.");

      await track.applyConstraints({
        advanced: [{ torch: next } as CameraConstraintSet],
      });

      setTorchOn(next);
    } catch {
      setError("Torch control is not available on this phone.");
    }
  }

  async function disconnect() {
    if (session?.manifestId)
      await disconnectOperationsScanSession(
        session.manifestId,

        sessionId,
      ).catch(() => undefined);

    stopCamera();

    const returnTo = getScannerReturnPath(
      new URLSearchParams(window.location.search).get("returnTo"),
    );

    router.replace(returnTo);
  }

  async function removeLastScannedParcel() {
    const lastScan = session?.lastScannedParcel;

    if (!lastScan || !session || removingLastScan) return;

    setRemovingLastScan(true);

    setError("");

    try {
      await removeOperationsScan(
        session.manifestId,

        lastScan.scanId,

        "Removed from the mobile scanner by the operator.",
      );

      setResult(null);

      await loadSession();
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : "The last parcel scan could not be removed.",
      );
    } finally {
      setRemovingLastScan(false);
    }
  }

  function submitManual(event: FormEvent) {
    event.preventDefault();

    void submitCode(manualCode, "MANUAL");
  }

  const latestConsignment = result?.scan?.consignment;

  const consignee = latestConsignment
    ? partyLines(latestConsignment.consigneeSnapshot)
    : null;

  const lastScannedParcel = session?.lastScannedParcel;

  return (
    <main className="min-h-dvh bg-slate-950 px-2.5 pb-3 text-white sm:px-3 sm:pb-4">
      <header className="sticky top-0 z-10 -mx-2.5 mb-2 flex min-h-14 items-center justify-between bg-[#0D1282] px-3 py-2.5 shadow-lg sm:-mx-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Image
            src="/Slogo.png"
            alt="Swiftline"
            width={36}
            height={36}
            className="h-8 w-8 shrink-0 rounded-lg object-contain sm:h-9 sm:w-9"
          />

          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">
              {session?.manifest?.manifestNumber ?? "Manifest Scanner"}
            </p>

            <p className="truncate text-xs text-white/70">
              Bags assigned automatically
            </p>
          </div>
        </div>

        <button
          onClick={() => void disconnect()}
          title="Disconnect phone"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/15 text-white transition active:scale-95"
        >
          <FiLogOut />
        </button>
      </header>

      {session?.manifest ? (
        <section
          aria-label="Manifest details"
          className="mb-2 overflow-hidden rounded-xl bg-white/10 shadow-lg ring-1 ring-white/10"
        >
          {/* Header */}

          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <h2 className="text-xs font-semibold text-white">
                Manifest details
              </h2>

              <p className="mt-0.5 truncate text-[11px] text-white/65">
                {session.manifest.destinationCountryName ||
                  "Destination pending"}
              </p>
            </div>

            <span className="max-w-[45%] shrink-0 truncate rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-white/75 sm:max-w-none">
              {session.manifest.status.replaceAll("_", " ")}
            </span>
          </div>

          {/* Stats */}

          <div className="grid grid-cols-4 border-t border-white/10">
            <div className="min-w-0 border-r border-white/10 px-2.5 py-2.5">
              <p className="truncate text-[10px] font-medium text-white/60 sm:text-xs">
                Bags
              </p>

              <p className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                {session.manifest.totalBags}
              </p>
            </div>

            <div className="min-w-0 border-r border-white/10 px-2.5 py-2.5">
              <p className="truncate text-[10px] font-medium text-white/60 sm:text-xs">
                Scanned
              </p>

              <p className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                {session.manifest.totalPhysicalParcels}
              </p>
            </div>

            <div className="min-w-0 border-r border-white/10 px-2.5 py-2.5">
              <p className="truncate text-[10px] font-medium text-white/60 sm:text-xs">
                Consignments
              </p>

              <p className="mt-0.5 text-sm font-semibold tabular-nums text-white">
                {session.manifest.totalConsignments}
              </p>
            </div>

            <div className="min-w-0 px-2.5 py-2.5">
              <p className="truncate text-[10px] font-medium text-white/60 sm:text-xs">
                Weight
              </p>

              <p className="mt-0.5 whitespace-nowrap text-sm font-semibold tabular-nums text-white">
                {session.manifest.totalWeightKg.toFixed(3)} kg
              </p>
            </div>
          </div>
        </section>
      ) : null}

      {/* The live camera exists only inside this taller yellow rectangle. The

          decoder uses the same centre crop, so nothing outside it can scan. */}

      <section className="w-full rounded-xl bg-slate-900 p-2 shadow-lg ring-1 ring-white/10">
        <div className="relative h-[clamp(7.5rem,32vw,9.5rem)] w-full overflow-hidden rounded-lg border-2 border-[#F0DE36] bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className="h-full w-full object-cover"
          />

          {!cameraRunning ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950 p-3 text-center">
              <FiCamera className="h-6 w-6 text-[#F0DE36]" />

              <p className="mt-1.5 max-w-sm text-[11px] leading-4 text-white/80">
                {loading
                  ? "Loading scanner..."
                  : "Open the camera and fit the complete barcode inside this box."}
              </p>

              <button
                onClick={() => void startCamera()}
                disabled={loading || session?.status !== "ACTIVE"}
                className="mt-2 h-9 rounded-lg bg-[#F0DE36] px-5 text-xs font-semibold text-[#0D1282] transition active:scale-95 disabled:opacity-40"
              >
                Start Camera
              </button>
            </div>
          ) : null}
        </div>

        <p className="mt-1.5 text-center text-[10px] font-medium leading-4 text-white/70">
          Only the barcode visible inside the yellow box is scanned
        </p>
      </section>

      <div className="mt-2 space-y-2">
        <div className="grid grid-cols-3 gap-1.5">
          <button
            onClick={cameraRunning ? stopCamera : () => void startCamera()}
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-white/10 text-xs font-semibold transition active:scale-95"
          >
            {cameraRunning ? <FiXCircle /> : <FiCamera />}

            {cameraRunning ? "Stop" : "Camera"}
          </button>

          <button
            onClick={() => void toggleTorch()}
            disabled={!cameraRunning}
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-white/10 text-xs font-semibold transition active:scale-95 disabled:opacity-40"
          >
            {torchOn ? <FiZapOff /> : <FiZap />}

            {torchOn ? "Torch" : "Torch"}
          </button>

          <button
            onClick={() => void loadSession()}
            className="flex h-10 items-center justify-center gap-1.5 rounded-xl bg-white/10 text-xs font-semibold transition active:scale-95"
          >
            <FiRefreshCw />
            Sync
          </button>
        </div>

        <section
          aria-label="Bag capacity"
          className="rounded-xl bg-white/10 p-3 ring-1 ring-white/10"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-white/60">
                Bag capacity
              </p>

              <p className="mt-0.5 truncate text-sm font-semibold text-white">
                {session?.activeBag?.bagNumber ?? "Awaiting first scan"}
              </p>
            </div>

            <div className="shrink-0 text-right">
              <p className="text-base font-semibold tabular-nums text-white">
                {session?.activeBag
                  ? `${session.activeBag.totalWeightKg.toFixed(3)} / ${OPERATIONS_BAG_MAX_WEIGHT_KG.toFixed(3)} kg`
                  : "--"}
              </p>

              <p className="text-[10px] text-white/60">Current bag weight</p>
            </div>
          </div>

          <div
            className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/15"
            role="progressbar"
            aria-label="Current bag capacity"
            aria-valuemin={0}
            aria-valuemax={OPERATIONS_BAG_MAX_WEIGHT_KG}
            aria-valuenow={session?.activeBag?.totalWeightKg ?? 0}
          >
            <div
              className="h-full rounded-full bg-[#F0DE36] transition-all"
              style={{
                width: `${Math.min(100, ((session?.activeBag?.totalWeightKg ?? 0) / OPERATIONS_BAG_MAX_WEIGHT_KG) * 100)}%`,
              }}
            />
          </div>

          {/* <div className="mt-3 flex flex-col gap-1 text-[11px] leading-4 text-white/60 sm:flex-row sm:flex-wrap sm:justify-between">

            <span>The server selects the fullest suitable bag and never exceeds {OPERATIONS_BAG_MAX_WEIGHT_KG} kg.</span>

            {session?.manifest?.destinationCountryCode === "GB" ? (

              <span>UK bags are also limited to {UK_OPERATIONS_BAG_MAX_PIECES} parcels.</span>

            ) : null}

          </div> */}
        </section>

        {result ? (
          <div
            className={`rounded-xl p-3 ring-1 ${result.accepted ? "bg-emerald-950 ring-emerald-400" : "bg-red-950 ring-red-400"}`}
          >
            <div className="flex items-start">
              {/* {result.accepted ? (

                <FiCheckCircle className="mt-0.5 h-6 w-6 shrink-0 text-emerald-300" />

              ) : (

                <FiXCircle className="mt-0.5 h-6 w-6 shrink-0 text-red-300" />

              )} */}

              <div className="min-w-0">
                <p className="font-mono text-xs font-semibold">{result.code}</p>

                <p className="mt-0.5 text-xs leading-5">{result.message}</p>

                {latestConsignment && consignee ? (
                  <div className="mt-2 space-y-1.5 text-[11px] leading-4 text-white/80">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
                      <span>Consignment</span>

                      <strong className="text-right text-white">
                        {latestConsignment.displayConsignmentNumber}
                      </strong>

                      <span>Parcels</span>

                      <strong className="text-right text-white">
                        {latestConsignment.scannedParcels} of{" "}
                        {latestConsignment.expectedParcels}
                      </strong>

                      <span>Weight</span>

                      <strong className="text-right text-white">
                        {latestConsignment.weightKg.toFixed(3)} kg
                      </strong>

                      <span>Service</span>

                      <strong className="text-right text-white">
                        {latestConsignment.serviceInfo || "Not set"}
                      </strong>
                    </div>

                    <div className="border-t border-white/15 pt-1.5">
                      <p className="text-white/60">Consignee</p>

                      <p className="mt-0.5 text-xs font-semibold text-white">
                        {consignee.name}
                      </p>

                      {consignee.address ? (
                        <p className="mt-0.5 text-[11px] leading-4 text-white/80">
                          {consignee.address}
                        </p>
                      ) : null}
                    </div>

                    {latestConsignment.description ? (
                      <div className="border-t border-white/15 pt-1.5">
                        <p className="text-white/60">Contents</p>

                        <p className="mt-0.5 text-[11px] leading-4 text-white/90">
                          {latestConsignment.description}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {lastScannedParcel ? (
          <section
            aria-label="Last scanned parcel"
            className="rounded-xl bg-white/10 p-3 ring-1 ring-white/10"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold text-white/60">
                  Last scanned parcel
                </p>

                <p className="mt-0.5 break-all font-mono text-xs font-semibold text-white">
                  {lastScannedParcel.parcelNumber}
                </p>

                <p className="mt-0.5 text-[11px] text-white/65">
                  Bag {lastScannedParcel.bagNumber ?? "Not assigned"} ·{" "}
                  {new Date(lastScannedParcel.scannedAt).toLocaleTimeString(
                    [],

                    { hour: "numeric", minute: "2-digit" },
                  )}
                </p>
              </div>

              <button
                type="button"
                onClick={() => void removeLastScannedParcel()}
                disabled={session?.status !== "ACTIVE" || removingLastScan}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-red-300/40 px-3 text-xs font-semibold text-red-200 transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <FiTrash2 aria-hidden="true" />{" "}
                {removingLastScan ? "Removing..." : "Remove last"}
              </button>
            </div>
          </section>
        ) : null}

        {error ? (
          <div className="rounded-xl bg-amber-950 p-2.5 text-xs leading-5 text-amber-100 ring-1 ring-amber-400/50">
            {error}
          </div>
        ) : null}

        <form onSubmit={submitManual} className="flex gap-1.5">
          <input
            value={manualCode}
            onChange={(event) =>
              setManualCode(event.target.value.toUpperCase())
            }
            placeholder="Manual parcel code"
            className="h-10 min-w-0 flex-1 rounded-xl bg-white px-3.5 font-mono text-xs text-slate-950 outline-none ring-1 ring-white/20"
          />

          <button
            disabled={!manualCode.trim() || session?.status !== "ACTIVE"}
            className="h-10 rounded-xl bg-white px-4 text-xs font-semibold text-[#0D1282] transition active:scale-95 disabled:opacity-40"
          >
            Submit
          </button>
        </form>
      </div>
    </main>
  );
}
