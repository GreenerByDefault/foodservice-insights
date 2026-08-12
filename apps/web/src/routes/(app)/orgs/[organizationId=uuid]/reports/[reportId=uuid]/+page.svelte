<!-- **Stub:** renders a placeholder. It will be one route for all four outcomes, because they are
     the same report at different moments:
       queued or processing — the timeline of events, the current stage, a warning when a stage
         overruns, and a cancel button, polling with `invalidate()` roughly every ten seconds;
       succeeded — download buttons for the input file, the PDF and the XLSX, the eight or so
         charts, and the run's metadata;
       failed — what happened, said in a way that makes clear the file was not at fault, and a
         retry;
       canceled — a dead end, since canceling soft-deletes the report.
     Every file link goes through `/file/...`, which is public and permanent by design.
     Cancel, retry and delete are the endpoints under `/api/orgs/[organizationId]/reports/`.
     A poll that fails to reach the server is not a failed analysis: keep the last known state on
     screen and say the app is reconnecting, rather than an error page. Retry is offered only on a
     terminal status — never while unreachable, never mid-poll — and polling stops once terminal. -->
<h1 class="text-2xl font-semibold tracking-tight">Report</h1>

<p class="text-muted-foreground">Boilerplate only. Real features arrive in later phases.</p>
