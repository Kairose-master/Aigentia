function trimBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/** `${base}/transactions/${hash}` */
export function explorerTxUrl(base: string, hash: string): string {
  return `${trimBase(base)}/transactions/${hash}`;
}

/** `${base}/accounts/${address}` */
export function explorerAccountUrl(base: string, address: string): string {
  return `${trimBase(base)}/accounts/${address}`;
}
