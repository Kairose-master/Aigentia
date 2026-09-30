import { dataMode } from "@/lib/data-mode";
import Link from "next/link";
import { getTransactions } from "@/lib/api";
import { Panel, PageHeader, OfflineBanner, EmptyState } from "@/components/panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Money } from "@/components/money";
import { StatusChip } from "@/components/status-chip";
import { TxLink } from "@/components/address-link";
import { LedgerBadge } from "@/components/ledger-badge";
import { shortAddress, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

function Party({
  id,
  name,
  address,
}: {
  id: string | null;
  name: string | null;
  address: string;
}): React.JSX.Element {
  if (id) {
    return (
      <Link href={`/agents/${id}`} className="font-mono text-xs hover:text-live" title={address}>
        {name ?? id}
      </Link>
    );
  }
  return (
    <span className="font-mono text-xs text-ink-muted" title={address}>
      {name ?? shortAddress(address)}
    </span>
  );
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.JSX.Element> {
  const sp = await searchParams;
  const cursorRaw = sp.cursor;
  const cursor = typeof cursorRaw === "string" && cursorRaw.length > 0 ? cursorRaw : undefined;
  const result = await getTransactions({ cursor, limit: PAGE_SIZE });
  const offline = result.error?.offline === true;
  const payments = result.data?.payments ?? [];
  const nextCursor = result.data?.nextCursor ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Transactions"
        subtitle="Every payment the economy attempted. Validated rows link to the XRPL Testnet explorer; denied and failed rows never touched the ledger."
        action={
          <span className="font-mono text-[11px] tracking-[0.14em] text-ink-muted uppercase">
            {cursor ? `page after ${cursor.slice(0, 12)}…` : "newest"}
          </span>
        }
      />
      {offline && <OfflineBanner />}
      <Panel eyebrow="Ledger" title="Payments">
        {payments.length === 0 ? (
          result.error?.code === "NOT_FOUND" ? (
            <EmptyState
              title="This page is not part of the recorded snapshot."
              detail={result.error.message}
            />
          ) : (
            <EmptyState
              offline={offline}
              title="No payments recorded."
              detail={
                dataMode() === "snapshot"
                  ? "The recorded run contains no payments."
                  : "The first x402 purchase or transfer will appear here with its tx hash."
              }
            />
          )
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="text-[10px] tracking-[0.14em] text-ink-muted uppercase">
                <TableHead>Kind</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Sender → Receiver</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Ledger</TableHead>
                <TableHead>Tx hash</TableHead>
                <TableHead>Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {payments.map((p) => (
                <TableRow
                  key={p.id}
                  className={cn(p.status === "failed" || p.status === "denied" ? "opacity-80" : "")}
                >
                  <TableCell className="font-mono text-[11px] text-ink-muted uppercase">
                    {p.kind}
                  </TableCell>
                  <TableCell>
                    <StatusChip status={p.status} />
                    {p.error && (
                      <span className="ml-2 text-[11px] text-bad" title={p.error}>
                        {p.error.slice(0, 40)}
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-2">
                      <Party id={p.senderAgentId} name={p.senderName} address={p.senderAddress} />
                      <span className="text-ink-dim">→</span>
                      <Party
                        id={p.receiverAgentId}
                        name={p.receiverName}
                        address={p.receiverAddress}
                      />
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    <Money
                      drops={p.amountDrops}
                      tone={
                        p.status === "validated"
                          ? "ok"
                          : p.status === "denied" || p.status === "failed"
                            ? "bad"
                            : "warn"
                      }
                      className="text-xs"
                    />
                  </TableCell>
                  <TableCell>
                    <LedgerBadge ledger={p.ledger} className="h-5 text-[9px]" />
                  </TableCell>
                  <TableCell>
                    <TxLink txHash={p.txHash} ledger={p.ledger} explorerUrl={p.explorerUrl} />
                  </TableCell>
                  <TableCell
                    className="font-mono text-[11px] text-ink-muted"
                    title={p.validatedAt ?? p.createdAt}
                  >
                    {timeAgo(p.validatedAt ?? p.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div className="flex items-center gap-3 border-t border-line px-3 py-2 font-mono text-[11px] tracking-[0.14em] uppercase">
          {cursor && (
            <Link href="/transactions" className="text-ink-muted hover:text-live">
              « newest
            </Link>
          )}
          <span className="text-ink-dim">{payments.length} rows</span>
          {nextCursor && (
            <Link
              href={`/transactions?cursor=${encodeURIComponent(nextCursor)}`}
              className="ml-auto rounded-sm border border-line-strong px-2 py-0.5 text-ink hover:border-live/50 hover:text-live"
            >
              older →
            </Link>
          )}
        </div>
      </Panel>
    </div>
  );
}
