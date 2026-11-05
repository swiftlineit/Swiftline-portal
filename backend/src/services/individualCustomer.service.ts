import mongoose from "mongoose";
import { BusinessAccount } from "../models/businessAccount.model.js";
import { getSwiftlineTenantId } from "./swiftlineTenant.service.js";
import { CounterPayment, type CounterPaymentMethod } from "../models/counterPayment.model.js";
import { getTenantContext } from "./tenantScope.service.js";

/**
 * Individual (walk-in) shipments are booked for people who have no company, no
 * KYC file and no portal login. The shipment chain- draft, invoice, shipment
 * manifest and operations consignment- all require a `businessAccountId`, so
 * every individual shipment is booked against one tenant-local system account.
 *
 * A record per customer is deliberately NOT created: `BusinessAccount` carries
 * unique indexes over `contact.email` and `(contact.countryCode,
 * contact.mobileNumber)` for every live account, so walk-ins with no email would
 * collide with each other on "" and a walk-in sharing a phone number with a real
 * business account would be rejected outright. The customer's own identity lives
 * on the shipment draft instead (`consignorAddress` and `kycDocuments`), which is
 * where the booking snapshot and the invoice bill-to already read it from.
 *
 * Reserved identity values satisfy the account model's required fields and
 * unique indexes. Operator values are tenant-qualified for compatibility with
 * legacy global indexes. They are never shown to customers: sentinels are
 * filtered out of normal account listings via `excludeSentinel`.
 */
export const INDIVIDUAL_SENTINEL_ACCOUNT_ID = "BA-SYSTEM-INDIVIDUAL";
const SENTINEL_EMAIL = "individual.customers@system.swiftline.internal";
const SENTINEL_COUNTRY_CODE = "+91";
const SENTINEL_MOBILE = "0000000000";

export function getIndividualSentinelIdentity(
  tenantId: mongoose.Types.ObjectId,
  tenantKind: "SWIFTLINE" | "OPERATOR"
) {
  if (tenantKind === "SWIFTLINE") {
    return {
      accountId: INDIVIDUAL_SENTINEL_ACCOUNT_ID,
      email: SENTINEL_EMAIL,
      countryCode: SENTINEL_COUNTRY_CODE,
      mobileNumber: SENTINEL_MOBILE
    };
  }

  // Old installations can still have global unique indexes until the explicit
  // tenant-index migration runs. Namespace every legacy unique-key field so an
  // operator's bookkeeping account cannot collide with Swiftline or another
  // operator during that transition.
  const tenantKey = tenantId.toHexString().toLowerCase();
  return {
    accountId: `${INDIVIDUAL_SENTINEL_ACCOUNT_ID}-${tenantKey.toUpperCase()}`,
    email: `individual.customers+${tenantKey}@system.swiftline.internal`,
    countryCode: SENTINEL_COUNTRY_CODE,
    mobileNumber: `SYSTEM-${tenantKey.toUpperCase()}`
  };
}

/**
 * Adds the sentinel exclusion to a business account query filter. Use this on
 * every path that lists or counts accounts for a human- the sentinel is
 * bookkeeping, not a customer, and must never appear in a list, a search result
 * or a dashboard count.
 *
 * Written as `$ne` rather than `{ accountKind: "BUSINESS" }` so accounts created
 * before `accountKind` existed (no such field) are still matched.
 */
export function excludeSentinel(filters: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...filters, accountKind: { $ne: "INDIVIDUAL_SENTINEL" as const } };
}

/**
 * Records money taken from a walk-in customer for a shipment.
 *
 * Idempotent per shipment: a retried booking must not double-count the branch's
 * takings, so an existing collection for the draft is updated rather than added
 * to. Refunds are separate rows and are never touched by this.
 */
