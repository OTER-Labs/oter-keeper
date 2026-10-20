/**
 * Build, preview, sign, submit and poll one transaction.
 *
 * The safety order is fixed: build, preview, and only then consider submitting. A preview
 * the Engine refused is reported and never forced; a dry run stops after the preview. When
 * live submission is on, the spending limits are checked against the account's balance and
 * the local daily ledger before anything is signed and sent.
 */

import {
  LTSNotarizedTransaction,
  ManifestBuilder,
  RadixEngineToolkit,
  TransactionBuilder,
  decimal,
  type PrivateKey,
  type TransactionHeader,
  type TransactionManifest,
  type Value,
} from "@radixdlt/radix-engine-toolkit";

import { NETWORK_IDS, type NetworkName } from "./config.ts";
import { GatewayError, type Gateway } from "./gateway.ts";
import { formatXrd, parseXrd, type Limits } from "./limits.ts";

export interface Call {
  component: string;
  method: string;
  args: readonly Value[];
}

/** A manifest before the fee payer's lock-fee call is added by the executor. */
export interface Manifest {
  readonly calls: readonly Call[];
  /**
   * For a manifest that needs instructions beyond one method call, such as moving a bucket
   * through a component. When present it replaces `calls`; the executor has already added the
   * lock-fee call to the builder it receives.
   */
  readonly build?: (builder: ManifestBuilder) => ManifestBuilder;
}

export function buildCall(
  component: string,
  method: string,
  args: Value[] = [],
): Manifest {
  return { calls: [{ component, method, args }] };
}

/** Wrap a sequence of manifest-builder steps as a Manifest. */
export function buildManifest(
  build: (builder: ManifestBuilder) => ManifestBuilder,
): Manifest {
  return { calls: [], build };
}

export type Outcome =
  | "dry_run"
  | "previewed_refused"
  | "submitted"
  | "committed"
  | "failed"
  | "over_limit";

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const consoleLogger: Logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(message),
  error: (message) => console.error(message),
};

export interface ExecutorOptions {
  gateway: Gateway;
  network: NetworkName;
  account: string;
  privateKey: PrivateKey;
  liveSubmit: boolean;
  /** The lock fee put on every transaction, and the amount checked against the limits. */
  maxFeePerTx: bigint;
  limits: Limits;
  /** Reads the fee payer's XRD balance in atto-XRD; defaults to a Gateway read. */
  balance?: () => Promise<bigint>;
  logger?: Logger;
  pollAttempts?: number;
  pollDelayMs?: number;
  randomNonce?: () => number;
}

interface PreviewReceipt {
  receipt?: {
    status?: string;
    error_message?: string | null;
  };
}

interface TransactionStatus {
  intent_status?: string;
  status?: string;
  error_message?: string | null;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0
    ? Promise.resolve()
    : new Promise((resolve) => setTimeout(resolve, ms));
}

export class Executor {
  private readonly options: ExecutorOptions;
  private readonly logger: Logger;
  private readonly networkId: number;
  private readonly pollAttempts: number;
  private readonly pollDelayMs: number;
  private readonly randomNonce: () => number;

  constructor(options: ExecutorOptions) {
    this.options = options;
    this.logger = options.logger ?? consoleLogger;
    this.networkId = NETWORK_IDS[options.network];
    this.pollAttempts = Math.max(1, options.pollAttempts ?? 10);
    this.pollDelayMs = Math.max(0, options.pollDelayMs ?? 1_000);
    this.randomNonce =
      options.randomNonce ?? (() => Math.floor(Math.random() * 0x7ffffffe) + 1);
  }

