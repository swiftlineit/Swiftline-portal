import type { Metadata } from "next";
import "react-international-phone/style.css";
import "react-toastify/dist/ReactToastify.css";
import PortalToasts from "@/components/PortalToasts";
import PortalHistoryTracker from "@/components/PortalHistoryTracker";
import PortalThemeController from "@/components/PortalThemeController";
import { SITE_URL } from "@/lib/siteUrl";
import "./globals.css";
import "./portal-theme.css";

// Apply a saved portal choice before hydration so a dark page never paints light.
// Public routes stay light even when this browser has a saved dark choice.
const portalThemeBootstrap = `try {
  var p = location.pathname;
  if ((p === '/dashboard' || p.startsWith('/dashboard/') || p === '/client' || p.startsWith('/client/'))
    && localStorage.getItem('swiftline-portal-theme') === 'dark') {
    document.documentElement.dataset.portalTheme = 'dark';
  }
} catch (e) {}`;

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Swiftline Cargo Portal",
  description: "A portal provided by Swiftline Cargo for managing your shipments and tracking your orders.",
  alternates: {
    canonical: "/",
  },
  icons: {
    icon: [{ url: "/icon.png", type: "image/png", sizes: "192x192" }],
    shortcut: [{ url: "/icon.png", type: "image/png", sizes: "192x192" }],
    apple: [{ url: "/icon.png", type: "image/png", sizes: "192x192" }],
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: portalThemeBootstrap }} />
      </head>
      <body className="min-h-full">
        {children}
        <PortalThemeController />
        <PortalHistoryTracker />
        <PortalToasts />
      </body>
    </html>
  );
}
