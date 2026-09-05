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
