/**
 * Proof of delivery, gathered in one place.
 *
 * POD already existed per shipment, reachable only by opening that shipment.
 * A customer reconciling a month of deliveries, or answering a supplier asking
 * "did this arrive", had no way to see them together. This is the list behind
 * the POD Centre, plus the loader the merged PDF and the email share.
 *
 * Only VERIFIED revisions are ever returned. A POD under review is Swiftline's
 * working document, and handing a customer one that is later rejected would
 * be worse than making them wait.
 */
import mongoose from "mongoose";
import { DeliveryAssignment, PodRevision } from "../../models/pod.model.js";
import { DpdShipment } from "../../models/dpdShipment.model.js";
import { ShipmentDraft } from "../../models/shipmentDraft.model.js";
import type { ClientAccountBranchScope } from "../../utils/clientScope.js";

export type PodCentreFilter = {
  accountScopes: ClientAccountBranchScope[];
  /** Free text over the Swiftline AWB, carrier reference and recipient name. */
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  limit: number;
};

export type PodCentreRow = {
  assignmentId: string;
  shipmentDraftId: string;
  awb: string;
  carrierReference: string;
  consignee: string;
  destination: string;
  parcelNumbers: string[];
  recipientName: string;
  recipientRelationship: string;
  deliveredAt: Date | null;
  revisionId: string;
  evidenceCount: number;
  /** Every evidence file on the newest verified revision, for the PDF. */
  // `legacyPath` is the absolute path these rows held before storage keys
  // existed. Carried through so a reader can fall back to it when the key is
  // missing or wrong; see storage/legacyKeys.ts.
  evidence: Array<{ id: string; type: string; storageKey: string; legacyPath: string; mimeType: string; originalName: string; capturedAt: Date | null }>;
};

function joinPlace(values: Array<string | undefined>) {
  return [...new Set(values.map((value) => value?.trim()).filter(Boolean))].join(", ");
}

/**
 * The verified PODs an account may see.
 *
 * Searching and date-filtering happen in the database rather than over the
 * fetched page, for the same reason every other list in this portal does it
 * there: the result is capped, so filtering afterwards would silently miss
 * whatever fell outside the cap.
 */
