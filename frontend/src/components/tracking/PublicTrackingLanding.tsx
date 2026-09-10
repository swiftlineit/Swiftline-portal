import { FiBox, FiFileText, FiGlobe, FiTruck } from "react-icons/fi";

import PublicTrackingForm from "@/components/tracking/PublicTrackingForm";
import { siteUrl } from "@/lib/siteUrl";

/**
 * The public tracking landing page, top to bottom.
 *
 * OWNED BY THE PUBLIC TRACKER. Nothing here is shared with the signed-in
 * portals, so this can be restyled freely without touching what staff or
 * clients see.
 *
 * It is the page meant to rank, so it carries real content rather than only a
 * search box. The per-shipment results at /track/[number] are noindex, which
 * means everything a crawler should ever read has to live here.
 */

const services = [
  {
    title: "International Express",
    description:
      "Time-sensitive international courier movement with milestone-based visibility from origin to delivery.",
    icon: FiGlobe,
  },
  {
    title: "International Cargo",
    description:
      "Air cargo solutions for heavier, commercial and business shipments moving internationally.",
    icon: FiBox,
  },
  {
    title: "Customs Support",
    description:
      "Clear shipment visibility through international customs clearance and document-related exceptions.",
    icon: FiFileText,
  },
  {
    title: "Last-Mile Delivery",
    description:
      "Destination handover and final-mile delivery event visibility through integrated delivery partners.",
    icon: FiTruck,
  },
];

const faqs = [
  {
    question: "Where do I find my Swiftline tracking number?",
    answer:
      "It is printed on the shipping label as the AWB number, and it appears on the booking " +
      "confirmation email your sender received. Recent shipments use a number such as " +
      "SLCDEL170826001; shipments booked earlier use a longer form such as SLDL20072026000001. " +
      "Both are accepted here.",
  },
  {
    question: "Do I need an account to track a shipment?",
    answer:
      "No. Tracking is open to anyone holding the number, and individuals can book and pay " +
      "online without an account. A business account adds team, invoice and document management tools.",
  },
  {
    question: "My shipment has several parcels. Can I track just one?",
    answer:
      "Yes. Every piece carries its own number on its own label - usually the shipment number " +
      "with a two-digit suffix, such as SLCDEL170826001-02. Searching a piece number shows the " +
      "timeline for the whole shipment, because scans are recorded against the shipment rather " +
      "than against each parcel.",
  },
  {
    question: "Why has my tracking not updated for a while?",
    answer:
      "Long-haul legs and customs clearance can run for a day or more between scans, so a quiet " +
      "period is normal in transit. If a shipment is held, the page says so, and the estimated " +
      "delivery date is paused until it moves again.",
  },
  {
    question: "The page says no shipment was found. What now?",
    answer:
      "Check the number against the label- the letter O and the digit 0 are easy to confuse. " +
      "A very recent booking can also take a short while to appear. If it still does not " +
      "resolve, contact the sender or reach Swiftline with the number to hand.",
  },
];

const network = [
  {
    country: "UK",
    detail: "Gateway + last-mile visibility",
  },
  {
    country: "USA",
    detail: "Multi-gateway tracking flow",
  },
  {
    country: "Canada",
    detail: "International + local hub flow",
  },
  {
    country: "Europe",
    detail: "Destination gateway visibility",
  },
];

