"use client";

import { useParams, useRouter } from "next/navigation";
import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { FiCheckCircle, FiClock, FiFileText, FiMapPin, FiPackage, FiTruck, FiChevronDown  } from "react-icons/fi";
import { BsArrowCounterclockwise } from "react-icons/bs";
import { toast } from "react-toastify";
import { DashboardLoading } from "@/components/DashboardShell";
import ShipmentAmendmentPanel from "@/components/shipments/ShipmentAmendmentPanel";
import ShipmentCancellationPanel from "@/components/shipments/ShipmentCancellationPanel";
import ShipmentChargeVerificationPanel from "@/components/shipments/ShipmentChargeVerificationPanel";
import ShipmentInvoiceHistory from "@/components/shipments/ShipmentInvoiceHistory";
import CustomsInvoiceCard from "@/components/shipments/CustomsInvoiceCard";
import ShipmentManifestPanel from "@/components/shipments/ShipmentManifestPanel";
import ParcelActivityPanel from "@/components/shipments/ParcelActivityPanel";
import ShipmentKycDocumentsPanel, { collectShipmentKycDocuments } from "@/components/shipments/ShipmentKycDocumentsPanel";
import StaffSupportingDocuments from "@/components/shipments/StaffSupportingDocuments";
import { ShipmentLabelsPanel } from "@/components/shipments/ShipmentLabelsPanel";
import GatewayIataInput, { isValidGatewayIata } from "@/components/shipments/GatewayIataInput";
import {
  DpdShipmentHistoryItem,
  rebookShipmentDraft,
  ShipmentAmendmentInput,
  ShipmentHoldReason,
  ShipmentDraft,
  ShipmentOperationalStatus,
  createShipmentAmendment,
  correctDpdShipmentGateway,
  findMissingStatusPrerequisites,
  findRecordedLaterStatusMilestones,
  firstAllowedOperationalStatus,
  generateExistingDpdLabel,
  getAdminShipmentDetails,
  hasRecordedOperationalStatus,
  getDpdLabelAccessUrl,
  getShipmentDraft,
  holdDpdShipment,
  openShipmentKycDocument,
  openShipmentParcelKycDocument,
  previewShipmentAmendment,
  reconcileDpdShipmentDocuments,
  refreshCarrierTracking,
  releaseDpdShipment,
  shipmentHoldReasonOptions,
  shipmentOperationalStatusOptions,
  updateDpdShipmentOperationalStatus
} from "@/lib/dpdLabels";
import { currentDateTimeLocal, dateTimeLocalToIso, formatDashboardDate, formatDashboardDateTime } from "@/lib/dateFormat";
import { formatCsbType } from "@/lib/csbType";
import {
  getAdminShipmentCancellation,
  requestAdminShipmentCancellation,
  type ShipmentCancellation
} from "@/lib/shipmentCancellations";
import { SHIPMENT_VIEW_AREA } from "@/lib/roles";
import { useAdminUser } from "@/lib/useAdminUser";

function formatDateTime(value?: string | null) {
  return formatDashboardDateTime(value);
}

function formatLabel(value?: string | null) {
  if (!value) return "Not available";
  return value.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatMoneyMinor(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2
  }).format(value / 100);
}

function getDestination(draft: ShipmentDraft) {
  const consignee = draft.consigneeEnteredAddress;
  return [
    consignee.addressLine1,
    consignee.addressLine2,
    consignee.townOrCity,
    consignee.county,
    consignee.postcode,
    consignee.countryName || consignee.countryCode
  ].filter(Boolean).join(", ");
}

function getShipmentStatus(history: DpdShipmentHistoryItem | null) {
  if (history?.currentEvent?.status === "PARCEL_COLLECTED") return "Booking Confirmed";
  if (history?.currentEvent?.status === "DESTINATION_ARRIVED" && history.trackingJourney?.context.gatewayLabel) {
    return `Arrived at ${history.trackingJourney.context.gatewayLabel}`;
  }
  if (history?.currentEvent?.statusLabel) return history.currentEvent.statusLabel;
  if (history?.dpdShipment.status === "LABEL_RECEIVED") return "Shipment Booked";
  if (history?.dpdShipment.status === "DPD_CREATED") return "Documents Need Review";
  if (history?.dpdShipment.status === "DPD_STATUS_UNKNOWN") return "Carrier Outcome Pending";
  if (history?.dpdShipment.status === "DPD_CREATING") return "Booking In Progress";
  if (history?.dpdShipment.status === "DPD_REJECTED") return "Booking Failed";
  if (history?.dpdShipment.status) return formatLabel(history.dpdShipment.status);
  return "Ready for Booking";
}

function hasDpdCarrierLabel(history: DpdShipmentHistoryItem | null) {
  return Boolean(history?.labels.some((label) => label.labelType === "DPD"));
}

/**
 * Internal-only bookings were historically stored as LABEL_RECEIVED even
 * though only Swiftline parcel labels existed. Keep those records actionable,
 * but never expose a retry action when a carrier reference or DPD document is
 * already present.
 */
function canGenerateDpdCarrierLabel(history: DpdShipmentHistoryItem | null) {
  if (!history || history.dpdShipment.dpdShipmentId?.trim() || hasDpdCarrierLabel(history)) return false;
  return ["DPD_CREATED", "LABEL_RECEIVED"].includes(history.dpdShipment.status);
}

