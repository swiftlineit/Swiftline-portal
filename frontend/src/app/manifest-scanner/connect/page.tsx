"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { FiLoader } from "react-icons/fi";
import { getAccessToken, refreshAccessToken } from "@/lib/auth";
import { pairOperationsScanSession } from "@/lib/operationsManifests";

const tokenStorageKey = "swiftline_manifest_pairing_token";

function readStoredPairingToken() {
  try {
    return sessionStorage.getItem(tokenStorageKey) || "";
  } catch {
    return "";
  }
}

function storePairingToken(token: string) {
  try {
    sessionStorage.setItem(tokenStorageKey, token);
  } catch {
    // The URL fragment remains the source of truth when Safari blocks storage.
  }
}

function clearStoredPairingToken() {
  try {
    sessionStorage.removeItem(tokenStorageKey);
  } catch {
    // There is nothing else to clean up when browser storage is unavailable.
  }
}

export default function ConnectManifestScannerPage() {
  const router = useRouter();
  const [message, setMessage] = useState("Connecting this phone to the manifest...");
  const [error, setError] = useState("");
  const pairingAttemptedRef = useRef(false);

  useEffect(() => {
    if (pairingAttemptedRef.current) return;
    pairingAttemptedRef.current = true;
    let active = true;
    async function connect() {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      const tokenFromLink = hash.get("token") ?? "";
      if (tokenFromLink) storePairingToken(tokenFromLink);
      const token = tokenFromLink || readStoredPairingToken();
      if (!token) {
        if (active) setError("This pairing link is incomplete. Create a new phone connection on the laptop.");
        return;
      }

      const accessToken = getAccessToken() ?? await refreshAccessToken();
      if (!accessToken) {
        // Keep the one-time token in the fragment while the user signs in.
        // Fragments are not sent to the server, and this also survives Safari
        // tabs where sessionStorage is unavailable or partitioned.
        const destination = `/manifest-scanner/connect#token=${encodeURIComponent(token)}`;
        router.replace(`/?next=${encodeURIComponent(destination)}`);
        return;
      }

      try {
        const result = await pairOperationsScanSession(token);
        clearStoredPairingToken();
        window.history.replaceState({}, "", "/manifest-scanner/connect");
        if (active) {
          setMessage("Phone connected. Opening the camera scanner...");
          router.replace(`/manifest-scanner/${result.session.id}`);
        }
      } catch (caughtError) {
        if (active) setError(caughtError instanceof Error ? caughtError.message : "This phone could not connect to the manifest.");
      }
    }
    void connect();
    return () => { active = false; };
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0D1282] p-6">
      <div className="w-full max-w-sm border border-white/20 bg-white p-7 text-center shadow-2xl">
        <Image src="/Slogo.png" alt="Swiftline Cargo" width={56} height={56} className="mx-auto h-14 w-14 object-contain" priority />
        <h1 className="mt-5 text-xl font-semibold text-slate-950">Manifest Scanner</h1>
        {error ? (
          <div className="mt-5 border border-red-200 bg-red-50 p-4 text-left text-sm font-semibold text-red-700">{error}</div>
        ) : (
          <div className="mt-5 flex items-center justify-center gap-3 text-sm text-slate-600">
            <FiLoader className="h-5 w-5 animate-spin text-[#0D1282]" />
            <span>{message}</span>
          </div>
        )}
      </div>
    </main>
  );
}
