# 0005 — x402 on both sides, and the HCS journal

**Inbound.** The service is x402-gated on Hedera testnet through the Blocky402
facilitator. `GET /quote` is free and returns a metered price: a base charge
plus a per-deployment charge for the indexed data the verdict will read, with
a cap. The point is that the cost of an answer is visible before it is bought.

**Outbound.** Data is paid for on Base over x402 (EIP-3009, facilitator
submits), with a spend ceiling. Both sides of the same transaction are shown
in the demo: what the verdict cost the agent, and what it cost us.

**Journal.** Every verdict is written to an HCS topic with a salted commitment
to the paying transaction, so the record is checkable without exposing the
payer. The refusal path in particular must leave a timestamp that cannot be
backdated. Write at payment time, and let the operator choose the mode rather
than choosing it for them.

Payments are replay-protected: a payment signature that has already been used
is rejected rather than honoured twice.