function getTrackingEvents(draft: ShipmentDraft, history: DpdShipmentHistoryItem | null) {
  if (history?.trackingJourney?.milestones.length) {
    return history.trackingJourney.milestones.map((milestone) => ({
      label: milestone.label,
      value: milestone.reachedAt ? formatDashboardDate(milestone.reachedAt) : "Pending",
      done: Boolean(milestone.reachedAt)
    }));
  }

  const originFacility = history?.branch?.city ? `Origin Facility ${history.branch.city}` : "Origin Facility";
  const orderedStatuses: Array<{ status: string; label: string }> = [
    { status: "SHIPMENT_BOOKED", label: "Booking Confirmed" },
    { status: "WAREHOUSE_SCAN_IN", label: `Received at ${originFacility}` },
    { status: "ORIGIN_HUB_PROCESSED", label: "Processing for Export" },
    { status: "READY_FOR_EXPORT", label: "Ready for Dispatch" },
    { status: "ORIGIN_HUB_DISPATCHED", label: `Departed from ${originFacility}` },
    { status: "IN_TRANSIT", label: "In International Transit" },
    { status: "DESTINATION_ARRIVED", label: "Arrived in Destination Country" },
    { status: "OUT_FOR_DELIVERY", label: "Out for Delivery" },
    { status: "DELIVERED", label: "Delivered" }
  ];
  const sourceEvents = [...(history?.events ?? [])].reverse();
  const eventsByStatus = new Map(sourceEvents.map((event) => [event.status, event]));
  const events: Array<{ label: string; value: string; done: boolean }> = [];

  if (history?.dpdShipment && !eventsByStatus.has("SHIPMENT_BOOKED")) {
    events.push({
      label: "Booking Confirmed",
      value: `${formatDashboardDate(history.dpdShipment.createdAt)} • Shipment booked with Swiftline and awaiting collection.`,
      done: true
    });
  }

  const cancellationEvent = eventsByStatus.get("SHIPMENT_CANCELLED");
  if (cancellationEvent) {
    for (const status of orderedStatuses) {
      const event = eventsByStatus.get(status.status);
      if (!event) continue;
      events.push({
        label: status.label,
        value: `${formatDashboardDate(event.eventAt)} - ${event.note || "Shipment progress updated."}`,
        done: true
      });
    }
    events.push({
      label: cancellationEvent.statusLabel ?? "Shipment Cancelled",
      value: `${formatDashboardDate(cancellationEvent.eventAt)} - ${cancellationEvent.note || "Cancelled by Swiftline Operations"}`,
      done: true
    });
    return events;
  }

  for (const status of orderedStatuses) {
    if (status.status === "SHIPMENT_BOOKED" && history?.dpdShipment && !eventsByStatus.has(status.status)) continue;
    const event = eventsByStatus.get(status.status);
    events.push({
      label: status.label,
      value: event
        ? `${formatDashboardDate(event.eventAt)} • ${event.note || "Shipment progress updated."}`
        : "Pending",
      done: Boolean(event)
    });
  }

  return events;
}

function hasMovedPastParcelCollected(history: DpdShipmentHistoryItem | null) {
  const blockedStatuses = new Set([
    "WAREHOUSE_SCAN_IN",
    "EXPORT_CUSTOMS_CLEARED",
    "FLIGHT_ASSIGNED",
    "FLIGHT_DEPARTED",
    "DESTINATION_ARRIVED",
    "IMPORT_CUSTOMS_CLEARANCE",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "RETURNED",
    "LOST",
    "DAMAGED"
  ]);

  return Boolean(history?.events.some((event) => blockedStatuses.has(event.status)));
}

function hasReachedWarehouse(history: DpdShipmentHistoryItem | null) {
  const blockedStatuses = new Set([
    "WAREHOUSE_SCAN_IN", "ORIGIN_HUB_PROCESSED", "READY_FOR_EXPORT", "ORIGIN_HUB_DISPATCHED",
    "EXPORT_CUSTOMS_CLEARED", "FLIGHT_ASSIGNED", "FLIGHT_DEPARTED", "DESTINATION_ARRIVED",
    "IMPORT_CUSTOMS_CLEARANCE", "IMPORT_CUSTOMS_CLEARED", "DELIVERY_PARTNER_TRANSFERRED",
    "DELIVERY_HUB_ARRIVED", "OUT_FOR_DELIVERY", "DELIVERED",
    "RETURNED", "LOST", "DAMAGED"
  ]);
  return Boolean(history?.events.some((event) => blockedStatuses.has(event.status)));
}

