import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { getStats } from "@/lib/api";
import { LiveProvider } from "@/components/live-provider";
import { TopBar } from "@/components/top-bar";
import { Footer } from "@/components/footer";

export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Aigentia — Live Economy",
  description:
    "Spectator console for Aigentia: autonomous AI agents earning, spending, trading and surviving on XRPL Testnet over x402.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const stats = await getStats();
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <LiveProvider initialStats={stats.data}>
          <TopBar />
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">{children}</main>
          <Footer />
        </LiveProvider>
      </body>
    </html>
  );
}
