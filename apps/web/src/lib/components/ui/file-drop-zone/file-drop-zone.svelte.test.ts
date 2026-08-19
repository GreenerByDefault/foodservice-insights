import { describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';
import { Root } from './index.ts';
import type { FileRejectedReason } from './types.ts';

describe('FileDropZone', () => {
  test('accepts a .csv file', async () => {
    const onUpload = vi.fn().mockResolvedValue(undefined);
    const screen = await render(Root, {
      accept: '.csv',
      onUpload,
      'data-testid': 'file-input',
    });

    const file = new File(['product,date\nbeef,2026-01-05'], 'data.csv', { type: 'text/csv' });
    await screen.getByTestId('file-input').upload(file);

    expect(onUpload).toHaveBeenCalledWith([file]);
  });

  test('reports "Maximum file size exceeded" past maxFileSize', async () => {
    const onFileRejected = vi.fn();
    const screen = await render(Root, {
      maxFileSize: 10,
      onUpload: vi.fn().mockResolvedValue(undefined),
      onFileRejected,
      'data-testid': 'file-input',
    });

    const file = new File(['well past ten bytes of content'], 'big.csv', { type: 'text/csv' });
    await screen.getByTestId('file-input').upload(file);

    expect(onFileRejected).toHaveBeenCalledWith({
      file,
      reason: 'Maximum file size exceeded' satisfies FileRejectedReason,
    });
  });

  test('reports "File type not allowed" for a .txt against accept=".csv"', async () => {
    const onFileRejected = vi.fn();
    const screen = await render(Root, {
      accept: '.csv',
      onUpload: vi.fn().mockResolvedValue(undefined),
      onFileRejected,
      'data-testid': 'file-input',
    });

    const file = new File(['not a csv'], 'notes.txt', { type: 'text/plain' });
    await screen.getByTestId('file-input').upload(file);

    expect(onFileRejected).toHaveBeenCalledWith({
      file,
      reason: 'File type not allowed' satisfies FileRejectedReason,
    });
  });
});
