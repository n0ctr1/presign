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
