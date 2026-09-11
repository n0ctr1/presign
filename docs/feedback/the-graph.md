# Feedback — The Graph

Tracks: AI Tooling or AI Use Case (From Scratch, Start Fresh pool), Composable.

---

## 2026-09-05 — `subgraph-registry` is published under a different name than its repo

**Doing:** adding the registry as a dependency for the discovery layer.

**Found:** the repo is `PaulieB14/subgraph-registry`, but the npm package is
`subgraph-registry-mcp` (0.9.15 today). `npm view subgraph-registry` is a flat
404 with no pointer, so the obvious first command fails with nothing to follow.
`npm search subgraph-registry` does surface it, one entry down.

**Impact:** minor, a couple of minutes. Worth noting only because the repo
README's install instructions all use `npx subgraph-registry-mcp`, so the
mismatch is invisible if you start from the README and only bites if you start
from the repo name.

---

## 2026-09-05 — reliability score answers a different question than freshness

**Doing:** deciding whether the registry's ranking could gate a pre-signature
verdict directly.

**Found:** it cannot, and the README is admirably explicit about why. The score
is a composite of query fees (30%), 30-day volume (30%), curation (20%) and
indexer allocation (20%) — all cumulative, so it measures traction and
therefore age. The README even publishes the age/score table showing sub-30-day
subgraphs averaging 0.107 against 0.313 for those over a year old, and routes
young matches into a separate `emerging` list rather than reweighting the score
to hide the effect.

That is the right call for a discovery tool. It does mean there is no signal in
the corpus for *"is this deployment indexing right now"*: no `_meta`, no
distance from chain head, no `hasIndexingErrors`, and a multi-day sync cadence.
A deployment can hold a 0.88 score and sit hours behind head.

**Why it matters for us:** a verdict returned immediately before a signature
cannot rest on that. It is the reason this project has an operational layer at
all, so this is an observation about a boundary, not a defect report.

**Suggestion:** a `last_seen_block` / `last_seen_at` column, even at sync
cadence, would let consumers tell "high score, still indexing" apart from "high
score, stopped in March" without probing every candidate themselves. The
`emerging` list precedent suggests the right shape is a separate honest field
rather than folding it into the composite.

---

## 2026-09-05 — `ipfs_hash` vs `id` is the distinction that matters, and it is easy to miss

**Doing:** mapping registry rows onto our candidate records.

**Found:** every row carries both `id` (the subgraph id) and `ipfs_hash` (the
pinned deployment). `query_url` is built from `id`, so the path of least
resistance is to key everything on the subgraph id — which floats to whatever
version the owner publishes next. For provenance we need the deployment that
actually answered, which is `ipfs_hash`.

**Impact:** none once you know. Flagging it because a consumer that stores `id`
and believes it has pinned a version will be wrong silently, and the field name
`id` invites exactly that.

---

## 2026-09-05 — probing the MCP server from a script was pleasantly boring

**Doing:** recording real response shapes so our adapter maps confirmed fields
instead of guessed ones.

**Found:** `npx subgraph-registry-mcp` over plain stdio JSON-RPC worked first
try, no SDK needed, and the server auto-downloaded its 8 MB SQLite corpus on
first run without prompting. 15,306 subgraphs indexed and answering in well
under a second locally. `get_top_subgraph_deployments` on the Aave V3 Ethereum
pool returned `matched_contracts` with `startBlock` — more than we asked for
and directly useful.

Worth saying plainly since most feedback entries are friction: this was the
part of day 1 that cost the least time.

---

## 2026-09-05 — the gateway answers HTTP 200 with a GraphQL error body

**Doing:** wiring the Studio API key into the gateway client and handling
auth failure.

**Found:** an unauthenticated or wrongly-keyed query returns **HTTP 200** with
`{"errors":[…]}` rather than a 401. The registry's own README flags the same
behaviour, so this is known, but it is a sharp edge: the natural client shape
is `if (!response.ok) throw`, and that path reports a broken API key as a
successful response carrying no data.

**Impact:** for a dashboard, a confusing empty state. For us it is worse — a
verdict engine that reads "no data" as "no problem found" fails *open* on a
credential error, which is the exact failure mode the project exists to
prevent. Our client therefore inspects the GraphQL error body before it looks
at the status code.

**Suggestion:** return 401 for authentication failures. If the 200 is load-
bearing for GraphQL-spec compliance, an `x-graph-auth-error` response header
would let clients distinguish the case without parsing error strings.

---

## 2026-09-05 — `_meta` is the one thing every deployment answers, and it is enough

**Doing:** building the freshness check across a heterogeneous corpus.

**Found:** `_meta { block { number timestamp } hasIndexingErrors }` is served
by every graph-node deployment regardless of schema, which is what makes a
single liveness probe work corpus-wide without per-protocol special-casing.
`block.timestamp` is the useful part: comparing it against wall clock gives
data age directly, with no second lookup.

