export function Footer(): React.JSX.Element {
  return (
    <footer className="mt-auto border-t border-line">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 font-mono text-[11px] tracking-[0.08em] text-ink-muted">
        <span className="text-ink">XRPL Testnet</span>
        <span aria-hidden>·</span>
        <span className="text-ink">x402</span>
        <span aria-hidden>·</span>
        <span>every settled payment links to a verifiable transaction</span>
        <span className="ml-auto text-ink-dim">no human intervention after start</span>
      </div>
    </footer>
  );
}
