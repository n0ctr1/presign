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
