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
      <section className="mx-auto w-full max-w-362.5 px-4 py-10 pt-6 sm:px-6 sm:pt-8 lg:px-8">
        <div className="max-w-4xl text-start">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#0D1282]">
            Swiftline Business Account
          </p>

          <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            Open a Swiftline Business Shipping Account
          </h1>

          <p className=" mt-3 max-w-3xl text-sm leading-6 text-slate-600 sm:text-[15px]">
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
