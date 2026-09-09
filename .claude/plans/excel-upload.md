# Excel upload: the browser converts a workbook to CSV, the server stores it unopened

## Context

`REQUIREMENTS.md` § File upload already says "a CSV or XLSX file", and `ARCHITECTURE.md` § Input
file upload already decides how: "the web server accepts only CSV; the client converts XLSX to CSV
before uploading, taking care with Excel dates." Today the code is behind both: the drop zone's
`accept` is `.csv,text/csv`, and `csv/read/decode.ts` recognises the `PK` bytes of an `.xlsx` only
to reject it with "Save it as CSV and upload it again."

This plan closes that gap without touching the CSV pipeline's logic. `apps/web/src/lib/reports/csv/`
stays the one place that judges a file's *content*; a new sibling `excel/` turns a workbook into the
CSV bytes `normalizeCsv` already takes, and everything downstream — header aliases, date rules,
row problems, the rejection view — is inherited unchanged.

Two things were decided with Eric on 2026-09-07 that go past the architecture note:

- **The original workbook is also uploaded and kept**, so the report page's "Uploaded file" link
  hands back `orders.xlsx`, not a CSV the user never saw. The server stores it as opaque bytes and
  **never opens it** — every zip and XML risk stays in the uploader's own browser tab.
- **A multi-sheet workbook is read from its first sheet with data**, tolerating a notes tab. When
  that choice leads to a header failure, the rejection says which sheet we read and which we
  skipped.

