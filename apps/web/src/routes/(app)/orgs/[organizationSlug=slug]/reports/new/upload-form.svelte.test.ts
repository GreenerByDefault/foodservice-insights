import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { aWorkbook } from '#lib/reports/excel/testing/index.js';
import { lastFetchCall, stubFetch, stubUnreachableFetch } from '#lib/testing/fetch.js';
import { resetNavigationMocks } from '#lib/testing/navigation.js';
import { goto } from '$app/navigation';
import UploadForm from './upload-form.svelte';

vi.mock('$app/navigation', () => import('#lib/testing/navigation.js'));

const inspection = vi.hoisted(() => ({ gate: Promise.resolve() }));

vi.mock('#lib/reports/inspect-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#lib/reports/inspect-file.js')>();
  return {
    ...actual,
    inspectFile: async (file: File) => {
      await inspection.gate;
      return actual.inspectFile(file);
    },
  };
});

/** Holds every file in "Checking your file…" until the returned function is called. */
function holdInspection(): () => void {
  const { promise, resolve } = Promise.withResolvers<void>();
  inspection.gate = promise;
  return resolve;
}

const ORGANIZATION_SLUG = 'org-1';
const CSV = 'product,date,weight\nbeef,2026-01-05,12\n';

function csvFile(text = CSV): File {
  return new File([text], 'procurement.csv', { type: 'text/csv' });
}

