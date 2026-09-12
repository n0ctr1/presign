# 0008 — A public instance judges can touch

Deploy to my own VPS behind Caddy on `presign.dev`, not a tunnel from a
laptop. `GET /health` and `GET /quote` need no key.

- `/health` reports readiness, the stream window, journal sequence and lag;
  it returns 503 until the engine is actually ready.
- Graceful shutdown: stop accepting, drain the journal with a deadline, then
  stop. The stop sequence must be fault-tolerant — one failing close must not
  abort the rest, and the process must exit 0.
- Guardrails: body limit, chain guard, rate limiting, payment de-duplication.
- Document the environment variables and the operational traps, including the
  bind-mounted Caddyfile: editing it with `sed -i` creates a new inode and the
  container keeps serving the old file.
