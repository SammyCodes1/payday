import type { Metadata, Viewport } from "next";
import "@fontsource-variable/fraunces/opsz.css";
import "@fontsource-variable/inter-tight/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "./globals.css";
import { Providers } from "@/components/Providers";
import { Header, MobileNav } from "@/components/Header";
import { Footer } from "@/components/Footer";

export const metadata: Metadata = { title: "Payday · accounts-payable agent", description: "Invoices in, payments out, bounded by an on-chain SpendPolicy" };
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#F2F5F1" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="flex min-h-screen flex-col">
        <Providers>
          <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-[var(--z-toast)] focus:rounded-lg focus:bg-ink focus:px-3 focus:py-2 focus:text-surface">
            Skip to content
          </a>
          <Header />
          <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 pb-16 pt-8 sm:px-8 sm:pt-12">{children}</main>
          <Footer />
          <MobileNav />
        </Providers>
      </body>
    </html>
  );
}
