export function formatPaymentMoney(minor: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, minimumFractionDigits: 2 }).format(minor / 100);
}

export function paymentActivityLabel(value: string) {
  const onlinePaymentActivityLabels: Record<string, string> = {
    RAZORPAY_BOOKING_PAYMENT: "Online booking payment",
    RAZORPAY_AMENDMENT_PAYMENT: "Online amendment payment",
    RAZORPAY_REFUND: "Payment refund",
    CASH_RECEIPT_RECORDED: "Cash receipt recorded",
    SHIPMENT_CASH_RECEIPT: "Cash receipt recorded",
    CASH_REFUND: "Cash refund recorded",
    CASH_REFUND_RECORDED: "Cash refund recorded",
  };
  const normalized = value.toUpperCase();
  if (onlinePaymentActivityLabels[normalized]) return onlinePaymentActivityLabels[normalized];
  return value.toLowerCase().replaceAll("_", " ");
}

export function paymentSourceLabel(value: string) {
  const normalized = value.toUpperCase();
  const sourceLabels: Record<string, string> = {
    RAZORPAY: "Online payment",
    DIRECT_RAZORPAY: "Online payment",
    PUBLIC_RAZORPAY: "Online payment",
    CASH_RECEIPT: "Cash receipt",
    CASH: "Cash",
    BUSINESS_ACCOUNT: "Business account"
  };
  return sourceLabels[normalized] ?? value;
}
