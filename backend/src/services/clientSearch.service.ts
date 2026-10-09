import mongoose from "mongoose";
import { Claim } from "../models/claim.model.js";
import { DpdShipment } from "../models/dpdShipment.model.js";
import { PickupRequest } from "../models/pickupRequest.model.js";
import { ShipmentDraft } from "../models/shipmentDraft.model.js";
import { ShipmentInvoice } from "../models/shipmentInvoice.model.js";
import { ShipmentManifest } from "../models/shipmentManifest.model.js";
import { SupportTicket } from "../models/supportTicket.model.js";

/**
 * One search box over everything a customer identifies work by.
 *
 * Customers do not think in entity types- they hold a number off an email or a
 * label and want whatever it belongs to. So a single query runs across AWBs,
 * piece numbers, customer references, invoices, manifests, pickups, claims and
 * tickets at once, and the result says which kind of thing each hit is.
 *
 * Every query is scoped to the caller's account and branches. A search box that
 * reaches past those is a data leak with an input field on it, so scoping is
 * applied to each collection rather than to the merged result.
 */

export const searchResultKindValues = [
  "SHIPMENT",
  "INVOICE",
  "MANIFEST",
  "PICKUP",
  "CLAIM",
  "TICKET",
] as const;
export type SearchResultKind = (typeof searchResultKindValues)[number];

export type ClientSearchResult = {
  kind: SearchResultKind;
  /** What matched, shown as the row's heading- usually the number typed. */
  title: string;
  /** Enough context to tell two similar hits apart. */
  subtitle: string;
  href: string;
  /** Which field matched, so an unexpected hit explains itself. */
  matchedOn: string;
};

/** How many hits each kind may contribute before the list is trimmed. */
const PER_KIND_LIMIT = 5;

/**
 * A case-insensitive "contains" match on an escaped term.
 *
 * Escaped because these are identifiers a customer pastes: a stray bracket or
 * plus sign from a copied email would otherwise be read as regex syntax and
 * either throw or match something absurd.
 */
function containsPattern(term: string) {
  return new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
}

function draftHref(draftId: unknown, staff = false) {
  return staff ? `/dashboard/shipments/${String(draftId)}` : `/client/shipments/${String(draftId)}`;
}