export async function recordCounterCollection(input: {
  shipmentDraftId: mongoose.Types.ObjectId;
  branchId: mongoose.Types.ObjectId;
  amountMinor: number;
  payment: { method: CounterPaymentMethod; reference?: string; note?: string };
  recordedBy: mongoose.Types.ObjectId;
}) {
  return CounterPayment.findOneAndUpdate(
    { shipmentDraftId: input.shipmentDraftId, direction: "COLLECTED" },
    {
      shipmentDraftId: input.shipmentDraftId,
      branchId: input.branchId,
      direction: "COLLECTED",
      amountMinor: input.amountMinor,
      method: input.payment.method,
      reference: input.payment.reference ?? "",
      note: input.payment.note ?? "",
      recordedBy: input.recordedBy,
      recordedAt: new Date()
    },
    { returnDocument: "after", upsert: true, runValidators: true, setDefaultsOnInsert: true }
  ).exec();
}

/** True when this account is the individual-shipment sentinel. */
export function isIndividualSentinel(account: { accountKind?: string } | null | undefined) {
  return account?.accountKind === "INDIVIDUAL_SENTINEL";
}

/**
 * Returns the sentinel account, creating it on first use. Safe to call
 * concurrently: the tenant-qualified reserved account ID makes the upsert
 * idempotent without relying on the old global account ID index having already
 * been removed.
 *
 * `createdBy` is the member booking the first individual shipment; it is only
 * recorded because the schema requires it.
 */
export async function getOrCreateIndividualSentinel(createdBy: mongoose.Types.ObjectId) {
  const tenantContext = getTenantContext();
  const tenantId = tenantContext?.tenantId ?? await getSwiftlineTenantId();
  const tenantKind = tenantContext?.kind ?? "SWIFTLINE";
  const identity = getIndividualSentinelIdentity(tenantId, tenantKind);
  const findSentinel = () => BusinessAccount.findOne({
    tenantId,
    accountKind: "INDIVIDUAL_SENTINEL"
  }).exec();
  const existing = await findSentinel();
  if (existing) {
    if (!existing.tenantId || !existing.tenantId.equals(tenantId)) {
      throw new Error("The individual customer account belongs to a different tenant.");
    }
    if (existing.rateCardBand !== "BAND_D" || !existing.company.noCompany) {
      existing.rateCardBand = "BAND_D";
      existing.company.noCompany = true;
    }
    if (existing.isModified()) await existing.save();
    return existing;
  }

  try {
    await BusinessAccount.updateOne(
      { tenantId, accountId: identity.accountId },
      {
        $setOnInsert: {
          tenantId,
          accountId: identity.accountId,
          accountKind: "INDIVIDUAL_SENTINEL",
          rateCardBand: "BAND_D",
          // Approved so it never enters the KYC queue, and left without an assigned
          // branch because it serves every branch. The individual draft flow skips
          // the branch-match check that ordinary accounts go through.
          status: "approved",
          contact: {
            title: "mr.",
            firstName: "Individual",
            lastName: "Customers",
            email: identity.email,
            mobileType: "office",
            countryCode: identity.countryCode,
            mobileNumber: identity.mobileNumber,
            jobTitle: "System",
            department: "System",
            shipmentTypes: ["international_courier", "international_cargo"]
          },
          company: {
            registrationCountry: "India",
            companyName: "Individual Customers",
            noCompany: true,
            // No GSTIN: each individual invoice takes its buyer details from the
            // shipment's own snapshot, never from this record.
            gstin: ""
          },
          createdBy
        }
      },
      { upsert: true }
    ).exec();
  } catch (error) {
    // Concurrent first use can race on the reserved account ID or one of the
    // legacy global identity indexes. Reuse the tenant's winner when present;
    // surface unrelated duplicate identities unchanged.
    if ((error as { code?: number })?.code !== 11000) throw error;
    const concurrentSentinel = await findSentinel();
    if (concurrentSentinel) return concurrentSentinel;
    throw error;
  }

  const sentinel = await findSentinel();
  if (!sentinel) throw new Error("The individual customer account could not be prepared.");
  return sentinel;
}
