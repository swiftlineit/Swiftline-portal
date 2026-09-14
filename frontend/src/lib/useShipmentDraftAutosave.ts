"use client";

import { useCallback, useEffect, useState } from "react";
import {
  LatestShipmentDraftSaver,
  SHIPMENT_DRAFT_AUTOSAVE_DELAY_MS,
  type ShipmentDraftAutosaveStatus
} from "@/lib/shipmentDraftAutosave";

export function useShipmentDraftAutosave<TPatch, TResult>({
  enabled,
  changeKey,
  patch,
  save,
  onSaved,
  onError
}: {
  enabled: boolean;
  changeKey: string;
  patch: TPatch;
  save: (patch: TPatch) => Promise<TResult>;
  onSaved: (result: TResult, isLatest: boolean) => void;
  onError?: (error: unknown) => void;
}) {
  const [status, setStatus] = useState<ShipmentDraftAutosaveStatus>("idle");
  const [saver] = useState(() => new LatestShipmentDraftSaver(
    save,
    onSaved,
    setStatus,
    (error) => onError?.(error)
  ));

  useEffect(() => {
    saver.setPersistenceHandlers(save, onSaved, (error) => onError?.(error));
  }, [onError, onSaved, save, saver]);

  useEffect(() => {
    saver.setStatusHandler(setStatus);
    return () => saver.setStatusHandler(() => undefined);
  }, [saver]);

  useEffect(() => {
    saver.setSnapshot(changeKey, patch);
  }, [changeKey, patch, saver]);

  const flush = useCallback(() => saver.flush(), [saver]);

  useEffect(() => {
    if (!enabled) return;

    const timer = window.setTimeout(() => {
      void flush().catch(() => {
        // The inline status and the form's next explicit action surface failure.
      });
    }, SHIPMENT_DRAFT_AUTOSAVE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, [changeKey, enabled, flush]);

  return { status, flush };
}
