/**
 * Both sides of the trade, in one run.
 *
 * The scenarios in `bin.ts` produce verdicts. This one produces a verdict that
 * somebody *bought*, and shows what buying it cost us — an agent pays for a
 * verdict in HBAR on Hedera, and producing that verdict pays The Graph in USDC
 * on Base, a cent per query.
 *
 * Keeping them in the same process is the point rather than a convenience.
 * Split across two terminals, the two numbers are two anecdotes; printed
 * together against one transaction they are a margin, with settlement hashes
 * on two different chains that anyone can check. Nothing here is mocked: real
 * payments, real facilitators, real journal entry.
 *
 * The service is bound to loopback and given an ephemeral port. It exists for
 * the length of one request and should not be reachable from anywhere else
 * while it does.
 */

import { serve } from "@hono/node-server";
import { HcsVerdictJournal } from "@presign/hedera";
import { PresignPipeline } from "@presign/gateway";
import type { PaymentLedger } from "@presign/operational-layer";
import { createApp, readTopicId, writeTopicId } from "@presign/service";
import type { VerdictEngine } from "@presign/verdict-engine";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { createClientHederaSigner, PrivateKey } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";

/** Hedera portals hand out ECDSA keys as 0x-prefixed hex; the SDK wants them bare. */
function parseKey(raw: string): PrivateKey {
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  return /^[0-9a-fA-F]{64}$/.test(hex)
    ? PrivateKey.fromStringECDSA(hex)
    : PrivateKey.fromStringDer(raw);
}

export interface TwoSidedOptions {
  /** R1 through R4: what `/verdict/full` charges for and delivers. */
  readonly engine: VerdictEngine;
  /** R1 and R2 only, so the cheaper route is genuinely the cheaper verdict. */
  readonly localEngine: VerdictEngine;
  /** Records what queries cost upstream. Only non-empty on the paid path. */
  readonly ledger: PaymentLedger;
  /** Reads a secret by file name, or null when it is absent. */
  readonly secret: (name: string) => Promise<string | null>;
  /** The transaction the agent wants judged before signing it. */
  readonly transaction: {
    readonly from: string;
    readonly to: string;
    readonly value: string;
    readonly data: string;
    readonly chainId: number;
  };
}

const LINE = "─".repeat(72);