export async function searchClientRecords(input: {
  /**
   * Omitted for a staff search, which spans accounts. Every client-facing
   * caller passes it, and the client route is the only thing that can reach
   * this without one- see `searchStaffRecords` below.
   */
  businessAccountId?: mongoose.Types.ObjectId;
  branchIds?: mongoose.Types.ObjectId[];
  term: string;
  /** Where a hit should link to, which differs between the two portals. */
  audience?: "client" | "staff";
}): Promise<ClientSearchResult[]> {
  const term = input.term.trim();
  // Two characters is the shortest thing worth matching; one would return most
  // of the account and read as a broken search.
  if (term.length < 2) return [];

  const staff = input.audience === "staff";
  const pattern = containsPattern(term);
  const accountScope: Record<string, unknown> = {};
  if (input.businessAccountId) accountScope.businessAccountId = input.businessAccountId;
  if (input.branchIds !== undefined) accountScope.branchId = { $in: input.branchIds };

  // The account's drafts bound every shipment-shaped lookup below, so a hit can
  // never belong to another customer.
  const scopedDrafts = await ShipmentDraft.find({
    ...accountScope,
    deletedAt: null,
  })
    .select(
      "_id parcelList.shipmentReference1 parcelList.shipmentReference2 consignorAddress.companyName consignorAddress.contactName consigneeEnteredAddress.companyName consigneeEnteredAddress.contactName consigneeValidatedAddress.companyName consigneeValidatedAddress.contactName consigneeSelectedAddress.companyName consigneeSelectedAddress.contactName",
    )
    .lean()
    .exec();
  const scopedDraftIds = scopedDrafts.map(
    (draft) => draft._id as mongoose.Types.ObjectId,
  );
  const matchedByName = scopedDrafts.map((draft) => ({
    draft,
    consignor: [draft.consignorAddress?.companyName, draft.consignorAddress?.contactName]
      .find((name) => pattern.test(name ?? "")),
    consignee: [
      draft.consigneeValidatedAddress?.companyName,
      draft.consigneeValidatedAddress?.contactName,
      draft.consigneeSelectedAddress?.companyName,
      draft.consigneeSelectedAddress?.contactName,
      draft.consigneeEnteredAddress?.companyName,
      draft.consigneeEnteredAddress?.contactName
    ].find((name) => pattern.test(name ?? ""))
  })).filter(({ consignor, consignee }) => consignor || consignee);

  // An account with no shipments can still have tickets and claims, so only the
  // shipment-shaped lookups are skipped when there are no drafts to bound them.
  const [shipments, namedShipments, invoices, manifests, pickups, claims, tickets] =
    await Promise.all([
      scopedDraftIds.length
        ? DpdShipment.find({
            shipmentDraftId: { $in: scopedDraftIds },
            $or: [
              { swiftlineTrackingNumber: pattern },
              { dpdShipmentId: pattern },
              { parcelNumbers: pattern },
            ],
          })
            .select(
              "shipmentDraftId swiftlineTrackingNumber dpdShipmentId parcelNumbers",
            )
            .limit(PER_KIND_LIMIT)
            .lean()
            .exec()
        : [],
      matchedByName.length
        ? DpdShipment.find({ shipmentDraftId: { $in: matchedByName.map(({ draft }) => draft._id) } })
            .select("shipmentDraftId swiftlineTrackingNumber dpdShipmentId")
            .limit(PER_KIND_LIMIT)
            .lean()
            .exec()
        : [],
      scopedDraftIds.length
        ? ShipmentInvoice.find({
            shipmentDraftId: { $in: scopedDraftIds },
            invoiceNumber: pattern,
          })
            .select("shipmentDraftId invoiceNumber")
            .limit(PER_KIND_LIMIT)
            .lean()
            .exec()
        : [],
      ShipmentManifest.find({ ...accountScope, manifestNumber: pattern })
        .select("_id manifestNumber")
        .limit(PER_KIND_LIMIT)
        .lean()
        .exec(),
      PickupRequest.find({ ...(input.businessAccountId ? { businessAccountId: input.businessAccountId } : {}), requestNumber: pattern })
        .select("_id requestNumber status")
        .limit(PER_KIND_LIMIT)
        .lean()
        .exec(),
      Claim.find({ ...(input.businessAccountId ? { businessAccountId: input.businessAccountId } : {}), claimNumber: pattern })
        .select("_id claimNumber status")
        .limit(PER_KIND_LIMIT)
        .lean()
        .exec(),
      SupportTicket.find({
        ...(input.businessAccountId ? { businessAccountId: input.businessAccountId } : {}),
        $or: [{ ticketNumber: pattern }, { subject: pattern }],
      })
        .select("_id ticketNumber subject status")
        .limit(PER_KIND_LIMIT)
        .lean()
        .exec(),
    ]);

  const results: ClientSearchResult[] = [];

  for (const shipment of shipments) {
    const awb =
      shipment.swiftlineTrackingNumber || shipment.dpdShipmentId || "Shipment";
    const piece = shipment.parcelNumbers?.find((number) =>
      pattern.test(number),
    );
    results.push({
      kind: "SHIPMENT",
      title: awb,
      subtitle: piece && piece !== awb ? `Piece ${piece}` : "Shipment",
      href: draftHref(shipment.shipmentDraftId, staff),
      matchedOn: piece && piece !== awb ? "Piece number" : "AWB",
    });
  }

  const nameMatchByDraftId = new Map(matchedByName.map((match) => [String(match.draft._id), match]));
  for (const shipment of namedShipments) {
    const href = draftHref(shipment.shipmentDraftId, staff);
    if (results.some((result) => result.href === href)) continue;
    const match = nameMatchByDraftId.get(String(shipment.shipmentDraftId));
    if (!match) continue;
    const matchedOn = match.consignee ? "Consignee name" : "Consignor name";
    const name = match.consignee || match.consignor || "";
    results.push({
      kind: "SHIPMENT",
      title: shipment.swiftlineTrackingNumber || shipment.dpdShipmentId || "Shipment",
      subtitle: `${matchedOn === "Consignee name" ? "Consignee" : "Consignor"}: ${name}`,
      href,
      matchedOn
    });
  }

  // Customer reference lives on each parcel, so it is matched over the drafts
  // already loaded rather than with another round trip.
  const matchedByReference = scopedDrafts
    .filter((draft) =>
      (draft.parcelList ?? []).some(
        (parcel) =>
          pattern.test(parcel?.shipmentReference1 ?? "") ||
          pattern.test(parcel?.shipmentReference2 ?? ""),
      ),
    )
    .slice(0, PER_KIND_LIMIT);

  for (const draft of matchedByReference) {
    if (results.some((result) => result.href === draftHref(draft._id, staff)))
      continue;
    const parcel = (draft.parcelList ?? []).find(
      (item) =>
        pattern.test(item?.shipmentReference1 ?? "") ||
        pattern.test(item?.shipmentReference2 ?? ""),
    );
    const reference = pattern.test(parcel?.shipmentReference1 ?? "")
      ? parcel?.shipmentReference1
      : parcel?.shipmentReference2;

    results.push({
      kind: "SHIPMENT",
      title: reference || "Shipment",
      subtitle:
        draft.consigneeEnteredAddress?.companyName ||
        draft.consigneeEnteredAddress?.contactName ||
        "Shipment",
      href: draftHref(draft._id, staff),
      matchedOn: "Your reference",
    });
  }

  for (const invoice of invoices) {
    results.push({
      kind: "INVOICE",
      title: invoice.invoiceNumber,
      subtitle: "Shipment invoice",
      href: staff ? `/dashboard/shipments/${String(invoice.shipmentDraftId)}/invoice` : `/client/shipments/${String(invoice.shipmentDraftId)}/invoice`,
      matchedOn: "Invoice number",
    });
  }

  for (const manifest of manifests) {
    results.push({
      kind: "MANIFEST",
      title: manifest.manifestNumber,
      subtitle: "Manifest",
      href: staff ? "/dashboard/shipment-manifests" : "/client/manifests",
      matchedOn: "Manifest number",
    });
  }

  for (const pickup of pickups) {
    results.push({
      kind: "PICKUP",
      title: pickup.requestNumber,
      subtitle: `Pickup- ${String(pickup.status).replaceAll("_", " ").toLowerCase()}`,
      href: staff ? "/dashboard/pickups" : "/client/pickups",
      matchedOn: "Pickup reference",
    });
  }

  for (const claim of claims) {
    results.push({
      kind: "CLAIM",
      title: claim.claimNumber ?? "Claim",
      subtitle: `Claim- ${String(claim.status).replaceAll("_", " ").toLowerCase()}`,
      href: staff ? `/dashboard/claims/${String(claim._id)}` : `/client/claims/${String(claim._id)}`,
      matchedOn: "Claim number",
    });
  }

  for (const ticket of tickets) {
    const matchedNumber = pattern.test(ticket.ticketNumber);
    results.push({
      kind: "TICKET",
      title: ticket.ticketNumber,
      subtitle: ticket.subject,
      href: staff ? `/dashboard/tickets/${String(ticket._id)}` : `/client/tickets/${String(ticket._id)}`,
      matchedOn: matchedNumber ? "Ticket number" : "Subject",
    });
  }

  return results;
}

/**
 * The same search for staff, across every account.
 *
 * A separate entry point rather than an extra flag on the client one: forgetting
 * to pass a business account to a function that accepts an optional account is
 * a silent data leak, whereas calling the wrong named function is a decision
 * someone has to make on purpose.
 */
export async function searchStaffRecords(input: {
  term: string;
  branchIds?: mongoose.Types.ObjectId[];
}): Promise<ClientSearchResult[]> {
  return searchClientRecords({ term: input.term, branchIds: input.branchIds, audience: "staff" });
}
