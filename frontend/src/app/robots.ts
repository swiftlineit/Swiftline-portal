import type { MetadataRoute } from "next";
import { SITE_URL, siteUrl } from "@/lib/siteUrl";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        /**
         * The signed-in portals only.
         *
         * `/track/` is deliberately absent. Per-shipment pages carry their own
         * `noindex`, and disallowing the path here would stop a crawler from
         * ever fetching them- so the tag would never be read and a URL picked
         * up from a forwarded link could still be indexed URL-only.
         */
        disallow: ["/dashboard/", "/client/", "/driver/", "/book-shipment-online/status"],
      },
    ],
    sitemap: siteUrl("/sitemap.xml"),
    host: SITE_URL,
  };
}
