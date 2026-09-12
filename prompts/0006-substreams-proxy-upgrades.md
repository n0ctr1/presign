# 0006 — Substreams: proxy upgrades as a stream

Replace polling for proxy-implementation changes with a Substreams gRPC
stream: consume upgrade events continuously, keep a cursor, handle reorgs, and
expose the window (blocks watched, proxies seen) through `/health` so the
stream is observable rather than claimed.

R2 reads from this stream. The package must be visible in the repository
layout and in the README — a streaming component that judges cannot find is a
component that does not count.

Pin `substreams-sink-sql` to v4.11.3; later versions break on `s2`
compression in gRPC. Start from a recent block, never genesis.
