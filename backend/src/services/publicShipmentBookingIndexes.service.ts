type IndexInfo = {
  name?: string;
  key?: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: {
    shipmentDraftId?: { $type?: unknown };
  };
};

type IndexCollection = {
  listIndexes(): { toArray(): Promise<IndexInfo[]> };
  dropIndex(name: string): Promise<unknown>;
};

type PublicBookingIndexDependencies = {
  bookingCollection: IndexCollection;
  createBookingIndexes(): Promise<unknown>;
  createPaymentIndexes(): Promise<unknown>;
};

function isNamespaceNotFound(error: unknown) {
  if (typeof error !== "object" || error === null) return false;
  const mongoError = error as { code?: unknown; codeName?: unknown };
  return mongoError.code === 26 || mongoError.codeName === "NamespaceNotFound";
}

/**
 * Repairs the legacy public-booking draft index and creates all declared public
 * booking/payment indexes. A first production deployment has no collections
 * yet; MongoDB creates them when createIndexes runs.
 */
export async function ensurePublicShipmentBookingIndexes(
  dependencies: PublicBookingIndexDependencies,
) {
  let indexes: IndexInfo[];
  let bookingCollectionMissing = false;

  try {
    indexes = await dependencies.bookingCollection.listIndexes().toArray();
  } catch (error) {
    if (!isNamespaceNotFound(error)) throw error;
    indexes = [];
    bookingCollectionMissing = true;
  }

  const shipmentDraftIndex = indexes.find(
    (index) => index.key?.shipmentDraftId === 1,
  );
  const hasCorrectShipmentDraftIndex = Boolean(
    shipmentDraftIndex?.unique &&
      shipmentDraftIndex.partialFilterExpression?.shipmentDraftId?.$type ===
        "objectId",
  );

  if (!hasCorrectShipmentDraftIndex) {
    for (const index of indexes.filter(
      (candidate) => candidate.key?.shipmentDraftId === 1,
    )) {
      if (index.name) await dependencies.bookingCollection.dropIndex(index.name);
    }
    await dependencies.createBookingIndexes();
  }

  await dependencies.createPaymentIndexes();

  return {
    bookingCollectionMissing,
    bookingIndexesRebuilt: !hasCorrectShipmentDraftIndex,
  };
}
