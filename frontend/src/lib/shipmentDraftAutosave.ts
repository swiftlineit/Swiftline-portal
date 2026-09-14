export const SHIPMENT_DRAFT_AUTOSAVE_DELAY_MS = 1_500;

export type ShipmentDraftAutosaveStatus = "idle" | "saving" | "saved" | "failed";

type DraftSnapshot<TPatch> = {
  key: string;
  patch: TPatch;
};

/**
 * Serializes draft writes and always follows an older in-flight write with the
 * newest snapshot. This prevents a slower response from overwriting edits made
 * while the first request was running.
 */
export class LatestShipmentDraftSaver<TPatch, TResult> {
  private latest: DraftSnapshot<TPatch> | null = null;
  private lastSavedKey: string | null = null;
  private lastSavedResult: TResult | null = null;
  private inFlight: Promise<TResult> | null = null;

  constructor(
    private persist: (patch: TPatch) => Promise<TResult>,
    private saved: (result: TResult, isLatest: boolean) => void,
    private statusChanged: (status: ShipmentDraftAutosaveStatus) => void,
    private failed: (error: unknown) => void = () => undefined
  ) {}

  setPersistenceHandlers(
    persist: (patch: TPatch) => Promise<TResult>,
    saved: (result: TResult, isLatest: boolean) => void,
    failed: (error: unknown) => void = () => undefined
  ) {
    this.persist = persist;
    this.saved = saved;
    this.failed = failed;
  }

  setStatusHandler(statusChanged: (status: ShipmentDraftAutosaveStatus) => void) {
    this.statusChanged = statusChanged;
  }

  setSnapshot(key: string, patch: TPatch) {
    this.latest = { key, patch };
  }

  async flush(): Promise<TResult> {
    for (;;) {
      const snapshot = this.latest;
      if (!snapshot) throw new Error("Shipment draft is not ready to save.");

      if (this.lastSavedKey === snapshot.key && this.lastSavedResult !== null) {
        return this.lastSavedResult;
      }

      if (this.inFlight) {
        await this.inFlight;
        continue;
      }

      this.statusChanged("saving");
      const request = this.persist(snapshot.patch);
      this.inFlight = request;

      try {
        const result = await request;
        const isLatest = this.latest?.key === snapshot.key;
        this.lastSavedKey = snapshot.key;
        this.lastSavedResult = result;
        this.saved(result, isLatest);
        this.statusChanged(isLatest ? "saved" : "idle");

        if (isLatest) return result;
      } catch (error) {
        this.statusChanged("failed");
        this.failed(error);
        throw error;
      } finally {
        if (this.inFlight === request) this.inFlight = null;
      }
    }
  }
}