Measured on Aave V3 Ethereum (`QmcXE5QV…`): 0 blocks behind head, 5 s data
age, 173 ms round trip including an independent chain-head RPC call. Querying
by pinned deployment id (`/api/deployments/id/…`) works exactly as it does by
subgraph id, which is what lets us pin provenance without giving up latency.

**Suggestion:** none — this worked as documented. Noting it because the
combination of "universally available" and "cheap enough to poll" is what made
the freshness layer feasible inside a hackathon week, and it is worth knowing
that `_meta` carries `timestamp` and not merely `number`.

---

## 2026-09-05 — free-tier quota is the real constraint on a health-check layer

**Doing:** planning warm-up intervals for the capability cache.

**Found:** Subgraph Studio's free tier is 100,000 queries/month. Our
conformance check costs two introspection queries plus one probe per
deployment, and liveness costs one more per refresh. Warming a few hundred
deployments at a one-minute refresh would exhaust the month's quota in well
under a day.

**Impact:** this is a design constraint rather than a defect, and it pushed
freshness budgets and cache TTLs into the architecture on day 2 instead of
becoming a rate-limit surprise mid-demo. It is also a concrete argument for
the x402 gateway at \$0.01/query: cost per verdict becomes an observable
number rather than a quota that silently runs out.

**Suggestion:** documenting a rough per-tool query cost next to the free-tier
limit would help. The limit is easy to find; what a health-check workload
actually costs against it is not.

---

## 2026-09-05 — reliability ranking puts non-conforming deployments first

**Doing:** warming the capability index for R3 over mainnet lending
deployments, with a probe budget of six candidates.

**Found:** one conforming deployment out of six. Widening to 18 found five:
Aave V2, Aave V3, Compound V2, Compound V3 and Morpho Blue. The five that
conform to the Messari `markets` schema sit at reliability 0.72–0.77, while
the five *above* them (0.69–0.89) do not conform at all — `protocol-v3`,
`sofa ethereum opt`, `TellerV2`, `Compoundor`, `LIS_AAVE_PROD`.

So the top of the reliability ranking is systematically the wrong place to
look for schema conformance. This is not a defect in the score — it measures
query traction, and a heavily-queried bespoke-schema subgraph legitimately
outranks a standardised one. But it means any consumer selecting "top N by
reliability, then check the schema" gets a poor hit rate, and a small N can
return nothing while good candidates sit at N+1.

**Impact:** direct. Our probe budget is constrained by the free-tier quota, so
a low hit rate in the ranked window is expensive: we spend queries probing
deployments that were never going to answer. We raised the probe budget, but
the underlying mismatch stays.

**Suggestion:** a `schema_family` or `canonical_schema` filter on
`search_subgraphs` would fix this outright — the crawler already computes
schema fingerprints and canonical entities, so the information exists. Being
able to ask for "lending subgraphs whose schema matches the fingerprint family
Aave V3 belongs to" would turn a 5-in-18 hit rate into something close to 1.0
and cut the probe cost proportionally.

**Worth noting on the positive side:** five real lending protocols answered
one rule with zero per-protocol code, which is the whole argument for binding
rules to schema families rather than to protocols.

---

## 2026-09-08 — `txHash` and log fields disagree about encoding in `ethereum_common`

**Doing:** exposing our proxy-upgrade stream over MCP, so a consumer can ask
when a contract's implementation last changed without running a Substreams
stream themselves. First time the transaction hash reached a response body
rather than only an internal index.

**Found:** within one `StreamedEvent` from the `ethereum_common` spkg, fields
carry two different encodings. `log.address` and `log.topics[]` arrive as raw
bytes. `txHash` arrives as the **ASCII text of the hex digits** — the byte
sequence `0x37 0x64 0x64 …`, which is the string `"7dd050…"`, not the 32 bytes
it names.

The consequence is quiet. Hex-encoding every field uniformly, which is the
obvious thing to write and the thing that is correct for the log fields, turns
the hash into 128 characters:

```
0x37646430353031333966643930353633333632643837653538643565313661323865...
```

That is well-formed, passes any length-agnostic validation, and matches no
transaction on any chain. Decoding it as ASCII gives
`0x7dd050139fd90563362d87e58d5e16a28edcd5a56e3af55c65c52b5bd2630cc1`, which is
a real mainnet transaction whose `to` is exactly the proxy in the event and
whose block is exactly the block recorded — so the data was right and only its
encoding was wrong.

**Impact:** we shipped this hash as evidence attached to R2's findings. A
verdict's entire claim here is that a reader can go and check it; a hash that
looks valid and resolves to nothing is worse than omitting the field, because
it fails only at the moment someone tries to verify. It survived because our
tests constructed events with raw bytes for every field — the same uniform
assumption the bug comes from — so nothing disagreed until we read a real one.

**Suggestion:** make the encoding uniform within the event, or if `txHash` is
intentionally a string, type it as one. A consumer has no way to discover this
from the message shape: both fields are bytes on the wire, and only the
content distinguishes them. A line in the spkg documentation naming which
fields are text would also have caught it.

