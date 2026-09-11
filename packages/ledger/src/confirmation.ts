/**
 * On-device confirmation of a medium-risk transaction.
 *
 * The device is asked to sign, which makes it display what it is signing. That
 * display is the entire product of this module: the human is confirming *what*
 * the transaction does, not merely attesting that an agent asked. An
 * "approve?" prompt showing an opaque hash would be worth nothing, which is
 * why blind signing is reported rather than quietly tolerated.
 */

import { serializeTransaction, type Hex } from "viem";

import type { Verdict, UnsignedTransaction } from "@presign/verdict-engine";

import { DeviceActionStatus, signerModule } from "./dmk.js";
import type { LedgerDevice } from "./device.js";
import { decideEscalation } from "./escalation.js";

/**
 * A transaction complete enough to sign.
 *
 * Deliberately a separate type from the one the rules judge. Risk assessment
 * needs `from`, `to`, `value`, `data` and `chainId`; a signature additionally
 * commits to a nonce and a fee. Conflating them would let a caller believe the
 * thing that was assessed is byte-for-byte the thing that gets signed, when a
 * nonce or fee chosen afterwards makes it a different transaction.
 */
export interface SignableTransaction extends UnsignedTransaction {
  readonly nonce: number;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
}

export interface Signature {
  readonly r: Hex;
  readonly s: Hex;
  readonly v: number;
}

export type ConfirmationResult =
  | {
      readonly approved: true;
      readonly signature: Signature;
      /**
       * False when the device fell back to blind signing.
       *
       * The human then approved a hash rather than a decoded transaction, so
       * the confirmation carries far less meaning than it appears to. Surfaced
       * so a caller can refuse to treat it as a real approval.
       */
      readonly clearSigned: boolean;
      readonly steps: readonly string[];
    }
  | {
      readonly approved: false;
      readonly reason:
        | "rejected_on_device"
        | "cancelled"
        | "not_escalated"
        | "device_error"
        | "timeout";
      readonly detail: string;
    };

/**
 * The step the signer emits when it gives up on decoding and falls back to
 * signing an opaque hash.
 *
 * Matched exactly rather than by searching for "blind". The signer also emits
 * `detectBlindSigning`, which is the *check* and runs on every signature, so a
 * substring match reports every transaction as blind-signed — including ones
 * the device decoded perfectly. That is a false claim in the direction that
 * matters least safely: it understates a real confirmation, and a caller
 * taught to ignore the flag would then also ignore it when it is true.
 */
const BLIND_SIGN_FALLBACK_STEP = "signer.eth.steps.blindSignTransactionFallback";

/**
 * The step a decoded signature passes through, recorded from a Nano X.
 *
 * Clear signing is claimed only on evidence of it. Reading "no fallback step
 * seen" as clear signing would call a signature clear whenever the step is
 * renamed in a new signer release, or whenever no intermediate states arrive
 * at all — a detector that fails open on exactly the change nobody announces.
 */
const SIGN_TRANSACTION_STEP = "signer.eth.steps.signTransaction";

/** Default BIP-44 path for the first Ethereum account. */
export const DEFAULT_DERIVATION_PATH = "44'/60'/0'/0/0";

/** The slice of the Ethereum signer this module uses. */
export interface TransactionSigner {
  signTransaction(
    derivationPath: string,
    transaction: Uint8Array,
  ): {
    observable: {
      subscribe(handlers: {
        next: (state: Record<string, unknown>) => void;
        error: (error: unknown) => void;
      }): { unsubscribe(): void };
    };
    cancel: () => void;
  };
  /** Read the address at a path. Optional so older test doubles still fit. */
  getAddress?(
    derivationPath: string,
    options?: { checkOnDevice?: boolean },
  ): {
    observable: {
      subscribe(handlers: {
        next: (state: Record<string, unknown>) => void;
        error: (error: unknown) => void;
      }): { unsubscribe(): void };
    };
    cancel: () => void;
  };
}

