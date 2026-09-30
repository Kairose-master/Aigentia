import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { getStats } from "@/lib/api";
import { LiveProvider } from "@/components/live-provider";
import { TopBar } from "@/components/top-bar";
import { Footer } from "@/components/footer";
import { SnapshotBanner } from "@/components/snapshot-banner";
import { dataMode } from "@/lib/data-mode";
import { getSnapshotMeta } from "@/lib/snapshot";

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
  title: dataMode() === "snapshot" ? "Aigentia — Recorded Testnet Run" : "Aigentia — Live Economy",
  description:
    "Spectator console for Aigentia: autonomous AI agents earning, spending, trading and surviving on XRPL Testnet over x402.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<React.JSX.Element> {
  const mode = dataMode();
  const [stats, snapshot] = await Promise.all([
    getStats(),
    mode === "snapshot" ? getSnapshotMeta() : Promise.resolve(null),
  ]);
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <LiveProvider
          initialStats={stats.data}
          mode={mode}
          snapshotRecordedAt={snapshot?.recordedAt ?? null}
        >
          <TopBar />
          {snapshot ? <SnapshotBanner meta={snapshot} /> : null}
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 py-5">{children}</main>
          <Footer />
        </LiveProvider>
      </body>
    </html>
  );
}
