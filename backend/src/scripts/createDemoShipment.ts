import mongoose from "mongoose";
import { assertNonProductionEnvironment } from "./migrationSafety.js";
import { env } from "../config/env.js";
import { Branch } from "../models/branch.model.js";
import { BusinessAccount, type IBusinessAccount } from "../models/businessAccount.model.js";
import { BusinessAccountMember } from "../models/businessAccountMember.model.js";
import { BusinessCreditAccount } from "../models/businessCreditAccount.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { ShipmentChargeVerification } from "../models/shipmentChargeVerification.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import {
  ShipmentEvent,
  shipmentMilestoneKey,
  type ShipmentEventStatus
} from "../models/shipmentEvent.model.js";
import { User } from "../models/user.model.js";
import {
  closeCreditBillingCycle,
  getPreviousClosedBillingPeriod
} from "../services/creditBillingCycle.service.js";
import {
  completeShipmentBookingCharge,
  reserveShipmentBookingCharge
} from "../services/shipmentBookingBilling.service.js";
import { buildShipmentBookingSnapshot } from "../services/shipmentBookingSnapshot.service.js";
import { calculateShipmentPricingEstimate } from "../services/shipmentPricing.service.js";
import { ensureShipmentInvoiceForDraft, markShipmentChargeFinalized } from "../services/shipmentInvoice.service.js";
import { storeGeneratedLabel } from "../services/dpdShipment.service.js";
import { SWIFTLINE_SERVICE_CODE } from "../services/shipmentPayload.service.js";
import {
  renderSwiftlineLabelPdf,
  type ShipmentLabelData
} from "../services/shipmentLabelPdf.service.js";

const demoShipmentName = process.env.DEMO_SHIPMENT_NAME || "TESTING SHIPMENT NOT DEMO";
const demoInvoiceNumber = process.env.DEMO_INVOICE_NUMBER || "TESTING-INV-0001";
const demoShipmentReference = process.env.DEMO_SHIPMENT_REFERENCE || demoShipmentName;
const finalizeForBilling = process.env.DEMO_FINALIZE_FOR_BILLING === "true";
const closeBillingCycle = process.env.DEMO_CLOSE_BILLING_CYCLE === "true";
const smallShipment = process.env.DEMO_SMALL_SHIPMENT === "true";
const nonBillableTest = process.env.DEMO_NON_BILLABLE_TEST === "true";
const destinationCode = (process.env.DEMO_DESTINATION_COUNTRY_CODE || "GB").trim().toUpperCase();
const smallShipmentWeightKg = Number(process.env.DEMO_WEIGHT_KG || 5);
const billingClosingDate = process.env.DEMO_BILLING_CLOSING_DATE
  ? new Date(process.env.DEMO_BILLING_CLOSING_DATE)
  : null;
const defaultEventStatuses: ShipmentEventStatus[] = [
  "SHIPMENT_BOOKED",
  "PARCEL_COLLECTED",
  "WAREHOUSE_SCAN_IN",
  "EXPORT_CUSTOMS_CLEARED"
];

function mongoUri() {
  const separator = env.MONGODB_URI.includes("?") ? "&" : "?";
  return env.MONGODB_URI.includes("retryWrites=")
    ? env.MONGODB_URI
    : `${env.MONGODB_URI}${separator}retryWrites=false`;
}

function objectIdFromOptional(value?: string) {
  return value && mongoose.Types.ObjectId.isValid(value)
    ? new mongoose.Types.ObjectId(value)
    : null;
}

function getSeedEventStatuses() {
  const statuses = process.env.DEMO_EVENT_STATUSES?.split(",")
    .map((status) => status.trim())
    .filter(Boolean) as ShipmentEventStatus[] | undefined;

  return statuses?.length ? statuses : defaultEventStatuses;
}

