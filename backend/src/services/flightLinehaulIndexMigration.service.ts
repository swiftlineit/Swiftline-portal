/**
 * A cost sheet can legitimately exist before its operations manifest is
 * attached to a flight. Only a row whose manifest no longer exists is an
 * orphan that must stop the flight-index migration.
 */
export function orphanedFlightCostSheetPipeline() {
  return [
    {
      $lookup: {
        from: "operationsmanifests",
        localField: "operationsManifestId",
        foreignField: "_id",
        as: "manifest"
      }
    },
    { $match: { manifest: { $size: 0 } } },
    { $project: { _id: 1, operationsManifestId: 1 } }
  ];
}
