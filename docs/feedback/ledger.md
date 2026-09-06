# Feedback — Ledger

Track: AI Agents x Ledger.

Scope for this project: two Ledger primitives, not wallet branding.

1. **Device Management Kit (DMK) skills** — escalating a medium-risk verdict to
   on-device confirmation, so a human approves *what* is being signed rather
   than merely attesting *who* the agent is.
2. **Key Ring CLI** — holding the Subgraph Studio key instead of a `.env` file:
   one touch at setup, headless decryption afterwards.

Integration work is scheduled for day 6; these entries come from validating
the device path early so that day 6 is not the day we discover it does not
work.

---

## 2026-09-05 — `@ledgerhq/device-management-kit` 1.9.0 cannot be imported as ESM

**Doing:** a device discovery and connection smoke test before committing to
DMK for the escalation flow.

**Found:** `import { DeviceManagementKitBuilder } from "@ledgerhq/device-management-kit"`
fails on Node 22.14:

```
Error [ERR_UNSUPPORTED_DIR_IMPORT]: Directory import '.../lib/esm/src'
is not supported resolving ES modules imported from .../lib/esm/index.js
```

The shipped `lib/esm/index.js` is one line:

```js
export*from"./src";
```

That is a bare directory specifier. Node's ESM resolver does no directory or
index resolution, so it is invalid — and the package `exports` map points
`import` straight at it:

```json
{ ".": { "import": "./lib/esm/index.js", "require": "./lib/cjs/index.js" } }
```

The CJS build is fine. So the package works under `require` and is broken
under `import`, which is the opposite of what a modern consumer expects.

**Impact:** real but not fatal. Any ESM project — the default for new Node work
and what the DMK's own documentation examples look like — hits this on the
first line. Diagnosis is quick only if you know to look inside `lib/esm`. Our
workaround is `createRequire`:

```js
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { DeviceManagementKitBuilder } = require("@ledgerhq/device-management-kit");
```

**Suggestion:** the bundler needs to emit `export * from "./src/index.js"`
with the explicit filename and extension. Worth adding a CI check that does a
bare `node --input-type=module -e 'import("@ledgerhq/device-management-kit")'`
against the packed tarball — this class of bug is invisible to a test suite
that runs through a bundler or through Jest's CJS interop.

---

## 2026-09-05 — udev: upstream rules grant more than they need, and `uaccess` is not enough headless

**Doing:** getting the device readable by an unprivileged process on a Linux VM.

**Found:** two things worth reporting.

First, a freshly attached Nano X appears as `/dev/hidraw*` owned `root:root` at
mode `0600`. Without rules the DMK fails with a permission error that reads
like a transport bug rather than a configuration one — an expensive thing to
debug under time pressure.