export interface DeviceConfirmationOptions {
  readonly device: LedgerDevice;
  /**
   * Build the signer for a device. Defaults to the real Ethereum signer kit;
   * injected in tests so the device-action state machine — rejection, blind
   * signing, timeout — can be exercised without hardware in the loop.
   */
  readonly signerFactory?: (device: LedgerDevice) => TransactionSigner;
  readonly derivationPath?: string;
  /** How long to wait for the human. */
  readonly timeoutMs?: number;
  /** Called as the device action progresses, for operator visibility. */
  readonly onProgress?: (interaction: string) => void;
}

function defaultSignerFactory(device: LedgerDevice): TransactionSigner {
  return new signerModule.SignerEthBuilder({
    dmk: device.kit,
    sessionId: device.sessionId,
  }).build() as unknown as TransactionSigner;
}

export class DeviceConfirmation {
  readonly #device: LedgerDevice;
  readonly #signerFactory: (device: LedgerDevice) => TransactionSigner;
  readonly #derivationPath: string;
  readonly #timeoutMs: number;
  readonly #onProgress: ((interaction: string) => void) | undefined;

  constructor(options: DeviceConfirmationOptions) {
    this.#device = options.device;
    this.#signerFactory = options.signerFactory ?? defaultSignerFactory;
    this.#derivationPath = options.derivationPath ?? DEFAULT_DERIVATION_PATH;
    this.#timeoutMs = options.timeoutMs ?? 120_000;
    this.#onProgress = options.onProgress;
  }

