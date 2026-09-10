import crypto from "crypto";
import mongoose from "mongoose";
import { AuditLog } from "../models/auditLog.model.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { DpdShipment, IDpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument, type LabelFormat, type LabelType } from "../models/labelDocument.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import type { PaymentSource } from "../models/financialTypes.js";
import { validateShipmentDraftFields } from "./shipmentValidation.service.js";
import {
  buildShipmentPayload,
  sanitizeShipmentRequestSnapshot,
  validateShipmentPayload
} from "./shipmentPayload.service.js";
import { saveLabelBuffer } from "./labelStorage.service.js";
import {
  buildPricingInputFromDraft,
  calculateShipmentPricingEstimate,
  publicBookingGstRate,
  publicBookingRateCardBand,
} from "./shipmentPricing.service.js";
import { assertPriceLockUnchanged } from "./shipmentCostEstimate.service.js";
import { renderSwiftlineLabelPdf } from "./shipmentLabelPdf.service.js";
import {
  AlsRequestError,
  AlsUncertainError,
  createAlsDocket,
  isAlsEnabled,
} from "./als/alsClient.service.js";
import { isDpdLabelDestination } from "./als/alsPayload.service.js";
import { ensureShipmentInvoiceForDraft } from "./shipmentInvoice.service.js";
import { notifyShipmentBooked } from "./shipmentBookedNotification.service.js";
import {
  allocateSwiftlineTrackingNumber,
  resolveStationCode
} from "./swiftlineTracking.service.js";
import {
  bookingSnapshotToLabelData,
  buildShipmentBookingSnapshot,
  readShipmentBookingSnapshot
} from "./shipmentBookingSnapshot.service.js";
import {
  completeShipmentBookingCharge,
  recordCounterShipmentCharge,
  recordPublicShipmentCharge,
  markShipmentBookingChargeConsuming,
  markShipmentBookingChargeReviewRequired,
  releaseShipmentBookingCharge,
  reserveShipmentBookingCharge
} from "./shipmentBookingBilling.service.js";
import {
  beginShipmentDraftBooking,
  transitionShipmentDraftBooking
} from "./shipmentDraftPolicy.service.js";
import { isBookingPaused } from "./bookingPause.service.js";
import { runWithConcurrency } from "../utils/runWithConcurrency.js";

// Keeps multi-parcel PDF/S3 work moving without opening an unbounded number of
// uploads or holding too many generated label buffers in memory.
const LABEL_STORAGE_CONCURRENCY = 4;

type ShipmentBookingTimings = {
  initialReadMs: number;
  preparationMs: number;
  billingMs: number;
  carrierMs: number;
  bookingWriteMs: number;
  labelMs: number;
  invoiceMs: number;
  notificationMs: number;
};

function emptyShipmentBookingTimings(): ShipmentBookingTimings {
  return {
    initialReadMs: 0,
    preparationMs: 0,
    billingMs: 0,
    carrierMs: 0,
    bookingWriteMs: 0,
    labelMs: 0,
    invoiceMs: 0,
    notificationMs: 0
  };
}

function roundedDuration(startedAt: number) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function roundedTimings(timings: ShipmentBookingTimings) {
  return Object.fromEntries(
    Object.entries(timings).map(([stage, duration]) => [stage, Math.round(duration * 10) / 10])
  ) as ShipmentBookingTimings;
}

async function measureShipmentBookingStage<TResult>(
  timings: ShipmentBookingTimings,
  stage: keyof ShipmentBookingTimings,
  operation: () => Promise<TResult>
) {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    timings[stage] += roundedDuration(startedAt);
  }
}

export class DpdShipmentServiceError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
  }
}

/**
 * The DPD label could not be created, and nothing was booked.
 *
 * Carries its own code so the booking form can offer to continue without the
 * carrier label instead of showing a dead end. Only ever raised when the
 * shipment has been fully rolled back.
 */
export class DpdLabelUnavailableError extends Error {
  readonly code = "DPD_LABEL_FAILED";

  constructor(
    message: string,
    public readonly statusCode = 409,
    /** The carrier's own wording. Shown to staff, never to a customer. */
    public readonly carrierErrors: string[] = []
  ) {
    super(message);
    this.name = "DpdLabelUnavailableError";
  }
}

function createIdempotencyKey(shipmentDraftId: mongoose.Types.ObjectId, bookingAttemptId: string) {
  return `SHIPMENT_BOOKING:${shipmentDraftId.toString()}:${bookingAttemptId}`;
}

/**
 * The price the booker was shown and accepted, from the cost estimate endpoint.
 *
 * Carried on both arms of the union so a client and an admin booking are held to
 * the same check. Optional because counter sales and seed scripts book drafts
 * that were never quoted, and there is no accepted price for those to differ from.
 */
type AcceptedPricing = { acceptedPricingHash?: string };

/**
 * Set when the booker has been shown a DPD failure and chosen to go ahead with
 * Swiftline labels alone. Never inferred: a United Kingdom shipment silently
 * losing its carrier label is exactly the outcome this flag exists to prevent.
 */
type DpdLabelChoice = { skipDpdLabel?: boolean };

type LabelPaymentContext =
  | ({
      // ADMIN_DIRECT is a walk-in booked at the counter: the customer has already
      // paid into a company account, so there is no credit to reserve. Staying in
      // the admin arm of this union keeps clients unable to book one.
      actor: "admin";
      paymentSource?: Extract<PaymentSource, "BUSINESS_ACCOUNT" | "ADMIN_DIRECT" | "TEST">;
    } & AcceptedPricing & DpdLabelChoice)
  | ({
      actor: "client";
      paymentSource: Extract<PaymentSource, "BUSINESS_ACCOUNT">;
    } & AcceptedPricing & DpdLabelChoice)
  | ({
      actor: "public";
      paymentSource: Extract<PaymentSource, "PUBLIC_RAZORPAY">;
      acceptedPricingHash: string;
      skipDpdLabel: true;
    } & AcceptedPricing & DpdLabelChoice);

function normalizePaymentContext(context?: LabelPaymentContext): LabelPaymentContext {
  return context ?? { actor: "admin", paymentSource: "BUSINESS_ACCOUNT" };
}

/** One label per parcel, always: they are rendered locally from the snapshot. */
export function isCompleteLabelSet(input: { parcelCount: number; labelCount: number }) {
  return input.labelCount === input.parcelCount;
}

export function hasCompleteSwiftlineLabelSet(input: {
  parcelCount: number;
  labels: readonly { labelType?: string }[];
}) {
  return isCompleteLabelSet({
    parcelCount: input.parcelCount,
    labelCount: input.labels.filter((label) => label.labelType === "SWIFTLINE").length
  });
}

