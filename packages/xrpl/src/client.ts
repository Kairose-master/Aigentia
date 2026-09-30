import { AigentiaError, createLogger, errorMessage, sleep, type Logger } from "@aigentia/shared";
import {
  Client,
  ConnectionError,
  RippledError,
  XrplError,
  type Request,
  type ServerInfoResponse,
  type SubmittableTransaction,
  type TxResponse,
} from "xrpl";
import { asRecord, getNumber, getString } from "./internal/tx-parse";
import type {
  SubmitResult,
  TransactionSubmitter,
  XrplNetworkConfig,
  XrplRequestClient,
} from "./types";

export interface XRPLClientOptions {
  /** WebSocket connection timeout in ms (default 15s). */
  readonly connectionTimeout?: number;
  /** Per-request timeout in ms (default 20s). */
  readonly requestTimeout?: number;
  /** Connection attempts before giving up (default 3, exponential backoff). */
  readonly maxConnectAttempts?: number;
  readonly logger?: Logger;
}

export type ServerInfo = ServerInfoResponse["result"]["info"];

/** rippled error code (e.g. "actNotFound", "txnNotFound") carried by an xrpl.js RippledError, if any. */
export function rippledErrorCode(e: unknown): string | null {
  const data = asRecord((e as { data?: unknown } | null)?.data);
  return getString(data, "error");
}

/**
 * Thin wrapper over the xrpl.js WebSocket Client: lazy connection with retry, request
 * passthrough, autofill and reliable submission. Never reads process.env.
 */
export class XRPLClient implements XrplRequestClient, TransactionSubmitter {
  readonly ledger = "testnet" as const;
  readonly config: XrplNetworkConfig;
  private readonly inner: Client;
  private readonly log: Logger;
  private readonly maxConnectAttempts: number;
  private connecting: Promise<void> | undefined;

  constructor(config: XrplNetworkConfig, options: XRPLClientOptions = {}) {
    this.config = config;
    this.log = options.logger ?? createLogger("xrpl.client");
    this.maxConnectAttempts = options.maxConnectAttempts ?? 3;
    this.inner = new Client(config.wssUrl, {
      connectionTimeout: options.connectionTimeout ?? 15_000,
      timeout: options.requestTimeout ?? 20_000,
    });
    this.inner.on("error", (code: unknown, message: unknown) => {
      this.log.warn({ code, message }, "xrpl connection error");
    });
    this.inner.on("disconnected", (code: number) => {
      this.log.info({ code }, "xrpl disconnected");
    });
  }

  networkId(): number {
    return this.config.networkId;
  }

  isConnected(): boolean {
    return this.inner.isConnected();
  }

  /** Connect if needed. Concurrent callers share one attempt. */
  async connect(): Promise<void> {
    if (this.inner.isConnected()) return;
    if (!this.connecting) {
      this.connecting = this.connectWithRetry().finally(() => {
        this.connecting = undefined;
      });
    }
    await this.connecting;
  }

  private async connectWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxConnectAttempts; attempt++) {
      try {
        await this.inner.connect();
        this.log.info({ url: this.config.wssUrl, attempt }, "xrpl connected");
        return;
      } catch (e) {
        lastError = e;
        this.log.warn({ attempt, error: errorMessage(e) }, "xrpl connect failed");
        if (attempt < this.maxConnectAttempts) await sleep(500 * 2 ** (attempt - 1));
      }
    }
    throw new AigentiaError(
      "LEDGER_UNAVAILABLE",
      `could not connect to ${this.config.wssUrl}: ${errorMessage(lastError)}`,
      { url: this.config.wssUrl, attempts: this.maxConnectAttempts },
    );
  }

  async disconnect(): Promise<void> {
    if (this.inner.isConnected()) await this.inner.disconnect();
  }

  /** Send a raw rippled command. Connection failures are retried once, then surface as LEDGER_UNAVAILABLE. */
  async request<T = unknown>(cmd: Record<string, unknown>): Promise<T> {
    await this.connect();
    try {
      return (await this.inner.request(cmd as unknown as Request)) as unknown as T;
    } catch (e) {
      if (e instanceof RippledError) throw e;
      if (e instanceof ConnectionError) {
        this.log.warn({ error: errorMessage(e) }, "xrpl request lost connection, reconnecting");
        await this.connect();
        try {
          return (await this.inner.request(cmd as unknown as Request)) as unknown as T;
        } catch (retryError) {
          if (retryError instanceof RippledError) throw retryError;
          throw new AigentiaError("LEDGER_UNAVAILABLE", errorMessage(retryError), {
            command: cmd["command"],
          });
        }
      }
      throw e;
    }
  }

  async autofill(tx: Record<string, unknown>): Promise<Record<string, unknown>> {
    await this.connect();
    const filled = await this.inner.autofill(tx as unknown as SubmittableTransaction);
    return filled as Record<string, unknown>;
  }

  /** Submit a signed blob and wait for the final validated outcome. */
  async submitAndWait(txBlob: string): Promise<SubmitResult> {
    await this.connect();
    let response: TxResponse;
    try {
      response = await this.inner.submitAndWait(txBlob);
    } catch (e) {
      if (e instanceof XrplError && !(e instanceof ConnectionError)) {
        throw new AigentiaError("PAYMENT_FAILED", e.message, { ledger: this.ledger });
      }
      throw new AigentiaError("LEDGER_UNAVAILABLE", errorMessage(e), { ledger: this.ledger });
    }
    const result = asRecord(response.result) ?? {};
    const meta = asRecord(result["meta"]);
    const deliveredRaw = meta?.["delivered_amount"];
    return {
      hash: getString(result, "hash") ?? "",
      ledgerIndex: getNumber(result, "ledger_index") ?? 0,
      result: getString(meta, "TransactionResult") ?? "unknown",
      validated: result["validated"] === true,
      ...(typeof deliveredRaw === "string" && /^\d+$/.test(deliveredRaw)
        ? { deliveredDrops: BigInt(deliveredRaw) }
        : {}),
      meta,
      ledger: this.ledger,
    };
  }

  async serverInfo(): Promise<ServerInfo> {
    const response = await this.request<ServerInfoResponse>({ command: "server_info" });
    return response.result.info;
  }

  /** Verify the server really is on the configured network (guards against Mainnet). */
  async assertNetwork(): Promise<void> {
    const info = await this.serverInfo();
    if (info.network_id !== this.config.networkId) {
      throw new AigentiaError(
        "LEDGER_UNAVAILABLE",
        `server ${this.config.wssUrl} reports network_id ${String(info.network_id)}, expected ${this.config.networkId}`,
        { expected: this.config.networkId, actual: info.network_id ?? null },
      );
    }
  }
}