function parcelSnapshot(parcels: InstanceType<typeof ShipmentDraft>["parcelList"]) {
  return parcels.map((parcel) => ({
    sequence: parcel.sequence,
    weightKg: parcel.weightKg,
    lengthCm: parcel.lengthCm ?? null,
    widthCm: parcel.widthCm ?? null,
    heightCm: parcel.heightCm ?? null,
    shipmentContentType: parcel.shipmentContentType,
    contentsDescription: parcel.contentsDescription,
    shipmentReference1: parcel.shipmentReference1 ?? "",
    shipmentReference2: parcel.shipmentReference2 ?? ""
  }));
}

async function findBusinessAccount() {
  const requestedId = process.env.DEMO_BUSINESS_ACCOUNT_ID || process.env.DEMO_ACCOUNT_ID;
  const query: mongoose.QueryFilter<IBusinessAccount> = requestedId && mongoose.Types.ObjectId.isValid(requestedId)
    ? { _id: new mongoose.Types.ObjectId(requestedId) }
    : requestedId
      ? { accountId: requestedId }
      : {
          status: { $in: ["active", "approved"] },
          assignedBranch: { $ne: null }
        };

  return BusinessAccount.findOne(query).sort({ updatedAt: -1 }).exec();
}

async function resolveActor(accountId: mongoose.Types.ObjectId, fallbackUserId: mongoose.Types.ObjectId) {
  const member = await BusinessAccountMember.findOne({
    businessAccount: accountId,
    status: "active"
  })
    .sort({ updatedAt: -1 })
    .exec();

  if (member?.user) return member.user;

  const admin = await User.findOne({ role: "admin", userStatus: "active" }).sort({ updatedAt: -1 }).exec();
  return admin?._id as mongoose.Types.ObjectId | undefined ?? fallbackUserId;
}