  /**
   * The address this confirmation signs with, read without a prompt.
   *
   * A caller that treats a device signature as a human's approval has to
   * check the signature came from this device's key over the exact bytes it
   * meant to approve. That check needs the address, and asking the human to
   * confirm an address they did not choose would be a prompt with nothing to
   * decide.
   */
  address(): Promise<string> {
    const signer = this.#signerFactory(this.#device);
    if (signer.getAddress === undefined) {
      return Promise.reject(new Error("this signer cannot read addresses"));
    }
    const action = signer.getAddress(this.#derivationPath, { checkOnDevice: false });

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscription.unsubscribe();
        fn();
      };
      const timer = setTimeout(() => {
        action.cancel();
        finish(() => reject(new Error("no address from the device within 30s")));
      }, 30_000);
      const subscription = action.observable.subscribe({
        next: (state) => {
          if (state["status"] === DeviceActionStatus.Completed) {
            const output = state["output"] as { address?: string };
            finish(() =>
              typeof output?.address === "string"
                ? resolve(output.address)
                : reject(new Error("the device returned no address")),
            );
          } else if (
            state["status"] === DeviceActionStatus.Error ||
            state["status"] === DeviceActionStatus.Stopped
          ) {
            const error = state["error"] as { message?: string } | undefined;
            finish(() =>
              reject(new Error(error?.message ?? "the device could not read an address")),
            );
          }
        },
        error: (error) =>
          finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
      });
    });
  }

  /**
   * Ask the device to sign, which asks the human to look.
   *
   * The escalation decision is re-checked here rather than trusted from the
   * caller. This is the last point before a transaction reaches a human, and a
   * caller that passes a `high` verdict by mistake must not be able to turn a
   * refusal into a prompt.
   */
  async request(
    transaction: SignableTransaction,
    verdict: Verdict,
  ): Promise<ConfirmationResult> {
    const decision = decideEscalation(verdict);
    if (decision.action !== "confirm_on_device") {
      return {
        approved: false,
        reason: "not_escalated",
        detail: `verdict tier ${verdict.tier} calls for "${decision.action}", not device confirmation: ${decision.rationale}`,
      };
    }

    const serialized = serializeTransaction({
      type: "eip1559",
      chainId: transaction.chainId,
      nonce: transaction.nonce,
      to: transaction.to ?? undefined,
      value: transaction.value,
      data: transaction.data,
      gas: transaction.gasLimit,
      maxFeePerGas: transaction.maxFeePerGas,
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
    });

    // viem returns a 0x-prefixed hex string; the signer wants raw bytes.
    const bytes = Uint8Array.from(
      (serialized.slice(2).match(/.{2}/g) ?? []).map((byte) => parseInt(byte, 16)),
    );

    return this.#awaitDevice(this.#signerFactory(this.#device), bytes);
  }

  #awaitDevice(
    signer: TransactionSigner,
    bytes: Uint8Array,
  ): Promise<ConfirmationResult> {
    return new Promise<ConfirmationResult>((resolve) => {
      const steps: string[] = [];
      let settled = false;

      const action = signer.signTransaction(this.#derivationPath, bytes);

      const finish = (result: ConfirmationResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscription.unsubscribe();
        resolve(result);
      };

      const timer = setTimeout(() => {
        action.cancel();
        finish({
          approved: false,
          reason: "timeout",
          detail: `no response from the device within ${this.#timeoutMs}ms`,
        });
      }, this.#timeoutMs);

      const subscription = action.observable.subscribe({
        next: (state) => {
          const status = state["status"];

          if (status === DeviceActionStatus.Pending) {
            const intermediate = state["intermediateValue"] as
              | { requiredUserInteraction?: string; step?: string }
              | undefined;
            const label =
              intermediate?.step ?? intermediate?.requiredUserInteraction ?? "";
            if (label !== "" && steps[steps.length - 1] !== label) {
              steps.push(label);
              this.#onProgress?.(label);
            }
            return;
          }

          if (status === DeviceActionStatus.Completed) {
            const output = state["output"] as Signature;
            finish({
              approved: true,
              signature: output,
              // If a fallback step appears, the human approved a hash rather
              // than a decoded transaction; if the signing step never did,
              // nothing shows the device decoded anything.
              clearSigned:
                steps.includes(SIGN_TRANSACTION_STEP) &&
                !steps.some((step) => step === BLIND_SIGN_FALLBACK_STEP || /fallback/i.test(step)),
              steps,
            });
            return;
          }

          if (status === DeviceActionStatus.Stopped) {
            /*
             * Stopped means the device action was halted, which is not the
             * same as a person pressing reject. An earlier version reported it
             * as a decline, and a transport fault then surfaced as "the human
             * refused" — a service built on the honesty of its verdicts must
             * not invent a human decision that never happened. A real
             * rejection arrives as an Error carrying status word 0x6985 and is
             * handled below.
             */
            finish({
              approved: false,
              reason: "cancelled",
              detail: "the device action stopped before the transaction was signed",
            });
            return;
          }

          if (status === DeviceActionStatus.Error) {
            const error = state["error"] as {
              _tag?: string;
              message?: string;
              errorCode?: string;
            };
            const message = error?.message ?? error?._tag ?? "unknown device error";

            /*
             * A decline is reported through `errorCode`, not through the
             * message. Recorded from a Nano X:
             *
             *   { _tag: "EthAppCommandError",
             *     errorCode: "6985",
             *     message: "Condition not satisfied" }
             *
             * `6985` is "conditions of use not satisfied" — the user pressed
             * reject. An earlier version matched on the message text, which
             * contains none of the words one would look for, so a deliberate
             * human decision was classified as a device fault and the person's
             * "no" was lost. Read the code, not the prose.
             */
            const rejected =
              error?.errorCode === "6985" || /\b6985\b/.test(message);

            finish({
              approved: false,
              reason: rejected ? "rejected_on_device" : "device_error",
              detail: rejected ? `declined on the device (${message})` : message,
            });
          }
        },
        error: (error) => {
          finish({
            approved: false,
            reason: "device_error",
            detail: error instanceof Error ? error.message : String(error),
          });
        },
      });
    });
  }
}