**Worth noting on the positive side:** the stream itself has been solid. Once
`applyParams` was used instead of `createRequest`, it has run for hours at
chain head without a stall — 410 blocks and 199 distinct proxies during this
session's MCP check, and the upgrade a rule caught 87 seconds after it landed
is still the single most convincing thing this project demonstrates.

---

## 2026-09-08 — the registry advertises only the subgraph-id form of the x402 URL

**Doing:** building outbound x402 so verdict queries can be paid per call on
Base rather than drawn from a Studio plan, which is what makes the cost of a
verdict a number a caller can see instead of one they take on trust.

**Found:** two things, one good and one worth fixing.

The good one first: `payment_options` on every registry row is genuinely well
built. It names both funding methods, the exact price, the flow, and — the
part that is unusual — a `use_when` for each. "You have a funded wallet and no
API key, and no human to mint one" is the clearest one-line statement of what
x402 is *for* that we have read anywhere, and it is what decided our default:
a Studio key when one exists, payment when there is no key and no human.

The fixable one: `payment_options.x402.url` and `query_url_x402` both point at
`/api/x402/subgraphs/id/<subgraphId>`. A subgraph id floats to whatever version
its owner publishes next, so a verdict quoting one names something that may
have changed since. Everything else in our pipeline is pinned to a deployment
id for exactly that reason, and `query_url` (the keyed one) is available in
both forms.

`/api/x402/deployments/id/<Qm…>` turns out to exist and serve identical terms —
same scheme, network, amount, `payTo`, asset, and `eip3009` transfer method —
but we found it by guessing at the path, not from any documentation. A
consumer who does not think to try it takes the floating id, and loses pinning
without noticing that they have.

**Impact:** would have silently weakened provenance on the one path where we
also pay for the data. We use the deployment-pinned URL and our tests assert
the emitted endpoint contains no `/subgraphs/` segment.

**Suggestion:** add the deployment-pinned URL to the registry row, alongside
the subgraph one — `query_url_x402_deployment`, or a second entry under
`payment_options.x402`. The information exists; the row already carries
`ipfs_hash`. Documenting that the path form exists at all would be most of the
fix.

**Also worth noting:** the failure message when the wallet is empty is exactly
right. `Verification failed: invalid_exact_evm_insufficient_balance`, in the
second 402's `payment-required` header, is specific enough to act on without
guessing. The contrast with the first 402 is worth keeping in mind for anyone
implementing this — the two are the same status code and mean different
things, and a client that does not read the header reports an empty body and
sends its operator hunting a broken endpoint.

---

## 2026-09-08 — the x402 gateway refuses concurrent payments from one payer

**Doing:** first real paid queries after funding the wallet. A single query
settled immediately and correctly: 0.01 USDC, EIP-3009, gas paid by the
facilitator, `_meta.deployment` echoing back the exact deployment we pinned.

**Found:** under concurrency it drops payments. Four paid requests from the
same payer in flight together returned two answers and two bare `402`s — and
those 402s carried `payment-required` with an **empty error string**, unlike
every other refusal we have seen from this gateway, which are specific enough
to act on (`invalid_exact_evm_insufficient_balance` told us exactly what was
wrong the first time).

It is not a balance problem: the wallet held nearly a dollar and each query
costs a cent. Sequentially, and at two in flight, everything settles. The
symptom is that some fraction of overlapping payments is simply refused.

**Impact:** larger than it sounds, because the natural way to write a consumer
is the one that breaks. Our rule that needs indexed data probes every
candidate deployment *in parallel* — that is the fastest way to ask, and it is
free when queries are funded by a key. On the paid path it silently lost a
probe or two per verdict, and our own fail-closed logic then correctly refused
to answer. The verdict was right and the reason was invisible: a funded
wallet, correct code, and `probe_failed`.

We now serialise payments per payer. It costs about a second per extra
deployment on a verdict, which is the right trade — a slower verdict is still
a verdict, while one assembled from whichever probes won a race is not.

**Suggestion:** two things, in order of value.

First, put an error string in that 402. Every other refusal from this gateway
names its cause, and this one arriving empty is what turned a ten-minute
diagnosis into an hour: an empty error is indistinguishable from a bug in our
own client. `payment_in_flight_for_payer`, or anything at all, would have
pointed straight at it.

Second, document the limit — whether it is one payment per payer at a time, a
rate, or a lock held during settlement. A consumer cannot discover the
concurrency a payment rail supports except by losing requests to it, and the
number is the difference between a parallel and a serial design.

**Worth noting on the positive side:** the settled path is genuinely good. A
paid query answers in under a second including the extra round trip, the
settlement hash is returned in `payment-response` so a caller can verify the
payment on Base without trusting us, and requiring no ETH for gas means an
agent funds one asset instead of two. Being able to quote a verdict's upstream
cost as a real number with checkable transactions behind it is the thing we
could not do before this existed.