export async function runTwoSided(options: TwoSidedOptions): Promise<void> {
  const network = "hedera:testnet" as const;
  const short = "testnet";

  const [serviceId, serviceKey, agentId, agentKey] = await Promise.all([
    options.secret(`hedera__${short}-service-id`),
    options.secret(`hedera__${short}-service-key`),
    options.secret(`hedera__${short}-agent-id`),
    options.secret(`hedera__${short}-agent-key`),
  ]);

  if (serviceId === null || serviceKey === null || agentId === null || agentKey === null) {
    console.log(
      `\n${LINE}\nTwo-sided payment\n${LINE}\n` +
        "  skipped: this needs Hedera testnet credentials for both the service\n" +
        "  and the agent under ~/.presign/secrets.",
    );
    return;
  }

  console.log(`\n${LINE}\nTwo-sided payment: the agent buys the verdict, we buy the data\n${LINE}`);

  // The remembered topic, not a fresh one. A demo that opened its own each
  // run would scatter the verdict record across topics, and a journal in
  // fragments is not a track record — the same reason the service persists it.
  const knownTopic = await readTopicId(short);
  const journal = await HcsVerdictJournal.open({
    network: short,
    operatorId: serviceId,
    operatorKey: serviceKey,
    ...(knownTopic === null ? {} : { topicId: knownTopic }),
  });
  if (knownTopic === null) await writeTopicId(short, journal.topicId);
  console.log(
    `  journal topic ${journal.topicId} (${knownTopic === null ? "created" : "reused"})`,
  );

  const app = createApp({
    pipelines: {
      local: new PresignPipeline({ engine: options.localEngine }),
      full: new PresignPipeline({ engine: options.engine }),
    },
    ledger: options.ledger,
    journal,
    payTo: serviceId,
    network,
  });

  /*
   * Port 0 asks the OS for a free one. A fixed port would collide with a
   * service already running on this machine — which is exactly the situation
   * someone recording a demo is in.
   *
   * Awaited through the listening callback rather than read straight back off
   * the server: the socket is not bound yet when `serve` returns, so
   * `address()` is null and the port reads as 0, which the agent then fails to
   * connect to with a bare ECONNREFUSED.
   */
  const { server, port } = await new Promise<{
    server: ReturnType<typeof serve>;
    port: number;
  }>((resolve) => {
    const started = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) =>
      resolve({ server: started, port: info.port }),
    );
  });
  const base = `http://127.0.0.1:${port}`;
  console.log(`  service listening on 127.0.0.1:${port}, loopback only`);

  try {
    const spentBefore = options.ledger.count;

    const quote = (await (await fetch(`${base}/quote`)).json()) as {
      routes: Record<string, { hbar?: string; buys?: string }>;
    };
    const price = quote.routes["/verdict/full"]?.hbar ?? "?";
    console.log(`  the agent asks the price first, unpaid: ${price} HBAR for /verdict/full`);
    console.log(`    buys: ${quote.routes["/verdict/full"]?.buys ?? "?"}`);

    const signer = createClientHederaSigner(agentId, parseKey(agentKey), { network });

    /*
     * Spend controls set rather than switched off. The client refuses unknown
     * assets by default, so native HBAR has to be allowed by name — and it is
     * allowed with a ceiling. A verdict costs 0.001 HBAR here; a cap of 0.1
     * leaves room for a price change while keeping a compromised service from
     * draining the account one call at a time. An agent that hands over value
     * because something asked it to is the failure this project warns about,
     * and it would be a poor argument to make while doing it ourselves.
     */
    const client = new x402Client()
      .setSpendControls({
        allowedAssets: [
          { network, asset: "0.0.0", maxAmountPerPayment: "10000000" },
        ],
      })
      .register("hedera:*", new ExactHederaScheme(signer));

    const started = Date.now();
    const response = await wrapFetchWithPayment(fetch, client)(`${base}/verdict/full`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transaction: options.transaction }),
    });

    if (!response.ok) {
      console.log(`  request failed: HTTP ${response.status} ${await response.text()}`);
      return;
    }

    const settlementHeader = response.headers.get("payment-response");
    const body = (await response.json()) as {
      decision: string;
      verdict: { tier: string; findings: { rule: string; title: string }[] };
      cost: {
        charged: string;
        paid_upstream: {
          known: boolean;
          total?: string;
          queries_paid?: number;
          payments?: { deployment_id: string; amount: string; transaction: string | null }[];
        };
      };
      journal: { topic: string; sequence: number };
    };

    console.log(`  paid and answered in ${Date.now() - started} ms\n`);
    console.log(`  VERDICT: ${body.verdict.tier.toUpperCase()} — ${body.decision}`);
    for (const finding of body.verdict.findings) {
      console.log(`    · ${finding.rule}: ${finding.title}`);
    }

    console.log("\n  IN  — the agent paid us, on Hedera");
    console.log(`        ${body.cost.charged}   ${agentId} -> ${serviceId}`);
    if (settlementHeader !== null) {
      const settled = decodePaymentResponseHeader(settlementHeader) as {
        transaction?: string;
      };
      if (settled.transaction !== undefined) {
        console.log(`        ${settled.transaction}`);
      }
    }

    console.log("\n  OUT — we paid The Graph, on Base");
    const upstream = body.cost.paid_upstream;
    if (!upstream.known) {
      // Never printed as zero. On a Studio plan the cost is real and simply
      // billed elsewhere, and a zero here would be the one number in this
      // output that was not measured.
      console.log("        not measurable: queries were funded by a Studio plan,");
      console.log("        which bills monthly. Re-run with --paid to buy them per query.");
    } else if ((upstream.queries_paid ?? 0) === 0) {
      console.log("        nothing: this verdict needed no indexed protocol data.");
    } else {
      for (const payment of upstream.payments ?? []) {
        console.log(`        ${payment.amount}  ${payment.deployment_id}  ${payment.transaction ?? ""}`);
      }
      console.log(`        ${upstream.queries_paid} queries, ${upstream.total} in total`);
    }

    console.log(
      `\n  journal: topic ${body.journal.topic} sequence ${body.journal.sequence}`,
    );
    console.log(
      `  Both settlements are public: the HBAR on Hedera testnet, the USDC on Base.`,
    );
    console.log(
      `  ${options.ledger.since(spentBefore).length} upstream payment(s) are attributable to this verdict.`,
    );
  } finally {
    server.close();
    journal.close();
  }
}