export default function PublicTrackingLanding() {
  // Structured data so a search result can carry the tracking box and the FAQ
  // answers directly. There is no ParcelDelivery markup on result pages- they
  // are noindex, so it would be read by nobody.
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        name: "Swiftline Cargo",
        url: siteUrl("/"),
        potentialAction: {
          "@type": "SearchAction",
          target: {
            "@type": "EntryPoint",
            urlTemplate: `${siteUrl("/track")}/{tracking_number}`,
          },
          "query-input": "required name=tracking_number",
        },
      },
      {
        "@type": "FAQPage",
        mainEntity: faqs.map((faq) => ({
          "@type": "Question",
          name: faq.question,
          acceptedAnswer: {
            "@type": "Answer",
            text: faq.answer,
          },
        })),
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        // Content is a literal defined above, so there is no user input in it.
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData),
        }}
      />

      {/* Hero */}
      <section
        className="relative left-1/2 w-screen -translate-x-1/2 overflow-hidden bg-[#05070d]"
        style={{
          backgroundImage:
            'url("https://images.unsplash.com/vector-1758528899232-475c7421fa3b?q=80&w=880&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D")',
          backgroundPosition: "center",
          backgroundRepeat: "no-repeat",
          backgroundSize: "cover",
        }}
      >
        <div className="absolute inset-0 bg-black/80" />
        {/* <div className="absolute inset-0 bg-gradient-to-b from-[#07113f]/80 via-[#07113f]/65 to-black/75" />
        <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-black/40 to-transparent" />
        <div className="absolute left-0 top-0 h-1 w-full bg-[#d71920]" /> */}

        <div className="relative mx-auto flex min-h-125 max-w-7xl items-center justify-center px-4 py-14 sm:min-h-140 sm:px-6 sm:py-16 lg:min-h-155 lg:px-8 lg:py-20">
          <div className="mx-auto w-full max-w-3xl text-center">
            <div className="mb-5 flex items-center justify-center gap-3">
              <span className="h-px w-8 bg-[#d71920] sm:w-10" />

              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/80 sm:text-xs">
                Shipment tracking
              </p>

              <span className="h-px w-8 bg-[#d71920] sm:w-10" />
            </div>

            <h1 className="text-3xl font-semibold tracking-[-0.035em] text-white sm:text-5xl lg:text-6xl lg:leading-[1.08]">
              Track Your Swiftline Shipment
            </h1>

            <p className="mx-auto mt-5 max-w-2xl text-sm leading-6 text-white/70 sm:text-base sm:leading-7 lg:text-lg lg:leading-8">
              Enter your Swiftline AWB or SLC tracking number to see your latest shipment status, customs progress and estimated delivery.
            </p>

            <div
              id="tracking"
              className="mx-auto mt-7 max-w-2xl scroll-mt-24 sm:mt-9"
            >
              <div className="rounded-xl border border-white/15 bg-white/95 p-2 shadow-2xl shadow-black/20 backdrop-blur-sm sm:rounded-2xl sm:p-3">
                <PublicTrackingForm autoFocus />
              </div>

              <p className="mx-auto mt-4 max-w-xl text-[11px] leading-5 text-white/55 sm:text-xs md:text-lg">
                <span> Every parcel a promise, swiftly delivered.</span>
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Services */}
      <section className="mt-14 sm:mt-16 lg:mt-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {services.map((service) => {
              const Icon = service.icon;

              return (
                <article
                  key={service.title}
                  className="group relative flex min-h-48.75 flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 transition duration-300 hover:-translate-y-1 hover:border-[#0D1282]/20 hover:shadow-[0_20px_50px_rgba(15,23,42,0.10)] sm:p-6"
                >
                  {/* Premium top accent */}
                  {/* <div className="absolute inset-x-0 top-0 h-0.75 bg-linear-to-r from-[#d71920] via-[#d71920] to-[#0D1282]" /> */}

                  {/* Subtle decorative red glow */}
                  <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-[#d71920]/4 blur-2xl transition duration-300 group-hover:bg-[#d71920]/8" />

                  <div className="relative flex items-start justify-between gap-4">
                    <span className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-[#0D1282]/10 bg-[#0D1282]/6 text-[#0D1282] transition duration-300 group-hover:border-[#0D1282] group-hover:bg-[#0D1282] group-hover:text-white">
                      <Icon className="h-4.75 w-4.75" />
                    </span>

                    {/* <span className="mt-1 text-[11px] font-semibold tracking-[0.16em] text-[#d71920]/70">
                {String(index + 1).padStart(2, "0")}
              </span> */}
                  </div>

                  <div className="relative mt-5">
                    {/* <div className="mb-3 h-[2px] w-7 bg-[#d71920]" /> */}

                    <h3 className="text-lg font-semibold tracking-tight text-slate-950">
                      {service.title}
                    </h3>

                    <p className="mt-2.5 text-sm leading-6 text-slate-600">
                      {service.description}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="mt-14 pt-14 sm:mt-16 sm:pt-16 lg:mt-10 lg:pt-10">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_18px_55px_rgba(15,23,42,0.06)]">
            {/* Top accent */}
            <div className="absolute inset-x-0 top-0 h-0.75 bg-linear-to-r from-[#d71920] via-[#d71920] to-[#0D1282]" />

            {/* Background detail */}
            <div className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-[#d71920]/[0.035] blur-3xl" />

            <div className="relative">
              {faqs.map((faq, index) => (
                <details
                  key={faq.question}
                  className="group border-b border-slate-100 last:border-b-0 open:bg-[#0D1282]/2.5"
                >
                  <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-4 marker:hidden transition duration-200 hover:bg-slate-50/70 sm:gap-4 sm:px-6 sm:py-5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-slate-200 bg-white text-[11px] font-semibold text-slate-500 shadow-sm transition duration-200 group-open:border-[#d71920]/25 group-open:bg-[#d71920]/8 group-open:text-[#d71920]">
                      {String(index + 1).padStart(2, "0")}
                    </span>

                    <span className="flex-1 text-sm font-semibold leading-6 text-slate-900 transition duration-200 group-open:text-[#0D1282] sm:text-[15px]">
                      {faq.question}
                    </span>

                    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-400 transition duration-200 group-open:border-[#d71920]/20 group-open:bg-[#d71920]/6 group-open:text-[#d71920]">
                      <span className="absolute h-px w-3 bg-current" />
                      <span className="absolute h-3 w-px bg-current transition duration-200 group-open:rotate-90 group-open:opacity-0" />
                    </span>
                  </summary>

                  <div className="relative px-4 pb-5 sm:pl-20 sm:pr-8">
                    <div className="mb-3 h-px w-full bg-linear-to-r from-[#d71920]/20 via-slate-200 to-transparent" />

                    <p className="max-w-5xl text-sm leading-6 text-slate-600">
                      {faq.answer}
                    </p>
                  </div>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>
      {/* About Swiftline */}
      <section className="relative left-1/2 mt-16 w-screen -translate-x-1/2 overflow-hidden bg-[#07113f] sm:mt-20 lg:mt-24">
        <div className="absolute right-0 top-0 h-64 w-64 rounded-full bg-white/3 blur-3xl" />
        <div className="absolute bottom-0 left-0 h-72 w-72 rounded-full bg-[#d71920]/5 blur-3xl" />

        <div className="relative mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-16 lg:px-8 lg:py-20">
          <div className="grid gap-12 lg:grid-cols-[1.05fr_0.95fr] lg:items-end lg:gap-20">
            <div>
              <div className="flex items-center gap-3">
                <span className="h-px w-8 bg-[#d71920]" />

                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">
                  About Swiftline
                </p>
              </div>

              <h2 className="mt-5 max-w-2xl text-3xl font-semibold tracking-tight text-white sm:text-4xl lg:text-[42px] lg:leading-[1.15]">
                International movement with one clear customer experience.
              </h2>

              <div className="mt-6 max-w-2xl space-y-4 text-sm leading-7 text-white/65 sm:text-[15px]">
                <p>
                  Swiftline Cargo &amp; Express Logistics Pvt. Ltd. is built
                  around shipment control, visibility and dependable
                  international delivery coordination.
                </p>

                <p>
                  Our tracking platform brings the complete shipment journey
                  into one interface-from Delhi origin processing to export,
                  destination customs, last-mile handover and final delivery.
                </p>

                <p>
                  Our operational infrastructure includes Delhi
                  Customs-authorised operations, Swiftline-managed network
                  capabilities and dedicated CFL connectivity, supporting a more
                  controlled and transparent international logistics experience.
                </p>
              </div>
            </div>

            <div>
              <div className="mb-6">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[#d71920]">
                  Swiftline Global Network
                </p>

                <h3 className="mt-3 text-xl font-semibold text-white sm:text-2xl">
                  One consistent tracking experience across key international
                  destinations.
                </h3>
              </div>

              <div className="grid overflow-hidden rounded-2xl border border-white/10 sm:grid-cols-2">
                {network.map((item, index) => (
                  <div
                    key={item.country}
                    className={[
                      "p-5 transition duration-200 hover:bg-white/5 sm:p-6",
                      index === 0 ? "border-b border-white/10" : "",
                      index === 1
                        ? "border-b border-white/10 sm:border-l sm:border-white/10"
                        : "",
                      index === 2
                        ? "border-b border-white/10 sm:border-b-0"
                        : "",
                      index === 3 ? "sm:border-l sm:border-white/10" : "",
                    ].join(" ")}
                  >
                    <span className="text-lg font-semibold text-white">
                      {item.country}
                    </span>

                    <p className="mt-2 text-sm leading-6 text-white/55">
                      {item.detail}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
