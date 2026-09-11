# Deploying the verdict service

The service is a long-lived process. It spawns a native `anvil`, runs the
registry as an MCP subprocess, holds an in-memory upgrade index and a gRPC
stream, and re-forks itself as the chain moves. None of that survives a
serverless or edge runtime, so it ships as an ordinary container and wants a
host that runs containers or plain processes.

Measured on a live instance: **330 MB resident** across all processes — node
139 MB, the registry 161 MB across two, anvil 27 MB. Anvil grows as it caches
state and shrinks again on each re-fork, so **1 GB is enough and 2 GB is
comfortable**.

## Build and run

```bash
docker build -t presign-service .
docker run -d --name presign --env-file presign.env -p 4021:4021 presign-service
```

The image is around 2.4 GB. Most of it is dependency trees we do not control:
the Hedera SDK pulls React Native through its cryptography package, the x402
and protobuf packages are large, and the registry adds 412 MB of its own.

## Configuration

Secrets resolve from a directory first and the environment second, so a
deployment injects them as variables and a mounted directory still wins when
one is present. The file convention `scope__name` maps to the variable
`SCOPE_NAME` upper-cased.

| Variable | Needed for |
|---|---|
| `HEDERA_TESTNET_SERVICE_ID` | the account that receives payment and owns the topic |
| `HEDERA_TESTNET_SERVICE_KEY` | signing HCS journal entries |
| `ETH_RPC_URL` | the fork. **Must be archive-capable** — public endpoints refuse historical state |
| `THE_GRAPH_STUDIO_API_KEY` | R3 and R4. Without it neither runs and `/verdict/full` is not offered |
| `SUBSTREAMS_API_KEY` | R2's upgrade history. Optional; without it R2 reports the history as unavailable |
| `HCS_TOPIC_ID` | **set this.** See below |
| `HEDERA_NETWORK` | where payment settles: `hedera:testnet` (default) or `hedera:mainnet` |
| `FACILITATOR_URL` | override the x402 facilitator. Defaults to Blocky402's host for the network |
| `MAX_FORK_AGE_SECONDS` | how far the fork may fall behind head. Defaults to 60 |
| `GATEWAY_FUNDING` | `x402` to pay gateway queries from `BASE_PAYER_KEY` even when a Studio key exists |
| `BASE_PAYER_KEY` | Base key that pays gateway queries over x402. See below before setting it |
| `GATEWAY_MAX_SPEND_USDC` | ceiling on everything this process pays the gateway over x402. Defaults to `1` |
| `REGISTRY_COMMAND`, `REGISTRY_ARGS` | how the registry subprocess is started. Default `npx -y subgraph-registry-mcp@0.10.1`; the image points them at the installed copy |
| `PRESIGN_SECRETS_DIR` | directory read before the environment. Default `~/.presign/secrets` |
| `HOST`, `PORT` | bind address and port. Default `0.0.0.0:4021` |

### Set `HCS_TOPIC_ID`

The journal is the one asset this project accumulates: timestamps that cannot
be forged after the fact. The service remembers its topic in
`~/.presign/state`, which a fresh container does not have — so without this
variable every deploy opens a new topic and the record arrives in fragments. A
journal in fragments is not a track record.

### Do not put the Base payer key on a public host

`BASE_PAYER_KEY` funds gateway queries by paying x402 on Base. On a public
instance that is a drain: a caller pays 0.005 HBAR for a verdict that can cost
us several cents upstream, so anyone can pump it at our expense. Leave it
unset and queries draw on the Studio plan, where `paid_upstream` honestly
reports `known: false`. The paid path stays demonstrable locally with
`npm run demo -- --paid`.

Where it is set, `GATEWAY_MAX_SPEND_USDC` bounds the damage: spend is counted
when a payment is signed, and past the ceiling the process refuses to sign
another, so R3 reports its data unavailable rather than the wallet emptying.

## Health

`/health` answers without payment and reports data-source liveness, which is
what the container healthcheck uses. It is the honest readiness signal: the
process is up and can say what it can currently see.

```bash
curl -s http://localhost:4021/health
curl -s http://localhost:4021/quote
```

`/quote` and the 402 body are readable without any key, so a reviewer can see
the price and what it buys before deciding to pay.

## TLS

The service speaks plain HTTP and expects something in front of it. A host
that issues a certificate for you (a `*.fly.dev`-style hostname, or a managed
container platform) needs no extra work. On a bare VPS, put Caddy in front —
with a domain, or with an IP-derived hostname from a service like `sslip.io`
when there is no domain to hand.

Limit request bodies at the proxy as well as in the service:

```
presign.dev {
	@verdict path /verdict/*
	request_body @verdict {
		max_size 320KiB
	}
	reverse_proxy presign:4021
}
```

The service refuses a larger body with `413` on its own, but only after the
proxy has started streaming it. The connection is then closed with bytes still
unread, and a proxy that reuses it sends the next request into a dead socket —
observed as a `502` on the request right after a `413`. Refusing at the proxy
means the oversized body never reaches the service at all.
