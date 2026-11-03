import mongoose from "mongoose";

export type TenantUniqueIndexPlan = {
  key: Record<string, number>;
  options: mongoose.IndexOptions;
};

export function tenantScopedUniqueIndexes(
  model: Pick<mongoose.Model<any>, "schema">
): TenantUniqueIndexPlan[] {
  return (model.schema.indexes() as Array<[Record<string, number>, mongoose.IndexOptions]>)
    .filter(([key, options]) => options.unique === true && key.tenantId === 1)
    .map(([key, options]) => ({ key, options }));
}

export function duplicateTenantIdentityPipeline(index: TenantUniqueIndexPlan): mongoose.PipelineStage[] {
  const groupedKey = Object.fromEntries(
    Object.keys(index.key).map((field, position) => [`key${position}`, `$${field}`])
  );

  return [
    { $match: index.options.partialFilterExpression ?? {} },
    { $group: { _id: groupedKey, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $count: "duplicateGroups" }
  ];
}

export const businessAccountLegacyUniqueKeys: ReadonlyArray<Record<string, number>> = [
  { accountId: 1 },
  { "contact.email": 1 },
  { "contact.countryCode": 1, "contact.mobileNumber": 1 },
  { "company.registrationIdKey": 1 }
];

export function sameIndexKey(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every(([field, value], position) =>
    field === rightEntries[position]?.[0] && value === rightEntries[position]?.[1]
  );
}
