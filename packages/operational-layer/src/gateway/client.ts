/**
 * GraphQL client for The Graph's gateway.
 *
 * Two behaviours of the gateway shape this code:
 *
 * 1. It answers HTTP 200 with a GraphQL error body when authentication is
 *    missing or wrong. Checking the status code alone reports a broken key as a
 *    successful empty result, which on a fail-closed path is the difference
 *    between refusing to answer and answering "nothing looks wrong".
 * 2. Queries are addressed either by subgraph id or by deployment id. This
 *    client uses deployment ids, because a subgraph id floats to whatever
 *    version the owner publishes next and provenance has to name the
 *    deployment that actually answered.
 */

import {
  paymentRefusalReason,
  StudioKeyFunding,
  type GatewayFunding,
} from "./funding.js";
import type { DeploymentId } from "../types.js";

const DEFAULT_BASE_URL = "https://gateway.thegraph.com/api";

/** Every query is bounded: a verdict has a latency budget it cannot exceed. */
const DEFAULT_TIMEOUT_MS = 3_000;

export interface GatewayClientOptions {
  /**
   * Resolves the Studio API key per call, so a rotated key is picked up.
   *
   * Shorthand for `funding: new StudioKeyFunding(apiKey)`, kept because it is
   * how most callers pay and spelling out a strategy object for the common
   * case would be noise.
   */
  readonly apiKey?: () => Promise<string>;
  /**
   * How queries are paid for. Overrides {@link apiKey} when both are given.
   *
   * The alternative is x402 on Base, where the price of each query is in the
   * payment rather than on a monthly invoice. That is the only arrangement
   * under which this project's claim about its own economics — that a
   * verdict's cost is visible rather than trusted — is actually true.
   */
  readonly funding?: GatewayFunding;
  readonly baseUrl?: string;
  /**
   * Per-query timeout.
   *
   * A paid query is slower than a keyed one by an entire extra round trip: the
   * gateway answers 402, the client signs, and the request is retried. The
   * default here is for the keyed path; callers funding with x402 should raise
   * it rather than discover the difference as a freshness failure.
   */
  readonly timeoutMs?: number;
  /** Injectable for tests. Ignored when `funding` supplies its own. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Raised when the gateway declines or fails a query. */
export class GatewayQueryError extends Error {
  readonly deploymentId: DeploymentId;
  readonly httpStatus: number | null;
  readonly graphqlErrors: readonly string[];

  constructor(
    deploymentId: DeploymentId,
    message: string,
    details: { httpStatus?: number | null; graphqlErrors?: readonly string[] } = {},
  ) {
    super(`gateway query for ${deploymentId} failed: ${message}`);
    this.name = "GatewayQueryError";
    this.deploymentId = deploymentId;
    this.httpStatus = details.httpStatus ?? null;
    this.graphqlErrors = details.graphqlErrors ?? [];
  }
}

interface GraphQLBody {
  data?: unknown;
  errors?: unknown;
}

function readGraphQLErrors(body: GraphQLBody): readonly string[] {
  if (!Array.isArray(body.errors)) return [];
  return body.errors.map((entry) => {
    if (typeof entry === "object" && entry !== null) {
      const message = (entry as { message?: unknown }).message;
      if (typeof message === "string") return message;
    }
    return JSON.stringify(entry);
  });
}

export class GatewayClient {
  readonly #funding: GatewayFunding;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: GatewayClientOptions) {
    if (options.funding === undefined && options.apiKey === undefined) {
      // Neither key nor payment method: a client that could never answer,
      // failing at the first query instead of here.
      throw new TypeError("GatewayClient needs either `apiKey` or `funding`");
    }
    this.#funding =
      options.funding ?? new StudioKeyFunding(options.apiKey!, options.fetch);
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** How queries are paid for, named in provenance. */
  get funding(): GatewayFunding["kind"] {
    return this.#funding.kind;
  }

  /** Endpoint pinned to one immutable deployment. */
  deploymentUrl(deploymentId: DeploymentId): string {
    return this.#funding.url(this.#baseUrl, deploymentId);
  }

  async query<T>(
    deploymentId: DeploymentId,
    query: string,
    variables?: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    const funded = await this.#funding.headers();

    let response: Response;
    try {
      response = await this.#funding.fetch(this.deploymentUrl(deploymentId), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...funded,
        },
        body: JSON.stringify(
          variables === undefined ? { query } : { query, variables },
        ),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      // A timeout is a freshness failure like any other: the caller must fail
      // closed rather than wait past its budget.
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new GatewayQueryError(deploymentId, reason, { httpStatus: null });
    }

    /*
     * A 402 here is the *second* one in a paid exchange, and it means
     * something different from the first: the payment was made and refused.
     * Its body is empty, so falling through to the JSON check below would
     * report "response was not JSON" and send an operator hunting a broken
     * endpoint instead of reading the reason the gateway supplied.
     */
    if (response.status === 402) {
      const reason = paymentRefusalReason(response.headers.get("payment-required"));
      throw new GatewayQueryError(
        deploymentId,
        `payment was refused${reason === null ? " and the gateway gave no reason" : `: ${reason}`}`,
        { httpStatus: 402 },
      );
    }

    let body: GraphQLBody;
    try {
      body = (await response.json()) as GraphQLBody;
    } catch {
      throw new GatewayQueryError(deploymentId, "response was not JSON", {
        httpStatus: response.status,
      });
    }

    // Checked before the status code, because the gateway reports auth failures
    // as HTTP 200 with an error body.
    const errors = readGraphQLErrors(body);
    if (errors.length > 0) {
      throw new GatewayQueryError(deploymentId, errors.join("; "), {
        httpStatus: response.status,
        graphqlErrors: errors,
      });
    }

    if (!response.ok) {
      throw new GatewayQueryError(deploymentId, `HTTP ${response.status}`, {
        httpStatus: response.status,
      });
    }

    if (body.data === undefined || body.data === null) {
      throw new GatewayQueryError(deploymentId, "response carried no data", {
        httpStatus: response.status,
      });
    }

    return body.data as T;
  }
}
