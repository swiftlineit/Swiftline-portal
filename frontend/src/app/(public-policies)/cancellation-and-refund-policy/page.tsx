import type { Metadata } from "next";
import PublicPolicyPage from "@/components/public/PublicPolicyPage";

export const metadata: Metadata = { title: "Cancellation and Refund Policy | Swiftline Cargo", description: "Cancellation, failed-booking and refund rules for Swiftline public online shipment bookings.", alternates: { canonical: "/cancellation-and-refund-policy" } };
export default function CancellationPolicyPage() { return <PublicPolicyPage eyebrow="Swiftline online booking" title="Cancellation and refund policy" summary="How public online booking cancellations, payment failures and refunds are handled.">
  <h2>Online requests</h2><p>Public customers cannot cancel, amend or rebook a shipment from the booking-status page. Contact Swiftline promptly with the AWB and booking reference. Only authorised staff can approve and record a cancellation or rebooking.</p>
  <h2>Before services begin</h2><p>If cancellation is approved before carriage, customs processing, label procurement or another paid service begins, Swiftline will calculate the refundable amount from the services not performed. Statutory, gateway, bank or third-party charges may be non-refundable where the law and provider terms allow.</p>
  <h2>After processing or handover</h2><p>A full refund is not guaranteed after operational work has begun or a parcel has been accepted into the network. Swiftline will review actual services, third-party costs, customs work and the shipment&apos;s current location before confirming any refund or further charge.</p>
  <h2>Technical failure after payment</h2><p>If Razorpay confirms a captured payment but no durable shipment record exists, the system starts an idempotent refund and alerts Swiftline. If a shipment record exists but its invoice or labels need recovery, the booking is held for staff review and is not automatically refunded or rebooked.</p>
  <h2>Payment uncertainty</h2><p>If the gateway amount, currency, order or payment state is ambiguous, Swiftline holds the transaction for Finance and Operations reconciliation. Do not pay again until Swiftline confirms the outcome.</p>
  <h2>Refund timing</h2><p>After Swiftline or Razorpay marks a refund processed, the receiving bank or payment method controls when the credit appears. Keep the refund reference supplied by Swiftline when contacting your bank.</p>
</PublicPolicyPage>; }