async function main() {
  assertNonProductionEnvironment(env.NODE_ENV, "Demo shipment creation");
  if (billingClosingDate && Number.isNaN(billingClosingDate.getTime())) {
    throw new Error("DEMO_BILLING_CLOSING_DATE must be a valid ISO date.");
  }
  if (closeBillingCycle && !finalizeForBilling) {
    throw new Error("DEMO_CLOSE_BILLING_CYCLE requires DEMO_FINALIZE_FOR_BILLING=true.");
  }
  if (!Number.isFinite(smallShipmentWeightKg) || smallShipmentWeightKg <= 0) {
    throw new Error("DEMO_WEIGHT_KG must be a positive number.");
  }

  await mongoose.connect(mongoUri(), { family: 4, retryWrites: false });

  const account = await findBusinessAccount();
  if (!account) {
    throw new Error("No approved/active business account with an assigned branch was found. Set DEMO_BUSINESS_ACCOUNT_ID to target one.");
  }

  const branchId = objectIdFromOptional(process.env.DEMO_BRANCH_ID)
    ?? account.assignedBranch as mongoose.Types.ObjectId | null;
  if (!branchId) {
    throw new Error("The selected business account has no assigned branch. Set DEMO_BRANCH_ID or assign a branch first.");
  }

  if (finalizeForBilling) {
    const [creditAccount, branch] = await Promise.all([
      BusinessCreditAccount.findOne({ businessAccountId: account._id }).exec(),
      Branch.findById(branchId).exec()
    ]);
    if (!creditAccount) throw new Error("The selected business account has no credit account.");
    if (!account.company.gstin) throw new Error("Customer GSTIN is required for a billable statement test shipment.");
    if (!branch?.gstin) throw new Error("The assigned branch GSTIN is required for a billable statement test shipment.");
  }

  const actorId = await resolveActor(account._id as mongoose.Types.ObjectId, (account.createdBy as mongoose.Types.ObjectId | null) ?? undefined as any);
  const now = new Date();

  const destinationPresets: Record<string, {
    countryName: string;
    townOrCity: string;
    county: string;
    postcode: string;
    mobileCountryCode: string;
    mobileNumber: string;
    addressLine1: string;
  }> = {
    GB: { countryName: "United Kingdom", townOrCity: "London", county: "Greater London", postcode: "E16 1XL", mobileCountryCode: "+44", mobileNumber: "7700900456", addressLine1: "Warehouse Gate 3, Royal Victoria Dock" },
    US: { countryName: "United States", townOrCity: "New York", county: "New York", postcode: "10001", mobileCountryCode: "+1", mobileNumber: "2025550123", addressLine1: "350 Fifth Avenue" },
    CA: { countryName: "Canada", townOrCity: "Toronto", county: "Ontario", postcode: "M5V 2T6", mobileCountryCode: "+1", mobileNumber: "4165550123", addressLine1: "290 Bremner Boulevard" },
    DE: { countryName: "Germany", townOrCity: "Frankfurt", county: "Hesse", postcode: "60311", mobileCountryCode: "+49", mobileNumber: "15123456789", addressLine1: "10 Test Logistics Strasse" }
  };
  const destination = destinationPresets[destinationCode];
  if (!destination) throw new Error(`Unsupported DEMO_DESTINATION_COUNTRY_CODE: ${destinationCode}`);

  const destinationAddress = {
    companyName: demoShipmentName,
    contactName: "Avery Testing",
    email: `testing.shipment+${destinationCode.toLowerCase()}@example.com`,
    mobileCountryCode: destination.mobileCountryCode,
    mobileNumber: destination.mobileNumber,
    countryCode: destinationCode,
    countryName: destination.countryName,
    postcode: destination.postcode,
    addressLine1: destination.addressLine1,
    addressLine2: "Testing Delivery Suite",
    townOrCity: destination.townOrCity,
    county: destination.county,
    deliveryInstructions: "Testing shipment only. Call before delivery and collect signature at reception."
  };

  const shipmentDraft = await ShipmentDraft.findOneAndUpdate(
    {
      businessAccountId: account._id,
      branchId,
      creationSource: "MANUAL",
      "parcelList.shipmentReference1": demoShipmentReference
    },
    {
      $set: {
        creationSource: "MANUAL",
        businessAccountId: account._id,
        branchId,
        sender: {
          companyName: account.company.companyName,
          contactName: `${account.contact.firstName} ${account.contact.lastName}`.trim(),
          email: account.contact.email,
          countryCode: account.contact.countryCode,
          mobileNumber: account.contact.mobileNumber
        },
        consignorAddress: {
          companyName: account.company.companyName,
          contactName: `${account.contact.firstName} ${account.contact.lastName}`.trim() || "Demo Consignor",
          email: `consignor.${account.contact.email}`,
          mobileCountryCode: "+91",
          mobileNumber: "9876543210",
          // Valid Verhoeff check digit for the demo sender.
          aadhaarNumber: "234567890124",
          countryCode: "IN",
          countryName: "India",
          postcode: "110001",
          addressLine1: "12 Connaught Place",
          townOrCity: "New Delhi",
          county: "Delhi"
        },
        kycDocuments: {
          aadhaar: { type: "aadhaar", documentLabel: "Aadhaar Card", originalName: "aadhaar.pdf", storageKey: "shipments/demo-draft/kyc/demo-aadhaar.pdf", mimeType: "application/pdf", size: 1024, uploadedAt: new Date() },
          pan: { type: "pan", documentLabel: "PAN Card", originalName: "pan.pdf", storageKey: "shipments/demo-draft/kyc/demo-pan.pdf", mimeType: "application/pdf", size: 1024, uploadedAt: new Date() }
        },
        consigneeEnteredAddress: destinationAddress,
        consigneeSelectedAddress: destinationAddress,
        consigneeValidatedAddress: destinationAddress,
        googlePlaceId: "demo-place-id",
        addressValidationStatus: "VALIDATED",
        addressValidationResult: { demo: true, verdict: "validated" },
        parcelList: smallShipment ? [
          {
            sequence: 1,
            weightKg: smallShipmentWeightKg,
            lengthCm: 10,
            widthCm: 10,
            heightCm: 10,
            shipmentContentType: "PARCEL",
            items: [{ description: "Testing documents", hsnCode: "49019900", unitType: "PCS", quantity: 2, unitRate: 500 }],
            contentsDescription: "Grace-period booking test documents",
            shipmentReference1: demoShipmentReference,
            shipmentReference2: demoInvoiceNumber
          }
        ] : [
          {
            sequence: 1,
            weightKg: 10,
            lengthCm: 45,
            widthCm: 35,
            heightCm: 30,
            shipmentContentType: "PARCEL",
            items: [{ description: "Testing apparel samples", hsnCode: "61091000", unitType: "PCS", quantity: 2, unitRate: 500 }],
            contentsDescription: "Testing shipment apparel samples",
            shipmentReference1: demoShipmentReference,
            shipmentReference2: demoInvoiceNumber
          },
          {
            sequence: 2,
            weightKg: 6.5,
            lengthCm: 40,
            widthCm: 30,
            heightCm: 25,
            shipmentContentType: "MERCHANDISE",
            items: [{ description: "Testing packaged accessories", hsnCode: "42029900", unitType: "PCS", quantity: 3, unitRate: 250 }],
            contentsDescription: "Testing shipment packaged accessories",
            shipmentReference1: `${demoShipmentReference}-BOX-2`,
            shipmentReference2: demoInvoiceNumber
          }
        ],
        serviceType: "COURIER",
        serviceCode: SWIFTLINE_SERVICE_CODE,
        validationIssues: [],
        status: "READY_FOR_DPD",
        createdBy: actorId
      }
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  ).exec();

  const existingDpdShipment = await DpdShipment.findOne({ shipmentDraftId: shipmentDraft._id }).lean().exec();
  if (existingDpdShipment?.paymentSource === "TEST") {
    throw new Error(
      "This shipment reference belongs to a legacy test-billing shipment. Use a new DEMO_INVOICE_NUMBER and DEMO_SHIPMENT_REFERENCE."
    );
  }

  // The carrier response is mocked, but customer billing follows the same
  // reservation and conversion services used by a normal shipment booking.
  const reservationResult = nonBillableTest
    ? null
    : await reserveShipmentBookingCharge({
      draft: shipmentDraft,
      createdBy: actorId,
      bookingAttemptId: `DEMO-${String(shipmentDraft._id)}`
    });

  const dpdShipment = await DpdShipment.findOneAndUpdate(
    { shipmentDraftId: shipmentDraft._id },
    {
      $set: {
        idempotencyKey: `demo-dashboard-shipment:${String(shipmentDraft._id)}`,
        dpdShipmentId: `TEST-DPD-${String(shipmentDraft._id).slice(-8).toUpperCase()}`,
        dpdTransactionId: `TEST-TXN-${String(shipmentDraft._id).slice(-8).toUpperCase()}`,
        parcelNumbers: shipmentDraft.parcelList.map((parcel) => `TEST-PARCEL-${String(parcel.sequence).padStart(2, "0")}`),
        serviceCode: shipmentDraft.serviceCode,
        requestSnapshot: {
          seededTestingShipment: true,
          shipmentName: demoShipmentName,
          shipmentDraftId: shipmentDraft._id,
          destinationAddress,
          parcelList: shipmentDraft.parcelList,
          serviceType: shipmentDraft.serviceType,
          serviceCode: shipmentDraft.serviceCode
        },
        responseSnapshot: {
          seededTestingShipment: true,
          status: "LABEL_RECEIVED",
          labelCount: shipmentDraft.parcelList.length
        },
        paymentSource: nonBillableTest ? "TEST" : "BUSINESS_ACCOUNT",
        status: "LABEL_RECEIVED"
      }
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  ).exec();

  // The shipment record claims LABEL_RECEIVED, so it needs actual labels behind
  // it- without these the portal shows a booked shipment with nothing to
  // download, and there is no way to check a label change.
  const swiftlineTrackingNumber = `SLCDEMO${String(shipmentDraft._id).slice(-6).toUpperCase()}`;

  for (const [index, parcel] of shipmentDraft.parcelList.entries()) {
    const parcelSuffix = String(index + 1).padStart(2, "0");
    const labelData: ShipmentLabelData = {
      parcelNumber: `${swiftlineTrackingNumber}-${parcelSuffix}`,
      parcelIndex: index,
      parcelCount: shipmentDraft.parcelList.length,
      weightKg: parcel.weightKg ?? 1,
      generatedAt: new Date(),
      origin: {
        stationCode: swiftlineTrackingNumber.slice(3, 6),
        city: "New Delhi"
      },
      destination: {
        city: destinationAddress.townOrCity,
        countryCode: destinationAddress.countryCode,
        countryName: destinationAddress.countryName
      },
      consignee: {
        name: destinationAddress.companyName,
        contactName: destinationAddress.contactName,
        addressLines: [destinationAddress.addressLine1, destinationAddress.addressLine2, destinationAddress.townOrCity],
        postcode: destinationAddress.postcode,
        countryCode: destinationAddress.countryCode,
        countryName: destinationAddress.countryName,
        email: destinationAddress.email
      }
    };

    await storeGeneratedLabel({
      dpdShipmentId: dpdShipment._id as mongoose.Types.ObjectId,
      parcelNumber: labelData.parcelNumber,
      buffer: await renderSwiftlineLabelPdf(labelData)
    });
  }

  // Without a booking snapshot the shipment is not manifest-eligible and the
  // invoice falls back to the live account instead of the values accepted at
  // booking, so a seeded shipment behaves unlike a real one. Built through the
  // same service a genuine booking uses.
  const branchDocument = await Branch.findById(branchId).exec();
  if (!branchDocument) throw new Error("The demo branch could not be loaded.");
  const demoPricing = await calculateShipmentPricingEstimate({
    businessAccountId: shipmentDraft.businessAccountId,
    countryCode: destinationAddress.countryCode,
    serviceType: shipmentDraft.serviceType,
    parcels: shipmentDraft.parcelList,
    csbType: shipmentDraft.csbType
  });
  if (demoPricing.missingRate) {
    throw new Error(`No rate card covers ${destinationAddress.countryCode} / ${shipmentDraft.serviceType}.`);
  }

  const legacyReservation = reservationResult && "reservation" in reservationResult
    ? reservationResult.reservation
    : null;
  const demoSnapshot = buildShipmentBookingSnapshot({
    draft: shipmentDraft,
    account,
    branch: branchDocument,
    pricing: demoPricing,
    serviceCode: shipmentDraft.serviceCode,
    bookedAt: now,
    swiftlineTrackingNumber,
    carrierShipmentId: dpdShipment.dpdShipmentId ?? "",
    carrierTransactionId: dpdShipment.dpdTransactionId ?? "",
    carrierParcelNumbers: [],
    advanceAmountMinor: legacyReservation?.advanceAmountMinor
      ?? (reservationResult && "funding" in reservationResult ? Math.round(demoPricing.totalAmount * 100) : 0),
    creditAmountMinor: legacyReservation?.creditAmountMinor
      ?? (reservationResult && "funding" in reservationResult ? 0 : Math.round(demoPricing.totalAmount * 100))
  });
  dpdShipment.bookingSnapshot = demoSnapshot as never;
  dpdShipment.currentShipmentSnapshot = demoSnapshot as never;
  dpdShipment.swiftlineTrackingNumber = swiftlineTrackingNumber;
  await dpdShipment.save();

  shipmentDraft.bookingState = "BOOKED";
  await shipmentDraft.save();

  if (!nonBillableTest) {
    await completeShipmentBookingCharge({
      shipmentDraftId: shipmentDraft._id as mongoose.Types.ObjectId,
      dpdShipmentId: dpdShipment._id as mongoose.Types.ObjectId,
      createdBy: actorId
    });
  }

  const eventStatuses = getSeedEventStatuses();

  await Promise.all(eventStatuses.map((status, index) => ShipmentEvent.findOneAndUpdate(
    {
      shipmentDraftId: shipmentDraft._id,
      status
    },
    {
      $set: {
        dpdShipmentId: dpdShipment._id,
        milestoneKey: shipmentMilestoneKey(status),
        note: "",
        customerVisible: true,
        createdBy: actorId,
        eventAt: new Date(now.getTime() + index * 60_000)
      }
    },
    { returnDocument: "after", upsert: true, setDefaultsOnInsert: true }
  ).exec()));

  const shipmentInvoice = await ensureShipmentInvoiceForDraft({
    shipmentDraftId: shipmentDraft._id as mongoose.Types.ObjectId,
    dpdShipmentId: dpdShipment._id as mongoose.Types.ObjectId,
    userId: actorId
  });

  if (finalizeForBilling) {
    const creditAccount = await BusinessCreditAccount.findOne({ businessAccountId: account._id }).exec();
    if (!creditAccount) throw new Error("The selected business account has no credit account.");
    if (shipmentInvoice.status !== "ISSUED") {
      throw new Error(`The shipment invoice cannot be billed: ${shipmentInvoice.validationWarnings.join(" ")}`);
    }

    const closingDate = billingClosingDate ?? now;
    const period = getPreviousClosedBillingPeriod(creditAccount.billingCycle, closingDate);
    const verifiedAt = new Date(period.start.getTime() + 12 * 60 * 60 * 1000);
    const parcels = parcelSnapshot(shipmentDraft.parcelList);
    const existingVerification = await ShipmentChargeVerification.findOne({
      shipmentDraftId: shipmentDraft._id
    }).exec();

    if (!existingVerification) {
      await ShipmentChargeVerification.create({
        shipmentDraftId: shipmentDraft._id,
        dpdShipmentId: dpdShipment._id,
        businessAccountId: account._id,
        branchId,
        previousParcelList: parcels,
        verifiedParcelList: parcels,
        previousPricingSnapshot: shipmentInvoice.pricingSnapshot,
        verifiedPricingSnapshot: shipmentInvoice.pricingSnapshot,
        previousAmountMinor: shipmentInvoice.totalAmountMinor,
        verifiedAmountMinor: shipmentInvoice.totalAmountMinor,
        billingMode: "BUSINESS_ACCOUNT",
        billingAdjustment: {},
        invoiceNumber: shipmentInvoice.invoiceNumber,
        invoiceRevision: shipmentInvoice.revision,
        note: "Development fixture for completed-cycle statement testing.",
        verifiedBy: actorId,
        verifiedAt
      });
    }

    // What actually puts the invoice on a statement. The verification above is
    // the audit record of the re-weigh; it stopped doubling as the billing
    // signal when final weight verification became optional.
    await markShipmentChargeFinalized({
      shipmentDraftId: shipmentDraft._id as mongoose.Types.ObjectId,
      finalizedAt: verifiedAt
    });

    console.log(`Billing verification: ${verifiedAt.toISOString()}`);
    console.log(`Completed period: ${period.start.toISOString()} to ${period.end.toISOString()}`);

    if (closeBillingCycle) {
      const result = await closeCreditBillingCycle({
        businessAccountId: account._id as mongoose.Types.ObjectId,
        closingDate,
        createdBy: actorId
      });
      console.log(`Billing statement: ${result.statement?.statementNumber ?? "No eligible charges"}`);
      console.log(`Statement amount: INR ${((result.statement?.totalAmountMinor ?? 0) / 100).toFixed(2)}`);
    }
  }

  console.log("Testing shipment ready");
  console.log(`Name: ${demoShipmentName}`);
  console.log(`Account: ${account.accountId} (${String(account._id)})`);
  console.log(`Branch: ${String(branchId)}`);
  console.log(`Shipment draft: ${String(shipmentDraft._id)}`);
  console.log(`DPD shipment: ${String(dpdShipment._id)}`);
  console.log(`Swiftline AWB: ${swiftlineTrackingNumber}`);
  console.log(`Destination: ${destination.countryName} (${destinationCode})`);
  console.log(`Billing: ${nonBillableTest ? "TEST (non-billable)" : "BUSINESS_ACCOUNT"}`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