function toPaymentError(error: unknown) {
  if (!(error instanceof Error)) return null;

  if (error.message === "BOOKING_RATE_NOT_FOUND") {
    return new DpdShipmentServiceError(
      "Rates are not available for the selected destination, service, or box weight. Please contact your assigned branch.",
      409
    );
  }

  if (error.message === "INSUFFICIENT_BOOKING_CAPACITY") {
    return new DpdShipmentServiceError(
      "Available Customer Advance and credit are not sufficient to book this shipment. Contact your assigned branch.",
      402
    );
  }

  if (error.message === "OVERDUE_BOOKING_BLOCKED") {
    return new DpdShipmentServiceError(
      "Bookings are blocked because the maximum overdue period has been exceeded. Contact your assigned branch.",
      409
    );
  }

  if (error.message === "OVERDUE_CREDIT_USAGE_BLOCKED") {
    return new DpdShipmentServiceError(
      "Credit usage is blocked because a billing statement is overdue. Pay the overdue statement or add enough Customer Advance to book this shipment.",
      409
    );
  }

  if (error.message === "BOOKING_AMOUNT_INVALID") {
    return new DpdShipmentServiceError("The shipment charge could not be calculated. Check the shipment rate and parcel details.", 409);
  }

  return null;
}

/**
 * A booking attempt is recorded against the draft until the carrier answers,
 * because a rejected attempt never creates a booking record to hang it off.
 * Once a record exists the trail continues against that instead.
 */
async function writeDpdAuditLog(
  action: "DPD_REQUEST_INITIATED" | "DPD_REQUEST_SUCCEEDED" | "DPD_REQUEST_FAILED",
  entityId: mongoose.Types.ObjectId,
  entityType: "DPD_SHIPMENT" | "SHIPMENT_DRAFT",
  userId: mongoose.Types.ObjectId,
  metadata: Record<string, unknown>
) {
  await AuditLog.create({
    action,
    entityType,
    entityId,
    performedBy: userId,
    performedAt: new Date(),
    metadata
  });
}

async function getReusableShipment(existingShipment: IDpdShipment | null, expectedParcelCount: number) {
  if (!existingShipment) return null;

  if (existingShipment.status === "LABEL_RECEIVED") {
    const labels = await LabelDocument.find({ dpdShipmentId: existingShipment._id }).lean().exec();
    // The completeness invariant is per parcel, so it counts Swiftline labels
    // only - a DPD label is one document covering the whole shipment.
    if (!hasCompleteSwiftlineLabelSet({ parcelCount: expectedParcelCount, labels })) {
      throw new DpdShipmentServiceError(
        "This booking exists, but its label set is incomplete. Contact Swiftline Operations; do not book it again.",
        409
      );
    }
    return {
      dpdShipment: existingShipment,
      labels,
      reused: true
    };
  }

  if (existingShipment.status === "DPD_CREATING") {
    throw new DpdShipmentServiceError("A booking is already processing for this shipment.", 409);
  }

  if (existingShipment.status === "DPD_STATUS_UNKNOWN") {
    throw new DpdShipmentServiceError("The result of this request is uncertain. Do not submit it again.", 409);
  }

  if (existingShipment.status === "DPD_CREATED") {
    throw new DpdShipmentServiceError(
      "This shipment is booked, but its documents require reconciliation. Contact Swiftline Operations; do not book it again.",
      409
    );
  }

  return null;
}

// Exported so the demo seeder can produce labels through the same storage path
// as a real booking- same checksum, storage layout and version numbering.
export async function storeGeneratedLabel(input: {
  dpdShipmentId: mongoose.Types.ObjectId;
  /** Avoids resolving the booking again when the caller already loaded it. */
  shipmentDraftId?: mongoose.Types.ObjectId | string;
  parcelNumber: string;
  /** Defaults to the Swiftline label, which every parcel carries. */
  labelType?: LabelType;
  buffer: Buffer;
  format?: LabelFormat;
  labelSize?: "A4" | "A6";
  /** Exact snapshot revision; avoids a label-version lookup on known writes. */
  labelVersion?: number;
}) {
  const labelType = input.labelType ?? "SWIFTLINE";
  const format = input.format ?? "PDF";
  const labelSize = input.labelSize ?? "A6";
  const existingPromise = input.labelVersion === undefined
    ? LabelDocument.findOne({
        dpdShipmentId: input.dpdShipmentId,
        labelType,
        parcelNumber: input.parcelNumber
      }).select("labelVersion").lean().exec()
    : Promise.resolve(null);

  // Labels are stored under the draft, not the booking, so everything belonging
  // to one shipment shares a prefix. Normal booking flows pass the draft id they
  // already loaded; scripts and older callers retain the safe lookup fallback.
  const bookingPromise = input.shipmentDraftId === undefined
    ? DpdShipment.findById(input.dpdShipmentId).select("shipmentDraftId").lean().exec()
    : Promise.resolve(null);
  const [existing, booking] = await Promise.all([existingPromise, bookingPromise]);
  const shipmentDraftId = input.shipmentDraftId ?? booking?.shipmentDraftId;
  if (!shipmentDraftId) {
    throw new DpdShipmentServiceError("The booking this label belongs to no longer exists.", 404);
  }

  const stored = await saveLabelBuffer({
    shipmentDraftId: shipmentDraftId.toString(),
    parcelNumber: input.parcelNumber,
    buffer: input.buffer,
    format,
    labelSize,
    labelType
  });

  return LabelDocument.findOneAndUpdate(
    {
      dpdShipmentId: input.dpdShipmentId,
      labelType,
      parcelNumber: input.parcelNumber
    },
    {
      dpdShipmentId: input.dpdShipmentId,
      parcelNumber: input.parcelNumber,
      labelType,
      format,
      labelSize,
      storageKey: stored.storageKey,
      fileChecksum: stored.fileChecksum,
      generatedAt: new Date(),
      labelVersion: input.labelVersion ?? (existing?.labelVersion ?? 0) + 1
    },
    { returnDocument: "after", upsert: true, runValidators: true, setDefaultsOnInsert: true }
  ).exec();
}

type GeneratedLabelJob = Omit<Parameters<typeof storeGeneratedLabel>[0], "buffer"> & {
  buffer: Buffer | (() => Promise<Buffer>);
};

async function storeGeneratedLabels(jobs: readonly GeneratedLabelJob[]) {
  return runWithConcurrency(jobs, LABEL_STORAGE_CONCURRENCY, async (job) => {
    const { buffer: bufferSource, ...input } = job;
    const buffer = typeof bufferSource === "function"
      ? await bufferSource()
      : bufferSource;
    return storeGeneratedLabel({ ...input, buffer });
  });
}

export async function createLabelForShipmentDraft(
  shipmentDraftId: string,
  userId: mongoose.Types.ObjectId,
  paymentContextInput?: LabelPaymentContext
) {
  const operationStartedAt = performance.now();
  const timings = emptyShipmentBookingTimings();
  const paymentContext = normalizePaymentContext(paymentContextInput);
  let outcome = "failed";

  try {
    const result = await createLabelForShipmentDraftInternal(
      shipmentDraftId,
      userId,
      paymentContext,
      timings
    );
    outcome = result.reused ? "reused" : "succeeded";
    return result;
  } catch (error) {
    outcome = error instanceof DpdLabelUnavailableError
      ? "carrier_rejected"
      : error instanceof DpdShipmentServiceError && error.statusCode < 500
        ? "rejected"
        : "failed";
    throw error;
  } finally {
    console.info("[performance] shipment booking", {
      outcome,
      shipmentDraftId,
      actor: paymentContext.actor,
      paymentSource: paymentContext.paymentSource ?? "BUSINESS_ACCOUNT",
      ...roundedTimings(timings),
      totalMs: roundedDuration(operationStartedAt)
    });
  }
}

