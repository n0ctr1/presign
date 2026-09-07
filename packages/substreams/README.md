# @presign/substreams

History that state reads cannot provide: **when** a proxy's logic last changed.

## Why stream instead of poll

R2 already reads the proxy slots and can tell that a contract's logic is
replaceable. What a storage read cannot tell it is when the logic was last
replaced — and that is where the risk actually lives.

*"This contract is upgradeable"* is true of most of DeFi, USDC included, and
earns a shrug. *"This contract's implementation changed forty minutes ago"* is a
different sentence, and it is the shape of the classic rug: deploy something
benign, wait for funds, upgrade.

Answering it needs history rather than state. Polling every proxy's
implementation slot costs an RPC call per contract per interval and still misses
an upgrade that is reverted between two polls. A stream sees every one.

```ts
const index = ProxyUpgradeIndex.create({ apiKey, packagePath, startBlock: -1000 });
void index.run();

const upgrade = index.lastUpgrade(counterparty);
// { proxy, implementation, block, timestamp, txHash } | null
```

## Absence means unknown, not never

`lastUpgrade` returns `null` for a proxy the index has not seen — which covers
both "never upgraded" and "upgraded before we started watching". These are not
the same, and treating the first as proven would turn a gap in observation into
a clean bill of health.

So `watchedSince` is published alongside, and a caller cannot honestly read one
without the other. The index answers *"has this proxy been upgraded within the
window I have been watching"*, and says how wide that window is.

## No Rust

`ethereum-common` v0.3.0 ships a `filtered_events` module whose event signature
is a runtime parameter, so filtering for `Upgraded(address)` needs no WASM
build. The package is vendored here (439 KB) so the stream does not depend on a
registry being reachable at start-up.

## The parameter trap

Parameters mutate the module definitions and must be applied **before** the
request is built:

```ts
applyParams([`filtered_events=evt_sig:${UPGRADED_TOPIC}`], pkg.modules.modules);
const request = createRequest({ substreamPackage: pkg, outputModule: "filtered_events" });
```

`createRequest` has no `params` field. Passing one is silently ignored, the
module keeps the package's default signature, and the stream delivers a
different event entirely while looking perfectly healthy — same block rate, same
shape, plausible volume. We shipped that mistake into a test run and only caught
it by decoding `topics[0]` and comparing.

Which is why `toUpgradeRecord` re-checks the topic client-side even though the
filter runs on the server. It is redundant when everything is correct and it is
the only thing standing between a misapplied parameter and a stream of wrong
events recorded as proxy upgrades.

## Credentials

A **Substreams** API key, from [thegraph.market](https://thegraph.market) or
[streamingfast.io](https://app.streamingfast.io). A Subgraph Studio key does not
work here — the two are both "from The Graph" and are not interchangeable; the
auth exchange rejects a Studio key with a bare `400`.

```bash
printf '%s' 'YOUR_KEY' > ~/.presign/secrets/substreams__api-key
chmod 600 ~/.presign/secrets/substreams__api-key
```

## Measured

Against Ethereum mainnet: 309 blocks streamed in 96 s, 52 distinct proxies
upgraded within that window.
