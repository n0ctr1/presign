# Feedback — Hedera

Track: AI & Agentic Payments.

What we built: an x402-gated verdict service settled on Hedera, an agent that
pays per call, and a verdict journal on the Consensus Service.

---

## 2026-09-07 — the two facilitators split by network, and nothing says so

**Doing:** choosing a facilitator for an x402 service on Hedera.

**Found:** they do not overlap. Querying each directly:

```
GET https://x402.org/facilitator/supported
  → {"scheme":"exact","network":"hedera:testnet","extra":{"feePayer":"0.0.9185802"}}

GET https://api.blocky402.com/supported
  → {"scheme":"exact","network":"hedera:mainnet","extra":{"feePayer":"0.0.10571514"}}
```

x402.org settles testnet only; Blocky402 settles mainnet only. The reference
PoC reflects this in its route table, but we found it by querying the two
`/supported` endpoints rather than from any document.

**Impact:** this decides the shape of a submission. The track requires
settlement "through the Blocky402 facilitator", and Blocky402 is mainnet-only —
so a qualifying paid request costs real money, however little. Teams
developing on testnet will build the whole thing against x402.org and discover
at submission time that the required facilitator is a different one on a
different network. Pointing the wrong facilitator at a network fails during
startup sync with no message naming the mismatch.

**Suggestion:** state the split in the track requirements, or in the Blocky402
docs. One sentence — "Blocky402 settles mainnet; use x402.org for testnet
development" — removes the surprise entirely. Better still would be Blocky402
supporting testnet so the same code path is exercised throughout.

---

## 2026-09-07 — spend controls reject HBAR by default, which is right and surprising

**Doing:** the first paid request from the agent.

**Found:** it refused to pay.

```
All payment requirements were rejected by spendControls: only default
assets or entries in spendControls.allowedAssets are allowed.
```

The x402 client will not spend assets outside a known list, and on Hedera that
list is USDC. A service priced in **native HBAR** is therefore rejected until
the agent explicitly permits it.

**This is the right default** and we kept it — we allowed HBAR by name with a
per-payment ceiling rather than passing `allowedAssets: true`. An agent should
not hand over value merely because something asked it to, which is the same
argument our own project makes.

**Impact:** small, once understood, and the error message is unusually good —
it names the field and the three ways out. Worth flagging only because "pay in
the network's native asset" is the most obvious first thing to try on Hedera
and is precisely the case the default blocks. The reference PoC uses USDC
routes, so it does not hit this.

**Suggestion:** mention in the Hedera x402 docs that HBAR needs an explicit
`allowedAssets` entry, with the three-line snippet. It would turn a
five-minute detour into nothing.

---

## 2026-09-07 — `RoutesConfig` shape is easy to get wrong and fails late

**Doing:** registering the priced routes.

**Found:** we guessed the route config shape as `{ price, network, config }`
and silenced the type error with a cast. It compiled and threw at startup:

```
TypeError: Cannot read properties of undefined (reading 'network')
  at x402HTTPResourceServer.validateRouteConfiguration
```

The real shape is `{ accepts: PaymentOption | PaymentOption[], description?,
mimeType? }`, with `scheme`, `payTo`, `price` and `network` inside `accepts`.

**Impact:** ours to own — the cast hid a type error that would have told us
immediately, and we have removed it. Flagging the other half: the failure
surfaces as a property read on `undefined` inside the server rather than as a
message naming the missing field. A route config is static, so this is
knowable at registration time.

**Suggestion:** validate route configuration with a message naming the route
and the missing key. `RouteConfigurationError` already exists in the exports;
the validator appears not to reach for it in this case.

---

## 2026-09-07 — `setSettlementOverrides` throws when there is no payment context

**Doing:** refusing payment for a verdict we could not produce.

**Found:** `setSettlementOverrides(c, { amount: "0" })` is the right tool —
payment is verified before the handler and settled after, so a handler that
fails would otherwise keep the money. It works, and the on-chain history
confirms nothing was charged.

But it throws if called when no payment context exists, which turned our honest
503 into a 500 — the error path failing inside the error handler. We now wrap
it.

**Suggestion:** make it a no-op when there is nothing to override. Callers use
this on failure paths by definition, and a failure handler is the worst place
for a function that can throw.

---

## 2026-09-07 — HCS was the part that gave no trouble at all

**Doing:** a tamper-evident journal of verdicts.

**Found:** `TopicCreateTransaction` plus `TopicMessageSubmitTransaction` was the
whole implementation. `getRecord()` returns the consensus timestamp assigned by
the network, which is exactly the property that makes the journal worth
keeping — we cannot backdate our own record. Entries were readable through the
public mirror node seconds later, with no dependency on us:

```
GET https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10401831/messages
```

Setting a submit key so anyone may read and only the operator may append was
one line.

Sub-second finality matters here in a way that is easy to overlook: the journal
write sits inside the request path, before the caller gets its verdict. On a
chain with slower finality we would have had to make journalling asynchronous
and accept that a verdict could be acted on before it was recorded. Here it
costs about two seconds and stays synchronous, so there is no window in which
we have answered but not written it down.

**Suggestion:** none. Noting it because a feedback log of nothing but friction
is not honest feedback, and this was the piece that worked exactly as
documented.

---

## Not yet done

A mainnet payment through Blocky402. Everything above is testnet, settled
through x402.org. The service takes the network as configuration and has a
mainnet route, so this is a funding decision rather than an engineering one.