async function createLabelForShipmentDraftInternal(
  shipmentDraftId: string,
  userId: mongoose.Types.ObjectId,
  paymentContext: LabelPaymentContext,
  timings: ShipmentBookingTimings
) {
  // Only account-backed bookings reserve capacity. TEST never did; ADMIN_DIRECT is
  // a counter sale that was paid before the booking was made, so there is nothing
  // to reserve, convert or release for it.
  const usesBusinessAccountBilling = paymentContext.paymentSource === "BUSINESS_ACCOUNT";
  const [draft, existingByDraft] = await measureShipmentBookingStage(
    timings,
    "initialReadMs",
    () => Promise.all([
      ShipmentDraft.findById(shipmentDraftId).exec(),
      DpdShipment.findOne({ shipmentDraftId }).exec()
    ])
  );
  if (!draft) throw new DpdShipmentServiceError("Shipment draft not found", 404);

  const reusable = await measureShipmentBookingStage(
    timings,
    "initialReadMs",
    () => getReusableShipment(existingByDraft, draft.parcelList.length)
  );

  if (reusable) {
    draft.bookingState = "BOOKED";
    draft.lockedAt = draft.lockedAt ?? reusable.dpdShipment.createdAt;
    await draft.save();

    try {
      const shipmentInvoice = await measureShipmentBookingStage(
        timings,
        "invoiceMs",
        () => ensureShipmentInvoiceForDraft({
          shipmentDraftId: draft._id as mongoose.Types.ObjectId,
          dpdShipmentId: reusable.dpdShipment._id as mongoose.Types.ObjectId,
          userId
        })
      );
      return { ...reusable, shipmentInvoice };
    } catch (error) {
      draft.bookingState = "REVIEW_REQUIRED";
      await draft.save();
      console.error("Unable to reconcile the shipment invoice for an existing booking.", error);
      throw new DpdShipmentServiceError(
        "This shipment is booked, but its invoice requires reconciliation. Contact Swiftline Operations; do not book it again.",
        409
      );
    }
  }

  const validationIssues = validateShipmentDraftFields(draft, { requireValidatedAddress: true });
  if (validationIssues.length) {
    draft.validationIssues = validationIssues;
    draft.status = "VALIDATION_FAILED";
    await draft.save();

    throw new DpdShipmentServiceError("Some shipment information must be corrected before creating the shipment.", 400, {
      validationIssues
    });
  }

  // Booking pauses - must be checked before any financial or carrier side-effects.
  // Blocks every audience (client/admin) and INDIVIDUAL walk-ins alike.
  const destinationCode =
    draft.consigneeEnteredAddress?.countryCode ||
    (draft.consigneeSelectedAddress as { countryCode?: string } | null)?.countryCode ||
    (draft.consigneeValidatedAddress as { countryCode?: string } | null)?.countryCode ||
    "";
  if (destinationCode) {
    const pauseCheck = await measureShipmentBookingStage(
      timings,
      "preparationMs",
      () => isBookingPaused(destinationCode)
    );
    if (pauseCheck.paused && pauseCheck.pause) {
      const pause = pauseCheck.pause;
      const fmt = (d: Date) => new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
      const labels = (pause.countries ?? []).join(", ");
      throw new DpdShipmentServiceError(
        `Bookings to ${destinationCode.trim().toUpperCase()} are temporarily paused from ${fmt(pause.startAt)} to ${fmt(pause.endAt)} - ${pause.reason}`,
        423,
        {
          code: "BOOKING_PAUSED",
          reason: pause.reason,
          countries: pause.countries,
          countryLabels: (pause as unknown as { countryLabels?: string[] }).countryLabels ?? pause.countries,
          startAt: pause.startAt,
          endAt: pause.endAt,
          pauseId: String(pause._id)
        }
      );
    }
  }

  const [branch, businessAccount] = await measureShipmentBookingStage(
    timings,
    "preparationMs",
    () => Promise.all([
      Branch.findById(draft.branchId).exec(),
      BusinessAccount.findById(draft.businessAccountId).exec()
    ])
  );
  if (!branch) throw new DpdShipmentServiceError("The shipment branch could not be found.", 409);
  if (!businessAccount) throw new DpdShipmentServiceError("The business account could not be found.", 409);

  let stationCode: string;
  try {
    stationCode = resolveStationCode(branch.labelCode, branch.code);
  } catch {
    throw new DpdShipmentServiceError(
      "The assigned branch needs a valid three-letter station code before shipments can be booked.",
      409
    );
  }

  const bookingAttemptId = crypto.randomUUID();
  const lockedDraft = await measureShipmentBookingStage(
    timings,
    "preparationMs",
    () => beginShipmentDraftBooking({ draft, bookingAttemptId })
  );
  const idempotencyKey = createIdempotencyKey(
    lockedDraft._id as mongoose.Types.ObjectId,
    bookingAttemptId
  );
  const payload = buildShipmentPayload(lockedDraft);
  const payloadIssues = validateShipmentPayload(payload);
  if (payloadIssues.length) {
    lockedDraft.validationIssues = payloadIssues;
    lockedDraft.status = "VALIDATION_FAILED";
    await lockedDraft.save();
    await transitionShipmentDraftBooking({
      shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
      bookingAttemptId,
      bookingState: "EDITABLE"
    });

    throw new DpdShipmentServiceError("Some shipment information must be corrected before booking this shipment.", 400, {
      validationIssues: payloadIssues
    });
  }

  // Every United Kingdom shipment is expected to carry a DPD label, because it
  // is what the parcel travels on. Whether ALS can actually produce one is a
  // separate question the carrier client answers: a switched-off or
  // misconfigured integration is reported as a failure, never skipped quietly.
  // Booking a UK shipment without the carrier label is possible only by
  // declining it explicitly after being shown why.
  const wantsDpdLabel = !paymentContext.skipDpdLabel
    && isDpdLabelDestination(payload.consignee.countryCode);

  const pricing = await measureShipmentBookingStage(
    timings,
    "preparationMs",
    () => calculateShipmentPricingEstimate(
      paymentContext.paymentSource === "PUBLIC_RAZORPAY"
        ? {
            ...buildPricingInputFromDraft(lockedDraft),
            businessAccountId: undefined,
            rateCardBand: publicBookingRateCardBand,
            gstRate: publicBookingGstRate,
            insuranceOptIn: false
          }
        : buildPricingInputFromDraft(lockedDraft)
    )
  );
  if (pricing.missingRate) {
    await transitionShipmentDraftBooking({
      shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
      bookingAttemptId,
      bookingState: "EDITABLE"
    });
    throw new DpdShipmentServiceError(
      `Rates are not available for ${lockedDraft.consigneeEnteredAddress.countryName || lockedDraft.consigneeEnteredAddress.countryCode} with ${lockedDraft.serviceType === "CARGO" ? "Cargo" : "Courier"} service. Please contact ${branch.name} to arrange this shipment.`,
      409
    );
  }

  // The per-box weight ceiling comes from the matched rate card, so it varies by
  // destination and service. Over-limit boxes used to price with a warning; they
  // are now refused, because the network cannot carry them.
  const overweightParcels = pricing.parcels.filter((parcel) => parcel.exceedsMaxBoxKg);
  if (overweightParcels.length) {
    await transitionShipmentDraftBooking({
      shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
      bookingAttemptId,
      bookingState: "EDITABLE"
    });
    throw new DpdShipmentServiceError(
      "Some boxes are over the maximum weight for this destination.",
      409,
      {
        // Names the weight that actually breached the limit. A large light box is
        // refused on its volumetric weight, and blaming "box weight" there sends
        // someone to re-weigh a parcel that was never the problem.
        validationIssues: overweightParcels.map((parcel) => (
          parcel.volumetricWeightKg > parcel.actualWeightKg
            ? `Box ${parcel.sequence}: volumetric weight ${parcel.volumetricWeightKg.toFixed(2)} kg is over the ${parcel.maxBoxKg} kg maximum box weight. Reduce the dimensions.`
            : `Box ${parcel.sequence}: actual weight ${parcel.actualWeightKg.toFixed(2)} kg is over the ${parcel.maxBoxKg} kg maximum box weight.`
        ))
      }
    );
  }

  // Checked before anything is reserved or sent to the carrier, so a shipment
  // whose price moved is stopped while it is still cleanly abandonable. The draft
  // is returned to EDITABLE and the booker is shown what changed.
  try {
    assertPriceLockUnchanged({
      acceptedPricingHash: paymentContext.acceptedPricingHash,
      currentPricing: pricing,
      requireAcceptedPricing: usesBusinessAccountBilling || paymentContext.paymentSource === "PUBLIC_RAZORPAY"
    });
  } catch (error) {
    await transitionShipmentDraftBooking({
      shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
      bookingAttemptId,
      bookingState: "EDITABLE"
    });
    throw error;
  }

  let advanceAmountMinor = 0;
  let creditAmountMinor = Math.round(pricing.totalAmount * 100);
  try {
    if (usesBusinessAccountBilling) {
      const reservationResult = await measureShipmentBookingStage(
        timings,
        "billingMs",
        () => reserveShipmentBookingCharge({
          draft: lockedDraft,
          createdBy: userId,
          bookingAttemptId,
          pricing
        })
      );
      advanceAmountMinor = reservationResult.reservation?.advanceAmountMinor ?? 0;
      creditAmountMinor = reservationResult.reservation?.creditAmountMinor ?? creditAmountMinor;
    } else if (paymentContext.paymentSource === "ADMIN_DIRECT") {
      // Already paid at the counter. Record the charge so the amendment and
      // cancellation flows have one to read, and treat the whole amount as
      // settled so the invoice is issued PAID rather than as credit owed.
      await measureShipmentBookingStage(
        timings,
        "billingMs",
        () => recordCounterShipmentCharge({ draft: lockedDraft, pricing })
      );
      advanceAmountMinor = Math.round(pricing.totalAmount * 100);
      creditAmountMinor = 0;
    } else if (paymentContext.paymentSource === "PUBLIC_RAZORPAY") {
      await measureShipmentBookingStage(
        timings,
        "billingMs",
        () => recordPublicShipmentCharge({ draft: lockedDraft, pricing })
      );
      advanceAmountMinor = Math.round(pricing.totalAmount * 100);
      creditAmountMinor = 0;
    }
  } catch (error) {
    await transitionShipmentDraftBooking({
      shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
      bookingAttemptId,
      bookingState: "EDITABLE"
    });
    const paymentError = toPaymentError(error);
    if (paymentError) throw paymentError;
    throw error;
  }

  const requestSnapshot = sanitizeShipmentRequestSnapshot(payload);
  // Nothing durable is written until the booking record below is created. A
  // failure before that point therefore leaves no booking record, no labels, no
  // invoice and no burnt AWB behind- only the audit trail and an editable draft.
  let dpdShipment: IDpdShipment | null = null;
  let bookingRecorded = false;

  const recordBookingOutcome = async (input: {
    status: IDpdShipment["status"];
    trackingNumber: string;
    /** Present only on a United Kingdom shipment that DPD accepted. */
    docket?: Awaited<ReturnType<typeof createAlsDocket>> | null;
    responseSnapshot?: Record<string, unknown>;
  }) => {
    const booking = await DpdShipment.findOneAndUpdate(
      { shipmentDraftId: lockedDraft._id },
      {
        shipmentDraftId: lockedDraft._id,
        idempotencyKey,
        serviceCode: payload.serviceCode,
        requestSnapshot,
        responseSnapshot: input.responseSnapshot ?? {},
        dpdShipmentId: input.docket?.awbNumber ?? "",
        dpdTransactionId: input.docket?.docketId ?? "",
        forwardingNumber: input.docket?.forwardingNumber ?? "",
        entryNumber: input.docket?.entryNumber ?? "",
        parcelNumbers: input.docket?.parcelNumbers ?? [],
        swiftlineTrackingNumber: input.trackingNumber,
        paymentSource: paymentContext.paymentSource ?? "BUSINESS_ACCOUNT",
        status: input.status
      },
      { returnDocument: "after", upsert: true, runValidators: true, setDefaultsOnInsert: true }
    ).exec();
    if (!booking) throw new Error("SHIPMENT_BOOKING_RECORD_NOT_CREATED");
    return booking;
  };

  // Reused across retries of the same draft so a rejected attempt does not
  // consume a fresh number from the station's daily sequence.
  const generatedAt = new Date();
  let trackingNumber = lockedDraft.allocatedTrackingNumber;
  if (!trackingNumber) {
    try {
      trackingNumber = await measureShipmentBookingStage(
        timings,
        "preparationMs",
        () => allocateSwiftlineTrackingNumber({ stationCode, date: generatedAt })
      );
      lockedDraft.allocatedTrackingNumber = trackingNumber;
      await lockedDraft.save();
    } catch (error) {
      if (usesBusinessAccountBilling) {
        await releaseShipmentBookingCharge({
          shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
          createdBy: userId
        });
      }
      await transitionShipmentDraftBooking({
        shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
        bookingAttemptId,
        bookingState: "EDITABLE"
      });
      throw error;
    }
  }

  try {
    await writeDpdAuditLog(
      "DPD_REQUEST_INITIATED",
      lockedDraft._id as mongoose.Types.ObjectId,
      "SHIPMENT_DRAFT",
      userId,
      { idempotencyKey, shipmentDraftId: lockedDraft._id, swiftlineTrackingNumber: trackingNumber }
    );

    // The DPD label is fetched before anything is consumed or written, so a
    // carrier failure leaves no booking, no invoice and no spent credit - only
    // the reserved hold, released below, and a draft that is editable again.
    let dpdDocket: Awaited<ReturnType<typeof createAlsDocket>> | null = null;
    if (wantsDpdLabel) {
      try {
        dpdDocket = await measureShipmentBookingStage(
          timings,
          "carrierMs",
          () => createAlsDocket({
            draft: lockedDraft,
            trackingNumber,
            bookedAt: generatedAt
          })
        );
      } catch (error) {
        // An uncertain result may have created a booking at the carrier, so it
        // is never offered as a retry - the shipment is held for review with
        // the money still reserved against it.
        if (error instanceof AlsUncertainError) throw error;
        if (!(error instanceof AlsRequestError)) throw error;

        await writeDpdAuditLog(
          "DPD_REQUEST_FAILED",
          lockedDraft._id as mongoose.Types.ObjectId,
          "SHIPMENT_DRAFT",
          userId,
          {
            stage: "DPD_LABEL",
            message: error.message,
            carrierErrors: error.carrierErrors,
            swiftlineTrackingNumber: trackingNumber
          }
        );

        if (usesBusinessAccountBilling) {
          await releaseShipmentBookingCharge({
            shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
            createdBy: userId
          });
        }
        await transitionShipmentDraftBooking({
          shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
          bookingAttemptId,
          bookingState: "EDITABLE"
        });

        throw new DpdLabelUnavailableError(error.message, error.statusCode, error.carrierErrors);
      }
    }

    if (usesBusinessAccountBilling) {
      await measureShipmentBookingStage(
        timings,
        "billingMs",
        () => markShipmentBookingChargeConsuming(lockedDraft._id as mongoose.Types.ObjectId)
      );
    }

    // The booking becomes durable here, before any of the work below can fail,
    // so a shipment that has consumed an AWB and a customer's money always has a
    // record to reconcile against. The carrier's own reply is captured with it:
    // losing an accepted DPD booking's AWB is what makes one unreconcilable.
    const booking = await measureShipmentBookingStage(
      timings,
      "bookingWriteMs",
      () => recordBookingOutcome({
        status: "DPD_CREATED",
        trackingNumber,
        docket: dpdDocket,
        responseSnapshot: dpdDocket
          ? dpdDocket.responseSnapshot
          : { provider: "SWIFTLINE", outcome: "INTERNAL_LABEL_ONLY" }
      })
    );
    dpdShipment = booking;
    bookingRecorded = true;

    const bookingSnapshot = buildShipmentBookingSnapshot({
      draft: lockedDraft,
      account: businessAccount,
      branch,
      pricing,
      serviceCode: payload.serviceCode,
      bookedAt: generatedAt,
      swiftlineTrackingNumber: trackingNumber,
      carrierShipmentId: "",
      carrierTransactionId: "",
      carrierParcelNumbers: [],
      advanceAmountMinor,
      creditAmountMinor
    });

    booking.bookingSnapshot = bookingSnapshot;
    booking.currentShipmentSnapshot = bookingSnapshot;
    booking.snapshotRevision = 1;
    await measureShipmentBookingStage(timings, "bookingWriteMs", () => booking.save());

    const swiftlineLabelJobs: GeneratedLabelJob[] = payload.parcels.map((_, index) => {
      const labelData = bookingSnapshotToLabelData(bookingSnapshot, index);
      return {
        dpdShipmentId: booking._id as mongoose.Types.ObjectId,
        shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
        parcelNumber: labelData.parcelNumber,
        labelVersion: booking.snapshotRevision,
        buffer: () => renderSwiftlineLabelPdf(labelData)
      };
    });

    // DPD supplies one printable document for the whole booking. It is safe to
    // store alongside the independently rendered Swiftline parcel labels after
    // the carrier identifiers and locked snapshot are durable.
    const dpdLabelJobs: GeneratedLabelJob[] = (dpdDocket?.labels ?? []).map((dpdLabel, index) => ({
      dpdShipmentId: booking._id as mongoose.Types.ObjectId,
      shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
      parcelNumber: dpdDocket?.awbNumber
        ? `${dpdDocket.awbNumber}${index > 0 ? `-${index + 1}` : ""}`
        : trackingNumber,
      labelType: "DPD",
      format: dpdLabel.format,
      labelVersion: booking.snapshotRevision,
      buffer: dpdLabel.content
    }));

    const storedLabels = await measureShipmentBookingStage(
      timings,
      "labelMs",
      () => storeGeneratedLabels([...swiftlineLabelJobs, ...dpdLabelJobs])
    );
    const labels = storedLabels.filter((label): label is NonNullable<typeof label> => Boolean(label));
    if (!hasCompleteSwiftlineLabelSet({ parcelCount: payload.parcels.length, labels })) {
      throw new Error("SHIPMENT_LABEL_SET_INCOMPLETE");
    }

    booking.status = "LABEL_RECEIVED";
    await measureShipmentBookingStage(timings, "bookingWriteMs", () => booking.save());

    await writeDpdAuditLog(
      "DPD_REQUEST_SUCCEEDED",
      booking._id as mongoose.Types.ObjectId,
      "DPD_SHIPMENT",
      userId,
      {
        swiftlineTrackingNumber: trackingNumber,
        parcelNumbers: bookingSnapshot.parcels.map((parcel) => parcel.swiftlineParcelNumber),
        labelCount: labels.length,
        dpdAwbNumber: dpdDocket?.awbNumber ?? "",
        dpdLabelCount: dpdDocket?.labels.length ?? 0
      }
    );

    if (usesBusinessAccountBilling) {
      await measureShipmentBookingStage(
        timings,
        "billingMs",
        () => completeShipmentBookingCharge({
          shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
          dpdShipmentId: booking._id as mongoose.Types.ObjectId,
          createdBy: userId
        })
      );
    }

    const shipmentInvoice = await measureShipmentBookingStage(
      timings,
      "invoiceMs",
      () => ensureShipmentInvoiceForDraft({
        shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
        dpdShipmentId: booking._id as mongoose.Types.ObjectId,
        userId
      })
    );
    if (!shipmentInvoice) throw new Error("SHIPMENT_INVOICE_NOT_CREATED");

    await transitionShipmentDraftBooking({
      shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
      bookingAttemptId,
      bookingState: "BOOKED"
    });

    // Queues the client and operations emails with the invoice and labels
    // attached. Swallows its own errors: the booking is complete and must not be
    // undone or retried because a notification could not be raised.
    await measureShipmentBookingStage(
      timings,
      "notificationMs",
      () => notifyShipmentBooked({
        draft: lockedDraft,
        dpdShipment: booking,
        shipmentInvoice,
        bookedBy: userId
      })
    );

    return {
      dpdShipment: booking,
      labels,
      shipmentInvoice,
      reused: false
    };
  } catch (error) {
    // Already fully rolled back where it was raised: no booking, no invoice, no
    // consumed credit. Rethrown untouched so the booker is offered the choice to
    // continue without the carrier label, and so nothing is released twice.
    if (error instanceof DpdLabelUnavailableError) throw error;

    // The request reached DPD but its outcome is unknown, so a booking may exist
    // at the carrier. The money stays reserved and the shipment is held for
    // review rather than released and offered as a retry- resubmitting could
    // book the same parcel twice.
    if (error instanceof AlsUncertainError) {
      const booking = dpdShipment ?? await recordBookingOutcome({
        status: "DPD_STATUS_UNKNOWN",
        trackingNumber,
        responseSnapshot: { stage: "DPD_LABEL", message: error.message }
      });

      await writeDpdAuditLog(
        "DPD_REQUEST_FAILED",
        booking._id as mongoose.Types.ObjectId,
        "DPD_SHIPMENT",
        userId,
        { status: "DPD_STATUS_UNKNOWN", stage: "DPD_LABEL", message: error.message }
      );

      if (usesBusinessAccountBilling) {
        await markShipmentBookingChargeReviewRequired({
          shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
          dpdShipmentId: booking._id as mongoose.Types.ObjectId,
          createdBy: userId
        });
      }
      await transitionShipmentDraftBooking({
        shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
        bookingAttemptId,
        bookingState: "REVIEW_REQUIRED"
      });

      throw new DpdShipmentServiceError(error.message, 409);
    }

    // The booking record exists but something after it failed. The shipment is
    // real and has consumed its AWB, so the record is kept for reconciliation and
    // the funds stay reserved rather than being silently released.
    if (bookingRecorded && dpdShipment) {
      const booking = dpdShipment;
      const message = "The shipment was created, but its invoice or labels could not be finalized. Do not submit it again; contact Swiftline Operations.";
      booking.status = "DPD_CREATED";
      booking.responseSnapshot = {
        ...booking.responseSnapshot,
        localLabelError: error instanceof Error ? error.message : "Unknown label error"
      };
      await booking.save();

      await writeDpdAuditLog(
        "DPD_REQUEST_FAILED",
        booking._id as mongoose.Types.ObjectId,
        "DPD_SHIPMENT",
        userId,
        { status: "DPD_CREATED", message }
      );

      if (usesBusinessAccountBilling) {
        await markShipmentBookingChargeReviewRequired({
          shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
          dpdShipmentId: booking._id as mongoose.Types.ObjectId,
          createdBy: userId
        });
      }

      await transitionShipmentDraftBooking({
        shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
        bookingAttemptId,
        bookingState: "REVIEW_REQUIRED"
      });

      throw new DpdShipmentServiceError(message, 409);
    }

    // The booking failed before any record was created, so it leaves no booking
    // record, no invoice and no labels behind- only this audit row against the
    // draft, which returns to being editable.
    const message = "The shipment could not be created.";

    await writeDpdAuditLog(
      "DPD_REQUEST_FAILED",
      lockedDraft._id as mongoose.Types.ObjectId,
      "SHIPMENT_DRAFT",
      userId,
      {
        status: "DPD_REJECTED",
        message,
        reason: error instanceof Error ? error.message : String(error),
        swiftlineTrackingNumber: trackingNumber
      }
    );

    if (usesBusinessAccountBilling) {
      await releaseShipmentBookingCharge({
        shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
        createdBy: userId
      });
    }

    await transitionShipmentDraftBooking({
      shipmentDraftId: lockedDraft._id as mongoose.Types.ObjectId,
      bookingAttemptId,
      bookingState: "EDITABLE"
    });

    throw new DpdShipmentServiceError(message, 502);
  }
}

