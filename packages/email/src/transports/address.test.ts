import { expect, test } from 'vitest';
import { parseAddress } from './address.ts';

test.each([
  ['noreply@example.test', { address: 'noreply@example.test', name: '' }],
  ['  noreply@example.test  ', { address: 'noreply@example.test', name: '' }],
  [
    'Foodservice Insights <noreply@example.test>',
    { address: 'noreply@example.test', name: 'Foodservice Insights' },
  ],
  [
    '"Foodservice Insights" <noreply@example.test>',
    { address: 'noreply@example.test', name: 'Foodservice Insights' },
  ],
  ['<noreply@example.test>', { address: 'noreply@example.test', name: '' }],
])('parses %s', (value, expected) => {
  expect(parseAddress(value)).toEqual(expected);
});
