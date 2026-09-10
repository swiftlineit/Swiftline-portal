import { restrictedCategories } from "./restrictedGoods.service.js";

// Versioned here and persisted with each acceptance. Content updates must bump
// the matching version so Operations can prove exactly what was accepted.
export const publicShipmentPolicyVersions = {
  terms: "2026-09-08",
  cancellation: "2026-09-08",
  prohibitedGoods: "2026-09-08",
} as const;

export function getPublicShipmentPolicySummary() {
  return {
    versions: publicShipmentPolicyVersions,
    prohibitedGoods: restrictedCategories.map(({ label }) => label),
    cancellationSummary:
      "Public bookings cannot be amended or cancelled online. Contact Swiftline for help. Any approved cancellation or refund is processed by staff under the published policy and may exclude services already performed or non-refundable gateway and statutory charges.",
  };
}
