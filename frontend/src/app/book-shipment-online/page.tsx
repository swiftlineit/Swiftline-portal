import type { Metadata } from "next";
import PublicShipmentBookingForm from "@/components/public-shipment-booking/PublicShipmentBookingForm";
import { siteUrl } from "@/lib/siteUrl";

export const metadata: Metadata = {
  title: "Book an International Shipment Online | Swiftline Cargo",
  description:
    "Book an international courier or cargo shipment from India with Swiftline. Enter sender, receiver and parcel details, review a 30-minute quote and pay securely online.",
  alternates: { canonical: "/book-shipment-online" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Book an International Shipment Online | Swiftline Cargo",
    description:
      "Get a Swiftline quote and securely book an international shipment from India.",
    url: siteUrl("/book-shipment-online"),
    siteName: "Swiftline Cargo",
    type: "website",
  },
};

export default function PublicShipmentBookingPage() {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Swiftline online international shipment booking",
    serviceType: "International courier and cargo booking",
    areaServed: { "@type": "Country", name: "India" },
    provider: {
      "@type": "Organization",
      name: "Swiftline Cargo",
      url: siteUrl("/"),
    },
    url: siteUrl("/book-shipment-online"),
    offers: {
      "@type": "Offer",
      priceCurrency: "INR",
      description:
        "Server-calculated shipment quote, valid for 30 minutes.",
    },
  };
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <section className="relative min-h-[22.625rem] overflow-hidden border-b border-slate-200 bg-white sm:min-h-[18rem]">
        {/* Hero illustration intentionally omitted; the gradient keeps the layout lightweight and responsive. */}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 88% 18%, rgba(99,102,241,0.18), transparent 34%), linear-gradient(118deg, #ffffff 0%, #f7f8ff 56%, #e7eafe 100%)",
          }}
        />
        <div className="relative z-10 mx-auto max-w-7xl  px-4 py-10 sm:px-6 sm:py-12 lg:px-8">
          <p className="text-xs mb-5 mt-10 font-bold uppercase tracking-[0.18em] text-[#0D1282]">
            International shipping from India
          </p>
          <h1 className="mt-2 mb-2 max-w-3xl text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl">
            Book your Swiftline shipment online
          </h1>
          <p className="mt-3 mb-2 max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
            Enter sender and receiver details, declare each parcel, review the
            complete weight and price breakdown, then pay securely through
            Razorpay. No account is required.
          </p>
        </div>
      </section>
     <section className="flex min-h-screen items-center justify-center bg-[#f7f9ff] px-4 py-6 sm:px-6 sm:py-8">
  <PublicShipmentBookingForm />
</section>
    </>
  );
}
