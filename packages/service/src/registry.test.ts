import assert from "node:assert/strict";
import { test } from "node:test";

import { splitArgs } from "../dist/index.js";

test("registry arguments survive quoting and spaces in paths", () => {
  assert.deepEqual(splitArgs("-y subgraph-registry-mcp@0.10.1"), ["-y", "subgraph-registry-mcp@0.10.1"]);

  // Splitting on spaces turned one path into two arguments, and the registry
  // failed to start complaining about a file nobody had named.
  assert.deepEqual(splitArgs('"/opt/my tools/registry.js" --flag'), ["/opt/my tools/registry.js", "--flag"]);
  assert.deepEqual(splitArgs("  --a   --b  "), ["--a", "--b"]);
  assert.deepEqual(splitArgs(""), []);
});
