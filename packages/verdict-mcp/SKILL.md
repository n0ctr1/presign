---
name: presign-verdict
description: Buy a pre-signature risk verdict for an unsigned EVM transaction before signing it. Use whenever you are about to sign or send a transaction, approve a token allowance, or call an unfamiliar contract on behalf of a user. Pays a fraction of a cent over x402 on Hedera from a session budget. Returns a tier (low, medium, high, unavailable), the findings, and how stale the evidence was.
---

# Pre-signature verdicts

## When to call

Call `get_verdict` with the **unsigned** transaction before you sign it — every
time the transaction moves value, grants an allowance, or touches a contract you
have not seen before. A verdict after signing is useless.

`get_quote` and `check_service` are free. Use `get_quote` if you need to decide
whether the price is worth it.

## What the tier obliges you to do

| tier | do |
|---|---|
| `low` | You may sign. Every rule ran and found nothing. |
| `medium` | Ask a human first. Do not sign unattended. |
| `high` | Do not sign. Report the findings. |
| `unavailable` | **Do not sign.** The transaction was not evaluated. |

Every result also contains `what_to_do`. Follow it.

**`unavailable` is not a softer `low`.** It means fresh data could not be
obtained, so no judgement was made. Treating it as "nothing found" converts a
failure to get data into permission to sign — the exact mistake this service
exists to prevent.

## Reading a `low` verdict properly

`verdict.provenance.sources[].effectiveLagSeconds` says how far behind chain head
the evidence was. A `low` resting on a source four seconds behind is a strong
claim; one resting on a source minutes behind is weaker. Mention the lag when you
report a verdict to your user.

## Money

Each verdict is paid from a session budget (0.1 HBAR by default). You cannot
raise it. If `get_verdict` returns `session_budget_exceeded`, stop, do not sign,
and tell your user the budget is spent.

If it returns `payer_not_configured`, relay the `setup` text to your user.

## Choosing options

- `route: "full"` (default, 0.005 HBAR) runs all four rules. Use `local`
  (0.001 HBAR) only when protocol accounting and counterparty identity do not
  matter.
- `journal: "sync"` (default) waits for the verdict to be recorded on Hedera and
  returns a sequence number (~4s). `async` answers in ~2.4s and returns `queued`.
  Use `sync` when a record may later need to be cited.
