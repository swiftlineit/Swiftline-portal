const IST_OFFSET_MS = 330 * 60_000;

export function formatIstDate(value: Date) {
  if (Number.isNaN(value.getTime())) throw new RangeError("Date must be valid.");
  return new Date(value.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Change the calendar day while retaining the existing India-local wall time. */
export function setIstDatePreservingTime(dateOnly: string, existing: Date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOnly) || Number.isNaN(existing.getTime())) {
    throw new RangeError("Enter a valid India-local calendar date.");
  }

  const [year, month, day] = dateOnly.split("-").map(Number);
  const dateStartUtc = Date.UTC(year!, month! - 1, day!);
  if (new Date(dateStartUtc).toISOString().slice(0, 10) !== dateOnly) {
    throw new RangeError("Enter a valid India-local calendar date.");
  }

  const existingIst = new Date(existing.getTime() + IST_OFFSET_MS);
  const timeOfDayMs = (((existingIst.getUTCHours() * 60 + existingIst.getUTCMinutes()) * 60
    + existingIst.getUTCSeconds()) * 1000) + existingIst.getUTCMilliseconds();
  return new Date(dateStartUtc + timeOfDayMs - IST_OFFSET_MS);
}
