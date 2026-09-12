# AI Usage Disclosure

The idea, the architecture, the four rules and every trade-off in this
repository are mine. I built it solo, and I used an AI coding agent — Claude
Code, model Opus 5 — as a tool inside a design that existed before the tool was
ever opened: a fast typist with good recall of API surfaces, working to a
specification, under review, against tests whose results I read myself.

The specification is `prompts/0001-project-specification.md`. The file it was
distilled from is timestamped **5 September, 14:27 UTC**; the first commit in
this repository is **15:18** the same day. The thesis it argues — that the
pre-signature moment and the agent packaging are both already taken, and that
what nobody returns is *how stale the evidence was* — is the whole product, and
it was written down before a line of code existed. Every layer, rule, tier and
fail-closed boundary in the shipped system is in that document.

## What is mine

- **The idea and the thesis.** Provenance as the open gap; advisor, never
  co-signer, because co-signing is a custodial position with legal
  consequences.
- **The architecture.** Two layers — an operational layer over indexed data
  that measures conformance and liveness by query, and a verdict layer that
  reads a fork's state diff rather than calldata. Freshness budget as a caller
  input. Fail-closed, with `unavailable` as a fourth outcome rather than an
  error. Registry as candidates only, never as truth.
- **The rules.** I decided there would be four, what each one claims, and —
  more importantly — what each one is not allowed to claim: R1 approvals and
  flagged counterparties, R2 mutable logic, R3 invariant breach over the
  standardized schema, R4 unknown counterparty. Three honest rules beat twenty
  heuristics was a decision, not an outcome.
- **The scope and the track strategy.** Three partner slots, what to cut, what
  not to claim as novel, and what to state as a known limit rather than fix
  badly.
- **The runs and what they meant.** The physical Ledger, the paid x402 calls in
  real USDC and HBAR, the live instance, the safety and latency harnesses — I
  ran them and I decided what their output obliged me to change. The three
  decisions below came out of those runs.
- **The operational reality.** The VPS, the domain, the device, the Hedera and
  Base accounts, the keys and the money.
- **The sponsor feedback** in `docs/feedback/` — my own experience with the
  tools, written as I hit things, not assembled at the end.

## What the AI tool did

It typed. Concretely: the TypeScript under `packages/`, the tests beside it,
the landing page with its hand-drawn guilloché art and favicons, `llms.txt`,
and the prose of the documentation — all produced with AI assistance, against
the specifications in `prompts/` and the instructions recorded per phase below.
No file in this repository is free of that assistance, and no design decision
in it is owed to that assistance. Where the tool proposed something that
conflicted with the specification, the specification won; several such
corrections are recorded below.

**Imported implementation: none copied.** Third-party code enters only as
pinned npm dependencies — `viem`, `hono`, `@hashgraph/sdk`, `@ledgerhq/*`
(Device Management Kit, Ethereum signer kit, node-HID transport, Key Ring
protocol), `@x402/*`, `@substreams/*`, `@modelcontextprotocol/sdk`, `zod` —
plus `subgraph-registry`, which is spawned as an MCP subprocess rather than
vendored, and Anvil, invoked as an external binary. Nothing was pasted from
blog posts, other repositories or prior submissions.

## Decisions taken after a run, not before it

These are the four places where reality contradicted my design and I changed
the design. They are the part of this project a model cannot produce on its
own, and they are visible in the commit history as a sequence.

**1. The gateway timeout: 306 ms → 7.7 s, and back.** `npm run latency` exists
because latency is named as a risk in the original specification. Raising the
gateway timeout from 3 s to 8 s rescued one case — Uniswap V3 Factory stopped
returning `unavailable` — and slowed the cold path on USDC from **306 ms to
7 661 ms**, twenty-five times, because a slow USDC indexer then consumed almost
the whole budget. USDC is on the hot path for nearly every agent; the factory
is not. I reverted to 3 s: USDC came back at 394 ms and the factory kept
returning `unavailable`, which is an honest answer to give. One number does not
serve both cases, so the timeout is configuration and the preference is written
down in the code rather than hidden in a constant. Four days later the factory
began answering inside those same three seconds — decision 4 below says why. It
had never been short of time.

