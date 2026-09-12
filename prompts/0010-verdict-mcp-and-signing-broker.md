# 0010 — Let the model buy the verdict, and gate the signature

An MCP surface that exposes only the data layer is not the product. The model
must be able to:

1. ask the price,
2. pay for and receive a verdict, over x402, from inside the tool call,
3. sign — but only through that verdict.

The signing broker enforces the policy: low signs; medium escalates to the
Ledger device and signs only after approval; high refuses and the refusal is
journalled. Keys come from the Key Ring, hardware-rooted, never from the
environment.

The end-to-end proof is a run on the real device that exercises all three
outcomes, plus a paid run settled in real funds.
