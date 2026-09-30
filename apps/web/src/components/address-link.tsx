import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  explorerAccountUrl,
  resolveTxLink,
  shortAddress,
  shortHash,
  type LedgerKind,
} from "@/lib/format";
import { MockBadge } from "@/components/ledger-badge";

/** XRPL account address with an explorer link (mock ledgers get a MOCK badge, no link). */
export function AddressLink({
  address,
  ledger,
  explorerUrl,
  className,
  full = false,
}: {
  address: string | null | undefined;
  ledger?: LedgerKind | null;
  explorerUrl?: string | null;
  className?: string;
  full?: boolean;
}): React.JSX.Element {
  if (!address) return <span className="text-ink-dim">—</span>;
  const label = full ? address : shortAddress(address);
  if (ledger === "mock") {
    return (
      <span className={cn("inline-flex items-center gap-1.5 font-mono text-xs", className)}>
        <span className="text-ink" title={address}>
          {label}
        </span>
        <MockBadge />
      </span>
    );
  }
  const href = explorerUrl && explorerUrl.length > 0 ? explorerUrl : explorerAccountUrl(address);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={address}
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs text-live/90 underline-offset-2 hover:underline",
        className,
      )}
    >
      {label}
      <ExternalLink className="size-3 opacity-60" aria-hidden />
    </a>
  );
}

/** Transaction hash with an explorer link, or a MOCK badge for the in-process ledger. */
export function TxLink({
  txHash,
  ledger,
  explorerUrl,
  className,
}: {
  txHash: string | null | undefined;
  ledger?: LedgerKind | null;
  explorerUrl?: string | null;
  className?: string;
}): React.JSX.Element {
  if (!txHash) return <span className="font-mono text-xs text-ink-dim">—</span>;
  const { href, mock } = resolveTxLink({ txHash, ledger, explorerUrl });
  if (!href) {
    return (
      <span className={cn("inline-flex items-center gap-1.5 font-mono text-xs", className)}>
        <span className="text-ink" title={txHash}>
          {shortHash(txHash)}
        </span>
        {mock && <MockBadge />}
      </span>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={txHash}
      className={cn(
        "inline-flex items-center gap-1 font-mono text-xs text-ok/90 underline-offset-2 hover:underline",
        className,
      )}
    >
      {shortHash(txHash)}
      <ExternalLink className="size-3 opacity-60" aria-hidden />
    </a>
  );
}