export async function reconcileShipmentDocuments(
  dpdShipmentId: string,
  userId: mongoose.Types.ObjectId
) {
  if (!mongoose.Types.ObjectId.isValid(dpdShipmentId)) {
    throw new DpdShipmentServiceError("Shipment booking not found.", 404);
  }

  const dpdShipment = await DpdShipment.findById(dpdShipmentId).exec();
  if (!dpdShipment) throw new DpdShipmentServiceError("Shipment booking not found.", 404);
  if (dpdShipment.status === "LABEL_RECEIVED") {
    const labels = await LabelDocument.find({ dpdShipmentId: dpdShipment._id }).exec();
    const shipmentInvoice = await ensureShipmentInvoiceForDraft({
      shipmentDraftId: dpdShipment.shipmentDraftId,
      dpdShipmentId: dpdShipment._id as mongoose.Types.ObjectId,
      userId
    });
    return { dpdShipment, labels, shipmentInvoice, reused: true };
  }
  if (dpdShipment.status !== "DPD_CREATED") {
    throw new DpdShipmentServiceError(
      "This booking cannot be finalized until its outcome is confirmed.",
      409
    );
  }

  // A carrier reference means ALS already accepted a label-only request. It is
  // not safe to turn that into LABEL_RECEIVED while the carrier document is
  // missing locally, because that would hide an operational document failure.
  if (dpdShipment.dpdShipmentId?.trim()) {
    const carrierLabels = await LabelDocument.countDocuments({
      dpdShipmentId: dpdShipment._id,
      labelType: "DPD"
    }).exec();
    if (!carrierLabels) {
      throw new DpdShipmentServiceError(
        "The carrier booking already exists, but its DPD label is not stored. Do not submit it again; contact Swiftline Operations.",
        409
      );
    }
  }

  const snapshot = readShipmentBookingSnapshot(dpdShipment.currentShipmentSnapshot)
    ?? readShipmentBookingSnapshot(dpdShipment.bookingSnapshot);
  if (!snapshot) {
    throw new DpdShipmentServiceError(
      "This booking is missing its locked shipment snapshot. Contact technical support before taking further action.",
      409
    );
  }

  // Only the Swiftline labels are re-rendered here; a DPD label can only come
  // from the carrier and is never regenerated locally.
  const existingLabels = await LabelDocument.find({
    dpdShipmentId: dpdShipment._id,
    labelType: "SWIFTLINE"
  }).exec();
  const expectedLabelVersion = dpdShipment.snapshotRevision || 1;

  const missingLabelJobs: GeneratedLabelJob[] = [];
  for (let index = 0; index < snapshot.parcels.length; index += 1) {
    const swiftlineParcelNumber = snapshot.parcels[index]?.swiftlineParcelNumber ?? "";
    const hasLabel = existingLabels.some((label) => (
      label.parcelNumber === swiftlineParcelNumber
      && label.labelVersion === expectedLabelVersion
    ));

    if (!hasLabel) {
      const labelData = bookingSnapshotToLabelData(snapshot, index);
      missingLabelJobs.push({
        dpdShipmentId: dpdShipment._id as mongoose.Types.ObjectId,
        shipmentDraftId: dpdShipment.shipmentDraftId,
        parcelNumber: labelData.parcelNumber,
        labelVersion: expectedLabelVersion,
        buffer: () => renderSwiftlineLabelPdf(labelData)
      });
    }
  }
  await storeGeneratedLabels(missingLabelJobs);

  const labels = await LabelDocument.find({
    dpdShipmentId: dpdShipment._id,
    labelVersion: expectedLabelVersion
  }).exec();
  if (!hasCompleteSwiftlineLabelSet({ parcelCount: snapshot.parcels.length, labels })) {
    throw new DpdShipmentServiceError("The complete parcel label set could not be finalized.", 409);
  }

  await completeShipmentBookingCharge({
    shipmentDraftId: dpdShipment.shipmentDraftId,
    dpdShipmentId: dpdShipment._id as mongoose.Types.ObjectId,
    createdBy: userId
  });
  const shipmentInvoice = await ensureShipmentInvoiceForDraft({
    shipmentDraftId: dpdShipment.shipmentDraftId,
    dpdShipmentId: dpdShipment._id as mongoose.Types.ObjectId,
    userId
  });

  dpdShipment.status = "LABEL_RECEIVED";
  await dpdShipment.save();
  await ShipmentDraft.updateOne(
    { _id: dpdShipment.shipmentDraftId, bookingState: "REVIEW_REQUIRED" },
    { $set: { bookingState: "BOOKED", lockedAt: new Date() } },
    { runValidators: true }
  ).exec();
  await writeDpdAuditLog(
    "DPD_REQUEST_SUCCEEDED",
    dpdShipment._id as mongoose.Types.ObjectId,
    "DPD_SHIPMENT",
    userId,
    { reconciled: true, labelCount: labels.length }
  );

  return { dpdShipment, labels, shipmentInvoice, reused: false };
}

