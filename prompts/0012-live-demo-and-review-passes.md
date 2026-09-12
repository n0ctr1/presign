# 0012 — Live demo, and judging my own project

**Review passes.** Act as a judge: read the official rules and previous
winners, then find what is wrong, weak or overstated here — and say where the
project is genuinely strong. Repeat after each round of fixes. Findings are
checked before they are acted on; a reviewer can be wrong too.

**Live demo on the landing page.** Three fixed transactions judged by the
running instance while the reader watches, with a freshness-budget slider on
the example where the budget actually changes the answer. Constraints:

- cache server-side, keyed by (example, budget), 30–60s TTL, so the page
  cannot be used to bill the instance;
- on transient failure, degrade to the last good verdict stamped with its
  age — never to a broken card;
- the tier ladder must be monotone in the budget: a larger freshness budget
  can never produce a worse outcome than a smaller one. This was broken and
  had to be fixed; verify it live across the whole ladder, repeatedly.

**README.** Numbers must agree with the commands the README tells the reader
to run. Re-measure, date the result, and soften any claim the measurement does
not support.
