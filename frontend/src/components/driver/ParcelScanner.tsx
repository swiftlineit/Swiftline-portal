"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { BarcodeFormat, BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { FiCamera, FiStopCircle } from "react-icons/fi";

export default function ParcelScanner({
  disabled,
  onScan,
  showManual = true,
  manualLabel = "Parcel barcode",
  manualPlaceholder = "Enter parcel number",
  submitLabel = "Add",
  cameraLabel = "Scan with device camera",
  scanScope,
}: {
  disabled?: boolean;
  onScan: (value: string) => Promise<void>;
  showManual?: boolean;
  manualLabel?: string;
  manualPlaceholder?: string;
  submitLabel?: string;
  cameraLabel?: string;
  /** Resets duplicate suppression when one physical barcode enters a new workflow stage. */
  scanScope?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastScanRef = useRef({ value: "", at: 0 });
  const onScanRef = useRef(onScan);
  const [manual, setManual] = useState("");
  const [camera, setCamera] = useState(false);
  const [error, setError] = useState("");

  // ZXing retains its callback while the camera is open. Keep that callback
  // pointed at the newest operation mode instead of requiring a page reload.
  onScanRef.current = onScan;

  function stopCamera() {
    controlsRef.current?.stop();
    controlsRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamera(false);
  }

  useEffect(() => stopCamera, []);
  useEffect(() => {
    lastScanRef.current = { value: "", at: 0 };
  }, [scanScope]);

  async function submit(raw: string) {
    const value = raw.trim().toUpperCase();
    if (!value) return;
    const now = Date.now();
    if (lastScanRef.current.value === value && now - lastScanRef.current.at < 2500) return;
    lastScanRef.current = { value, at: now };
    await onScanRef.current(value);
    setManual("");
  }

  async function startCamera() {
    setError("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" } }, audio: false });
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new Error("Camera preview is unavailable.");
      const reader = new BrowserMultiFormatReader(new Map(), { delayBetweenScanAttempts: 80, delayBetweenScanSuccess: 500 });
      reader.possibleFormats = [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE];
      controlsRef.current = await reader.decodeFromStream(stream, video, (result) => { if (result) void submit(result.getText()); });
      setCamera(true);
    } catch (caught) {
      stopCamera();
      setError(caught instanceof Error ? caught.message : "Camera permission was denied. Use manual entry.");
    }
  }

  function submitManual(event: FormEvent) { event.preventDefault(); void submit(manual); }

  return <div className="space-y-3">
    <div className={camera ? "relative aspect-[3/1] overflow-hidden rounded-2xl border border-[#0D1282]/35 bg-slate-950" : "hidden"}>
      <video ref={videoRef} muted playsInline className="h-full w-full object-cover" />
      <p className="pointer-events-none absolute inset-x-0 bottom-1.5 text-center text-[11px] font-semibold text-white drop-shadow">
        Scan anywhere in this camera view
      </p>
    </div>
    {error ? <p className="rounded-xl bg-red-50 p-3 text-xs font-medium text-red-700">{error}</p> : null}
    <button type="button" disabled={disabled} onClick={() => camera ? stopCamera() : void startCamera()} className="inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-[#0D1282] text-sm font-semibold text-[#0D1282]">
      {camera ? <><FiStopCircle />Stop camera</> : <><FiCamera />{cameraLabel}</>}
    </button>
    {showManual ? <form onSubmit={submitManual} className="flex gap-2"><label className="sr-only" htmlFor="parcel-scanner-manual">{manualLabel}</label><input id="parcel-scanner-manual" disabled={disabled} value={manual} onChange={(event) => setManual(event.target.value)} placeholder={manualPlaceholder} autoCapitalize="characters" className="h-12 min-w-0 flex-1 rounded-xl border border-slate-300 px-3 text-base uppercase" /><button disabled={disabled || !manual.trim()} className="h-12 rounded-xl bg-slate-900 px-4 text-sm font-semibold text-white">{submitLabel}</button></form> : null}
  </div>;
}