/**
 * Requests the carrier label for a booking that was deliberately created on
 * Swiftline labels only.
 *
 * This is deliberately separate from createLabelForShipmentDraft: the shipment
 * and its invoice already exist, so this action must never allocate another
 * Swiftline AWB, create another DpdShipment, reserve money, or create another
 * invoice. The status claim also makes two staff clicks safe against each other.
 */
export async function generateDpdLabelForExistingShipment(
  dpdShipmentId: string,
  userId: mongoose.Types.ObjectId
) {
  if (!mongoose.Types.ObjectId.isValid(dpdShipmentId)) {
    throw new DpdShipmentServiceError("Shipment booking not found.", 404);
  }

  const shipmentId = new mongoose.Types.ObjectId(dpdShipmentId);
  const initialShipment = await DpdShipment.findById(shipmentId).exec();
  if (!initialShipment) throw new DpdShipmentServiceError("Shipment booking not found.", 404);

  const existingLabels = await LabelDocument.find({ dpdShipmentId: shipmentId }).exec();
  const hasDpdLabel = existingLabels.some((label) => label.labelType === "DPD");
  const isInternalLabelOnly = !initialShipment.dpdShipmentId?.trim() && !hasDpdLabel;
  if (hasDpdLabel || (initialShipment.status === "LABEL_RECEIVED" && !isInternalLabelOnly)) {
    return { dpdShipment: initialShipment, labels: existingLabels, reused: true };
  }
  if (initialShipment.status !== "DPD_CREATED" && !isInternalLabelOnly) {
    throw new DpdShipmentServiceError(
      initialShipment.status === "DPD_CREATING"
        ? "A DPD label request is already processing for this shipment. Refresh before trying again."
        : initialShipment.status === "DPD_STATUS_UNKNOWN"
          ? "The DPD label request has an uncertain result. Do not submit it again; confirm the carrier outcome with Operations."
          : "This shipment is not available for a new DPD label request.",
      409
    );
  }

  // A prior successful carrier response with a local storage failure is kept
  // non-retryable. The carrier AWB proves the request already created a
  // consignment, so calling create_docket again could duplicate it.
  if (initialShipment.dpdShipmentId?.trim()) {
    throw new DpdShipmentServiceError(
      "The DPD booking already has a carrier reference, but its label still needs reconciliation. Do not submit it again; contact Swiftline Operations.",
      409
    );
  }

  const draft = await ShipmentDraft.findById(initialShipment.shipmentDraftId).exec();
  if (!draft) throw new DpdShipmentServiceError("Shipment draft not found.", 404);
  if (!isDpdLabelDestination(draft.consigneeEnteredAddress.countryCode)) {
    throw new DpdShipmentServiceError(
      "A DPD carrier label is only available for a supported DPD destination.",
      409
    );
  }
  const trackingNumber = initialShipment.swiftlineTrackingNumber?.trim();
  if (!trackingNumber) {
    throw new DpdShipmentServiceError(
      "This shipment does not have a Swiftline tracking number, so a DPD label cannot be requested safely.",
      409
    );
  }

  // Only one request may move this booking into the carrier-requesting state.
  // A second request re-reads the outcome and never calls ALS concurrently.
  const claimedShipment = await DpdShipment.findOneAndUpdate(
    { _id: shipmentId, status: { $in: ["DPD_CREATED", "LABEL_RECEIVED"] }, dpdShipmentId: { $in: ["", null] } },
    { $set: { status: "DPD_CREATING" } },
    { returnDocument: "after" }
  ).exec();
  if (!claimedShipment) {
    const current = await DpdShipment.findById(shipmentId).exec();
    if (current?.status === "LABEL_RECEIVED") {
      const labels = await LabelDocument.find({ dpdShipmentId: shipmentId }).exec();
      const currentHasDpdLabel = labels.some((label) => label.labelType === "DPD");
      if (current.dpdShipmentId?.trim() || currentHasDpdLabel) {
        return { dpdShipment: current, labels, reused: true };
      }
    }
    throw new DpdShipmentServiceError(
      current?.status === "DPD_CREATING"
        ? "A DPD label request is already processing for this shipment. Refresh before trying again."
        : "This shipment is not available for a new DPD label request.",
      409
    );
  }

  let carrierAccepted = false;
  try {
    await writeDpdAuditLog(
      "DPD_REQUEST_INITIATED",
      shipmentId,
      "DPD_SHIPMENT",
      userId,
      { stage: "DPD_LABEL_ONLY", shipmentDraftId: draft._id, swiftlineTrackingNumber: trackingNumber }
    );

    const docket = await createAlsDocket({ draft, trackingNumber, bookedAt: new Date() });
    carrierAccepted = true;

    // Persist the carrier identity before storing the document. If local object
    // storage fails after this point, the non-empty carrier AWB prevents a
    // second carrier call on a later click.
    claimedShipment.dpdShipmentId = docket.awbNumber;
    claimedShipment.dpdTransactionId = docket.docketId;
    claimedShipment.forwardingNumber = docket.forwardingNumber;
    claimedShipment.entryNumber = docket.entryNumber;
    claimedShipment.parcelNumbers = docket.parcelNumbers;
    claimedShipment.requestSnapshot = docket.requestSnapshot;
    claimedShipment.responseSnapshot = docket.responseSnapshot;
    claimedShipment.status = "DPD_CREATED";
    await claimedShipment.save();

    await storeGeneratedLabels(docket.labels.map((dpdLabel, index) => ({
        dpdShipmentId: shipmentId,
        shipmentDraftId: claimedShipment.shipmentDraftId,
        parcelNumber: docket.awbNumber
          ? `${docket.awbNumber}${index > 0 ? `-${index + 1}` : ""}`
          : trackingNumber,
        labelType: "DPD",
        buffer: dpdLabel.content,
        format: dpdLabel.format,
        labelVersion: claimedShipment.snapshotRevision || 1
      })));

    claimedShipment.status = "LABEL_RECEIVED";
    await claimedShipment.save();
    const labels = await LabelDocument.find({ dpdShipmentId: shipmentId }).exec();
    await writeDpdAuditLog(
      "DPD_REQUEST_SUCCEEDED",
      shipmentId,
      "DPD_SHIPMENT",
      userId,
      {
        stage: "DPD_LABEL_ONLY",
        shipmentDraftId: draft._id,
        swiftlineTrackingNumber: trackingNumber,
        dpdAwbNumber: docket.awbNumber,
        dpdLabelCount: docket.labels.length
      }
    );
    return { dpdShipment: claimedShipment, labels, reused: false };
  } catch (error) {
    if (error instanceof AlsUncertainError) {
      claimedShipment.status = "DPD_STATUS_UNKNOWN";
      claimedShipment.responseSnapshot = {
        ...claimedShipment.responseSnapshot,
        stage: "DPD_LABEL_ONLY",
        message: error.message
      };
      await claimedShipment.save();
      await writeDpdAuditLog(
        "DPD_REQUEST_FAILED",
        shipmentId,
        "DPD_SHIPMENT",
        userId,
        { stage: "DPD_LABEL_ONLY", status: "DPD_STATUS_UNKNOWN", message: error.message }
      );
      throw new DpdShipmentServiceError(error.message, 409);
    }

    if (carrierAccepted) {
      claimedShipment.status = "DPD_CREATED";
      claimedShipment.responseSnapshot = {
        ...claimedShipment.responseSnapshot,
        localLabelError: error instanceof Error ? error.message : "Unknown local label error",
        stage: "DPD_LABEL_ONLY"
      };
      await claimedShipment.save();
      await writeDpdAuditLog(
        "DPD_REQUEST_FAILED",
        shipmentId,
        "DPD_SHIPMENT",
        userId,
        {
          stage: "DPD_LABEL_ONLY",
          status: "DPD_CREATED",
          message: "DPD accepted the booking, but the carrier label could not be stored locally."
        }
      );
      throw new DpdShipmentServiceError(
        "DPD accepted this shipment, but the carrier label could not be stored locally. Do not submit it again; contact Swiftline Operations.",
        409
      );
    }

    claimedShipment.status = "DPD_CREATED";
    await claimedShipment.save();
    await writeDpdAuditLog(
      "DPD_REQUEST_FAILED",
      shipmentId,
      "DPD_SHIPMENT",
      userId,
      { stage: "DPD_LABEL_ONLY", status: "DPD_CREATED", reason: error instanceof Error ? error.message : String(error) }
    );
    if (error instanceof AlsRequestError) {
      throw new DpdLabelUnavailableError(error.message, error.statusCode, error.carrierErrors);
    }
    throw error;
  }
}

