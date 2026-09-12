# 0009 — The landing page, and a page for agents

One hand-built page. No framework, no stock assets, no icon packs — the
guilloché art is drawn by code in the page itself, and the favicons are
generated. English only. Respect `prefers-reduced-motion`.

The page must show the live instance judging, not screenshots of it: numbers
read from `/health`, verdicts produced while the reader is on the page.

Alongside it, `llms.txt`: the same product described for a model rather than a
person — endpoints, payment flow, error codes, what each rule means. Make
integration cheap for an agent; the design is for humans, the text file is
not.
