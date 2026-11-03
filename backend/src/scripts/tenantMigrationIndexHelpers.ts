export type ExistingIndexShape = {
  name?: string;
  key?: Record<string, unknown>;
  unique?: unknown;
  partialFilterExpression?: Record<string, unknown>;
};

export type PlannedIndexShape = {
  key: Record<string, number>;
  options: {
    name?: string;
    unique?: unknown;
    partialFilterExpression?: Record<string, unknown>;
  };
};

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableValue(item)}`)
    .join(",")}}`;
}

export function indexKeyEquals(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return leftEntries.length === rightEntries.length && leftEntries.every(([field, value], index) =>
    field === rightEntries[index]?.[0] && value === rightEntries[index]?.[1]
  );
}

/** Index names are labels; an equivalent key and behavior already satisfies the plan. */
export function indexSatisfiesPlan(existing: ExistingIndexShape, plan: PlannedIndexShape) {
  return Boolean(existing.key) && indexKeyEquals(existing.key!, plan.key) &&
    Boolean(existing.unique) === (plan.options.unique === true) &&
    stableValue(existing.partialFilterExpression ?? {}) === stableValue(plan.options.partialFilterExpression ?? {});
}
