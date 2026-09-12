# 0003 — Simulation and the rules

Simulate the unsigned transaction on a mainnet fork and take the state diff
via `debug_traceCall` with the prestate tracer in diff mode. Rules read the
diff. Calldata says what a transaction claims to do; the diff says what it
does, and they part company exactly where it matters — a router, a multicall,
a permit forwarding somebody else's approval.

- **R1 — approvals and flagged addresses.** Allowances that are effectively
  unlimited (at least 2^128, at least total supply, or covering the holder's
  balance), operator approvals via `setApprovalForAll`, and any counterparty
  reached by the transaction that appears in the incident registry — including
  recipients found in the effects, not only the `to` field. Approvals reached
  through a mapping slot must be resolved by computing the slot, not guessed.
- **R2 — mutable logic.** Proxy behind which the implementation can change,
  read from storage slots; admin that is a live EOA; absence of a timelock.
- **R3 — invariant breach.** Read from the standardized schema through the
  operational layer, with the lag of the data that produced the answer carried
  into the verdict.
- **R4 — unknown counterparty.** An unverified or freshly deployed contract is
  its own outcome, stated as such.

**Fail closed.** If a rule needs fresh protocol data and none is available
within budget, that rule is *unavailable* and the verdict cannot be green.
`unavailable` is a fourth outcome and a designed one — not an error state.

Every verdict carries provenance: deployment ids, lag, the block the
simulation ran against and its age, and which rules could not be evaluated and
why. Distinguish an execution failure (the transaction reverts — that is a
finding) from an RPC fault (we failed — that is unavailability).
