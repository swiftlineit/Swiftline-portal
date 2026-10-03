export const adCodePattern = /^(?:\d{7}|\d{7}-\d{7})$/;

export function getAdCodeError(value: string): string {
  if (!value.trim()) return "AD code is required";
  return adCodePattern.test(value.trim())
    ? ""
    : "Enter a 7-digit AD code or two 7-digit parts separated by a hyphen";
}
