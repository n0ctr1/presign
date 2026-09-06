/**
 * Which verdicts reach the device, and which do not.
 *
 * The rule that matters here is the one about `high`: a refused transaction
 * must **never** be presented to the device. Showing a human a transaction we
 * have already concluded is dangerous invites them to approve it, and a prompt
 * is a request — people approve prompts, especially the tenth one that day.
 * Refusal has to be refusal, not a confirmation dialog with a scary title.
 *
 * `unavailable` is treated the same way for the same reason. "I could not
 * check this" is not a question to delegate to a human who has strictly less
 * information than the service that gave up.
 */

import type { Verdict } from "@presign/verdict-engine";

export type EscalationDecision =
  | {
      readonly action: "sign_directly";
      readonly rationale: string;
    }
  | {
      readonly action: "confirm_on_device";
      readonly rationale: string;
      /** One line per finding, short enough to make sense on a device screen. */
      readonly summary: readonly string[];
    }
  | {
      readonly action: "refuse";
      readonly rationale: string;
    };

export function decideEscalation(verdict: Verdict): EscalationDecision {
  switch (verdict.tier) {
    case "low":
      return {
        action: "sign_directly",
        rationale: "No rule raised a concern and every rule was able to run.",
      };

    case "medium":
      return {
        action: "confirm_on_device",
        rationale:
          "A concern was raised that a human should weigh, but nothing was proved " +
          "dangerous. The device shows what is being signed so the decision is " +
          "informed rather than delegated.",
        summary: verdict.findings
          .filter((finding) => finding.severity !== "info")
          .map((finding) => `${finding.ruleId}: ${finding.title}`),
      };

    case "high":
      return {
        action: "refuse",
        rationale:
          "A rule proved this transaction dangerous. Presenting it for confirmation " +
          "would invite approval of something already known to be wrong.",
      };

    case "unavailable":
      return {
        action: "refuse",
        rationale:
          "Fresh context could not be obtained, so no verdict was reached. A human " +
          "asked to confirm would have less information than the service that " +
          "could not decide.",
      };
  }
}
