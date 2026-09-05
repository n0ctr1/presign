# Feedback — The Graph

Tracks: AI Tooling (Building from Scratch), Composable.

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