export default function AdminShipmentDetailsPage() {
  const params = useParams<{ draftId: string }>();
  const router = useRouter();
  const { user, loading } = useAdminUser(SHIPMENT_VIEW_AREA);
  const [draft, setDraft] = useState<ShipmentDraft | null>(null);
  const [history, setHistory] = useState<DpdShipmentHistoryItem | null>(null);
  const [cancellation, setCancellation] = useState<ShipmentCancellation | null>(null);
  const [loadError, setLoadError] = useState("");
  const [shipmentLoading, setShipmentLoading] = useState(true);
  const [actionFeedback, setActionFeedback] = useState<{ message: string; tone: "warning" | "error" } | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMode, setActionMode] = useState<"hold" | "release" | "status" | "gateway" | null>(null);
  // Starts unchosen. Defaulting to a reason meant a hold placed without touching
  // the dropdown was recorded as "missing documents", which raises a customer
  // -facing demand for paperwork nobody actually asked for.
  const [holdReason, setHoldReason] = useState<ShipmentHoldReason | "">("");
  const [nextStatus, setNextStatus] = useState<ShipmentOperationalStatus>("PARCEL_COLLECTED");
  const [actionNote, setActionNote] = useState("");
  // Where this scan happened. Optional- an event without a location is still
  // recorded, it just does not move the shipment's "current location".
  const [actionLocation, setActionLocation] = useState("");
  const [actionGatewayCode, setActionGatewayCode] = useState("");
  /**
   * When this scan actually happened, as a datetime-local value. Optional-
   * empty records the event at the moment it is saved, exactly as before, while
   * a stated time is what the customer's timeline shows for a status keyed in
   * later than the parcel actually moved.
   */
  const [actionAt, setActionAt] = useState("");
  const [amendmentBusy, setAmendmentBusy] = useState(false);
  const [chargeVerified, setChargeVerified] = useState(false);
  const [cancellationBusy, setCancellationBusy] = useState(false);
  const [cancellationError, setCancellationError] = useState("");
  const [rebooking, setRebooking] = useState(false);
  const [refreshingCarrier, setRefreshingCarrier] = useState(false);

  const totalWeight = useMemo(() => (
    draft?.parcelList.reduce((total, parcel) => total + (Number(parcel.weightKg) || 0), 0) ?? 0
  ), [draft]);
  const kycDocuments = useMemo(
    () => draft ? collectShipmentKycDocuments({ documents: draft.kycDocuments, parcels: draft.parcelList, kycUseForAllParcels: draft.kycUseForAllParcels }) : [],
    [draft]
  );
  const isOnHold = history?.currentEvent?.status === "ON_HOLD";
  const cancellationLocked = cancellation?.status === "REQUESTED" || cancellation?.status === "COMPLETED";
  const isUkRoute = draft?.consigneeEnteredAddress.countryCode?.toUpperCase() === "GB";
  const canManageDpdLabel = user?.role === "admin" || user?.role === "operations";
  const canRequestDpdLabel = canManageDpdLabel && isUkRoute && canGenerateDpdCarrierLabel(history);
  const needsCarrierDocumentReview = canManageDpdLabel
    && (history?.dpdShipment.status === "DPD_CREATED" || canRequestDpdLabel);
  const arrivalEvent = useMemo(
    () => (history?.events ?? []).find((event) => event.status === "DESTINATION_ARRIVED") ?? null,
    [history]
  );

  /**
   * Every status this shipment has ever recorded, which is what decides how far
   * up the ladder Operations may go next. Progress is recorded in order, so a
   * stage whose earlier steps are missing cannot be selected until they are
   * filled in- see findMissingStatusPrerequisites.
   */
  const recordedStatuses = useMemo(
    () => (history?.events ?? []).map((event) => event.status),
    [history]
  );
  const canRefreshCarrierTracking = canManageDpdLabel
    && Boolean(history?.dpdShipment.dpdShipmentId?.match(/^\d+$/))
    && recordedStatuses.some((status) => ["IN_TRANSIT", "DESTINATION_ARRIVED", "OUT_FOR_DELIVERY"].includes(status));
  const statusChoices = useMemo(
    () => shipmentOperationalStatusOptions.map((option) => ({
      ...option,
      completed: hasRecordedOperationalStatus(option.value, recordedStatuses),
      missing: findMissingStatusPrerequisites(option.value, recordedStatuses),
      later: findRecordedLaterStatusMilestones(option.value, recordedStatuses)
    })),
    [recordedStatuses]
  );
  const blockedStatus = statusChoices.find((option) => option.value === nextStatus);

  const loadShipment = useCallback(async () => {
    if (!params.draftId) return;

    setShipmentLoading(true);
    setLoadError("");

    try {
      const [draftData, shipmentData, cancellationData] = await Promise.all([
        getShipmentDraft(params.draftId),
        getAdminShipmentDetails(params.draftId),
        getAdminShipmentCancellation(params.draftId)
      ]);

      setDraft(draftData.shipmentDraft);
      setHistory(shipmentData.shipment);
      setCancellation(cancellationData.cancellation);
    } catch (caughtError) {
      setLoadError(caughtError instanceof Error ? caughtError.message : "Unable to load shipment.");
    } finally {
      setShipmentLoading(false);
    }
  }, [params.draftId]);

  useEffect(() => {
    if (!user || !params.draftId) return;

    let mounted = true;

    async function loadWhenMounted() {
      await Promise.resolve();
      if (!mounted) return;
      await loadShipment();
    }

    void loadWhenMounted();

    return () => {
      mounted = false;
    };
  }, [loadShipment, params.draftId, user]);

  async function handleShipmentAction() {
    if (!history?.dpdShipment || !actionMode) return;
    if ((actionMode === "hold" || actionMode === "release") && actionNote.trim().length < 3) return;
    // A hold must name its reason: the reason is what the customer is told.
    if (actionMode === "hold" && !holdReason) return;
    if ((actionMode === "gateway" || (actionMode === "status" && nextStatus === "DESTINATION_ARRIVED"))
      && !isValidGatewayIata(isUkRoute ? "LHR" : actionGatewayCode)) return;

    setActionBusy(true);
    setActionFeedback(null);

    try {
      if (actionMode === "gateway") {
        const result = await correctDpdShipmentGateway({
          dpdShipmentId: history.dpdShipment.id,
          gatewayCode: isUkRoute ? "LHR" : actionGatewayCode
        });
        toast.success(result.message);
      } else if (actionMode === "hold") {
        await holdDpdShipment({
          dpdShipmentId: history.dpdShipment.id,
          reason: holdReason as ShipmentHoldReason,
          note: actionNote,
          location: actionLocation
        });
      } else if (actionMode === "release") {
        await releaseDpdShipment({
          dpdShipmentId: history.dpdShipment.id,
          note: actionNote,
          location: actionLocation
        });
      } else {
        await updateDpdShipmentOperationalStatus({
          dpdShipmentId: history.dpdShipment.id,
          status: nextStatus,
          note: actionNote,
          location: actionLocation,
          gatewayCode: nextStatus === "DESTINATION_ARRIVED"
            ? (isUkRoute ? "LHR" : actionGatewayCode)
            : undefined,
          eventAt: dateTimeLocalToIso(actionAt)
        });
      }

      setActionMode(null);
      setActionNote("");
      setActionLocation("");
      setActionGatewayCode("");
      setActionAt("");
      await loadShipment();
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Shipment action failed.";
      // Both of these say something has to happen first, rather than that the
      // action failed, so they read as guidance rather than as an error.
      const isWorkflowGuidance = message.toLowerCase().includes("verify the final shipment weight and charge")
        || message.includes("must be recorded in order");
      setActionFeedback({ message, tone: isWorkflowGuidance ? "warning" : "error" });
    } finally {
      setActionBusy(false);
    }
  }

  async function handleDocumentReconciliation() {
    if (!history?.dpdShipment) return;
    setActionBusy(true);
    setActionFeedback(null);
    try {
      const result = await reconcileDpdShipmentDocuments(history.dpdShipment.id);
      toast.success(result.message);
      await loadShipment();
    } catch (caughtError) {
      const message = caughtError instanceof Error ? caughtError.message : "Shipment documents could not be reconciled.";
      setActionFeedback({ message, tone: "error" });
      toast.error(message);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleGenerateDpdLabel() {
    if (!history?.dpdShipment || !canRequestDpdLabel) return;
    if (history.dpdShipment.dpdShipmentId) {
      setActionFeedback({
        message: "This booking already has a carrier reference. Do not request another label; contact Swiftline Operations to reconcile the stored document.",
        tone: "warning"
      });
      return;
    }
    if (!window.confirm("This will request the DPD carrier label for this existing shipment. It will not create another shipment or invoice. Continue?")) return;

    setActionBusy(true);
    setActionFeedback(null);
    try {
      const result = await generateExistingDpdLabel(history.dpdShipment.id);
      toast.success(result.message);
      await loadShipment();
    } catch (caughtError) {
      const message = caughtError instanceof Error
        ? caughtError.message
        : "The DPD carrier label could not be generated. Check the shipment audit history before retrying.";
      setActionFeedback({ message, tone: "error" });
      toast.error(message);
    } finally {
      setActionBusy(false);
    }
  }

  async function handleAmendment(input: ShipmentAmendmentInput) {
    if (!draft) return;

    setAmendmentBusy(true);
    setActionFeedback(null);

    try {
      await createShipmentAmendment(draft._id, input);
      await loadShipment();
    } catch (caughtError) {
      setActionFeedback({
        message: caughtError instanceof Error ? caughtError.message : "Unable to apply amendment.",
        tone: "error"
      });
      throw caughtError;
    } finally {
      setAmendmentBusy(false);
    }
  }

  async function handleAmendmentPreview(input: ShipmentAmendmentInput) {
    if (!draft) throw new Error("Shipment is not available.");

    const result = await previewShipmentAmendment(draft._id, input);
    return {
      pricingImpact: result.pricingImpact,
      fundingPreview: result.fundingPreview
    };
  }

  async function handleCancellation(reason: string) {
    if (!draft) return;
    setCancellationBusy(true);
    setCancellationError("");
    try {
      const result = await requestAdminShipmentCancellation(draft._id, reason);
      setCancellation(result.cancellation);
      setActionMode(null);
    } catch (caughtError) {
      setCancellationError(caughtError instanceof Error ? caughtError.message : "Unable to request cancellation.");
      throw caughtError;
    } finally {
      setCancellationBusy(false);
    }
  }

  async function handleRebook() {
    if (!draft || rebooking) return;
    if (!history?.dpdShipment) {
      toast.error("Only booked shipments can be rebooked.");
      return;
    }
    setRebooking(true);
    try {
      const result = await rebookShipmentDraft(draft._id);
      toast.success("Shipment cloned for rebooking. Complete the booking.");
      router.push(`/dashboard/dpd-labels/${result.shipmentDraft._id}`);
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "Rebooking failed. Please try again.");
    } finally {
      setRebooking(false);
    }
  }

  async function handleCarrierRefresh() {
    if (!history?.dpdShipment || refreshingCarrier) return;
    setRefreshingCarrier(true);
    try {
      const result = await refreshCarrierTracking(history.dpdShipment.id);
      const appliedMessage = result.result.applied
        ? `${result.result.applied} new tracking milestone${result.result.applied === 1 ? "" : "s"} applied.`
        : "ALS tracking is already up to date.";
      if (result.result.reviewRequired) {
        toast.warning(
          `${appliedMessage} ${result.result.reviewRequired} carrier event${result.result.reviewRequired === 1 ? " needs" : "s need"} Operations review.`,
        );
      } else {
        toast.success(appliedMessage);
      }
      await loadShipment();
    } catch (caughtError) {
      toast.error(caughtError instanceof Error ? caughtError.message : "ALS tracking refresh failed.");
    } finally {
      setRefreshingCarrier(false);
    }
  }

  if (loading || !user) return <DashboardLoading />;

  return (
      <div className="mx-auto max-w-8xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="mt-3 text-2xl font-semibold text-slate-950">Shipment Details</h1>
            <p className="mt-1 text-sm font-medium text-slate-600">
              AWB / Tracking No.: {history?.dpdShipment.swiftlineTrackingNumber || "AWB Pending"}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StatusPill label={getShipmentStatus(history)} tone={isOnHold ? "warning" : history?.dpdShipment ? "success" : "neutral"} />
            {/* Rebook - only admin/operations may rebook. Delivery sees this page via SHIPMENT_VIEW_AREA but must not rebook. */}
            {history?.dpdShipment && (user.role === "admin" || user.role === "operations") ? (
              <button
                type="button"
                onClick={() => void handleRebook()}
                disabled={rebooking}
                className="inline-flex h-10 items-center gap-2 rounded-4xl border border-[#0D1282] bg-white px-4 text-sm font-semibold text-[#0D1282] transition hover:bg-[#0D1282]/5 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <BsArrowCounterclockwise aria-hidden="true" className="h-4 w-4" />
                {rebooking ? "Rebooking..." : "Rebook"}
              </button>
            ) : null}
            {canRefreshCarrierTracking ? (
              <button
                type="button"
                onClick={() => void handleCarrierRefresh()}
                disabled={refreshingCarrier}
                className="inline-flex h-10 items-center gap-2 rounded-xl border border-blue-700 bg-white px-4 text-sm font-semibold text-blue-800 transition hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <BsArrowCounterclockwise aria-hidden="true" className="h-4 w-4" />
                {refreshingCarrier ? "Refreshing ALS..." : "Refresh ALS Tracking"}
              </button>
            ) : null}
            {history?.dpdShipment && !cancellationLocked ? (
              <>
                {!isOnHold ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActionMode("status");
                      // Opens on the earliest stage this shipment may record, so the
                      // form never presents a selection the server would reject.
                      const firstStatus = firstAllowedOperationalStatus(recordedStatuses);
                      setNextStatus(firstStatus);
                      setActionGatewayCode(firstStatus === "DESTINATION_ARRIVED" && isUkRoute ? "LHR" : "");
                      setActionNote("");
                    }}
                    className="h-10 border border-blue-900 px-4 rounded-4xl text-sm font-semibold text-blue-900 hover:bg-blue-50"
                  >
                    Update Status
                  </button>
                ) : null}
                {isOnHold ? (
                  <button
                    type="button"
                    onClick={() => {
                      setActionMode("release");
                      setActionNote("");
                    }}
                    className="h-10 border border-emerald-700 px-4 rounded-xl text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                  >
                    Release Hold
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setActionMode("hold");
                      setActionNote("");
                    }}
                    className="h-10 border border-amber-700 px-4 rounded-4xl text-sm font-semibold text-amber-700 hover:bg-amber-50"
                  >
                    Put On Hold
                  </button>
                )}
              </>
            ) : null}
            {history?.dpdShipment && arrivalEvent ? (
              <button
                type="button"
                onClick={() => {
                  setActionMode("gateway");
                  setActionGatewayCode(isUkRoute ? "LHR" : arrivalEvent.gatewayCode ?? "");
                  setActionNote("");
                  setActionLocation("");
                  setActionAt("");
                }}
                className="h-10 rounded-xl border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:border-blue-900 hover:text-blue-900"
              >
                {arrivalEvent.gatewayCode ? "Correct Gateway IATA" : "Set Gateway IATA"}
              </button>
            ) : null}
          </div>
        </div>

        {shipmentLoading ? (
          <section className="flex min-h-[60vh] items-center justify-center">
            <div className="text-center">
              <div className="mx-auto mb-3 h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-blue-900" />
              <p className="text-sm font-semibold text-slate-600">Loading shipment details...</p>
            </div>
          </section>
        ) : loadError ? (
          <section className="flex min-h-[60vh] items-center justify-center px-4">
            <div
              role="alert"
              className="max-w-md rounded-xl border border-red-200 bg-red-50 px-6 py-5 text-center text-sm font-semibold text-red-700"
            >
              {loadError}
            </div>
          </section>
        ) : !draft ? (
          <section className="flex min-h-[60vh] items-center justify-center px-4">
            <div className="max-w-md rounded-xl border border-slate-200 bg-white px-6 py-5 text-center text-sm font-semibold text-slate-600">
              Shipment not found.
            </div>
          </section>
        ) : (
          <>
            {actionFeedback ? (
              <section
                role={actionFeedback.tone === "error" ? "alert" : "status"}
                className={`border p-4 text-sm font-medium ${
                  actionFeedback.tone === "warning"
                    ? "border-amber-300 bg-amber-50 text-amber-900"
                    : "border-red-200 bg-red-50 text-red-700"
                }`}
              >
                {actionFeedback.message}
              </section>
            ) : null}
            {actionMode ? (
             <section className="border  bg-white p-5 rounded-2xl border-amber-300">
                <div className={`grid gap-4 lg:items-start ${
                  actionMode === "status"
                    ? nextStatus === "DESTINATION_ARRIVED"
                      ? "lg:grid-cols-2 xl:grid-cols-[200px_minmax(0,1fr)_180px_170px_210px_auto]"
                      : "lg:grid-cols-[200px_minmax(0,1fr)_180px_210px_auto]"
                    : actionMode === "gateway"
                      ? "sm:grid-cols-[minmax(0,1fr)_190px_auto]"
                    : "lg:grid-cols-[220px_minmax(0,1fr)_220px_auto]"
                }`}>
                  {actionMode === "hold" ? (
                    <label>
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Hold Reason</span>
                      <div className="relative mt-2">
                        <select
                          value={holdReason}
                          onChange={(event) => setHoldReason(event.target.value as ShipmentHoldReason)}
                          className={`h-10 w-full appearance-none rounded-xl border bg-white px-3 pr-9 text-sm font-semibold focus:border-blue-900 focus:outline-none ${
                            holdReason ? "border-slate-300 text-slate-900" : "border-amber-300 text-slate-400"
                          }`}
                        >
                          <option value="" disabled>Select a hold reason</option>
                          {shipmentHoldReasonOptions.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                        <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      </div>
                    </label>
                  ) : actionMode === "status" ? (
                    <label>
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Shipment Status</span>
                      <div className="relative mt-2">
                        <select
                          value={nextStatus}
                          onChange={(event) => {
                            const status = event.target.value as ShipmentOperationalStatus;
                            setNextStatus(status);
                            setActionGatewayCode(status === "DESTINATION_ARRIVED" && isUkRoute ? "LHR" : "");
                          }}
                          className="h-10 w-full appearance-none border rounded-xl border-slate-300 bg-white px-3 pr-9 text-sm font-semibold text-slate-900 focus:border-blue-900 focus:outline-none"
                        >
                          {statusChoices.map((option) => (
                            <option
                              key={option.value}
                              value={option.value}
                              // A stage the shipment has not reached yet. Shown rather
                              // than hidden so the whole journey stays visible and the
                              // outstanding step explains itself.
                              disabled={option.completed || option.missing.length > 0 || option.later.length > 0}
                            >
                              {option.label}
                              {option.completed
                                ? " - completed"
                                : option.later.length
                                  ? " - earlier stage"
                                  : option.missing.length
                                    ? " - not yet reached"
                                    : ""}
                            </option>
                          ))}
                        </select>
                        <FiChevronDown className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                      </div>
                      {/* Says which step is outstanding before anything is submitted,
                          rather than leaving the server to explain it afterwards. */}
                      {blockedStatus?.missing.length ? (
                        <p className="mt-2 text-xs font-medium leading-5 text-amber-700">
                          Record{" "}
                          {blockedStatus.missing
                            .map((status) => shipmentOperationalStatusOptions.find((option) => option.value === status)?.label ?? status)
                            .join(", ")}{" "}
                          before {blockedStatus.label.toLowerCase()} becomes available. Shipment progress is
                          recorded in order.
                        </p>
                      ) : null}
                      {blockedStatus?.later.length ? (
                        <p className="mt-2 text-xs font-medium leading-5 text-amber-700">
                          {blockedStatus.label} cannot be added because a later milestone is already recorded.
                          Use the controlled correction process for historical data.
                        </p>
                      ) : null}
                    </label>
                  ) : actionMode === "gateway" ? (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actual Arrival Gateway</p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">
                        Correct the IATA without adding or changing a timeline event.
                      </p>
                    </div>
                  ) : (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Release Action</p>
                      <p className="mt-2 text-sm font-semibold text-slate-950">Release shipment from hold</p>
                    </div>
                  )}
                  {actionMode !== "gateway" ? <label>
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      {actionMode === "hold" ? "Hold Note" : actionMode === "release" ? "Release Note" : "Status Note"}
                    </span>
                    <input
                      value={actionNote}
                      onChange={(event) => setActionNote(event.target.value)}
                      placeholder={actionMode === "hold" ? "Explain why this shipment is on hold" : actionMode === "release" ? "Explain why this shipment can continue" : "Optional status note"}
                      className="mt-2 h-10 w-full border border-slate-300 px-3  rounded-xl text-sm text-slate-900 focus:border-blue-900 focus:outline-none"
                    />
                  </label> : null}
                  {actionMode !== "gateway" ? <label>
                    <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Location <span className="font-normal normal-case text-slate-400">(optional)</span>
                    </span>
                    <input
                      value={actionLocation}
                      onChange={(event) => setActionLocation(event.target.value)}
                      maxLength={120}
                      placeholder={nextStatus === "DESTINATION_ARRIVED" ? "Toronto Gateway" : "Delhi Hub"}
                      title="Where this scan happened. Shown to the customer as the shipment's current location."
                      className="mt-2 h-10 w-full border border-slate-300 px-3 rounded-xl text-sm text-slate-900 focus:border-blue-900 focus:outline-none"
                    />
                  </label> : null}
                  {actionMode === "gateway" || (actionMode === "status" && nextStatus === "DESTINATION_ARRIVED") ? (
                    <GatewayIataInput
                      value={actionGatewayCode}
                      onChange={setActionGatewayCode}
                      ukRoute={isUkRoute}
                    />
                  ) : null}
                  {actionMode === "status" ? (
                    <label>
                      <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Status Date <span className="font-normal normal-case text-slate-400">(optional)</span>
                      </span>
                      <input
                        type="datetime-local"
                        value={actionAt}
                        onChange={(event) => setActionAt(event.target.value)}
                        max={currentDateTimeLocal()}
                        title="When this scan actually happened. Leave empty to record it as happening now."
                        className="mt-2 h-10 w-full border border-slate-300 px-3 rounded-xl text-sm text-slate-900 focus:border-blue-900 focus:outline-none"
                      />
                      <span className="mt-1 block text-xs font-medium leading-4 text-slate-500">
                        Shown on the timeline instead of the moment you press Update.
                      </span>
                    </label>
                  ) : null}
                  <div className="flex gap-2 lg:mt-6">
                    <button
                      type="button"
                      onClick={handleShipmentAction}
                      disabled={actionBusy
                        || ((actionMode === "hold" || actionMode === "release") && actionNote.trim().length < 3)
                        || (actionMode === "hold" && !holdReason)
                        || (actionMode === "status" && Boolean(
                          blockedStatus?.completed || blockedStatus?.missing.length || blockedStatus?.later.length
                        ))
                        || ((actionMode === "gateway" || (actionMode === "status" && nextStatus === "DESTINATION_ARRIVED"))
                          && !isValidGatewayIata(isUkRoute ? "LHR" : actionGatewayCode))}
                      className="h-10 bg-blue-900 px-4  rounded-2xl text-sm font-semibold text-white hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
                    >
                      {actionBusy ? "Saving..." : actionMode === "hold" ? "Hold" : actionMode === "release" ? "Release" : actionMode === "gateway" ? "Save Gateway" : "Update"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setActionMode(null);
                        setActionNote("");
                        setActionLocation("");
                        setActionGatewayCode("");
                        setActionAt("");
                      }}
                      className="h-10 border     border-slate-300 px-4  rounded-2xl text-sm font-semibold text-slate-700 hover:border-slate-500"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </section>
        ) : null}

        {needsCarrierDocumentReview ? (
          <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4">
            <div>
              <h2 className="font-semibold text-amber-950">
                {canRequestDpdLabel ? "Internal labels ready; DPD label not generated" : "Carrier booking accepted, documents need review"}
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-amber-800">
                {canRequestDpdLabel
                  ? "This shipment already exists with Swiftline labels. An authorized Admin or Operations user can generate its DPD carrier label here without creating another shipment or invoice."
                  : "The shipment already exists. Complete the carrier document review here without creating another shipment or invoice. If the carrier result is uncertain, do not retry."}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {canRequestDpdLabel ? (
                <button
                  type="button"
                  onClick={handleGenerateDpdLabel}
                  disabled={actionBusy}
                  className="h-10 rounded-xl bg-amber-800 px-4 text-sm font-semibold text-white hover:bg-amber-900 disabled:cursor-wait disabled:opacity-60"
                >
                  {actionBusy ? "Generating..." : "Generate DPD label"}
                </button>
              ) : null}
              {history && history.dpdShipment.status === "DPD_CREATED" && !history.dpdShipment.dpdShipmentId ? (
                <button
                  type="button"
                  onClick={handleDocumentReconciliation}
                  disabled={actionBusy}
                  className="h-10 rounded-xl border border-amber-700 bg-white px-4 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60"
                >
                  {actionBusy ? "Finalizing..." : "Finalize without DPD label"}
                </button>
              ) : null}
            </div>
          </section>
        ) : null}

        {history?.dpdShipment.status === "DPD_STATUS_UNKNOWN" ? (
          <section className="border border-red-300 bg-red-50 rounded-2xl px-5 py-4">
            <h2 className="font-semibold text-red-950">Carrier outcome requires confirmation</h2>
            <p className="mt-1 text-sm text-red-800">Do not submit this shipment again. Confirm the booking with Swiftline Operations before releasing or completing it.</p>
          </section>
        ) : null}

            <section className="border border-slate-200 bg-white rounded-2xl">
              <div className="grid gap-0 lg:grid-cols-3">
                <DetailPanel title="Shipment" icon={<FiTruck aria-hidden="true" className="h-4 w-4" />}>
                  <DetailRow label="AWB / Tracking No." value={history?.dpdShipment.swiftlineTrackingNumber || "AWB Pending"} />
                  <DetailRow label="Customer Reference" value={history?.bookingConfirmation?.customerReference || "Not provided"} />
                  <DetailRow label="Current Status" value={getShipmentStatus(history)} />
                  <DetailRow label="Updated" value={formatDateTime(history?.dpdShipment.updatedAt)} />
                </DetailPanel>

                <DetailPanel title="Booking" icon={<FiFileText aria-hidden="true" className="h-4 w-4" />}>
                  <DetailRow label="Swiftline Tax Invoice No." value={history?.shipmentInvoice?.invoiceNumber || "Tax Invoice Pending"} />
                  <DetailRow label="Booked At" value={formatDateTime(history?.dpdShipment.createdAt)} />
                </DetailPanel>

                <DetailPanel title="Parcels" icon={<FiPackage aria-hidden="true" className="h-4 w-4" />}>
                  <DetailRow label="Parcel Count" value={String(draft.parcelCount || draft.parcelList.length)} />
                  <DetailRow label="Total Weight" value={`${totalWeight.toFixed(2)} kg`} />
                  <DetailRow label="Service" value={draft.serviceType === "CARGO" ? "Cargo" : draft.serviceType === "COURIER" ? "Courier" : formatLabel(draft.serviceCode)} />
                  <DetailRow label="Shipment Type" value={formatCsbType(draft.csbType)} />
                </DetailPanel>
              </div>
            </section>

            {history?.bookingConfirmation && (history.shipmentInvoice?.revision ?? 1) === 1 ? (
              <section className="border border-slate-200 bg-white rounded-xl">
                <div className="border-b border-slate-200 px-5 py-4">
                  <h2 className="text-base font-semibold text-slate-950">Booking Confirmation</h2>
                  <p className="mt-1 text-sm text-slate-600">Locked shipment, pricing, and account allocation recorded at booking.</p>
                </div>
                <dl className="grid sm:grid-cols-2 xl:grid-cols-5">
                  <ConfirmationValue label="Customer Reference" value={history.bookingConfirmation.customerReference || "Not provided"} />
                  <ConfirmationValue label="Base Charge" value={formatMoneyMinor(history.bookingConfirmation.baseAmountMinor)} />
                  <ConfirmationValue label="GST" value={history.bookingConfirmation.gstAmountMinor === 0 ? "-" : formatMoneyMinor(history.bookingConfirmation.gstAmountMinor)} />
                  <ConfirmationValue label="Total" value={formatMoneyMinor(history.bookingConfirmation.totalAmountMinor)} />
                  <ConfirmationValue label="Advance / Credit" value={`${formatMoneyMinor(history.bookingConfirmation.advanceAmountMinor)} / ${formatMoneyMinor(history.bookingConfirmation.creditAmountMinor)}`} />
                </dl>
              </section>
            ) : null}

            {history?.labels.length ? (
              <ShipmentLabelsPanel
                labels={history.labels}
                swiftlineTrackingNumber={history.dpdShipment.swiftlineTrackingNumber}
                getAccessUrl={(labelId, disposition) => getDpdLabelAccessUrl(history.dpdShipment.id, labelId, disposition)}
              />
            ) : null}

            {history?.dpdShipment ? (
              <>
                <ShipmentInvoiceHistory draftId={draft._id} audience="admin" canEdit={user.role === "admin" || user.role === "operations"} />
                <div className="mt-4"><CustomsInvoiceCard draftId={draft._id} audience="admin" /></div>
                <ShipmentManifestPanel draftId={draft._id} audience="admin" />
              </>
            ) : null}

            <ShipmentCancellationPanel
              cancellation={cancellation}
              canRequest={Boolean(history?.dpdShipment) && !hasReachedWarehouse(history)}
              blockedReason={history?.dpdShipment
                ? "Admin cancellation is blocked after Warehouse Scan In."
                : "Shipment must be booked before cancellation can be requested."}
              audience="admin"
              busy={cancellationBusy}
              error={cancellationError}
              onRequest={handleCancellation}
            />

            {history?.dpdShipment && !cancellationLocked ? (
              <ShipmentChargeVerificationPanel
                dpdShipmentId={history.dpdShipment.id}
                parcelList={draft.parcelList}
                onStateChange={setChargeVerified}
                onFinalized={loadShipment}
              />
            ) : null}

            <ShipmentAmendmentPanel
              key={draft.updatedAt ?? draft._id}
              address={draft.consigneeEnteredAddress}
              parcelList={draft.parcelList}
              serviceType={draft.serviceType ?? "COURIER"}
              canAmend={Boolean(history?.dpdShipment) && !hasMovedPastParcelCollected(history) && !chargeVerified && !cancellationLocked}
              blockedReason={
                cancellation?.status === "REQUESTED"
                  ? "Amendments are paused while the cancellation request is under review."
                  : cancellation?.status === "COMPLETED"
                    ? "Cancelled shipments cannot be amended."
                    : chargeVerified
                  ? "Amendments are blocked after final charge verification."
                  : history?.dpdShipment
                  ? "Amendments are blocked after Parcel Collected."
                  : "Shipment must be booked before amendments can be applied."
              }
              busy={amendmentBusy}
              onPreview={handleAmendmentPreview}
              onSubmit={handleAmendment}
            />

          {history?.carrierTrackingReviews?.length ? (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-5" aria-labelledby="carrier-review-heading">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 id="carrier-review-heading" className="text-sm font-semibold uppercase tracking-wide text-amber-950">
                    Carrier events needing review
                  </h2>
                  <p className="mt-1 text-sm text-amber-900">
                    These ALS updates were not guessed into a customer status. Operations should verify them before making a manual correction.
                  </p>
                </div>
                <span className="rounded-full bg-amber-200 px-3 py-1 text-xs font-semibold text-amber-950">
                  {history.carrierTrackingReviews.length} pending
                </span>
              </div>
              <div className="mt-4 grid gap-3">
                {history.carrierTrackingReviews.map((event) => (
                  <article key={event.id} className="rounded-xl border border-amber-200 bg-white p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-slate-950">{event.description || event.eventState}</p>
                      <time className="text-xs font-medium text-slate-500" dateTime={event.eventAt}>
                        {formatDateTime(event.eventAt)}
                      </time>
                    </div>
                    <p className="mt-1 text-sm text-slate-700">
                      {event.location || "Location not supplied"} · ALS state: {event.eventState || "blank"}
                    </p>
                    <p className="mt-2 text-xs font-medium text-amber-900">{event.processingNote}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <ParcelActivityPanel
            activities={history?.parcelActivities}
            progress={history?.parcelProgress}
          />

          <section className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
              {/* Destination card */}
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm ">
                <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4 rounded-2xl">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: "#E8E9F6" }}
                  >
                    <FiMapPin aria-hidden="true" className="h-4 w-4" style={{ color: "#0D1282" }} />
                  </span>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Destination</h2>
                </div>

                <div className="p-5">
                  <p className="text-lg font-bold text-slate-900">
                    {draft.consigneeEnteredAddress.companyName || draft.consigneeEnteredAddress.contactName || "Consignee"}
                  </p>
                  <p className="mt-1.5 text-sm leading-6 text-slate-600">{getDestination(draft) || "Not available"}</p>

                  <div className="mt-5 grid gap-x-6 gap-y-4 border-t border-slate-100 pt-5 sm:grid-cols-2">
                    <DetailRow label="Contact" value={draft.consigneeEnteredAddress.contactName} />
                    <DetailRow label="Email" value={draft.consigneeEnteredAddress.email} />
                    <DetailRow
                      label="Mobile"
                      value={`${draft.consigneeEnteredAddress.mobileCountryCode ?? ""} ${draft.consigneeEnteredAddress.mobileNumber ?? ""}`.trim()}
                    />
                    <DetailRow label="Instructions" value={draft.consigneeEnteredAddress.deliveryInstructions} />
                  </div>
                  <ShipmentKycDocumentsPanel
                    documents={kycDocuments}
                    onOpen={(document) => document.sequence
                      ? openShipmentParcelKycDocument(draft._id, document.sequence, document.type)
                      : openShipmentKycDocument(draft._id, document.type)}
                  />
                </div>
              </div>

              {/* Anything the customer sent after booking. Sits directly below
                  the KYC pack because an operator looking for a document does
                  not care which side of booking it arrived on. */}
              <StaffSupportingDocuments draftId={draft._id} onHold={isOnHold} />

              {/* Shipment timeline card */}
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-4">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
                    style={{ backgroundColor: "#E8E9F6" }}
                  >
                    <FiClock aria-hidden="true" className="h-4 w-4" style={{ color: "#0D1282" }} />
                  </span>
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Shipment Timeline</h2>
                </div>

                <div className="space-y-4 p-5">
                  {getTrackingEvents(draft, history).map((event) => (
                    <TimelineItem key={event.label} done={event.done} label={event.label} value={event.value} />
                  ))}
                </div>
              </div>
            </section>

            <section className="border border-slate-200 bg-white rounded-2xl">
              <div className="border-b border-slate-200 px-5 py-4">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Parcel Details</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-5 py-3">Parcel</th>
                      <th className="px-5 py-3">Contents</th>
                      <th className="px-5 py-3">Weight</th>
                      <th className="px-5 py-3">Dimensions</th>
                      <th className="px-5 py-3">Reference</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {draft.parcelList.map((parcel) => (
                      <tr key={parcel.sequence}>
                        <td className="px-5 py-3 font-semibold text-slate-950">#{parcel.sequence}</td>
                        {/* Per-item goods with their HSN codes. Parcels booked
                            before HSN capture show the description alone. */}
                        <td className="px-5 py-3 text-slate-700">
                          {parcel.items?.length ? (
                            <ul className="space-y-1">
                              {parcel.items.map((item, itemIndex) => (
                                <li key={itemIndex}>
                                  {item.description}
                                  {item.hsnCode ? (
                                    <span className="ml-2 text-xs text-slate-500">HSN {item.hsnCode}</span>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            parcel.contentsDescription || "Not available"
                          )}
                        </td>
                        <td className="px-5 py-3 text-slate-700">{parcel.weightKg} kg</td>
                        <td className="px-5 py-3 text-slate-700">
                          {[parcel.lengthCm, parcel.widthCm, parcel.heightCm].filter(Boolean).join(" x ") || "Not available"}
                        </td>
                        <td className="px-5 py-3 text-slate-700">{parcel.shipmentReference1 || parcel.shipmentReference2 || "Not available"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
  );
}

function ConfirmationValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-slate-200 px-5 py-4 sm:border-r xl:border-b-0">
      <dt className="text-xs font-semibold uppercase">{label}</dt>
      <dd className="mt-2 wrap-break-words font-semibold">{value}</dd>
    </div>
  );
}

function StatusPill({ label, tone }: { label: string; tone: "success" | "neutral" | "warning" }) {
  const classes = tone === "success"
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 "
    : tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-700"
      : "border-slate-200 bg-slate-50 text-slate-700";

  return <span className={`border px-3 py-3 rounded-4xl text-xs font-semibold uppercase tracking-wide ${classes}`}>{label}</span>;
}

function DetailPanel({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className="border-b border-slate-200 p-5 lg:border-b-0 lg:border-r lg:last:border-r-0">
      <div className="flex items-center gap-2 text-blue-900">
        {icon}
        <h2 className="text-sm font-semibold uppercase tracking-wide">{title}</h2>
      </div>
      <dl className="mt-5 space-y-4">{children}</dl>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="mt-1 wrap-break-word text-sm p-3 rounded bg-slate-50  font-medium text-slate-800">{value || "Not available"}</dd>
    </div>
  );
}

function TimelineItem({ done, label, value }: { done: boolean; label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center rounded justify-center border ${done ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-slate-200 bg-slate-50 text-slate-400"}`}>
        {done ? <FiCheckCircle aria-hidden="true" className="h-4 w-4" /> : <FiClock aria-hidden="true" className="h-4 w-4" />}
      </div>
      <div>
        <p className="text-sm font-semibold text-slate-950">{label}</p>
        <p className="mt-0.5 text-xs font-medium text-slate-500">{value}</p>
      </div>
    </div>
  );
}