export async function listClientPods(filter: PodCentreFilter): Promise<PodCentreRow[]> {
  const accountScopeFilter = clientPodAssignmentScope(filter.accountScopes);
  if (!accountScopeFilter) return [];
  const assignments = await DeliveryAssignment.find({
    ...accountScopeFilter,
    status: { $in: ["DELIVERED", "PARTIALLY_DELIVERED"] }
  })
    .select("shipmentDraftId dpdShipmentId businessAccountId parcelNumbers partnerReference status")
    .lean()
    .exec();
  if (!assignments.length) return [];

  // Newest verified revision per assignment: the POD as it currently stands.
  const revisions = await PodRevision.find({
    assignmentId: { $in: assignments.map((assignment) => assignment._id) },
    status: "VERIFIED",
    ...dateCondition(filter)
  })
    .sort({ revisionNumber: -1 })
    .lean()
    .exec();

  const newestByAssignment = new Map<string, (typeof revisions)[number]>();
  for (const revision of revisions) {
    const key = String(revision.assignmentId);
    if (!newestByAssignment.has(key)) newestByAssignment.set(key, revision);
  }
  if (!newestByAssignment.size) return [];

  const withPod = assignments.filter((assignment) => newestByAssignment.has(String(assignment._id)));
  const [bookings, drafts] = await Promise.all([
    DpdShipment.find({ _id: { $in: withPod.map((assignment) => assignment.dpdShipmentId) } })
      .select("swiftlineTrackingNumber dpdShipmentId")
      .lean()
      .exec(),
    ShipmentDraft.find({ _id: { $in: withPod.map((assignment) => assignment.shipmentDraftId) } })
      .select("consigneeEnteredAddress")
      .lean()
      .exec()
  ]);
  const bookingById = new Map(bookings.map((booking) => [String(booking._id), booking]));
  const draftById = new Map(drafts.map((draft) => [String(draft._id), draft]));

  const rows = withPod.map((assignment) => {
    const revision = newestByAssignment.get(String(assignment._id))!;
    const booking = bookingById.get(String(assignment.dpdShipmentId));
    const consignee = draftById.get(String(assignment.shipmentDraftId))?.consigneeEnteredAddress;
    const evidence = (revision.evidence ?? []) as Array<Record<string, unknown>>;

    return {
      assignmentId: String(assignment._id),
      shipmentDraftId: String(assignment.shipmentDraftId),
      awb: booking?.swiftlineTrackingNumber ?? "",
      carrierReference: booking?.dpdShipmentId ?? assignment.partnerReference ?? "",
      consignee: consignee?.companyName || consignee?.contactName || "",
      destination: joinPlace([consignee?.townOrCity, consignee?.countryName || consignee?.countryCode]),
      parcelNumbers: revision.parcelNumbers ?? [],
      recipientName: revision.recipientName ?? "",
      recipientRelationship: revision.recipientRelationship ?? "",
      deliveredAt: revision.deliveredAt ?? null,
      revisionId: String(revision._id),
      evidenceCount: evidence.length,
      evidence: evidence.map((item) => ({
        id: String(item._id),
        type: String(item.type ?? ""),
        storageKey: String(item.storageKey ?? ""),
        legacyPath: String(item.path ?? ""),
        mimeType: String(item.mimeType ?? ""),
        originalName: String(item.originalName ?? ""),
        capturedAt: (item.capturedAt as Date | undefined) ?? null
      }))
    };
  });

  const searched = filter.search?.trim()
    ? rows.filter((row) => {
      // Applied here rather than in the query because AWB and consignee live on
      // two other collections; the assignment set is already account-scoped and
      // bounded, so this cannot reach beyond what the customer may see.
      const needle = filter.search!.trim().toLowerCase();
      return [row.awb, row.carrierReference, row.recipientName, row.consignee, ...row.parcelNumbers]
        .some((value) => value.toLowerCase().includes(needle));
    })
    : rows;

  return searched
    .sort((left, right) => (right.deliveredAt?.getTime() ?? 0) - (left.deliveredAt?.getTime() ?? 0))
    .slice(0, filter.limit);
}

function dateCondition(filter: PodCentreFilter) {
  if (!filter.dateFrom && !filter.dateTo) return {};
  return {
    deliveredAt: {
      ...(filter.dateFrom ? { $gte: new Date(filter.dateFrom) } : {}),
      // Inclusive of the whole end day, which is what picking a date means.
      ...(filter.dateTo ? { $lte: new Date(`${filter.dateTo}T23:59:59.999Z`) } : {})
    }
  };
}

/**
 * The PODs behind a set of assignment ids, scoped to the caller's accounts.
 *
 * Takes the same account scope as the list so a crafted id cannot fetch a POD
 * belonging to somebody else- the scope is applied in the query, not checked
 * afterwards.
 */
export async function loadClientPodsByIds(input: {
  accountScopes: ClientAccountBranchScope[];
  assignmentIds: string[];
}) {
  const valid = input.assignmentIds.filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!valid.length) return [];

  const rows = await listClientPods({
    accountScopes: input.accountScopes,
    limit: valid.length
  });
  const wanted = new Set(valid);
  return rows.filter((row) => wanted.has(row.assignmentId));
}

export function clientPodAssignmentScope(accountScopes: ClientAccountBranchScope[]) {
  const branches = accountScopes
    .filter((scope) => scope.branchIds.length > 0)
    .map((scope) => ({
      businessAccountId: scope.businessAccountId,
      branchId: { $in: scope.branchIds }
    }));
  return branches.length ? { $or: branches } : null;
}