**2. R4 was asking a human to approve Permit2.** `npm run safety` exists
because the specification lists false positives as a release risk — *"a scanner
that flags safe contracts is worse than a narrow one."* The run over the twelve
known-safe contracts returned `low: 7, medium: 4, unavailable: 1`, and three of
those four were Permit2, Multicall3 and the Uniswap V3 router: an agent would
have had to wake a human to touch infrastructure it touches constantly. My
reasoning behind the rule was wrong — I had treated "older than a week and not
indexed" as evidence of a gap, but indexability reflects whether anyone wrote a
subgraph, not whether a contract is trusted. The finding stays and is still
reported, at `info`; it no longer moves the tier. The run after the fix:
`low: 10, medium: 1, unavailable: 1`. The remaining `medium` is USDC — correct
at that point, and changed by decision 3 below; the `unavailable` row is the
Uniswap V3 factory from decision 1 above, which decision 4 explains. The same
set reads `low: 12` today, factory included.

**3. R2 on USDC: right, and useless.** USDC is an upgradeable proxy whose admin
is a plain key, so R2 flagged it and the tier went to `medium` — a human on the
device. Correct, and it would have broken the product: every agent action
touching USDC needs a human, including the x402 payments this service itself
charges, which are USDC. I rewrote the rule instead of exempting the token,
because an allowlist of "trusted" assets is policy wearing the costume of
analysis. The standing admin finding now raises the tier only when the
transaction **adds exposure** to that contract — sends it value, moves tokens
into it, grants an allowance on it, or raises a balance it records for the
sender — read from the state diff. A USDC transfer is `low`. An approval to
Permit2 is still `medium`. An implementation swap inside the transaction being
judged is still `high`.

**4. The demo I built for the judges found what my tests could not.** The
landing page judges three fixed transactions live, and one of them carries the
freshness-budget slider — the comparison the entire product rests on. It made a
bug visible within hours of going up: a 60-second budget returned `unavailable`
while a 30-second budget, moments earlier and against the same deployment,
returned `low`. The ladder was not monotone, which is the one thing it may never
be. No test caught it because every test asked once; only a page inviting the
same question twice, in two orders, could show it. Three causes, each wrong on
its own: probes issued together contended for one gateway, so a single timeout
stood for the whole answer; a failed probe was cached for ten seconds, so that
timeout decided every verdict in the window; and the page held any answer for a
minute, including one that said `unavailable` only because a probe had timed
out. Failed probes are now re-asked one at a time, only completed probes are
remembered, and the page holds a genuine staleness answer while holding an
infrastructure failure for eight seconds. Fixed the day before the deadline —
and it retired the factory's standing `unavailable` from decision 1 as a side
effect, which is how I learned that case had been mine, not the indexer's.

## Per phase

The sessions themselves are not reproduced — hundreds of megabytes, containing
secrets and device output. The material specifications are distilled into
`prompts/`, in order. Routine edits, formatting and layout iteration have no
separate entry.

### 4–5 September: specification, repository, first layer

- **Decided:** advise, never co-sign; do not rebuild subgraph discovery, an
  existing MIT registry already does it and its output is candidates only;
  English-only repository; commit trailers carry no tooling metadata and
  commits land under my own identity in my own repository — the disclosure the
  rules require is this document. The Subgraph Studio key goes into the Ledger
  Key Ring on day one, not into a `.env`.
- **Built with AI assistance:** the npm workspace monorepo, the registry
  subprocess client, and the first operational layer — conformance by query,
  liveness against chain head.
- **Verified by me:** what the registry is trusted for, and that its economic
  reliability score never reaches a verdict.
- **Specs:** `prompts/0001-project-specification.md`,
  `prompts/0002-operational-layer.md`.

### 6 September: rules, MCP surface, the device

- **Decided:** rules read the state diff, not calldata; the operational layer
  ships standalone with its own `SKILL.md` so another team can ask *which
  deployments can answer this rule right now* without touching the engine; the
  medium tier blocks on the device, and what is on the device screen is what is
  being signed. Also, from this day, the R2 ceiling: a standing property of a
  counterparty may never on its own reach `high`.
- **Built with AI assistance:** fork simulation, the first rules, the MCP
  server, the Device Management Kit integration, the Key Ring secret source.
- **Verified by me:** every unlock, approval and rejection on the physical
  device.
- **Specs:** `prompts/0003-simulation-and-rules.md`,
  `prompts/0004-ledger-escalation.md`.

### 7 September: payments on both sides, and a name

