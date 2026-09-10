import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/siteUrl";

/**
 * The handful of portal pages a crawler should know about.
 *
 * Static by design. Everything else here is either behind a session or, like the
 * per-shipment tracking pages, deliberately noindex- listing a shipment URL
 * would both contradict its own robots tag and publish the AWB.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteUrl("/"),
      changeFrequency: "yearly",
      priority: 0.5
    },
    {
      // The tracking landing page is the one page here meant to rank.
      url: siteUrl("/track"),
      changeFrequency: "monthly",
      priority: 1
    },
    {
      // Public onboarding is a primary acquisition page.
      url: siteUrl("/request/business-account"),
      changeFrequency: "monthly",
      priority: 0.9
    },
    { url: siteUrl("/book-shipment-online"), changeFrequency: "monthly", priority: 1 },
    { url: siteUrl("/terms-and-conditions"), changeFrequency: "yearly", priority: 0.3 },
    { url: siteUrl("/cancellation-and-refund-policy"), changeFrequency: "yearly", priority: 0.3 },
    { url: siteUrl("/prohibited-and-restricted-goods"), changeFrequency: "yearly", priority: 0.4 },
    {
      url: siteUrl("/privacy-policy"),
      changeFrequency: "yearly",
      priority: 0.3
    }
  ];
}
