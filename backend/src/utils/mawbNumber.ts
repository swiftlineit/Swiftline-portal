export const MAWB_NUMBER_MAX_LENGTH = 40;

/** MAWB formats vary by carrier; Swiftline stores the supplied reference verbatim apart from casing/outer spaces. */
export function normalizeMawbNumber(value: string | null | undefined) {
  return (value ?? "").trim().toUpperCase();
}

export function isValidMawbNumber(value: string | null | undefined) {
  const normalized = normalizeMawbNumber(value);
  return normalized.length > 0 && normalized.length <= MAWB_NUMBER_MAX_LENGTH;
}
