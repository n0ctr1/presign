# @presign/ledger

Escalates a **medium** verdict to on-device human confirmation.

The device holds the key; this process never does. That is not an
implementation detail — a verdict service that could sign on the user's behalf
would be a custodian, and the human confirmation would be theatre.

## What reaches the device

| Verdict | Action | Why |
|---|---|---|
| `low` | sign directly | No rule raised a concern and every rule ran |
| `medium` | **confirm on device** | A human should weigh it, with the transaction in front of them |
| `high` | refuse | — |
| `unavailable` | refuse | — |

The two refusals are the part worth stating plainly.

**A `high` verdict must never be presented to the device.** Showing someone a
transaction we have already concluded is dangerous invites them to approve it.
A prompt is a request, and people approve prompts — especially the tenth one
that day. Refusal has to be refusal, not a confirmation dialog with a scary
title.

**`unavailable` is refused for the same reason.** "I could not check this" is
not a question to delegate to a human who has strictly less information than
the service that gave up.

The policy is re-checked inside `DeviceConfirmation.request` rather than
trusted from the caller. This is the last point before a transaction reaches a
person, and a caller passing a `high` verdict by mistake must not be able to
turn a refusal into a prompt. There is a test asserting the signer is never
even constructed in that case.

## Confirming *what*, not *who*

Asking the device to sign is what makes it display the transaction. That
display is the whole product of this module: the human confirms what the
transaction does, rather than attesting that an agent asked.

Which is why blind signing is reported rather than tolerated. If the device
falls back to it, the human approved an opaque hash and the confirmation
carries far less meaning than it appears to:

```ts
const result = await confirmation.request(transaction, verdict);
if (result.approved && !result.clearSigned) {
  // A hash was approved, not a decoded transaction. Treat accordingly.
}
```

A decline is also not an error. Status word `0x6985` — *conditions of use not
satisfied* — is the user pressing reject, and reporting it as a device fault
would hide a deliberate human decision.

## Two transaction shapes

`SignableTransaction` is deliberately distinct from the `UnsignedTransaction`
the rules judge. Risk assessment needs `from`, `to`, `value`, `data` and
`chainId`; a signature additionally commits to a nonce and a fee. Conflating
them would let a caller believe the thing that was assessed is byte-for-byte
the thing that gets signed, when a nonce or fee chosen afterwards makes it a
different transaction.

## Usage

```ts
const device = await LedgerDevice.connect();
const confirmation = new DeviceConfirmation({ device });

const decision = decideEscalation(verdict);
if (decision.action === "confirm_on_device") {
  const result = await confirmation.request(signable, verdict);
}
```

## The DMK import problem

`@ledgerhq/device-management-kit@1.9.0` cannot be imported as ESM. Its shipped
`lib/esm/index.js` is one line — `export*from"./src"` — a bare directory
specifier Node's resolver rejects with `ERR_UNSUPPORTED_DIR_IMPORT`, and the
package's `exports` map points `import` straight at it. The CJS build is fine,
so the package works under `require` and breaks under `import`.

The `createRequire` workaround is confined to [`src/dmk.ts`](./src/dmk.ts) so
the rest of the package reads normally and removing it later is a one-file
change. Types still come from the package's own declarations; only runtime
values are required. Reported in
[`docs/feedback/ledger.md`](../../docs/feedback/ledger.md).

## Device setup

See [`docs/setup/ledger.md`](../../docs/setup/ledger.md). A freshly attached
Ledger is `root:root` mode `0600` and unreachable until udev rules are
installed.

---

# Key Ring: the Studio key without a `.env` file

The second Ledger primitive. The device authenticates this client into a
trustchain and returns an encryption key; secrets are encrypted with it and
only ciphertext is written to disk.

```ts
const source = await LedgerKeyRingSecretSource.unlock({ device, vaultPath });
await source.store({ scope: "the-graph", name: "studio-api-key" }, key);

// Later, same process, no device interaction:
const { value } = await resolver.resolve({ scope: "the-graph", name: "studio-api-key" });
```

Chain it ahead of the file and env sources, and a deployment can demand
`minimumProtection: "hardware"` and fail at startup rather than quietly falling
back to a dotfile.

## What this guarantees, stated precisely

The tempting summary is stronger than the truth, so:

**What holds.** The Studio key never exists in plaintext on disk — there is a
test asserting the vault file does not contain it. Trustchain membership is
revocable from the device, and revoking it makes existing ciphertext
undecryptable. Neither property holds for a `.env` file.

**What does not.** The encryption key is in process memory after unlock, so
anything that can read this process can read it. That is precisely why it is
never persisted: writing a member key to disk would let anyone with the
filesystem reconstruct the encryption key at will, which is `process`
protection wearing a hardware label. One device touch per process start is the
price of the stronger claim.

The protocol's types permit a fully headless path — `authenticate` accepts a
`trustchainId` instead of a device session — but taking it would mean storing a
member private key locally, and `protection: "hardware"` would then be a
misstatement. We chose the touch.

## Requirements

Three, and two are outside this repo:

| | |
|---|---|
| **`Ledger Sync` app on the device** | The trusted app the protocol opens. Installed by enabling Ledger Sync in Ledger Live; not resolvable in the public app catalogue. Its absence surfaces as device error `6807`. |
| **Ledger's trustchain backend** | `https://trustchain.api.live.ledger.com/v1`. The trustchain is not local. |
| **An `applicationId`** | Separates this application's derived keys from others' in the trustchain. |

Device error `6807` arrives as *"Unknown application name"*, which reads like a
wrong name string rather than a missing install. It is translated into
`device_app_missing` with the remedy, because that misreading cost real time
here.

## Status

Implemented and unit-tested against an injected protocol; the encryption
round-trip, the vault format, and both device error paths are covered.
**Not yet verified against hardware** — the device used for development has no
`Ledger Sync` app, and the authenticate flow stops at `6807`. Everything up to
that point is confirmed live: the device unlocks, the protocol builds, and the
action reaches `lkrp.steps.openApp` with `confirm-open-app`.
