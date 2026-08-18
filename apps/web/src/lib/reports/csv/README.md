# CSV validation

`validate.ts` turns uploaded bytes into the CSV the analysis reads, or the reason we will not
accept them. The folder is three layers, one word each for what they hand upward:

| Word | Means | Lives in |
| --- | --- | --- |
| **Fault** | What is wrong with one thing — a byte stream, a header, a cell | `read/`, `rules/` |
| **Finding** | A fault, plus the rows it was found on | `findings.ts` |
| **Problem** | What the customer reads about a finding | `describe.ts` |

A value has a *fault*; we record a *finding*; we show a *problem*. "Problem" is reserved for the
customer-facing type.

| File | Enforces |
| --- | --- |
| `read/decode.ts` | Encoding |
| `read/parse.ts` | Delimiter grammar |
| `read/columns.ts` | Header matching |
| `read/layout.ts` | Which delimiter and header the file resolves to |
| `rules/calendar.ts` | Calendar fields into an ISO date inside the accepted range |
| `rules/dates.ts` | Date cells |
| `rules/date-order.ts` | Deciding a column's day-first/month-first order |
| `rules/amounts.ts` | Amount cells |
| `rules/products.ts` | Product cells, including the formula-injection check |
| `findings.ts` | Folding many failing rows into a few groups, without wording any of them |
| `describe.ts` | Every sentence a customer reading a rejection sees |

`validate.ts`, `findings.ts` and `describe.ts` stay at the top of `csv/` because they *are* the
pipeline; `read/` and `rules/` hold the leaf modules underneath it.

**Be more tolerant than the analysis, but never guess.** We accept things the analysis doesn't —
extra delimiters, extra encodings, the customer's other nineteen columns — and normalize them away
wherever that's safe, like dropping a column the analysis never reads. What we won't do is resolve
an ambiguity on the user's behalf: an ambiguous date or an unrecognized header gets rejected back to
them instead of guessed at.

What comes out is `product,date,weight`: comma-delimited, UTF-8, dates `YYYY-MM-DD`, amounts plain
numbers, and nothing else. Ambiguous dates, unit words, semicolon delimiters, Windows-1252 are rejected. Weights stay in the unit the form declared, which
the run manifest carries; converting them is the analysis's job.

**Banned APIs**, because each one would let the browser and the server disagree on a file the
other accepted — a disagreement the user cannot act on. Use `Date.UTC` only.

| API | Why not |
| --- | --- |
| `Intl`, `toLocale*` | Varies by runtime and by the user's machine |
| `Date.parse`, `new Date(string)` | Guesses at ambiguous input without saying so |
| `new Date(y, m, d)` | Depends on the local timezone |

Every file in this folder is imported by the browser as well as the server: keep them free of
`$env`, `$lib/server`, and anything Node-only.
