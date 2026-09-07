/**
 * Small pieces of state that must survive a restart.
 *
 * The HCS topic id is the only one so far, and it matters more than its size
 * suggests: creating a fresh topic on every start scatters the verdict journal
 * across topics, and a journal split into fragments is not a track record. It
 * belongs in a file rather than an environment variable an operator has to
 * remember to set.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const STATE_DIR = join(homedir(), ".presign", "state");

const topicFile = (network: string) => join(STATE_DIR, `hcs-topic-${network}`);

/** The topic this service used last time, if any. */
export async function readTopicId(network: string): Promise<string | null> {
  try {
    const value = (await readFile(topicFile(network), "utf8")).trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

export async function writeTopicId(network: string, topicId: string): Promise<void> {
  const path = topicFile(network);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, topicId, "utf8");
}
