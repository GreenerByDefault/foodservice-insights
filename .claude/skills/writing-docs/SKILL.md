---
name: writing-docs
description: How documentation works in this repo — where a doc belongs, how long it should be, and what must never go in one. Load before writing or changing any Markdown file (README, ARCHITECTURE.md, REQUIREMENTS.md, a package doc), and when deciding whether something belongs in a doc, a code comment, or a test.
---

# Documentation

Our worry is not too few docs; it is docs that quietly stop being true. These rules exist to
keep every document either accurate or obviously dead. [`AGENTS.md`](../../../AGENTS.md) §
Comments covers the same question for code comments.

- **A doc lives at the highest point in the tree that contains all the code it describes.**
  Something spanning more than one component goes in [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) —
  a colocated doc cannot own a seam between two components. Something about one package
  goes in that package. Product intent, owned by no code, goes in a root doc like
  [`REQUIREMENTS.md`](../../../REQUIREMENTS.md). Once there is more than one such doc, that's the
  signal to introduce a `docs/` folder — not before.
- **But a decision that one file enacts is documented on that file**, in a comment, even when
  its consequences reach other components. Ask which single file someone would have to edit to
  reverse the decision, and put the reasoning there — on the line that enacts it, or in the
  file's header comment if it holds across the file. Only split it out when no one file owns
  it. [`ARCHITECTURE.md`](../../../ARCHITECTURE.md) then gets a few lines at most — the consequences
  other components must know, and where the reasoning lives.
- **A README covers what a developer runs, not how the build is wired.** Everyone reads it,
  so keep config and build mechanics out of it unless an everyday command actually changed.
- **Say it once, and briefly.** State the rule or the non-obvious constraint and stop. Do not
  walk through the mechanism, the failure it prevented, or what CI does about it — those are
  the sentences that rot first, and length in a doc everyone reads is a cost paid repeatedly.
- **Never restate in prose what the code already states.** No schemas, file trees, or config
  values. Name the file that holds the fact instead. A number copied into a doc is a number
  that will disagree with the code within a month.
- **Prefer documentation that executes.** A schema invariant belongs in a test that asserts
  the database rejects the violation. A cross-language contract belongs in golden fixtures
  that both sides parse. Those cannot rot silently; prose can.
- **Docs carry intent; code carries mechanism.** If a refactor that changes no behaviour
  would force you to edit a doc, that doc is describing mechanism — fix the doc.
- **Record rejected alternatives as one-liners** (`*Rejected: X because Y.*`), wherever the
  decision itself is documented — a code comment counts. But only do this if there's a good
  chance someone will want to relitigate the decision.
- **Mark anything unresolved `**Open:**`** so it is greppable, and leave it where it belongs
  rather than in a separate list of open questions that will drift.
- **One source of truth per fact, named explicitly.** When two files could both plausibly answer a
  question, say in one of them which one wins.
- **A doc written before its code is a spec, and says so** in a status block naming what replaces it.