The prefactor and the PR that made the server keep a workbook it never opens are both done.
`inspectFile` now returns `{ ok: true; months; upload: { csvFile: File; workbook?: File } }` —
`file` was renamed
to `csvFile` throughout (`FileInspection`, `RawSubmission`, `FIELD`, the upload form's local state)
so a workbook upload has two unambiguous fields — and `apps/web/src/lib/reports/signatures.ts` holds
`spreadsheetSignature(bytes): 'xlsx' | 'xls' | undefined` (the four-byte zip local-file-header check,
isomorphic and imported by `csv/read/decode.ts`), `csv/write.ts` exports `escapeCsvField`, and
`MAX_UPLOAD_FIELD_BYTES` (one cap shared by the CSV field and the workbook field) /
`MAX_WORKBOOK_UNPACKED_BYTES` exist in `upload-limit.js` / `limits.ts` with `start.js` already
doubling the field cap plus the transport margin into `BODY_SIZE_LIMIT`.

The server side of a workbook upload is fully wired and already exercised end to end by tests, with
the field simply absent today: `RawSubmission.workbook: File | null`, sized and PK-sniffed (never
opened) in `validateSubmission`, stored at `workbookInputFileKey(ids)` alongside the CSV by
`putInputFile`, its three columns (`workbook_storage_key`, `workbook_byte_size`,
`workbook_checksum_sha256`, all-or-none, folded into `packages/db/migrations/001_initial_schema.ts`
rather than a new migration — the app has not shipped yet, so there is no prior deploy to leave
alone) written by `insertReport`, and both the download route and the report page's byte size
preferring the workbook over the CSV when one is present. `XLSX_CONTENT_TYPE` is exported once from
`packages/storage/src/keys.ts` and reused by `RESULT_FILE_FORMATS.xlsx`. Every PR below builds on
that shape; none of it is optional infrastructure to add later.

Once adopted with `/plan-adopt`, this file belongs at `.claude/plans/excel-upload.md`.

## Library: `read-excel-file`, via its `universal` entry

Reading `.xlsx` for real means shared strings, rich-text runs, inline strings, formulas' cached
values, error cells, sparse rows, the 1904 epoch, and — the hard part — telling a date from a
number by its cell's number format, including the locale-specific built-in format ids. That is
the "much more complex" part and the reason to take a dependency rather than write it.

| Candidate | Verdict |
| --- | --- |
| **`read-excel-file` 9.3.x** — MIT, ~1.75M weekly downloads, runtime deps `fflate` + `saxen` (`worker-f` and `unzipper-esm` are only reached by the `browser`/`node` entries), `sideEffects: false`, TS types | **Chosen.** `read-excel-file/universal` runs in a browser *and* under node vitest, takes a `Blob`/`ArrayBuffer`, returns every sheet as `(string \| number \| boolean \| Date \| null)[][]` with dates at UTC midnight, detected from number formats incl. the 1904 flag; formulas give their cached value; trailing empty rows are dropped. Stable `InvalidInputError.code` values to branch on |
| `xlsx` (SheetJS) | *Rejected:* the npm build is frozen at 0.18.5 with CVE-2023-30533 and CVE-2024-22363 unfixed; fixed versions ship only from the vendor's own CDN, 7.5MB unpacked |
| `exceljs` | *Rejected:* no release since 2023, 21MB unpacked, Node-stream oriented |
| `@office-kit/xlsx`, TabularJS | *Rejected:* pre-1.0 / new; not enough history for an input-handling path |
| First-party on `fflate` + `saxen` (~400 lines) | *Rejected for now:* fits the repo's own-CSV-parser precedent and would give full control, but we would own every date-format heuristic and OOXML quirk ourselves. Revisit if the library's churn (v9 rewrote its internals in mid-2026; single maintainer) bites |

Two things the library does not do, so we do them around it:

- **It inflates every `.xml` entry without a size check.** Before handing bytes to it, we read the
  zip's central directory ourselves with `fflate`'s `unzipSync(bytes, { filter })` — returning
  `false` for every entry inflates nothing — and refuse an archive whose declared uncompressed
  `.xml` total exceeds `MAX_WORKBOOK_UNPACKED_BYTES`. That is the zip-bomb guard REQUIREMENTS § Security
  asks for. `fflate` therefore becomes a direct dependency too.
- **Its `CellValue` type says `typeof Date` where it means `Date`.** Narrow with our own
  `isDateValue(value: unknown): value is Date` guard rather than `instanceof` on the union.

Known caveat, recorded as **Open** next to the CSP item in REQUIREMENTS when that work starts: the
`universal` entry avoids `worker-f`, but `fflate`'s async `unzip` still spins up blob-URL workers for
entries past a few hundred KB. A future Content Security Policy needs `worker-src blob:` (or we
switch the converter to a sync unzip of our own).

## Settled decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Where conversion happens | Browser only, in `inspectFile`, before anything is uploaded | ARCHITECTURE § Input file upload. The server never decompresses or parses a workbook |
| How a workbook is recognised | By its bytes (`50 4B 03 04` = zip local-file header → try as workbook; OLE2 `D0 CF 11 E0 A1 B1 1A E1` → `.xls` or password-protected → reject), never by extension or MIME | Same rule `decode.ts` already states for CSV; a `.csv` renamed `.xlsx` still just works. Four bytes, not two: a CSV whose title line starts `PKG SUMMARY` must not be sent to the unzipper and told it is a damaged workbook — this is what `signatures.ts` already enforces |
| What is uploaded | Two multipart fields: `csv-file` = the converted CSV (what the server validates and the worker reads, unchanged), plus `workbook` = the untouched original | Server code paths for CSV stay identical; the workbook is a side-car the server only sizes, sniffs two bytes of, hashes and stores |
| What the server does with the workbook | `size ≤ MAX_UPLOAD_FIELD_BYTES`, first two bytes are `PK`, sha256, `putObject` with the xlsx content type. Nothing else, ever | Eric: "we must never actually do anything with the Excel file". A comment on the field says so |
| Where the workbook lives | Blob key `…/input/{inputFileId}.xlsx`; three nullable columns on `input_file` (`workbook_storage_key`, `workbook_byte_size`, `workbook_checksum_sha256`), all-or-none | One row per report stays; the download route `coalesce`s. *Rejected:* a convention-only key like `-original.csv` — the download route would need `objectExists` on every hit and the row's `byte_size` would lie about the file the user gets |
| `original_filename` | The workbook's name (`orders.xlsx`) when one was sent; the CSV's otherwise | It is what the user chose and what the report page shows |
| Download link | Serves the workbook when present, else the CSV, under `original_filename` | Eric: the original Excel "is way less confusing than a CSV" |
| Sheet selection | First sheet (tab order) that has any cell; all sheets are parsed so the others' names are known | Tolerates a notes tab. *Rejected:* rejecting multi-sheet workbooks — too strict for real files; a sheet picker — first disambiguation UI in the app, more than this needs |
| Sheet hint | When `normalizeCsv` rejects with `reason: 'bad_columns'` and other sheets had data, append: `We read the first sheet, "Notes". Your workbook also has "Orders" and "Lookup" — move the sheet with your orders first, or delete the others.` | Eric asked for exactly this: tolerate, but explain when the header failure is probably the wrong tab. `bad_columns` is the only reason `describe/file.ts` gives a header failure |
| Excel dates | `Date` → `YYYY-MM-DD` from UTC getters; time of day dropped | Sidesteps the CSV's day-first/month-first inference entirely — the cell *was* a date, so there is nothing to infer. Matches `dates.ts` dropping times on `YYYY-MM-DD hh:mm`. A date-formatted cell holding text stays text and meets the CSV rules as before |
| Other cell kinds | number → `String(Number(n.toPrecision(15)))`; boolean → `TRUE`/`FALSE`; `null` → empty field; text escaped via `csv/write.ts`'s `escapeCsvField` (quote when it holds `"`, `,` or `\n`) | The output must be exactly the CSV a user could have saved themselves, so every existing rule and message applies. The 15 digits are Excel's own precision: the XML serialises a formula result like `=B2*0.453592` as `5.669900000000001`, which `weights.ts` would refuse as too many digits although Excel shows and saves-as-CSV `5.6699`. Rounding to what Excel holds is transcription, not a guess |
| Blank rows | An all-`null` row becomes an empty line, not `,,` | `parseCsv` skips empty lines while still counting them, so "row 7" in a message is Excel's row 7. Verify with a fixture that the library keeps interior blank rows as `null` rows; if it collapses them, cell addresses are the fallback |
| Extra columns and rows | Emitted as-is | `readLayout`/`MAX_COLUMNS` and `MAX_DATA_ROWS` already bound and describe them |
| Text trimming | `trim: false` | A workbook and the CSV saved from it must be judged identically; the CSV rules already trim where they mean to |
| Size caps | Workbook and its converted CSV each `≤ MAX_UPLOAD_FIELD_BYTES` (10MB, in `upload-limit.js`, one cap for both fields), with a message that says "converted to CSV, your workbook comes to 34MB"; declared uncompressed XML `≤ MAX_WORKBOOK_UNPACKED_BYTES` (100MB, in `limits.ts`, derived from `MAX_UPLOAD_FIELD_BYTES`) | XML is ~4× wordier than CSV, so 100MB of XML is ~25MB of CSV — the unpacked cap never refuses a workbook whose CSV would have passed, and it bounds what a tab inflates. A workbook whose *rows* fit 10MB of CSV compresses to 1–3MB, so 10MB of `.xlsx` is images and other tabs; keeping one number keeps the copy one sentence |
| Body limit | `BODY_SIZE_LIMIT = MAX_UPLOAD_FIELD_BYTES * 2 + TRANSPORT_MARGIN_BYTES` in `start.js` | Both files travel in one request, each bounded by the same field cap. Already wired, ahead of the form ever sending a `workbook` field |
| Rejected workbooks | A workbook the browser rejects is never sent, like a CSV the browser rejects today; a server rejection stores the CSV bytes as today and not the workbook | Unchanged behaviour; REQUIREMENTS "rejected files are kept" already means "kept when they reached us". Consequence worth a sentence in ARCHITECTURE: workbook-specific rejections never reach `rejected_upload`, so no new `rejected_upload_reason` value is needed — `excel/describe.ts` reuses `unparseable` / `too_large` / `empty` for type compatibility only |
| `-original.csv` forensics variant | Unchanged. For a workbook upload it holds the *converter's* CSV, which is exactly the forensic we want for a converter bug | Free |
| Main thread | Conversion runs where `normalizeCsv` already runs, behind the same `setTimeout` yield in `upload-form.svelte` | The library parses in `setTimeout(0)` chunks. **Open:** moving conversion + normalization into a Web Worker is the fix for jank on big files, for both formats at once |
| Bundle | Static import | No dynamic-import precedent in `apps/web`; `sideEffects: false` and ~60KB minified is tolerable. A lazy import when `PK` bytes are seen is a one-line follow-up if it matters |

## PR 1 — `excel/`: a workbook into the CSV `normalizeCsv` reads

Pure code with tests; nothing calls it yet. All isomorphic (the same header line as `csv/`).

- Dependencies: `read-excel-file` and `fflate` in a new `# --- Spreadsheets ---` catalog block
  (`fflate`'s comment: direct because `excel/zip.ts` reads the central directory; keep the range
  inside `read-excel-file`'s). Both `devDependencies` of `apps/web`, like every other
  browser-only library there. Add to `minimumReleaseAgeExclude` only if `pnpm install` refuses
  the version. Verify at install that `read-excel-file/universal` resolves its types under
  `moduleResolution: bundler`; if not, a local `.d.ts` shim in `excel/`. Also read `unzipSync` to
  confirm what `fflate` does when a payload inflates past its declared size, and state it in
  `zip.ts`'s comment — the cap is a *declared*-size check.
- `apps/web/src/lib/reports/excel/zip.ts`: `declaredXmlBytes(bytes): number` via `unzipSync` with an
  always-`false` filter that sums `originalSize` for `.xml`/`.xml.rels` entries (the same entries
  the library inflates). Throws the library-independent `WorkbookFault` on a malformed directory.
- `excel/convert.ts`: `convertWorkbook(bytes: Uint8Array, options?: { maxUnpackedBytes?: number })
  : Promise<WorkbookConversion>` with
  `{ ok: true; csv: Uint8Array; sheet: { name: string; others: readonly string[] } } | { ok: false; fault: WorkbookFault }`.
  Steps, in precedence order like `normalize.ts`: signature (`spreadsheetSignature`; `xls` → fault)
  → `declaredXmlBytes` cap → `readExcelFile(bytes.buffer)` from `read-excel-file/universal` → first
  sheet with rows, `others` = the rest with rows → render rows per the decisions table (text via
  `escapeCsvField`) → `TextEncoder`. `InvalidInputError` codes and `InvalidSpreadsheetError` map to
  faults; anything else rethrows.
  `WorkbookFault = { kind: 'xls' } | { kind: 'not-a-workbook' } | { kind: 'corrupt' } | { kind: 'too-large-unpacked'; declaredBytes: number } | { kind: 'no-data' }`.
- `excel/describe.ts`: `describeWorkbookFault(fault): RejectedUploadRecord` — the only file with
  sentences about workbooks, using the existing `RejectedUploadReason` values (`unparseable`,
  `too_large`, `empty`); `describeOversizeConversion(byteSize)` for a CSV past `MAX_UPLOAD_FIELD_BYTES`;
  `withSheetHint(rejection, sheet)` appends the hint sentence (uses `listOf` from
  `csv/describe/text.ts`). `excel/index.ts` re-exports.
- `excel/testing/workbook.ts`: `aWorkbook({ sheets: [{ name, rows }], date1904? })` assembles a
  minimal `.xlsx` with `fflate.zipSync` from XML template strings — `[Content_Types].xml`,
  `_rels/.rels`, `xl/workbook.xml`, `xl/_rels/workbook.xml.rels`, `xl/styles.xml` (built-in date
  style 14, one custom `dd/mm/yyyy`, one time-only), `xl/sharedStrings.xml` when asked,
  `xl/worksheets/sheetN.xml`. A cell is `string | number | boolean | null |
  { date: '2026-01-05' } | { formula: 'B2*2'; cached: 25 } | { error: '#N/A' } | { rich: ['a','b'] }`,
  so every edge case reads inline like the CSV tests do. `excel/testing/fixtures/*.xlsx`: three tiny
  synthetic workbooks saved from Excel for Mac, Google Sheets and LibreOffice — the repo's first
  binary fixtures, read with `node:fs` in the node tier only, there to catch what a hand-built
  file cannot.
- Tests: `zip.test.ts` (sums, ignores non-XML, malformed directory); `convert.test.ts` (each cell
  kind; date by built-in id, by custom format, in 1904; a date-time keeps only the day; shared vs
  inline vs rich strings; formula cached value; error cell → empty; interior blank row → empty
  line and the header on Excel row 3 is `headerLine: 3` once normalized; first-sheet choice and
  `others`; an empty workbook; `.xls` bytes; a zip with no workbook; a corrupt zip; a
  17-digit formula result renders at 15; the unpacked cap via a small `maxUnpackedBytes`, and a
  cap test that *proves nothing was inflated*: a zip whose central directory declares an
  oversize entry over a garbage payload must come back `too-large-unpacked`, since inflating it
  would have produced `corrupt`; two entries each just under the cap together exceed it);
  `describe.test.ts` (one case per fault, `toEqual`); the parity test — the integration point
  AGENTS.md says to test — asserts `normalizeCsv(convertWorkbook(aWorkbook(rows)).csv)` equals
  `normalizeCsv` of the same rows written as CSV, both for an accepted file (months and bytes) and
  for a file with a bad weight on Excel row 7 below two blank rows (the same `rowProblems`, with
  `ranges: [{ start: 7, end: 7 }]` — this is what proves line = Excel row); the three real fixtures
  normalize ok.

## PR 2 — The form accepts a workbook

- `inspect-file.ts`: after the size and empty checks, `spreadsheetSignature(bytes)`: `'xls'` →
  `describeWorkbookFault({ kind: 'xls' })`; `'xlsx'` → `convertWorkbook`, fault → describe; then
  `csv.byteLength > MAX_UPLOAD_FIELD_BYTES` → `describeOversizeConversion`; `upload = { csvFile: new
  File([csv], stem(file.name) + '.csv', { type: 'text/csv' }), workbook: file }`. Run `normalizeCsv`
  on the CSV bytes as today; on `reason === 'bad_columns'` with `sheet.others.length > 0`, wrap
  with `withSheetHint`. `inspect-file.test.ts`: a workbook yields `months`, a `text/csv`
  `orders.csv` and the original as `workbook`; a notes-first workbook's rejection carries the
  hint; a single-sheet header failure does not; a converted CSV over the cap; the CSV path
  unchanged; client and server agree on the same CSV bytes (existing test, still true).
- `upload-form.svelte`: `accept=".csv,text/csv,.xlsx,{XLSX_CONTENT_TYPE}"`; trigger label
  "Choose a CSV or Excel file"; description "A CSV or Excel workbook with three columns…";
  'File type not allowed' → "We can read CSV and Excel (.xlsx) files. For an older .xls file, in
  Excel choose File → Save As → Excel Workbook (.xlsx)."; the submit-time "Choose a CSV file to
  upload." and `submission.ts`'s copy → "…CSV or Excel file…"; on submit also
  `formData.set(FIELD.workbook, upload.workbook)` when present. `upload-form.svelte.test.ts`:
  uploading `aWorkbook(...)` posts `csv-file` as `orders.csv`/`text/csv` and `workbook` as the
  original; the type-rejection copy.
- `apps/web/e2e/lib/upload.ts`: label lookup follows; add `chooseWorkbook(page, filename, bytes)`.
  `new-report.e2e.ts`: upload a real fixture workbook → report created → the report page shows
  `orders.xlsx`, and `page.request.get(inputFileHref)` returns the xlsx content type and bytes.
- Screenshots: the new-report form re-baselines (copy and label changed).
- Comments that become false: `packages/storage/src/keys.ts`'s `originalInputFileKey` doc —
  "the upload as the user sent it" becomes "as the browser sent it: for a workbook, the
  converter's CSV, which is the forensic for a converter bug; the workbook itself is at
  `workbookInputFileKey`".
- Docs: ARCHITECTURE § Input file upload — the client converts with `read-excel-file`; the
  server stores the workbook without opening it (why: zip/XML bombs stay in the browser); where
  the unpacked cap lives; workbook rejections never reach `rejected_upload`. `csv/README.md` gains
  one line pointing at `excel/` as the thing that feeds it; no `excel/README.md` — three header
  comments cover it. `REQUIREMENTS.md` § Persistence: input metadata now includes the workbook
  when there was one. Deletes this plan file.

## Verification

Per PR: `pnpm lint && pnpm check && pnpm test` in the background; while iterating,
`pnpm --filter @gbd/web test:unit -- src/lib/reports/excel` and
`test:e2e -- e2e/new-report/new-report.e2e.ts`. Re-baseline with
`pnpm turbo run screenshots:update --filter=@gbd/web` only when Playwright asks.

End to end, by hand in `pnpm dev`: upload each `excel/testing/fixtures/*.xlsx` and a workbook with
a notes tab first; confirm the months list, the hint copy, that the report page's "Uploaded file"
downloads the `.xlsx`, and that `sample-reports/valid.csv` still behaves exactly as before.
