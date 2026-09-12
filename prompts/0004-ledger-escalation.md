# 0004 — Ledger: escalation and secrets

Two primitives, both load-bearing, neither cosmetic.

**Device confirmation for the medium tier.** Through the Device Management Kit
over node-HID. A medium verdict does not notify — it blocks until the human
approves on the device, and what appears on the device screen is what is being
signed. A rejection reads as a decision (`6985`), not as a fault. Where a
signature would be broadcastable, escalate on a non-broadcastable approval
nonce instead.

**Key Ring instead of `.env`.** Service secrets — the Subgraph Studio key, the
agent keys — live in the Ledger Key Ring: one touch at setup, headless
decryption afterwards. Nothing sensitive in the repository, nothing in a dot
file.

A signing broker sits over both, with an explicit policy: low signs, medium
escalates to the device, high refuses. Spend caps are configuration and the
refusal path is the one that must be right.

Operational rules while building this: never choose, type or handle the wallet
passphrase — the human sets it. Never ask for a private key to be pasted;
generate it into the ring. Never touch the device without the go-ahead.