/**
 * Re-renders every parcel label from the current shipment snapshot.
 *
 * Used after an amendment changes what a label must say. Labels are versioned
 * rather than overwritten, so the copy already sent to a client stays retrievable.
 */
export async function regenerateShipmentLabels(
  dpdShipmentId: mongoose.Types.ObjectId,
  userId: mongoose.Types.ObjectId
) {
  const dpdShipment = await DpdShipment.findById(dpdShipmentId).exec();
  if (!dpdShipment) throw new DpdShipmentServiceError("Shipment booking not found.", 404);

  const snapshot = readShipmentBookingSnapshot(dpdShipment.currentShipmentSnapshot)
    ?? readShipmentBookingSnapshot(dpdShipment.bookingSnapshot);
  if (!snapshot) throw new DpdShipmentServiceError("The current shipment snapshot is unavailable.", 409);

  const labelJobs: GeneratedLabelJob[] = [];
  for (let index = 0; index < snapshot.parcels.length; index += 1) {
    const labelData = bookingSnapshotToLabelData(snapshot, index);
    labelJobs.push({
      dpdShipmentId,
      shipmentDraftId: dpdShipment.shipmentDraftId,
      parcelNumber: labelData.parcelNumber,
      labelVersion: dpdShipment.snapshotRevision || 1,
      buffer: () => renderSwiftlineLabelPdf(labelData)
    });
  }
  await storeGeneratedLabels(labelJobs);

  const labels = await LabelDocument.find({
    dpdShipmentId,
    labelVersion: dpdShipment.snapshotRevision || 1
  }).exec();
  if (!hasCompleteSwiftlineLabelSet({ parcelCount: snapshot.parcels.length, labels })) {
    throw new DpdShipmentServiceError("The amended parcel label set could not be finalized.", 409);
  }

  dpdShipment.status = "LABEL_RECEIVED";
  await dpdShipment.save();
  await ShipmentDraft.updateOne(
    { _id: dpdShipment.shipmentDraftId },
    { $set: { bookingState: "BOOKED", lockedAt: new Date() } },
    { runValidators: true }
  ).exec();
  await writeDpdAuditLog("DPD_REQUEST_SUCCEEDED", dpdShipmentId, "DPD_SHIPMENT", userId, {
    labelsRegenerated: true,
    snapshotRevision: dpdShipment.snapshotRevision,
    parcelCount: snapshot.parcels.length
  });
  return labels;
}

