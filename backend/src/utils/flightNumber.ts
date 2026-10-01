/** Keep the display format stable while accepting legacy compact values. */
export function normalizeFlightNumber(value: string) {
  const upper = value.trim().toUpperCase();
  const compact = upper.replace(/[\s-]+/g, "");
  const match = /^([A-Z]{2,4})(\d{1,4}[A-Z]?)$/.exec(compact);
  return match ? `${match[1]}-${match[2]}` : upper;
}

export function comparableFlightNumber(value: string) {
  return normalizeFlightNumber(value).replace(/-/g, "");
}

export function isValidFlightNumber(value: string) {
  const normalized = normalizeFlightNumber(value);
  return normalized.length <= 20 && /^[A-Z0-9]{2,4}-\d{1,4}[A-Z]?$/.test(normalized);
}
