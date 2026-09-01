import { expect, test } from 'vitest';
import { screenStatus } from './attempt-status.ts';

const NOW = new Date('2026-01-15T10:00:00Z');

test('a pending attempt with a cancel request reads as canceled', () => {
  expect(screenStatus({ status: 'pending', cancelRequestedAt: NOW })).toBe('canceled');
});

test('a processing attempt with a cancel request reads as canceled', () => {
  expect(screenStatus({ status: 'processing', cancelRequestedAt: NOW })).toBe('canceled');
});

test('a succeeded attempt with a cancel request keeps its terminal status', () => {
  expect(screenStatus({ status: 'succeeded', cancelRequestedAt: NOW })).toBe('succeeded');
});

test('a failed attempt with a cancel request keeps its terminal status', () => {
  expect(screenStatus({ status: 'failed', cancelRequestedAt: NOW })).toBe('failed');
});

test('no cancel request passes the raw status through unchanged', () => {
  expect(screenStatus({ status: 'pending', cancelRequestedAt: null })).toBe('pending');
  expect(screenStatus({ status: 'processing', cancelRequestedAt: null })).toBe('processing');
});