export async function resetBookingForDevelopment(
  shipmentDraftId: string,
  userId: mongoose.Types.ObjectId
) {
  if (process.env.NODE_ENV === "production") {
    throw new DpdShipmentServiceError("Development booking reset is unavailable in production.", 404);
  }
  if (!mongoose.Types.ObjectId.isValid(shipmentDraftId)) {
    throw new DpdShipmentServiceError("Shipment draft not found.", 404);
  }

  const draft = await ShipmentDraft.findById(shipmentDraftId).exec();
  if (!draft) throw new DpdShipmentServiceError("Shipment draft not found.", 404);
  const dpdShipment = await DpdShipment.findOne({ shipmentDraftId }).exec();
  if (!dpdShipment) {
    if (draft.bookingState !== "BOOKING") {
      throw new DpdShipmentServiceError("No incomplete simulated booking attempt was found.", 409);
    }
    await releaseShipmentBookingCharge({
      shipmentDraftId: draft._id as mongoose.Types.ObjectId,
      createdBy: userId
    });
    draft.bookingState = "EDITABLE";
    draft.bookingAttemptId = "";
    draft.lockedAt = null;
    await draft.save();
    return null;
  }
  const labelCount = await LabelDocument.countDocuments({ dpdShipmentId: dpdShipment._id }).exec();
  if (labelCount || dpdShipment.status === "LABEL_RECEIVED") {
    throw new DpdShipmentServiceError(
      "This booking cannot be reset because label data already exists.",
      409
    );
  }

  await releaseShipmentBookingCharge({
    shipmentDraftId: dpdShipment.shipmentDraftId,
    dpdShipmentId: dpdShipment._id as mongoose.Types.ObjectId,
    createdBy: userId
  });
  dpdShipment.status = "DPD_REJECTED";
  dpdShipment.responseSnapshot = { developmentResetAt: new Date(), resetBy: userId };
  await dpdShipment.save();
  await ShipmentDraft.updateOne(
    { _id: dpdShipment.shipmentDraftId, bookingState: { $in: ["BOOKING", "REVIEW_REQUIRED"] } },
    { $set: { bookingState: "EDITABLE", bookingAttemptId: null, lockedAt: null } },
    { runValidators: true }
  ).exec();

  await writeDpdAuditLog(
    "DPD_REQUEST_FAILED",
    dpdShipment._id as mongoose.Types.ObjectId,
    "DPD_SHIPMENT",
    userId,
    { developmentReset: true, shipmentDraftId: dpdShipment.shipmentDraftId }
  );

  return dpdShipment;
}
