import crypto from "node:crypto";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { env } from "../config/env.js";
import { Branch } from "../models/branch.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { LabelDocument } from "../models/labelDocument.model.js";
import { PublicShipmentBooking } from "../models/publicShipmentBooking.model.js";
import { PublicShipmentPayment } from "../models/publicShipmentPayment.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { SYSTEM_ACTOR_ID } from "../utils/systemActor.js";
import { maskAadhaarNumber } from "./aadhaarValidation.service.js";
import { createLabelForShipmentDraft } from "./dpdShipment.service.js";
import { enqueueEmails } from "./email/enqueue.js";
import { getOrCreateIndividualSentinel } from "./individualCustomer.service.js";
import { notifyBranchOperationsStaff } from "./portalNotification.service.js";
import { ensureShipmentBookedEvent } from "./shipmentBookingEvent.service.js";
import type { PublicShipmentDraftPayload } from "./publicShipmentBooking.validation.js";
import { publicShipmentPolicyVersions } from "./publicShipmentPolicies.service.js";
import {
  captureRazorpayPayment,
  createRazorpayOrder,
  createRazorpayRefund,
  fetchRazorpayPayment,
  getRazorpayPublicConfig,
} from "./razorpay/client.js";
import { verifyRazorpayCheckoutSignature } from "./razorpay/signatures.js";
import { buildPricingHash } from "./shipmentCostEstimate.service.js";
import {
  buildPricingInputFromDraft,
  calculateShipmentPricingEstimate,
  publicBookingGstRate,
  publicBookingRateCardBand,
} from "./shipmentPricing.service.js";
import { validateShipmentDraftFields } from "./shipmentValidation.service.js";

export const PUBLIC_BOOKING_COOKIE = "slc_public_booking";
export const PUBLIC_QUOTE_TTL_MS = 30 * 60 * 1000;

export class PublicShipmentBookingError extends Error {
  constructor(message: string, public readonly statusCode = 400, public readonly code = "PUBLIC_BOOKING_ERROR", public readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = "PublicShipmentBookingError";
  }
}

function tokenHash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requestIpHash(request: Request) {
  return crypto.createHmac("sha256", env.JWT_SECRET).update(request.ip || "unknown").digest("hex");
}

function expiryDate() {
  return new Date(Date.now() + env.PUBLIC_BOOKING_SESSION_HOURS * 60 * 60 * 1000);
}

function setSessionCookie(response: Response, token: string) {
  response.cookie(PUBLIC_BOOKING_COOKIE, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production" || env.CROSS_SITE_COOKIES,
    sameSite: env.CROSS_SITE_COOKIES ? "none" : "lax",
    maxAge: env.PUBLIC_BOOKING_SESSION_HOURS * 60 * 60 * 1000,
    path: "/",
  });
}

