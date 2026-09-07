# @presign/hedera

A verdict journal whose timestamps nobody can forge, **including us**.

## Why a consensus log

The only asset this project accumulates is a track record: verdicts that can
later be checked against what actually happened. A log we could rewrite would
be worth nothing, and one we merely promise not to rewrite is worth exactly as
much as the promise. The Hedera Consensus Service assigns the timestamp, so
neither we nor anyone else can backdate an entry.

```ts
const journal = await HcsVerdictJournal.open({
  network: "testnet",
  operatorId, operatorKey,
});
const receipt = await journal.record(transaction, verdict);
// receipt.consensusTimestamp — assigned by the network
```

Live example: [topic `0.0.10401831` on
HashScan](https://hashscan.io/testnet/topic/0.0.10401831), and readable by
anyone without going through us:

```bash
curl https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.10401831/messages
```

## What is published, and what is not

The journal records the **hash** of the transaction, never its contents.

A consensus log is public and permanent. Publishing an agent's `to`, `value`
and calldata would broadcast its entire strategy to anyone watching the topic —
and would do it for every customer at once. Hashing keeps the record verifiable
without turning an audit trail into a surveillance feed: anyone holding the
transaction can recompute the hash and confirm we said exactly this, at exactly
that time. Anyone who does not learns nothing beyond the shape of our
decisions. There is a test asserting the serialised entry contains no address,
no calldata and no value.

The verdict itself is published in full, because a tier with no reasons is not
auditable, and those reasons describe the counterparty rather than the agent:

```json
{
  "v": 1,
  "txHash": "985a6841d03b7482…",
  "chainId": 1,
  "tier": "high",
  "rules": ["R1", "R2"],
  "sources": [{ "id": "QmcXE5QVcBcvca…", "lag": 4.3 }],
  "unavailable": [],
  "block": 25921807,
  "at": "2026-09-07T04:53:22.970Z"
}
```

`sources` carries the deployments the verdict rested on and how stale each was.
That is the point of journalling at all — a green verdict recorded without its
provenance could never be argued about afterwards.

## Details worth knowing

**The hash is canonical.** Field order is fixed and values are normalised, so
the same transaction hashes identically however the caller built it. Without
that the journal would be immutable and useless at once: no entry could be
matched back to the verdict it records.

**The topic has a submit key.** Anyone may read the journal; only the operator
may append. A world-writable audit trail proves nothing.

**Entries fit one message.** HCS bills by size and chunks past ~1 KB, and a
chunked entry would spread one verdict across several consensus timestamps. A
test holds the entry under that limit.

**`InMemoryVerdictJournal` is not a no-op.** It retains entries and marks its
receipts `local-…`, because a journal that silently discarded records would let
a deployment believe it had an audit trail when it had none.
