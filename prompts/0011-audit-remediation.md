# 0011 — Audit remediation

Two independent audits were commissioned — one from a different model family —
and written to files, so fixes could be checked against a list rather than a
conversation. Work them in severity order.

Correctness:

- resolve approvals reached through mapping slots by computing
  `keccak(key ‖ slot)` and the nested form, with a bounded candidate scan and
  an entropy filter; when candidates are truncated, return `unavailable` with
  the reason rather than a confident answer;
- read indexer lag from `_meta` in the *same document* as the data it
  qualifies, and count stale answers toward `all_candidates_stale`;
- never cache a failed probe — only successful ones — and retry failed probes
  once before declaring nothing conforming;
- distinguish RPC faults from reverts; rethrow the former instead of reporting
  a finding;
- bound every cache.

Operational: graceful shutdown that exits 0, payment replay rejection,
request limits, CI actions pinned by SHA, least-privilege workflow
permissions.

A finding that cannot be fixed honestly — npm advisories whose `overrides` npm
records but does not resolve — goes into *Known limits* with what was tried.
Do not paper over it.
