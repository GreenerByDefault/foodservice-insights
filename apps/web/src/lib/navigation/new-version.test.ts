import { describe, expect, test } from 'vitest';
import type { NavigationTarget } from '$app/navigation';
import { fullLoadForNewVersion } from './new-version.ts';

const url = new URL('https://example.com/reports');
const to = { url } as NavigationTarget;

describe('fullLoadForNewVersion', () => {
  test('loads the target in full after a new deploy', () => {
    expect(fullLoadForNewVersion(true, { willUnload: false, to })).toEqual(url);
  });

  test('navigates client-side when the build is current', () => {
    expect(fullLoadForNewVersion(false, { willUnload: false, to })).toBeNull();
  });

  test('leaves a navigation that already unloads the page alone', () => {
    expect(fullLoadForNewVersion(true, { willUnload: true, to })).toBeNull();
  });

  test('has nothing to load without a target', () => {
    expect(fullLoadForNewVersion(true, { willUnload: false, to: null })).toBeNull();
  });
});
