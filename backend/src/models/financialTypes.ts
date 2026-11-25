export const prepaidCurrencyValues = ["INR"] as const;
export type PrepaidCurrency = (typeof prepaidCurrencyValues)[number];

export const paymentSourceValues = [
  "BUSINESS_ACCOUNT",
  "BUSINESS_WALLET",
  "DIRECT_RAZORPAY",
  "CASH_RECEIPT",
  "CLIENT_PREPAID",
  "ADMIN_DIRECT",
  "PUBLIC_RAZORPAY",
  "TEST"
] as const;
export type PaymentSource = (typeof paymentSourceValues)[number];

export const shippingEnvironmentValues = ["MOCK", "PREPRODUCTION", "PRODUCTION"] as const;
export type ShippingEnvironment = (typeof shippingEnvironmentValues)[number];

export const maxCreditLimitRupees = 10_00_000;
export const maxCreditLimitMinor = maxCreditLimitRupees * 100;
/**
 * The ceiling as it reads in an error message.
 *
 * Exported so the copy is derived from the value rather than typed alongside
 * it- the two were written out separately before, and raising the limit left
 * five messages quoting the old one.
 */
export const maxCreditLimitLabel = `INR ${maxCreditLimitRupees.toLocaleString("en-IN")}`;

export function formatMinorRupees(amountMinor: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amountMinor / 100);
}

export function isMinorUnitInteger(value: unknown) {
  return Number.isInteger(value);
}
