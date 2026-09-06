/**
 * Connection to a physical Ledger.
 *
 * The device holds the key; this process never does. That is not a detail of
 * the implementation but the reason the escalation is worth anything: a
 * verdict service that could sign on the user's behalf would be a custodian,
 * and the human confirmation would be theatre.
 */

import { dmkModule, transportModule, type DeviceManagementKit } from "./dmk.js";

export class DeviceUnavailableError extends Error {
  constructor(message: string) {
    super(`no Ledger available: ${message}`);
    this.name = "DeviceUnavailableError";
  }
}

export interface DiscoveredDevice {
  readonly id: string;
  readonly name: string;
  readonly model: string;
}

export interface LedgerDeviceOptions {
  /** How long to look for a device before giving up. */
  readonly discoveryTimeoutMs?: number;
}

export class LedgerDevice {
  readonly sessionId: string;
  readonly model: string;
  readonly name: string;
  readonly #dmk: DeviceManagementKit;

  private constructor(
    dmk: DeviceManagementKit,
    sessionId: string,
    name: string,
    model: string,
  ) {
    this.#dmk = dmk;
    this.sessionId = sessionId;
    this.name = name;
    this.model = model;
  }

  /** The kit instance, for callers that need to build a signer against it. */
  get kit(): DeviceManagementKit {
    return this.#dmk;
  }

  static async connect(options: LedgerDeviceOptions = {}): Promise<LedgerDevice> {
    const dmk = new dmkModule.DeviceManagementKitBuilder()
      .addTransport(transportModule.nodeHidTransportFactory)
      .build();

    const timeoutMs = options.discoveryTimeoutMs ?? 5_000;

    const found = await new Promise<DiscoveredDevice[]>((resolve, reject) => {
      const devices: DiscoveredDevice[] = [];
      const subscription = (
        dmk.startDiscovering({}) as unknown as {
          subscribe(handlers: {
            next: (device: unknown) => void;
            error: (error: unknown) => void;
          }): { unsubscribe(): void };
        }
      ).subscribe({
        next: (device) => {
          const d = device as {
            id?: string;
            name?: string;
            deviceModel?: { model?: string };
          };
          devices.push({
            id: d.id ?? "",
            name: d.name ?? "Ledger",
            model: d.deviceModel?.model ?? "unknown",
          });
        },
        error: reject,
      });

      setTimeout(() => {
        subscription.unsubscribe();
        resolve(devices);
      }, timeoutMs);
    });

    const first = found[0];
    if (first === undefined) {
      throw new DeviceUnavailableError(
        "no device found on the USB bus. Check that it is plugged in and unlocked, " +
          "and that udev rules are installed (see docs/setup/ledger.md)",
      );
    }

    const sessionId = (await dmk.connect({
      device: first as never,
    })) as unknown as string;

    const connected = dmk.getConnectedDevice({ sessionId } as never) as unknown as {
      name?: string;
      modelId?: string;
    };

    return new LedgerDevice(
      dmk,
      sessionId,
      connected.name ?? first.name,
      connected.modelId ?? first.model,
    );
  }

  async disconnect(): Promise<void> {
    await this.#dmk.disconnect({ sessionId: this.sessionId } as never);
  }
}
