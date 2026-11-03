"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchShipmentCostEstimate,
  type ShipmentCostEstimate,
  type ShipmentCostEstimateInput,
  type ShipmentEstimateAudience
} from "@/lib/shipmentCostEstimate";

// Long enough that typing a weight does not fire a request per keystroke, short
// enough that the total feels live.
const estimateDebounceMs = 400;

/**
 * Keeps the booking form's cost estimate in step with what the customer is
 * editing.
 *
 * The server prices every estimate, so this hook holds no pricing logic- it
 * debounces, discards superseded responses, and surfaces the result. Requests are
 * read-only and reserve nothing, so re-pricing on every edit is safe.
 */
export function useShipmentCostEstimate(input: {
  shipmentDraftId: string;
  audience: ShipmentEstimateAudience;
  operatorSlug?: string;
  /** The values to price. Rebuilt on each render; compared by content, not identity. */
  values: ShipmentCostEstimateInput;
  /** Held off until the draft has loaded, so the first request is not priced against an empty form. */
  enabled: boolean;
}) {
  const [estimate, setEstimate] = useState<ShipmentCostEstimate | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  // The values object is rebuilt every render, so the effect keys off its content
  // instead. Without this the debounce would restart on every parent render and
  // the request would never fire. Serializing also gives the effect a stable value
  // to read the payload back from, with no ref to keep in step.
  const serializedValues = JSON.stringify(input.values);
  const { shipmentDraftId, audience, operatorSlug, enabled } = input;

  useEffect(() => {
    if (!enabled || !shipmentDraftId) return;

    const controller = new AbortController();

    const timer = setTimeout(() => {
      // Only once the debounce has actually elapsed, so the panel does not flash
      // a loading state on every keystroke.
      setLoading(true);

      fetchShipmentCostEstimate(
        shipmentDraftId,
        audience,
        JSON.parse(serializedValues) as ShipmentCostEstimateInput,
        controller.signal,
        operatorSlug
      )
        .then((result) => {
          if (controller.signal.aborted) return;
          setEstimate(result);
          setError("");
        })
        .catch((caughtError: unknown) => {
          if (controller.signal.aborted) return;
          setError(caughtError instanceof Error ? caughtError.message : "The shipment cost could not be calculated.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, estimateDebounceMs);

    return () => {
      // Aborting also stops a superseded response from overwriting a newer total.
      clearTimeout(timer);
      controller.abort();
    };
  }, [shipmentDraftId, audience, operatorSlug, enabled, serializedValues, reloadKey]);

  /** Re-prices immediately- used after a booking is refused for a changed price. */
  const refresh = useCallback(() => setReloadKey((current) => current + 1), []);
  const acceptEstimate = useCallback((nextEstimate: ShipmentCostEstimate) => {
    setEstimate(nextEstimate);
    setError("");
  }, []);

  return useMemo(
    () => ({ estimate, loading, error, refresh, acceptEstimate }),
    [estimate, loading, error, refresh, acceptEstimate]
  );
}