Second, [LedgerHQ/udev-rules](https://github.com/LedgerHQ/udev-rules) sets the
hidraw node to `MODE="0666"`. That is world readable *and writable*: any local
user or process on the machine can talk to the hardware wallet. The device
still requires physical confirmation for anything that matters, so this is not
a key-extraction risk, but it is a wider grant than necessary and it is
avoidable — `GROUP="plugdev", MODE="0660"` works identically for a user already
in `plugdev`, which is the same group convention the rest of the file assumes.

The `TAG+="uaccess"` lines are correct for a desktop session but do nothing
over SSH or in a VM with no active local seat, so they cannot be relied on as
the only mechanism. On a headless box the explicit group on the hidraw node is
the part that does the work.

**Suggestion:** default the hidraw rule to `GROUP="plugdev", MODE="0660"` and
mention in the README that `uaccess` requires a local seat. Our adapted rules
are in [`docs/setup/20-ledger.rules`](../setup/20-ledger.rules).

---

## 2026-09-05 — once connected, the DMK discovery API was clean

**Doing:** the same smoke test.

**Found:** past the import problem, this was quick. `startDiscovering()` is an
observable that emits devices as they appear, `connect()` returns a session id,
and `getConnectedDevice()` gives a typed model back:

```
devices found: 1
  id: 6c70c130-36ab-44b7-9b0e-0a2c5d450232
  model: "nanoX"
CONNECTED -> Ledger Nano X | modelId: nanoX | type: USB
disconnected cleanly
```

Session-id-based connection management is the right shape for our use: the
gateway is long-lived and needs to hold a device handle across many verdicts
rather than reconnecting per signature. No complaints here.

---

## 2026-09-06 — `connect()` needs the discovered object verbatim, and says "Unknown transport" otherwise

**Doing:** wrapping discovery and connection in our own small device class.

**Found:** `startDiscovering()` emits device objects, and `connect({ device })`
must receive **the same object**, unchanged. We projected it onto our own
`{ id, name, model }` shape first — every field we needed was there — and
`connect()` then failed with:

```
TransportNotSupportedError: Unknown transport
```

The emitted object carries a transport identifier that is not part of the
published `DiscoveredDevice`-style type surface, so dropping it is invisible at
compile time and the failure names the transport rather than the missing field.

**Impact:** maybe twenty minutes, and only because the error is misleading.
"Unknown transport" reads like a missing or unregistered transport — a setup or
driver problem — rather than "the object you gave me is not the object I
emitted". We went looking at `nodeHidTransportFactory` registration and udev
before suspecting our own mapping.

**Suggestion:** either type the discovered device as opaque so projecting it is
a compile error, or have `connect()` report `device object is missing its
transport identifier; pass the object emitted by startDiscovering unchanged`.
The second is a one-line change and would have saved the whole detour.

---

## 2026-09-06 — device actions block on physical confirmation with no way to know in advance

**Doing:** listing installed apps to check whether the Ethereum app is present.

**Found:** `ListAppsDeviceAction` reaches
`requiredUserInteraction: "allow-list-apps"` and then waits for a button press.
That is correct and desirable — it is the user's device. But there is no way to
ask beforehand *whether* an action will need physical confirmation, so a
headless or CI caller cannot distinguish "this will block until a human acts"
from "this is slow" until it has already blocked.

`requiredUserInteraction` on the pending state is the right signal and we use
it, but it arrives only once the action is already waiting.

**Suggestion:** expose the required-interaction set statically per device
action, so a caller can decide up front whether to attempt it unattended.

---

## 2026-09-06 — `openApp` fails with "Unknown application name" when the app is absent

**Doing:** the first live signing run against the device.

**Found:** the signer's `openApp` step returned `Unknown application name`. The
Ethereum app is not installed on this device. The message is accurate but
easily misread as "the name string is wrong" — our first instinct was to check
whether the signer passes `"Ethereum"` correctly — rather than "that app is not
on this device".

**Impact:** small, and the chain around it behaved exactly as designed: the
error propagated through the device action into our `device_error` result with
a readable detail, and nothing hung.

**Suggestion:** distinguish the two cases in the message, e.g. `application
"Ethereum" is not installed on this device`. The device already knows which
apps it has.

---

## 2026-09-06 — `device-transport-kit-node-hid` does not filter HID interfaces on Linux

**Doing:** the first live signing run with the Ethereum app installed.

**Found:** every attempt failed with `ReceiverApduError` before reaching the
device screen. The cause is in the transport's own device filter, from its
compiled source with `b = 65440` (`0xFFA0`):

```js
vendorId !== LEDGER_VENDOR_ID ? false
  : (platform === "darwin" || platform === "win32") ? usagePage === b
  : true
```

On Linux the usage-page check is skipped and **every** Ledger HID interface is
accepted. A Nano X with U2F enabled exposes two:

```
/dev/hidraw1  interface 0  usagePage 0xffa0   <- APDU
/dev/hidraw2  interface 2  usagePage 0xf1d0   <- FIDO
```

The FIDO interface cannot carry APDU, so whichever the transport happens to
pick decides whether anything works. The shipped tests cover this case for
darwin and win32 — *"should ignore non-APDU ledger interfaces on darwin"* — but
there is no Linux equivalent.

The device was fine throughout. A raw APDU written to `/dev/hidraw1` answered
immediately:

```
status word: 9000, running app: BOLOS 2.7.1
```

**Impact:** high, and expensive to diagnose. `ReceiverApduError` carries no
indication of which interface was used, so it reads as a device or permissions
problem. We checked udev rules, replugged, and confirmed the device over raw
HID before finding the filter. On a machine where U2F is disabled there is only
one interface and everything works — by luck, not by design.

**Suggestion:** apply the same `usagePage === 0xFFA0` filter on Linux. node-hid
reports usage pages correctly there — the values above are its own output. If
the exemption exists because some older kernels reported `0`, then filter only
when the value is present rather than skipping the check wholesale. Adding the
existing darwin/win32 test case for linux would have caught this.

**Workaround:** we filter `devicesAsync` before the transport is loaded. Note
that patching afterwards does not work: the transport captures the function at
import time (`const w = { devicesAsync: g.devicesAsync, HIDAsync: g.HIDAsync }`),
so the shim has to be installed before the module is required.

---

## 2026-09-06 — `detectBlindSigning` and `blindSignTransactionFallback` are easy to confuse

**Doing:** reporting whether a confirmation was clear-signed.

**Found:** a successful clear-signed ERC-20 approval emits this step sequence:

```
openApp, getAppConfig, parseTransaction, getAddress,
buildContexts, provideContexts, signTransaction, detectBlindSigning
```

`detectBlindSigning` runs on **every** signature — it is the check, not the
outcome. The fallback is a separate step, `blindSignTransactionFallback`. Our
first implementation searched the step list for "blind" and therefore reported
every transaction as blind-signed, including ones the device decoded fully.

**Impact:** ours to fix, and we did. Flagging it because the naming invites the
mistake, and the mistake is silent: the flag reads plausible and is simply
always wrong in one direction.

**Suggestion:** either name the check something without "blind" in it, or
surface the outcome directly on the completed state — a
`clearSigningType`/`wasBlindSigned` field on the output would remove the need
for callers to infer it from a step list at all. The signer already knows.

---

## 2026-09-06 — Key Ring works, but three separate setup steps look like one

**Doing:** holding the Subgraph Studio key in a Ledger Key Ring instead of a
`.env` file.

**Found:** it works, and the protocol is well shaped for this — one device
confirmation authenticates a client into the trustchain and yields an
encryption key, after which encrypt/decrypt are local and need no device. The
`applicationPath` (`m/0'/16'/0'`) deriving a branch per application id is
exactly the right property for several tools sharing one device.

Getting there meant discovering three prerequisites in sequence, each surfacing
only after the previous was satisfied:

1. Device unlocked — `DeviceLockedError`.
2. `Ledger Sync` app installed — device error `6807`, *"Unknown application
   name"*.
3. Trustchain initialised in Ledger Live — *"Ledger Sync must be initialized
   from Ledger Live with this device."*

Step 3 is the one worth flagging. Installing the app and initialising the
trustchain are distinct, and after step 2 it is natural to assume the app is
all that was missing. The message is clear once seen, but it arrives only after
a full authenticate attempt.

**Impact:** three round trips against hardware, each needing a human. For an
integration being written headlessly that is expensive, and none of it is in
the package README — which is a section skeleton with no content at all
(`How it works`, `Installation`, `Use Cases` are empty headings). Every fact
above came from reading `.d.ts` files and compiled sources.

**Suggestions:**

- Fill in the README, or point it at Ledger Live's usage as a reference.
  `authenticate → encryptData/decryptData` is a small, learnable API and the
  absence of any prose is the single biggest cost here.
- Expose a pre-flight check — something like `getTrustchainStatus(sessionId)` —
  returning "locked" / "app missing" / "not initialised" / "ready", so a caller
  can tell a user everything that is wrong at once instead of discovering it a
  step at a time.
- Document how `applicationId` values are assigned. We used `16` because it
  worked; colliding with another application's id would place our keys in its
  branch, and there is no stated way to reserve one.