  async run(manifest: Manifest, label: string): Promise<Outcome> {
    const built = this.buildManifest(manifest);
    const manifestString = await this.manifestString(built);
    const status = await this.options.gateway.status();
    const epoch = status.ledger_state.epoch;
    const nonce = this.randomNonce();
    const header: TransactionHeader = {
      networkId: this.networkId,
      startEpochInclusive: epoch,
      endEpochExclusive: epoch + 10,
      nonce,
      notaryPublicKey: this.options.privateKey.publicKey(),
      notaryIsSignatory: true,
      tipPercentage: 0,
    };

    const preview = await this.preview(manifestString, header);
    if (preview.receipt?.status !== "Succeeded") {
      const reason = preview.receipt?.error_message ?? preview.receipt?.status ?? "no receipt";
      // A refused preview is ordinary for a keeper: the work was taken by someone else, or
      // the window has not closed yet. It is reported and retried, never treated as a failure.
      this.logger.info(`[${label}] preview refused: ${String(reason)}`);
      return "previewed_refused";
    }

    if (!this.options.liveSubmit) {
      this.logger.info(`[${label}] dry run: preview succeeded, nothing submitted`);
      return "dry_run";
    }

    const balance = await this.balance();
    const decision = this.options.limits.check(this.options.maxFeePerTx, balance);
    if (!decision.allowed) {
      this.logger.warn(`[${label}] over limit: ${decision.reason ?? "limit refused"}`);
      return "over_limit";
    }

    const notarized = await (
      await TransactionBuilder.new()
    )
      .header(header)
      .manifest(built)
      .sign(this.options.privateKey)
      .notarize(this.options.privateKey);
    const transaction = new LTSNotarizedTransaction(notarized);
    const compiled = await transaction.compile();
    const intentHash = (await transaction.transactionId()).id;

    try {
      await this.options.gateway.post("/transaction/submit", {
        notarized_transaction_hex: Buffer.from(compiled).toString("hex"),
      });
    } catch (error) {
      const duplicate =
        error instanceof GatewayError &&
        error.status === 400 &&
        /duplicate/i.test(error.message);
      if (!duplicate) throw error;
    }

    this.options.limits.record(this.options.maxFeePerTx);
    this.logger.info(`[${label}] submitted ${intentHash}`);

    let lastStatus = "Pending";
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      const answer = await this.options.gateway.post<TransactionStatus>(
        "/transaction/status",
        { intent_hash: intentHash },
      );
      lastStatus = answer.intent_status ?? answer.status ?? "Unknown";

      if (lastStatus === "CommittedSuccess" || answer.status === "CommittedSuccess") {
        this.logger.info(`[${label}] committed ${intentHash}`);
        return "committed";
      }
      if (
        lastStatus === "CommittedFailure" ||
        lastStatus === "Rejected" ||
        lastStatus === "PermanentlyRejected" ||
        answer.status === "CommittedFailure" ||
        answer.status === "Rejected"
      ) {
        const reason = answer.error_message ?? lastStatus;
        this.logger.warn(`[${label}] failed ${intentHash}: ${reason}`);
        return "failed";
      }

      if (attempt < this.pollAttempts - 1) await sleep(this.pollDelayMs);
    }

    this.logger.info(`[${label}] submitted ${intentHash}, still ${lastStatus}`);
    return "submitted";
  }

  private buildManifest(manifest: Manifest): TransactionManifest {
    const builder = new ManifestBuilder().callMethod(this.options.account, "lock_fee", [
      decimal(formatXrd(this.options.maxFeePerTx)),
    ]);
    if (manifest.build !== undefined) {
      return manifest.build(builder).build();
    }
    for (const call of manifest.calls) {
      builder.callMethod(call.component, call.method, [...call.args]);
    }
    return builder.build();
  }

  private async manifestString(manifest: TransactionManifest): Promise<string> {
    const converted = await RadixEngineToolkit.Instructions.convert(
      manifest.instructions,
      this.networkId,
      "String",
    );
    if (converted.kind !== "String") {
      throw new Error("the toolkit did not render the manifest as a string");
    }
    return converted.value;
  }

  private async preview(
    manifest: string,
    header: TransactionHeader,
  ): Promise<PreviewReceipt> {
    const keyHex = Buffer.from(this.options.privateKey.publicKeyBytes()).toString("hex");
    const publicKey = { key_type: "EddsaEd25519", key_hex: keyHex };
    try {
      return await this.options.gateway.post<PreviewReceipt>("/transaction/preview", {
        manifest,
        start_epoch_inclusive: header.startEpochInclusive,
        end_epoch_exclusive: header.endEpochExclusive,
        notary_public_key: publicKey,
        notary_is_signatory: header.notaryIsSignatory,
        tip_percentage: header.tipPercentage,
        nonce: header.nonce,
        signer_public_keys: [publicKey],
        flags: {
          use_free_credit: true,
          assume_all_signature_proofs: false,
          skip_epoch_check: true,
        },
      });
    } catch (error) {
      if (
        error instanceof GatewayError &&
        (error.status === 400 || error.status === 422)
      ) {
        return { receipt: { status: "Refused", error_message: error.message } };
      }
      throw error;
    }
  }

  private async balance(): Promise<bigint> {
    if (this.options.balance !== undefined) return this.options.balance();
    const amount = await this.options.gateway.accountXrdBalance(this.options.account);
    return parseXrd(amount);
  }
}
