import { afterEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import UploadForm from './upload-form.svelte';

const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));
vi.mock('$app/navigation', () => ({ goto: gotoMock }));

const ORGANIZATION_ID = 'org-1';
const CSV = 'product,date,weight\nbeef,2026-01-05,12\n';

function csvFile(text = CSV): File {
  return new File([text], 'procurement.csv', { type: 'text/csv' });
}

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  gotoMock.mockClear();
});

async function fillRequiredFields(
  screen: Awaited<ReturnType<typeof render>>,
  { reportName = 'Q1 procurement' }: { reportName?: string } = {},
) {
  await screen.getByLabelText('Report name').fill(reportName);
  await screen.getByLabelText('Choose a CSV file', { exact: false }).upload(csvFile());
  await expect.element(screen.getByText('1 of 1 months still need a count')).toBeInTheDocument();
  await screen.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
  await screen.getByRole('radio', { name: 'lb' }).click();
}

describe('UploadForm', () => {
  test('every field posts under its FIELD name', async () => {
    const fetchMock = stubFetch(
      new Response(JSON.stringify({ reportId: 'report-1' }), {
        status: 201,
        headers: { location: '/orgs/org-1/reports/report-1' },
      }),
    );
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await fillRequiredFields(screen);
    await screen.getByLabelText('Site name (optional)').fill('Main kitchen');
    await screen.getByRole('radio', { name: 'Meals' }).click();
    await screen.getByRole('button', { name: 'Upload report' }).click();

    await expect.poll(() => gotoMock.mock.calls.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/orgs/${ORGANIZATION_ID}/reports`);
    const body = options.body as FormData;
    expect(body.get('report-name')).toBe('Q1 procurement');
    expect(body.get('site-name')).toBe('Main kitchen');
    expect(body.get('counts-basis')).toBe('meals');
    expect(body.get('unit-system')).toBe('lb');
    expect(JSON.parse(body.get('monthly-counts') as string)).toEqual({ '2026-01': 100 });
    expect(body.get('file')).toBeInstanceOf(File);

    expect(gotoMock).toHaveBeenCalledWith('/orgs/org-1/reports/report-1');
  });

  test('a 400 shows the rejection view', async () => {
    stubFetch(
      new Response(JSON.stringify({ summary: 'We found problems in your rows.' }), {
        status: 400,
      }),
    );
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await fillRequiredFields(screen);
    await screen.getByRole('button', { name: 'Upload report' }).click();

    await expect.element(screen.getByText('We found problems in your rows.')).toBeInTheDocument();
    await expect.element(screen.getByText('No report was created.')).toBeInTheDocument();
  });

  test('returning from the rejection view restores the typed name and the month counts', async () => {
    stubFetch(new Response(JSON.stringify({ summary: 'We found problems.' }), { status: 400 }));
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await fillRequiredFields(screen, { reportName: 'Q1 procurement' });
    await screen.getByRole('button', { name: 'Upload report' }).click();
    await expect.element(screen.getByText('We found problems.')).toBeInTheDocument();

    await screen.getByRole('button', { name: 'Back to the form' }).first().click();

    await expect.element(screen.getByLabelText('Report name')).toHaveValue('Q1 procurement');
    await expect.element(screen.getByText('0 of 1 months still need a count')).toBeInTheDocument();
    await expect.element(screen.getByRole('spinbutton', { name: 'January 2026' })).toHaveValue(100);
  });

  test('a 429 shows the same rejection view, with the "Back to the form" label rather than file-specific copy', async () => {
    stubFetch(
      new Response(JSON.stringify({ summary: 'You have created too many reports this hour.' }), {
        status: 429,
      }),
    );
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await fillRequiredFields(screen);
    await screen.getByRole('button', { name: 'Upload report' }).click();

    await expect
      .element(screen.getByText('You have created too many reports this hour.'))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole('button', { name: 'Back to the form' }).first())
      .toBeInTheDocument();
  });

  test('a rejecting fetch renders the unknown-outcome message and the report-list link', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await fillRequiredFields(screen);
    await screen.getByRole('button', { name: 'Upload report' }).click();

    await expect
      .element(screen.getByText(/not sure whether that upload went through/))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole('link', { name: 'your reports' }))
      .toHaveAttribute('href', `/orgs/${ORGANIZATION_ID}`);
    expect(gotoMock).not.toHaveBeenCalled();
  });

  test('an empty file is rejected by inspection before ever reaching the network, and shows the rejection view', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 201 }));
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await screen.getByLabelText('Choose a CSV file', { exact: false }).upload(csvFile(''));

    await expect.element(screen.getByText('That file has no rows in it.')).toBeInTheDocument();
    await expect.element(screen.getByText('No report was created.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('a rejected file type shows its own inline message rather than the drop zone silently ignoring it', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 201 }));
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await screen
      .getByLabelText('Choose a CSV file', { exact: false })
      .upload(new File(['not a csv'], 'notes.txt', { type: 'text/plain' }));

    await expect
      .element(
        screen.getByText(
          'We can only read CSV files right now. In Excel, choose File → Save As → CSV.',
        ),
      )
      .toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('replacing a chosen file returns to the drop zone and clears the months prompt', async () => {
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await screen.getByLabelText('Choose a CSV file', { exact: false }).upload(csvFile());
    await expect.element(screen.getByText('1 of 1 months still need a count')).toBeInTheDocument();

    await screen.getByRole('button', { name: 'Replace' }).click();

    await expect
      .element(screen.getByText('Choose a file first — we will list the months it covers.'))
      .toBeInTheDocument();
    await expect
      .element(screen.getByLabelText('Choose a CSV file', { exact: false }))
      .toBeInTheDocument();
  });

  test('submitting with no file posts nothing and shows the inline message', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 201 }));
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await screen.getByLabelText('Report name').fill('Q1 procurement');
    await screen.getByRole('radio', { name: 'lb' }).click();
    await screen.getByRole('button', { name: 'Upload report' }).click();

    await expect.element(screen.getByText('Choose a CSV file to upload.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('submitting with no unit system posts nothing', async () => {
    const fetchMock = stubFetch(new Response(null, { status: 201 }));
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await screen.getByLabelText('Report name').fill('Q1 procurement');
    await screen.getByLabelText('Choose a CSV file', { exact: false }).upload(csvFile());
    await screen.getByRole('spinbutton', { name: 'January 2026' }).fill('100');
    await screen.getByRole('button', { name: 'Upload report' }).click();

    await expect.element(screen.getByText('Choose lb or kg.')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('rateLimitWarning renders when set', async () => {
    const screen = await render(UploadForm, {
      organizationId: ORGANIZATION_ID,
      rateLimitWarning: 'You have created too many reports this week.',
    });

    await expect
      .element(screen.getByText('You have created too many reports this week.'))
      .toBeInTheDocument();
  });

  test('rateLimitWarning is absent when not set', async () => {
    const screen = await render(UploadForm, { organizationId: ORGANIZATION_ID });

    await expect
      .element(screen.getByText('You have created too many reports this week.'))
      .not.toBeInTheDocument();
  });
});
