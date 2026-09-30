/**
 * Where the dashboard gets its data.
 *
 *   live     → the Aigentia API (NEXT_PUBLIC_API_URL) plus its SSE stream. Default.
 *   snapshot → a recorded export of a real XRPL Testnet run, bundled at build time. Used when
 *              the dashboard is hosted without a reachable API (e.g. on Vercel). Every
 *              transaction in it is a real, validated Testnet transaction with an explorer link;
 *              the UI labels the data as a recorded snapshot and never claims it is live.
 */
export type DataMode = "live" | "snapshot";

export function dataMode(): DataMode {
  return process.env.NEXT_PUBLIC_DATA_MODE === "snapshot" ? "snapshot" : "live";
}
