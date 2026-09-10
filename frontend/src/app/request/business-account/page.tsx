import type { Metadata } from "next";
import PublicBusinessAccountPage from "@/components/public-business-account/PublicBusinessAccountForm";
import { siteUrl } from "@/lib/siteUrl";

export const metadata: Metadata = {
  title: "Swiftline Business Shipping Account | Apply Online",
  description:
    "Apply online for a Swiftline business shipping account for international courier and cargo services. Complete your business details and KYC verification online.",
  alternates: { canonical: "/request/business-account" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Swiftline Business Shipping Account | Apply Online",
    description:
      "Apply online for a Swiftline business shipping account for international courier and cargo services.",
    url: siteUrl("/request/business-account"),
    siteName: "Swiftline Cargo",
    type: "website"
  }
};

export default function RequestBusinessAccountRoute() {
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Swiftline Business Shipping Account",
    description:
      "Apply online for a Swiftline business shipping account for international courier and cargo services.",
    url: siteUrl("/request/business-account"),
    about: {
      "@type": "Service",
      name: "Swiftline Business Shipping Account",
      serviceType: "Business shipping account",
      provider: {
        "@type": "Organization",
        name: "Swiftline Cargo",
        url: siteUrl("/")
      }
    }
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
      />
      <section className="relative min-h-[22.625rem] overflow-hidden bg-gray-100 py-10 sm:min-h-[18rem] sm:py-12">
        {/* Hero illustration intentionally omitted; the gradient keeps the layout lightweight and responsive. */}
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at 88% 18%, rgba(37,99,235,0.14), transparent 34%), linear-gradient(118deg, #f8fafc 0%, #eef2ff 56%, #e2e8f0 100%)",
          }}
        />
        <div className="relative z-10 mx-auto  mt-10 w-full max-w-7xl px-4 text-start sm:px-6 lg:px-8">
          <p className="text-xs mb-5 font-semibold uppercase tracking-[0.18em] text-[#0D1282]">
            Swiftline Business Account
          </p>

          <h1 className="mt-2 mb-2  text-3xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Open a Swiftline Business Shipping Account
          </h1>

          <p className=" mt-3 mb-2 max-w-3xl text-sm leading-6 text-slate-600 sm:text-[15px]">
            Apply online for a Swiftline business account for international
            courier and cargo services. Complete your business details and KYC
            information to submit your application for review.
          </p>
        </div>
      </section>
      <PublicBusinessAccountPage />
    </>
  );
}
