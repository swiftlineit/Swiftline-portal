export function formatPaymentMoney(minor: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(minor / 100);
}

export function paymentActivityLabel(value: string) {
  return value.toLowerCase().replaceAll("_", " ");
}