- **Decided:** the project is `presign`; the price is metered by the data a
  verdict actually reads, so the cost of an answer is visible before it is
  bought; both sides of the money appear in one response, because the point is
  transparency of cost, not novelty of charging; the refusal path must leave a
  timestamp that cannot be backdated.
- **Built with AI assistance:** x402 inbound on Hedera via the Blocky402
  facilitator, the outbound payer on Base, the HCS journal, the first
  Substreams stream of proxy upgrades.
- **Verified by me:** a paid `/verdict/full` end to end from a second machine;
  I found and sent back the pricing defect in the first quote implementation.
- **Specs:** `prompts/0005-x402-both-sides.md`,
  `prompts/0006-substreams-proxy-upgrades.md`.

### 8 September: measurement, and the two findings above

- **Decided:** no claim in the README that a command cannot reproduce, and
  every number dated; the false-positive run is a release gate. Then the two
  trade-offs: the timeout reverted to 3 s, and R4 demoted to `info`.
- **Built with AI assistance:** the latency, safety and coverage harnesses, and
  the rule changes I specified after reading their output.
- **Verified by me:** `npm run latency`, `npm run safety`, `npm run coverage`,
  re-run after each change.
- **Spec:** `prompts/0007-measurement-and-safety-set.md`.

### 9–10 September: public instance, landing page, agent-facing page

- **Decided:** judges must be able to touch a live instance, so it is
  self-hosted on my own VPS and domain rather than shown from a laptop; one
  hand-built page, no framework and no stock assets; and a page written for
  models rather than people, because integration cost is the product's real
  barrier.
- **Built with AI assistance:** the deployment behind Caddy, health and
  readiness endpoints, graceful shutdown, the page and `llms.txt`.
- **Verified by me:** the live endpoints, and what the site is allowed to
  claim.
- **Specs:** `prompts/0008-public-deployment.md`,
  `prompts/0009-landing-and-agent-page.md`.

### 10–11 September: paying for a verdict from inside a model

- **Decided:** I rejected an intermediate state in which the MCP surface
  exposed only the data layer — if the model cannot buy the verdict itself, the
  product has no point. The journal entry is written at payment time and the
  operator chooses the mode. The agent never selects, types or handles the
  wallet passphrase; private keys are generated into the ring, never pasted.
- **Built with AI assistance:** the verdict MCP server, the signing broker and
  its policy, hardware-rooted key material, CI.
- **Verified by me:** a three-case broker run on the physical Nano X — signed,
  signed after approval on the device, refused — and a paid run I authorised
  explicitly, settled in real USDC on Base.
- **Spec:** `prompts/0010-verdict-mcp-and-signing-broker.md`.

### 11–12 September: two audits and their remediation

- **Decided:** commission the audits deliberately and have them written to
  files rather than read in a chat, so fixes could be checked against a list;
  order the work by severity; and document the one finding I could not fix
  honestly — npm advisories whose `overrides` npm records but does not resolve
  — as a known limit instead of papering over it.
- **Ran by:** two separate passes against a copy of the tree — one by a
  different model, one by a fresh Claude session with no context of the build.
- **Built with AI assistance:** mapping-slot resolution for approvals reached
  through routers, indexer lag read from the same document as the data it
  qualifies, failed probes no longer cached, RPC faults no longer mistaken for
  reverts, bounded caches, graceful shutdown, payment replay rejection, request
  limits, CI actions pinned by SHA.
- **Verified by me:** each fix re-read against its finding, then the full suite
  and live re-runs of the affected paths, including a concurrent duplicate
  payment and a clean shutdown of the production container.
- **Spec:** `prompts/0011-audit-remediation.md`.

### 12 September: judging my own project, and the live demo

- **Decided:** the landing page shows fixed examples judged live by the running
  instance rather than a recording, cached server-side so the page cannot bill
  the instance, and degrading to the last good verdict stamped with its age —
  a demo that admits its age beats one that breaks under load. The video waits
  until the product is finished.
- **Built with AI assistance:** the demo endpoints and cache, the freshness
  slider, the three-part fix for the non-monotonic ladder it exposed
  (decision 4 above), the re-measured README figures, and the layout rebuilt
  from screenshots I pasted into the session.
- **Verified by me:** the ladder re-checked live across repeated rounds, and
  every disputed claim checked before anything was changed — a reviewer can be
  wrong too.
- **Spec:** `prompts/0012-live-demo-and-review-passes.md`.