function newReference() {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `WEB-${day}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function createPublicBookingSession(response: Response) {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const booking = await PublicShipmentBooking.create({
    publicReference: newReference(),
    sessionTokenHash: tokenHash(rawToken),
    state: "DRAFT",
    expiresAt: expiryDate(),
  });
  setSessionCookie(response, rawToken);
  return { booking, rawToken };
}

export async function getPublicBookingFromRequest(request: Request, options: { allowStatusToken?: boolean } = {}) {
  const cookieToken = typeof request.cookies?.[PUBLIC_BOOKING_COOKIE] === "string" ? request.cookies[PUBLIC_BOOKING_COOKIE] : "";
  const queryToken = options.allowStatusToken && typeof request.query.token === "string" ? request.query.token : "";
  const rawToken = cookieToken || queryToken;
  if (!rawToken || rawToken.length > 200) throw new PublicShipmentBookingError("Your booking session has expired. Start a new booking.", 401, "SESSION_EXPIRED");
  const hash = tokenHash(rawToken);
  const booking = await PublicShipmentBooking.findOne({
    $or: [
      { sessionTokenHash: hash },
      ...(options.allowStatusToken ? [{ statusTokenHash: hash }] : []),
    ],
  }).select("+sessionTokenHash +statusTokenHash").exec();
  if (!booking) throw new PublicShipmentBookingError("Your booking session has expired. Start a new booking.", 401, "SESSION_EXPIRED");
  return { booking, rawToken };
}

async function configuredPublicBranch() {
  if (!env.PUBLIC_BOOKING_BRANCH_ID) {
    throw new PublicShipmentBookingError("Online booking is temporarily unavailable. Please contact Swiftline.", 503, "BRANCH_NOT_CONFIGURED");
  }
  const branch = await Branch.findOne({ _id: env.PUBLIC_BOOKING_BRANCH_ID, status: "ACTIVE" }).exec();
  if (!branch) throw new PublicShipmentBookingError("Online booking is temporarily unavailable. Please contact Swiftline.", 503, "BRANCH_UNAVAILABLE");
  return branch;
}

export async function savePublicShipmentDraft(bookingId: mongoose.Types.ObjectId, data: PublicShipmentDraftPayload) {
  const booking = await PublicShipmentBooking.findById(bookingId).exec();
  if (!booking) throw new PublicShipmentBookingError("Booking session not found.", 404);
  if (!["DRAFT", "QUOTED"].includes(booking.state)) {
    throw new PublicShipmentBookingError("This booking can no longer be edited. Contact Swiftline for help.", 409, "BOOKING_LOCKED");
  }

  const [branch, sentinel] = await Promise.all([
    configuredPublicBranch(),
    getOrCreateIndividualSentinel(SYSTEM_ACTOR_ID),
  ]);
  const parcelList = data.parcels.map((parcel, index) => ({
    sequence: index + 1,
    ...parcel,
    contentsDescription: parcel.items.map((item) => item.description).join(", ").slice(0, 120),
    aadhaarNumber: data.kycUseForAllParcels ? "" : data.sender.aadhaarNumber,
  }));
  const sender = { ...data.sender, pickupInstructions: "" };
  const consignee = { ...data.consignee };
  delete (sender as Record<string, unknown>).entityType;
  delete (consignee as Record<string, unknown>).entityType;

  let draft = booking.shipmentDraftId ? await ShipmentDraft.findById(booking.shipmentDraftId).exec() : null;
  if (!draft) {
    draft = new ShipmentDraft({
      creationSource: "PUBLIC_ONLINE",
      businessAccountId: sentinel._id,
      customerType: "INDIVIDUAL",
      branchId: branch._id,
      createdBy: SYSTEM_ACTOR_ID,
      kycDocuments: {},
    });
  }
  const previousParcelDocuments = draft.parcelList.map((parcel) => parcel.kycDocuments ?? {});
  draft.set({
    creationSource: "PUBLIC_ONLINE",
    businessAccountId: sentinel._id,
    customerType: "INDIVIDUAL",
    branchId: branch._id,
    sender: { entityType: data.sender.entityType, publicReference: booking.publicReference },
    consignorAddress: sender,
    kycUseForAllParcels: data.kycUseForAllParcels,
    consigneeEnteredAddress: consignee,
    consigneeSelectedAddress: consignee,
    consigneeValidatedAddress: consignee,
    addressValidationStatus: "VALIDATED",
    addressValidationResult: { provider: "PUBLIC_STRUCTURED_INPUT", validatedAt: new Date() },
    parcelCount: parcelList.length,
    parcelList: parcelList.map((parcel, index) => ({ ...parcel, kycDocuments: previousParcelDocuments[index] ?? {} })),
    csbType: data.csbType,
    insuranceOptIn: false,
    forceGst: false,
    serviceType: data.serviceType,
    serviceCode: "",
    bookingState: "EDITABLE",
  });
  draft.validationIssues = validateShipmentDraftFields(draft);
  draft.status = draft.validationIssues.length ? "VALIDATION_FAILED" : "READY_FOR_DPD";
  await draft.save();

  booking.shipmentDraftId = draft._id as mongoose.Types.ObjectId;
  booking.branchId = branch._id as mongoose.Types.ObjectId;
  booking.senderEntityType = data.sender.entityType;
  booking.customerName = data.sender.companyName || data.sender.contactName;
  booking.email = data.sender.email;
  booking.revision += 1;
  booking.state = "DRAFT";
  booking.quotedRevision = null;
  booking.pricingHash = "";
  booking.quoteAmountMinor = null;
  booking.quoteExpiresAt = null;
  booking.expiresAt = expiryDate();
  await booking.save();

  return { booking, draft };
}

export async function quotePublicShipment(input: {
  bookingId: mongoose.Types.ObjectId;
  request: Request;
}) {
  const booking = await PublicShipmentBooking.findById(input.bookingId).exec();
  if (!booking?.shipmentDraftId) throw new PublicShipmentBookingError("Save the shipment details before requesting a quote.", 409);
  if (!["DRAFT", "QUOTED"].includes(booking.state)) throw new PublicShipmentBookingError("This booking is already in payment processing.", 409);
  const draft = await ShipmentDraft.findById(booking.shipmentDraftId).exec();
  if (!draft) throw new PublicShipmentBookingError("Shipment details were not found.", 404);
  const issues = validateShipmentDraftFields(draft, { requireValidatedAddress: true });
  if (issues.length) throw new PublicShipmentBookingError("Complete the required shipment information before requesting a quote.", 400, "VALIDATION_FAILED", { validationIssues: issues });

  const pricing = await calculateShipmentPricingEstimate({
    ...buildPricingInputFromDraft(draft),
    businessAccountId: undefined,
    rateCardBand: publicBookingRateCardBand,
    // Band D is entered as the customer-facing, GST-inclusive amount. The
    // rate-card GST flag remains staff metadata and does not change public tax
    // treatment.
    gstRate: publicBookingGstRate,
    insuranceOptIn: false,
  });
  if (pricing.missingRate) throw new PublicShipmentBookingError("Online rates are not available for this route and weight. Contact Swiftline for help.", 409, "RATE_NOT_FOUND");
  const overweight = pricing.parcels.filter((parcel) => parcel.exceedsMaxBoxKg);
  if (overweight.length) throw new PublicShipmentBookingError("One or more parcels exceed the maximum weight for this route.", 409, "MAX_WEIGHT_EXCEEDED");

  booking.state = "QUOTED";
  booking.quotedRevision = booking.revision;
  booking.pricingHash = buildPricingHash(pricing);
  booking.quoteAmountMinor = Math.round(pricing.totalAmount * 100);
  booking.quoteExpiresAt = new Date(Date.now() + PUBLIC_QUOTE_TTL_MS);
  booking.acceptedPolicies = {
    termsVersion: publicShipmentPolicyVersions.terms,
    cancellationVersion: publicShipmentPolicyVersions.cancellation,
    prohibitedGoodsVersion: publicShipmentPolicyVersions.prohibitedGoods,
    acceptedAt: new Date(),
    acceptedIpHash: requestIpHash(input.request),
  };
  await booking.save();
  return { booking, pricing };
}

function assertLiveQuote(booking: InstanceType<typeof PublicShipmentBooking>) {
  if (booking.state !== "QUOTED" || !booking.quoteExpiresAt || booking.quoteExpiresAt.getTime() <= Date.now()
    || booking.quotedRevision !== booking.revision || !booking.quoteAmountMinor || !booking.pricingHash) {
    throw new PublicShipmentBookingError("Your 30 minute quote has expired or the shipment changed. Review a new quote before paying.", 409, "QUOTE_EXPIRED");
  }
}

export async function createPublicPaymentOrder(bookingId: mongoose.Types.ObjectId) {
  const booking = await PublicShipmentBooking.findById(bookingId).exec();
  if (!booking?.shipmentDraftId || !booking.branchId) throw new PublicShipmentBookingError("Shipment details were not found.", 404);
  const idempotencyKey = `PUBLIC_BOOKING:${String(booking._id)}:${booking.revision}`;
  const paymentConfig = getRazorpayPublicConfig();
  const existing = await PublicShipmentPayment.findOne({ idempotencyKey }).exec();
  if (existing) {
    if (["ORDER_CREATED", "FAILED"].includes(existing.status)) {
      if (booking.state !== "PAYMENT_PENDING") {
        booking.state = "PAYMENT_PENDING";
        await booking.save();
      }
      return { booking, payment: existing, keyId: paymentConfig.keyId };
    }
    throw new PublicShipmentBookingError("Payment has already been received or is being verified. Check the booking status; do not pay again.", 202, "PAYMENT_ALREADY_PROCESSING");
  }
  assertLiveQuote(booking);

  const claim = await PublicShipmentBooking.updateOne(
    {
      _id: booking._id,
      state: "QUOTED",
      revision: booking.revision,
      quotedRevision: booking.revision,
      quoteExpiresAt: { $gt: new Date() },
    },
    { $set: { state: "PAYMENT_PENDING" } },
  ).exec();
  if (claim.modifiedCount !== 1) {
    const racedPayment = await PublicShipmentPayment.findOne({ idempotencyKey }).exec();
    if (racedPayment) return { booking, payment: racedPayment, keyId: paymentConfig.keyId };
    throw new PublicShipmentBookingError("Payment has already been started or the quote expired. Refresh the booking status before trying again.", 409, "PAYMENT_ALREADY_STARTED");
  }
  booking.state = "PAYMENT_PENDING";
  let keepClaimedState = false;
  try {
    const order = await createRazorpayOrder({
      amountMinor: booking.quoteAmountMinor!,
      currency: "INR",
      receipt: booking.publicReference.slice(0, 40),
      notes: { bookingReference: booking.publicReference, branchId: String(booking.branchId) },
    });
    const matchesQuote = order.amount === booking.quoteAmountMinor && order.currency === "INR";
    const payment = await PublicShipmentPayment.create({
      bookingId: booking._id,
      shipmentDraftId: booking.shipmentDraftId,
      branchId: booking.branchId,
      bookingRevision: booking.revision,
      pricingHash: booking.pricingHash,
      idempotencyKey,
      razorpayOrderId: order.id,
      amountMinor: booking.quoteAmountMinor!,
      currency: "INR",
      status: matchesQuote ? "ORDER_CREATED" : "PAYMENT_REVIEW_REQUIRED",
      failureCode: matchesQuote ? "" : "PAYMENT_ORDER_MISMATCH",
      failureMessage: matchesQuote ? "" : "Gateway order did not match the accepted quote.",
    });
    if (!matchesQuote) {
      keepClaimedState = true;
      booking.state = "PAYMENT_REVIEW_REQUIRED";
      await booking.save();
      await notifyPaymentIssue(payment, "Public payment order mismatch", `${booking.publicReference} needs Operations review. The customer was not sent to checkout.`);
      throw new PublicShipmentBookingError("The payment order did not match the accepted quote. Swiftline has been notified.", 502, "PAYMENT_ORDER_MISMATCH");
    }
    keepClaimedState = true;
    return { booking, payment, keyId: paymentConfig.keyId };
  } catch (error) {
    if (!keepClaimedState) {
      booking.state = "QUOTED";
      await PublicShipmentBooking.updateOne(
        { _id: booking._id, state: "PAYMENT_PENDING" },
        { $set: { state: "QUOTED" } },
      ).exec();
      await notifyBranchOperationsStaff(booking.branchId, {
        type: "CREDIT_RECONCILIATION_ALERT",
        title: "Public checkout could not start",
        message: `${booking.publicReference} could not create or safely persist its Razorpay order. No shipment was created.`,
        href: "/dashboard/shipments",
        idempotencyKey: `PUBLIC_ORDER_ERROR:${String(booking._id)}:${booking.revision}`,
        metadata: { publicBookingId: booking._id, shipmentDraftId: booking.shipmentDraftId },
      }).catch((notifyError) => console.error("Public order failure alert could not be queued.", notifyError));
    }
    throw error;
  }
}

async function notifyPaymentIssue(payment: InstanceType<typeof PublicShipmentPayment>, title: string, message: string) {
  await notifyBranchOperationsStaff(payment.branchId, {
    type: "CREDIT_RECONCILIATION_ALERT",
    title,
    message,
    href: `/dashboard/shipments/${String(payment.shipmentDraftId)}`,
    idempotencyKey: `PUBLIC_PAYMENT_ALERT:${String(payment._id)}:${payment.status}`,
    metadata: { publicShipmentPaymentId: payment._id, shipmentDraftId: payment.shipmentDraftId, razorpayOrderId: payment.razorpayOrderId },
  }).catch((error) => console.error("Public payment alert could not be queued.", error));
}

async function sendPublicBookingEmail(input: {
  booking: InstanceType<typeof PublicShipmentBooking>;
  payment: InstanceType<typeof PublicShipmentPayment>;
  rawStatusToken: string;
}) {
  const [invoice, labels] = await Promise.all([
    ShipmentInvoice.findOne({ shipmentDraftId: input.payment.shipmentDraftId }).lean().exec(),
    input.booking.dpdShipmentId
      ? LabelDocument.find({ dpdShipmentId: input.booking.dpdShipmentId, labelType: "SWIFTLINE", voidedAt: null }).sort({ parcelNumber: 1 }).lean().exec()
      : [],
  ]);
  if (!invoice) return;
  const attachments = [
    { kind: "SHIPMENT_INVOICE_PDF" as const, refId: invoice._id, revision: invoice.revision, filename: `${invoice.invoiceNumber.replaceAll("/", "-")}-Invoice.pdf` },
    ...labels.map((label) => ({ kind: "LABEL_DOCUMENT" as const, refId: label._id, revision: null, filename: `Swiftline-Label-${label.parcelNumber}.${label.format.toLowerCase()}` })),
  ];
  await enqueueEmails({
    notificationType: "SHIPMENT_BOOKED",
    idempotencyKey: `PUBLIC_SHIPMENT_BOOKED:${String(input.booking._id)}`,
    recipients: [{ email: input.booking.email, name: input.booking.customerName }],
    subject: `Shipment booked - ${input.booking.swiftlineTrackingNumber}`,
    templateKey: "PUBLIC_SHIPMENT_BOOKED",
    payload: {
      trackingNumber: input.booking.swiftlineTrackingNumber,
      bookingReference: input.booking.publicReference,
      invoiceNumber: invoice.invoiceNumber,
      amountMinor: input.payment.amountMinor,
      paymentReceipt: input.payment.razorpayPaymentId,
      statusHref: `/book-shipment-online/status?token=${encodeURIComponent(input.rawStatusToken)}`,
      trackingHref: `/track?awb=${encodeURIComponent(input.booking.swiftlineTrackingNumber)}`,
    },
    attachmentRefs: attachments,
  });
}

export async function fulfillCapturedPublicPayment(paymentId: mongoose.Types.ObjectId, rawStatusToken: string) {
  let payment = await PublicShipmentPayment.findById(paymentId).exec();
  if (!payment) throw new PublicShipmentBookingError("Payment record not found.", 404);
  let booking = await PublicShipmentBooking.findById(payment.bookingId).exec();
  if (!booking) throw new PublicShipmentBookingError("Booking record not found.", 404);
  if (payment.status === "BOOKED" && booking.state === "BOOKED") return booking;
  if (payment.status === "FULFILLING") {
    throw new PublicShipmentBookingError("Payment was received and shipment creation is already in progress. Check the booking status in a moment.", 202, "PAYMENT_CONFIRMATION_IN_PROGRESS");
  }
  if (["REVIEW_REQUIRED", "REFUND_PENDING", "REFUNDED", "PAYMENT_REVIEW_REQUIRED"].includes(payment.status)) {
    throw new PublicShipmentBookingError("This paid booking is already being handled by Swiftline. Do not pay again.", 202, "BOOKING_REVIEW_REQUIRED");
  }
  if (payment.status !== "CAPTURED") {
    throw new PublicShipmentBookingError("Payment is not ready for fulfilment.", 409);
  }

  const claimedPayment = await PublicShipmentPayment.findOneAndUpdate(
    { _id: payment._id, status: "CAPTURED" },
    { $set: { status: "FULFILLING" } },
    { returnDocument: "after" },
  ).exec();
  if (!claimedPayment) {
    payment = await PublicShipmentPayment.findById(payment._id).exec();
    booking = await PublicShipmentBooking.findById(booking._id).exec();
    if (payment?.status === "BOOKED" && booking?.state === "BOOKED") return booking;
    if (booking) {
      throw new PublicShipmentBookingError("Payment was received and shipment creation is already in progress. Check the booking status in a moment.", 202, "PAYMENT_CONFIRMATION_IN_PROGRESS");
    }
    throw new PublicShipmentBookingError("Booking record not found.", 404);
  }
  payment = claimedPayment;
  booking.state = "FULFILLING";
  await booking.save();
  try {
    const result = await createLabelForShipmentDraft(String(payment.shipmentDraftId), SYSTEM_ACTOR_ID, {
      actor: "public",
      paymentSource: "PUBLIC_RAZORPAY",
      acceptedPricingHash: payment.pricingHash,
      skipDpdLabel: true,
    });
    await ensureShipmentBookedEvent({
      shipmentDraftId: payment.shipmentDraftId,
      dpdShipmentId: result.dpdShipment._id as mongoose.Types.ObjectId,
      userId: SYSTEM_ACTOR_ID,
      eventAt: result.dpdShipment.createdAt,
      source: "SYSTEM",
      sourceReference: `PUBLIC_SHIPMENT_BOOKING:${String(booking._id)}`,
    });
    const invoice = result.shipmentInvoice;
    booking.state = "BOOKED";
    booking.statusTokenHash = tokenHash(rawStatusToken);
    booking.dpdShipmentId = result.dpdShipment._id as mongoose.Types.ObjectId;
    booking.shipmentInvoiceId = invoice._id as mongoose.Types.ObjectId;
    booking.swiftlineTrackingNumber = result.dpdShipment.swiftlineTrackingNumber || "";
    booking.expiresAt = null;
    payment.status = "BOOKED";
    payment.fulfilledAt = new Date();
    await Promise.all([booking.save(), payment.save()]);
    await sendPublicBookingEmail({ booking, payment, rawStatusToken }).catch((error) => console.error("Public booking email could not be queued.", error));
    return booking;
  } catch (error) {
    const durable = await DpdShipment.findOne({ shipmentDraftId: payment.shipmentDraftId }).lean().exec();
    payment.failureMessage = error instanceof Error ? error.message : "Shipment fulfilment failed.";
    if (durable) {
      payment.status = "REVIEW_REQUIRED";
      booking.state = "REVIEW_REQUIRED";
      await Promise.all([payment.save(), booking.save()]);
      await notifyPaymentIssue(payment, "Paid public booking needs review", `${booking.publicReference} was paid and a shipment record exists, but documents or finalisation need Operations review. Do not refund or rebook automatically.`);
      throw new PublicShipmentBookingError("Your payment was successful. Swiftline Operations is reviewing the booking; do not pay again.", 202, "BOOKING_REVIEW_REQUIRED");
    }

    payment.status = "REFUND_PENDING";
    booking.state = "REFUND_PENDING";
    await Promise.all([payment.save(), booking.save()]);
    try {
      const refund = await createRazorpayRefund({ paymentId: payment.razorpayPaymentId, amountMinor: payment.amountMinor, idempotencyKey: `PUBLIC_REFUND:${String(payment._id)}` });
      payment.razorpayRefundId = refund.id;
      payment.status = refund.status === "processed" ? "REFUNDED" : "REFUND_PENDING";
      payment.refundedAt = refund.status === "processed" ? new Date() : null;
      booking.state = payment.status === "REFUNDED" ? "REFUNDED" : "REFUND_PENDING";
      await Promise.all([payment.save(), booking.save()]);
    } catch (refundError) {
      payment.failureMessage = `${payment.failureMessage} Refund error: ${refundError instanceof Error ? refundError.message : "Unknown"}`;
      await payment.save();
    }
    await notifyPaymentIssue(payment, "Public booking refund requires attention", `${booking.publicReference} was paid but no durable shipment was created. Refund status: ${payment.status}.`);
    throw new PublicShipmentBookingError("The shipment could not be completed after payment. A refund has been started and Swiftline has been notified.", 202, "REFUND_PENDING");
  }
}

export async function confirmPublicPayment(input: {
  bookingId: mongoose.Types.ObjectId;
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
  rawStatusToken: string;
}) {
  if (!env.RAZORPAY_KEY_SECRET) throw new PublicShipmentBookingError("Payment is temporarily unavailable.", 503);
  const payment = await PublicShipmentPayment.findOne({ bookingId: input.bookingId, razorpayOrderId: input.razorpayOrderId }).exec();
  if (!payment) throw new PublicShipmentBookingError("Payment order not found.", 404);
  if (payment.status === "BOOKED") return PublicShipmentBooking.findById(payment.bookingId).exec();
  if (!verifyRazorpayCheckoutSignature({ orderId: input.razorpayOrderId, paymentId: input.razorpayPaymentId, signature: input.razorpaySignature, secret: env.RAZORPAY_KEY_SECRET })) {
    throw new PublicShipmentBookingError("Payment confirmation signature is invalid.", 400, "INVALID_PAYMENT_SIGNATURE");
  }

  if (["CAPTURED", "FULFILLING"].includes(payment.status)) {
    return fulfillCapturedPublicPayment(payment._id as mongoose.Types.ObjectId, input.rawStatusToken);
  }
  if (["PAYMENT_REVIEW_REQUIRED", "REVIEW_REQUIRED", "REFUND_PENDING", "REFUNDED"].includes(payment.status)) {
    throw new PublicShipmentBookingError("This payment is already being handled by Swiftline. Do not pay again.", 202, "PAYMENT_REVIEW_REQUIRED");
  }
  const verificationClaim = await PublicShipmentPayment.updateOne(
    { _id: payment._id, status: { $in: ["ORDER_CREATED", "FAILED"] } },
    { $set: { status: "VERIFYING" } },
  ).exec();
  if (verificationClaim.modifiedCount !== 1) {
    throw new PublicShipmentBookingError("Payment confirmation is already in progress. Check the booking status in a moment.", 202, "PAYMENT_CONFIRMATION_IN_PROGRESS");
  }

  let gatewayPayment;
  try {
    gatewayPayment = await fetchRazorpayPayment(input.razorpayPaymentId);
  } catch (error) {
    payment.status = "ORDER_CREATED";
    payment.failureCode = "PAYMENT_LOOKUP_FAILED";
    payment.failureMessage = error instanceof Error ? error.message : "Gateway payment lookup failed.";
    await payment.save();
    await notifyPaymentIssue(payment, "Public payment confirmation delayed", `${payment.razorpayOrderId} could not be verified with Razorpay. No shipment or refund was created; webhook recovery remains enabled.`);
    throw error;
  }
  if (gatewayPayment.order_id !== payment.razorpayOrderId || gatewayPayment.amount !== payment.amountMinor || gatewayPayment.currency !== payment.currency) {
    payment.status = "PAYMENT_REVIEW_REQUIRED";
    payment.razorpayPaymentId = gatewayPayment.id;
    payment.failureCode = "PAYMENT_MISMATCH";
    payment.failureMessage = "Gateway payment did not match the stored order, amount, or currency.";
    await payment.save();
    await PublicShipmentBooking.updateOne({ _id: payment.bookingId }, { $set: { state: "PAYMENT_REVIEW_REQUIRED" } }).exec();
    await notifyPaymentIssue(payment, "Public payment mismatch", `${payment.razorpayOrderId} needs Finance and Operations review. No shipment or refund was created automatically.`);
    throw new PublicShipmentBookingError("Payment needs manual verification. Swiftline has been notified; do not pay again.", 202, "PAYMENT_REVIEW_REQUIRED");
  }
  let captured;
  try {
    captured = gatewayPayment.status === "captured"
      ? gatewayPayment
      : await captureRazorpayPayment({ paymentId: gatewayPayment.id, amountMinor: payment.amountMinor, currency: "INR" });
  } catch (error) {
    payment.status = "ORDER_CREATED";
    payment.failureCode = "PAYMENT_CAPTURE_FAILED";
    payment.failureMessage = error instanceof Error ? error.message : "Gateway payment capture failed.";
    await payment.save();
    await notifyPaymentIssue(payment, "Public payment capture delayed", `${payment.razorpayOrderId} could not be confirmed as captured. No shipment or refund was created; webhook recovery remains enabled.`);
    throw error;
  }
  payment.razorpayPaymentId = captured.id;
  payment.status = "CAPTURED";
  payment.capturedAt = payment.capturedAt ?? new Date();
  await payment.save();
  await notifyBranchOperationsStaff(payment.branchId, {
    type: "PAYMENT_CONFIRMED",
    title: "Public booking payment received",
    message: `Payment for ${payment.amountMinor / 100} INR was captured. Shipment fulfilment is in progress.`,
    href: `/dashboard/shipments/${String(payment.shipmentDraftId)}`,
    idempotencyKey: `PUBLIC_PAYMENT_CAPTURED:${String(payment._id)}`,
    metadata: { publicShipmentPaymentId: payment._id, shipmentDraftId: payment.shipmentDraftId },
  }).catch((error) => console.error("Captured-payment notification could not be queued.", error));
  return fulfillCapturedPublicPayment(payment._id as mongoose.Types.ObjectId, input.rawStatusToken);
}

export async function applyCapturedPublicPaymentWebhook(input: { orderId: string; paymentId: string; amountMinor: number; currency: string }) {
  const payment = await PublicShipmentPayment.findOne({ razorpayOrderId: input.orderId }).exec();
  if (!payment) return false;
  if (payment.amountMinor !== input.amountMinor || payment.currency !== input.currency) {
    payment.status = "PAYMENT_REVIEW_REQUIRED";
    payment.razorpayPaymentId = input.paymentId;
    payment.failureCode = "PAYMENT_MISMATCH";
    payment.failureMessage = "Webhook amount or currency mismatch.";
    await payment.save();
    await PublicShipmentBooking.updateOne({ _id: payment.bookingId }, { $set: { state: "PAYMENT_REVIEW_REQUIRED" } }).exec();
    await notifyPaymentIssue(payment, "Public payment webhook mismatch", `${input.orderId} needs Finance and Operations review.`);
    throw new PublicShipmentBookingError("Payment amount or currency mismatch.", 400, "PAYMENT_MISMATCH");
  }
  if (["FULFILLING", "BOOKED", "PAYMENT_REVIEW_REQUIRED", "REVIEW_REQUIRED", "REFUND_PENDING", "REFUNDED"].includes(payment.status)) return true;
  payment.razorpayPaymentId = input.paymentId;
  payment.status = "CAPTURED";
  payment.capturedAt = payment.capturedAt ?? new Date();
  await payment.save();
  // Webhooks do not possess the browser token. Fulfilment still completes; the
  // customer can use their existing cookie and the email omits a token link on
  // this recovery path rather than persisting a plaintext credential.
  await fulfillCapturedPublicPayment(payment._id as mongoose.Types.ObjectId, crypto.randomBytes(32).toString("base64url"));
  return true;
}

export async function markPublicPaymentFailed(orderId: string, message: string) {
  const payment = await PublicShipmentPayment.findOneAndUpdate(
    { razorpayOrderId: orderId, status: { $nin: ["CAPTURED", "FULFILLING", "BOOKED", "REVIEW_REQUIRED", "REFUND_PENDING", "REFUNDED"] } },
    { $set: { status: "FAILED", failureMessage: message } },
    { returnDocument: "after" },
  ).exec();
  if (!payment) return false;
  await PublicShipmentBooking.updateOne({ _id: payment.bookingId }, { $set: { state: "QUOTED" } }).exec();
  return true;
}

export function serializePublicBooking(booking: InstanceType<typeof PublicShipmentBooking>, draft?: InstanceType<typeof ShipmentDraft> | null) {
  return {
    reference: booking.publicReference,
    state: booking.state,
    revision: booking.revision,
    quote: booking.quoteAmountMinor ? {
      amountMinor: booking.quoteAmountMinor,
      currency: booking.quoteCurrency,
      pricingHash: booking.pricingHash,
      expiresAt: booking.quoteExpiresAt,
    } : null,
    shipment: booking.swiftlineTrackingNumber ? {
      trackingNumber: booking.swiftlineTrackingNumber,
      invoiceUrl: "/api/v1/public/shipment-bookings/status/invoice",
      labelsUrl: "/api/v1/public/shipment-bookings/status/labels",
    } : null,
    sender: draft ? {
      name: draft.consignorAddress.companyName || draft.consignorAddress.contactName,
      email: draft.consignorAddress.email,
      aadhaarNumber: maskAadhaarNumber(draft.consignorAddress.aadhaarNumber),
    } : null,
  };
}