function workbookFile(): File {
  const bytes = aWorkbook([
    ['Product', 'Date ordered', 'Weight'],
    ['beef', { date: '2026-01-05' }, 12],
  ]);
  return new File([bytes as BlobPart], 'orders.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

afterEach(() => {
  inspection.gate = Promise.resolve();
  vi.unstubAllGlobals();
  resetNavigationMocks();
});

async function fillRequiredFields(
  screen: Awaited<ReturnType<typeof render>>,
  { reportName = 'Q1 procurement' }: { reportName?: string } = {},
) {
  await screen.getByLabelText('Report name').fill(reportName);
  await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());
  await screen.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
  await screen.getByRole('radio', { name: 'Pounds (lb)' }).click();
}

describe('UploadForm', () => {
  describe("the server's response", () => {
    test('every field posts under its FIELD name', async () => {
      const fetchMock = stubFetch(
        new Response(JSON.stringify({ reportId: 'report-1' }), {
          status: 201,
          headers: { location: '/orgs/org-1/reports/report-1' },
        }),
      );
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await fillRequiredFields(screen);
      await screen.getByLabelText('Site name (optional)').fill('Main kitchen');
      await screen
        .getByRole('group', { name: 'Diners or meals served' })
        .getByRole('radio', { name: 'Meals' })
        .click();
      await screen.getByRole('button', { name: 'Upload report' }).click();

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = lastFetchCall(fetchMock);
      expect(url).toBe(`/api/orgs/${ORGANIZATION_SLUG}/reports`);
      const body = options.body as FormData;
      expect(body.get('report-name')).toBe('Q1 procurement');
      expect(body.get('site-name')).toBe('Main kitchen');
      expect(body.get('counts-basis')).toBe('meals');
      expect(body.get('unit-system')).toBe('lb');
      expect(JSON.parse(body.get('monthly-counts') as string)).toEqual({ '2026-01': 100 });
      expect(body.get('csv-file')).toBeInstanceOf(File);
      expect(body.get('workbook')).toBeNull();

      expect(goto).toHaveBeenCalledWith('/orgs/org-1/reports/report-1');
    });

    test('a workbook posts the converted CSV alongside the untouched original', async () => {
      const fetchMock = stubFetch(
        new Response(JSON.stringify({ reportId: 'report-1' }), {
          status: 201,
          headers: { location: '/orgs/org-1/reports/report-1' },
        }),
      );
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      const workbook = workbookFile();

      await screen.getByLabelText('Report name').fill('Q1 procurement');
      await screen.getByLabelText('Choose a CSV or Excel file').upload(workbook);
      await screen.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
      await screen.getByRole('radio', { name: 'Pounds (lb)' }).click();
      await screen.getByRole('button', { name: 'Upload report' }).click();

      await expect.poll(() => vi.mocked(goto).mock.calls.length).toBe(1);
      const body = lastFetchCall(fetchMock)[1].body as FormData;
      const posted = body.get('csv-file') as File;
      expect({ name: posted.name, type: posted.type }).toEqual({
        name: 'orders.csv',
        type: 'text/csv',
      });
      expect(await posted.text()).toBe('Product,Date ordered,Weight\nbeef,2026-01-05,12\n');
      // The picker hands the form its own `File` for the chosen bytes, so identity is not the
      // thing to assert — that the original arrives byte for byte is.
      const original = body.get('workbook') as File;
      expect({ name: original.name, type: original.type }).toEqual({
        name: 'orders.xlsx',
        type: workbook.type,
      });
      expect(new Uint8Array(await original.arrayBuffer())).toEqual(
        new Uint8Array(await workbook.arrayBuffer()),
      );
    });

    test('a 400 shows the rejection view', async () => {
      stubFetch(
        new Response(JSON.stringify({ summary: 'We found problems in your rows.' }), {
          status: 400,
        }),
      );
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await fillRequiredFields(screen);
      await screen.getByRole('button', { name: 'Upload report' }).click();

      await expect.element(screen.getByText('We found problems in your rows.')).toBeInTheDocument();
      await expect.element(screen.getByText('No report was created.')).toBeInTheDocument();
    });

    test('returning from the rejection view restores the typed name and the month counts', async () => {
      stubFetch(new Response(JSON.stringify({ summary: 'We found problems.' }), { status: 400 }));
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await fillRequiredFields(screen, { reportName: 'Q1 procurement' });
      await screen.getByRole('button', { name: 'Upload report' }).click();
      await expect.element(screen.getByText('We found problems.')).toBeInTheDocument();

      await screen.getByRole('button', { name: 'Back to the form' }).click();

      await expect.element(screen.getByLabelText('Report name')).toHaveValue('Q1 procurement');
      await expect
        .element(screen.getByRole('spinbutton', { name: 'January 2026' }))
        .toHaveValue(100);
    });

    test('a 429 shows the same rejection view, with the "Back to the form" label rather than file-specific copy', async () => {
      stubFetch(
        new Response(JSON.stringify({ summary: 'You have created too many reports this hour.' }), {
          status: 429,
        }),
      );
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await fillRequiredFields(screen);
      await screen.getByRole('button', { name: 'Upload report' }).click();

      await expect
        .element(screen.getByText('You have created too many reports this hour.'))
        .toBeInTheDocument();
      await expect
        .element(screen.getByRole('button', { name: 'Back to the form' }))
        .toBeInTheDocument();
    });

    test('a rejecting fetch renders the unknown-outcome message and the report-list link', async () => {
      stubUnreachableFetch();
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await fillRequiredFields(screen);
      await screen.getByRole('button', { name: 'Upload report' }).click();

      await expect
        .element(screen.getByText(/not sure whether that upload went through/))
        .toBeInTheDocument();
      await expect
        .element(screen.getByRole('link', { name: 'your reports' }))
        .toHaveAttribute('href', `/orgs/${ORGANIZATION_SLUG}`);
      expect(goto).not.toHaveBeenCalled();
    });
  });

  describe('rejected before upload', () => {
    test('an empty file is rejected by inspection before ever reaching the network, and shows the rejection view', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 201 }));
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile(''));

      await expect.element(screen.getByText('That file has no rows in it.')).toBeInTheDocument();
      await expect.element(screen.getByText('No report was created.')).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('a rejected file type shows its own inline message rather than the drop zone silently ignoring it', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 201 }));
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await screen
        .getByLabelText('Choose a CSV or Excel file')
        .upload(new File(['not a csv'], 'notes.txt', { type: 'text/plain' }));

      await expect
        .element(
          screen.getByText(
            'We can read CSV and Excel (.xlsx) files. For an older .xls file, in Excel choose File → Save As → Excel Workbook (.xlsx).',
          ),
        )
        .toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('replacing a chosen file returns to the drop zone and clears the months prompt', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());
      await expect
        .element(screen.getByRole('spinbutton', { name: 'January 2026' }))
        .toBeInTheDocument();

      await screen.getByRole('button', { name: 'Replace' }).click();

      await expect
        .element(
          screen.getByText(
            'Choose a file above. Then you can enter a count here for each month it covers.',
          ),
        )
        .toBeInTheDocument();
      await expect.element(screen.getByLabelText('Choose a CSV or Excel file')).toBeInTheDocument();
    });

    test('submitting with no file posts nothing and shows the inline message', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 201 }));
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await screen.getByLabelText('Report name').fill('Q1 procurement');
      await screen.getByRole('button', { name: 'Upload report' }).click();

      await expect
        .element(screen.getByText('Choose a CSV or Excel file to upload.'))
        .toBeInTheDocument();
      await expect.element(screen.getByLabelText('Choose a CSV or Excel file')).toHaveFocus();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    test('submitting with no unit system posts nothing, describes the group, and focuses its first radio', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 201 }));
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await screen.getByLabelText('Report name').fill('Q1 procurement');
      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());
      await screen.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
      await screen.getByRole('button', { name: 'Upload report' }).click();

      const unitSystem = screen.getByRole('radiogroup', { name: 'Weight unit' });
      await expect
        .element(unitSystem)
        .toHaveAccessibleDescription(
          "Your weight column doesn't say whether it's in pounds or kilograms. Name it Weight (lb) or Weight (kg) next time, and we won't need to ask. Choose pounds or kilograms.",
        );
      await expect.element(unitSystem).toHaveAttribute('aria-invalid', 'true');
      await expect.element(unitSystem.getByRole('radio', { name: 'Pounds (lb)' })).toHaveFocus();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('hints', () => {
    test('each hint describes the control it explains', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await expect
        .element(screen.getByRole('group', { name: 'Purchasing data' }))
        .toHaveAccessibleDescription(
          'Upload a spreadsheet of what you bought, as a CSV or Excel file up to 10MB. Its first row should name these three columns: Any other columns are fine. We ignore them.',
        );
      await expect
        .element(screen.getByLabelText('Report name'))
        .toHaveAccessibleDescription('For example, Q1 2026 purchases.');
      await expect
        .element(screen.getByLabelText('Site name (optional)'))
        .toHaveAccessibleDescription(
          'The specific location your file covers, such as one dining hall on a university campus. Leave blank if your file covers your whole organization.',
        );
      await expect
        .element(screen.getByRole('group', { name: 'Diners or meals served' }))
        .toHaveAccessibleDescription(
          'Give a count for each month, such as 1,200 diners in March. Your report will then show emissions per diner or per meal, so you can compare your site with sites of other sizes. Count diners or meals, whichever you already track.',
        );
      // Before any file is chosen, so the user knows which site to count before going to find it.
      await expect
        .element(screen.getByRole('group', { name: 'Diners per month' }))
        .toHaveAccessibleDescription(
          "Use counts for the same sites as your file. For example, if your file only covers one dining hall, count only that dining hall's diners, not the whole university's.",
        );
    });
  });

  describe('choosing a file', () => {
    test('"Checking your file…" arrives in a status region that was already mounted, and leaves it', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      const status = screen.getByRole('status');
      const statusBeforeChoosing = status.element();
      const release = holdInspection();

      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());

      await expect.element(status).toHaveTextContent('Checking your file…');
      expect(status.element()).toBe(statusBeforeChoosing);
      release();
      await expect.element(status).toBeEmptyDOMElement();
    });

    test('a checked file moves focus to Replace', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());

      await expect.element(screen.getByRole('button', { name: 'Replace' })).toHaveFocus();
    });

    test('a checked file leaves focus where the user moved it meanwhile', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      const release = holdInspection();

      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());
      await screen.getByLabelText('Report name').click();
      release();

      await expect
        .element(screen.getByRole('spinbutton', { name: 'January 2026' }))
        .toBeInTheDocument();
      await expect.element(screen.getByLabelText('Report name')).toHaveFocus();
    });

    test('Replace is disabled while the file is being checked', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      const release = holdInspection();

      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());

      await expect.element(screen.getByRole('button', { name: 'Replace' })).toBeDisabled();
      release();
      await expect.element(screen.getByRole('button', { name: 'Replace' })).toBeEnabled();
    });

    test('Replace moves focus to the file input', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());

      await screen.getByRole('button', { name: 'Replace' }).click();

      await expect.element(screen.getByLabelText('Choose a CSV or Excel file')).toHaveFocus();
    });
  });

  describe('the weight unit', () => {
    test('is not asked before a file is chosen', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await expect
        .element(screen.getByRole('table', { name: 'Columns your file needs' }))
        .toBeInTheDocument();
      await expect
        .element(screen.getByRole('radiogroup', { name: 'Weight unit' }))
        .not.toBeInTheDocument();
    });

    test('comes from a header that names it, overriding an earlier choice', async () => {
      const fetchMock = stubFetch(new Response(null, { status: 201 }));
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      await fillRequiredFields(screen);
      await screen.getByRole('button', { name: 'Replace' }).click();

      await screen
        .getByLabelText('Choose a CSV or Excel file')
        .upload(csvFile('Product,Date,Weight (kg)\nbeef,2026-01-05,12\n'));

      await expect
        .element(screen.getByText('Weights are in kilograms, as the column name says.'))
        .toBeInTheDocument();
      await expect
        .element(screen.getByRole('radiogroup', { name: 'Weight unit' }))
        .not.toBeInTheDocument();
      await screen.getByRole('button', { name: 'Upload report' }).click();
      await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
      expect((lastFetchCall(fetchMock)[1].body as FormData).get('unit-system')).toBe('kg');
    });

    test('is asked again once Replace swaps in a file whose header names no unit', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      await screen
        .getByLabelText('Choose a CSV or Excel file')
        .upload(csvFile('Product,Date,Weight (lbs)\nbeef,2026-01-05,12\n'));
      await expect
        .element(screen.getByText('Weights are in pounds, as the column name says.'))
        .toBeInTheDocument();

      await screen.getByRole('button', { name: 'Replace' }).click();
      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());

      await expect
        .element(screen.getByRole('radiogroup', { name: 'Weight unit' }))
        .toBeInTheDocument();
      await expect
        .element(screen.getByText('Weights are in pounds, as the column name says.'))
        .not.toBeInTheDocument();
    });
  });

  describe('skipping counts', () => {
    const NOTE =
      "Your report will show totals only. Bigger sites have bigger totals, so you won't be able to compare your totals directly with other sites.";

    function countsBasisGroup(screen: Awaited<ReturnType<typeof render>>) {
      return screen.getByRole('group', { name: 'Diners or meals served' }).getByRole('radiogroup');
    }

    async function chooseCountBasis(screen: Awaited<ReturnType<typeof render>>, name: string) {
      await countsBasisGroup(screen).getByRole('radio', { name }).click();
    }

    test('replaces the months with a note that describes the choice', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());

      await chooseCountBasis(screen, 'Skip counts');

      await expect
        .element(screen.getByRole('spinbutton', { name: 'January 2026' }))
        .not.toBeInTheDocument();
      await expect.element(countsBasisGroup(screen)).toHaveAccessibleDescription(NOTE);
    });

    test('replaces the placeholder with the note before any file is chosen', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await chooseCountBasis(screen, 'Skip counts');

      await expect
        .element(screen.getByText('Choose a file above', { exact: false }))
        .not.toBeInTheDocument();
      await expect.element(countsBasisGroup(screen)).toHaveAccessibleDescription(NOTE);
    });

    test('switching back to a basis restores the counts already typed', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());
      await screen.getByRole('spinbutton', { name: 'January 2026' }).fill('100');

      await chooseCountBasis(screen, 'Skip counts');
      await chooseCountBasis(screen, 'Diners');

      await expect
        .element(screen.getByRole('spinbutton', { name: 'January 2026' }))
        .toHaveValue(100);
      await expect.element(countsBasisGroup(screen)).not.toHaveAccessibleDescription(NOTE);
    });

    test('submits the none basis and no monthly counts, even with a month left blank', async () => {
      const fetchMock = stubFetch(
        new Response(JSON.stringify({ reportId: 'report-1' }), {
          status: 201,
          headers: { location: '/orgs/org-1/reports/report-1' },
        }),
      );
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      await screen.getByLabelText('Report name').fill('Q1 procurement');
      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile());
      await screen.getByRole('radio', { name: 'Pounds (lb)' }).click();

      await chooseCountBasis(screen, 'Skip counts');
      await screen.getByRole('button', { name: 'Upload report' }).click();

      await expect.poll(() => fetchMock.mock.calls.length).toBe(1);
      const body = lastFetchCall(fetchMock)[1].body as FormData;
      expect(body.get('counts-basis')).toBe('none');
      expect(body.has('monthly-counts')).toBe(false);
    });
  });

  describe('back from the rejection view', () => {
    test('a file rejected before upload returns focus to the file input', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      await screen.getByLabelText('Choose a CSV or Excel file').upload(csvFile(''));

      await screen.getByRole('button', { name: 'Back to the form' }).click();

      await expect.element(screen.getByLabelText('Choose a CSV or Excel file')).toHaveFocus();
    });

    test('a file the server rejected is still chosen, so focus lands on Replace', async () => {
      stubFetch(new Response(JSON.stringify({ summary: 'We found problems.' }), { status: 400 }));
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });
      await fillRequiredFields(screen);
      await screen.getByRole('button', { name: 'Upload report' }).click();

      await screen.getByRole('button', { name: 'Back to the form' }).click();

      await expect.element(screen.getByRole('button', { name: 'Replace' })).toHaveFocus();
    });
  });

  describe('props', () => {
    test('rateLimitWarning renders when set', async () => {
      const screen = await render(UploadForm, {
        organizationSlug: ORGANIZATION_SLUG,
        rateLimitWarning: 'You have created too many reports this week.',
      });

      await expect
        .element(screen.getByText('You have created too many reports this week.'))
        .toBeInTheDocument();
    });

    test('rateLimitWarning is absent when not set', async () => {
      const screen = await render(UploadForm, { organizationSlug: ORGANIZATION_SLUG });

      await expect
        .element(screen.getByText('You have created too many reports this week.'))
        .not.toBeInTheDocument();
    });
  });
});
