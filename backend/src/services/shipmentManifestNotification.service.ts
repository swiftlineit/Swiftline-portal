import mongoose from "mongoose";
import { env } from "../config/env.js";
import type { IShipmentManifest } from "../models/shipmentManifest.model.js";
import { TenantMembership } from "../models/tenantMembership.model.js";
import { Tenant } from "../models/tenant.model.js";
import { getTenantContext } from "./tenantScope.service.js";
import { notifyActiveAdmins, notifyPortalUsers } from "./portalNotification.service.js";

type ManifestNotificationInput = {
  manifest: IShipmentManifest;
  businessAccountName: string;
  generatedBy: string;
};

// Manifests have no detail route: the list page is where staff review and act on
// them, so the link resolves to that manifest's row.
function manifestHref(manifest: IShipmentManifest) {
  return `/dashboard/shipment-manifests#manifest-${String(manifest._id)}`;
}

/**
 * Tells staff a client sealed a manifest: an in-portal notification plus an email
 * carrying the manifest PDF, both raised by the same call. Best effort- the
 * manifest is already committed by the time this runs, so a failure here is
 * logged rather than thrown.
 */
export async function notifyAdminsOfClientManifest(input: ManifestNotificationInput) {
  const { manifest } = input;
  const shipmentCount = manifest.lineSnapshots.length;

  try {
    const tenantContext = getTenantContext();
    const notification = {
      type: "SHIPMENT_MANIFEST_GENERATED" as const,
      title: "Client generated a shipment manifest",
      message: `${input.businessAccountName || "A client"} generated manifest ${manifest.manifestNumber} `
        + `with ${shipmentCount} ${shipmentCount === 1 ? "shipment" : "shipments"}.`,
      idempotencyKey: `SHIPMENT_MANIFEST_GENERATED:${String(manifest._id)}`,
      businessAccountId: manifest.businessAccountId,
      metadata: {
        manifestId: manifest._id,
        manifestNumber: manifest.manifestNumber,
        shipmentCount,
        totalPieces: manifest.totalPieces,
        totalWeightKg: manifest.totalWeightKg
      },
      email: {
        payload: {
          generatedBy: input.generatedBy,
          generatedAt: manifest.generatedAt
        },
        attachmentRefs: [{
          kind: "SHIPMENT_MANIFEST_PDF" as const,
          refId: manifest._id as mongoose.Types.ObjectId,
          revision: null,
          filename: `MANIFEST-${manifest.manifestNumber}.pdf`
        }]
      }
    };

    if (tenantContext?.kind === "OPERATOR") {
      const [tenant, memberships] = await Promise.all([
        Tenant.findById(tenantContext.tenantId).select("slug").lean().exec(),
        TenantMembership.find({
          tenantId: tenantContext.tenantId,
          role: { $in: ["OPERATOR_ADMIN", "OPERATIONS"] },
          status: "ACTIVE"
        }).select("userId").lean().exec()
      ]);
      if (!tenant?.slug) throw new Error("The operator manifest notification has no tenant slug.");
      await notifyPortalUsers(memberships.map((membership) => membership.userId), {
        ...notification,
        href: "/portal/" + encodeURIComponent(tenant.slug) + "/manifests#manifest-" + String(manifest._id)
      });
      return;
    }

    await notifyActiveAdmins({
      ...notification,
      href: manifestHref(manifest),
      // The shared Swiftline operations inbox remains on the root-tenant email.
      email: {
        ...notification.email,
        extraRecipients: env.ADMIN_EMAIL
          ? [{ userId: null, email: env.ADMIN_EMAIL, name: "Swiftline Operations" }]
          : []
      }
    });
  } catch (error) {
    console.error("Manifest admin notification failed.", { manifestNumber: manifest.manifestNumber, error });
  }
}
