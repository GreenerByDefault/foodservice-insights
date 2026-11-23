import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { expect, test } from 'vitest';

// Read by the lab, which runs through `just`, never Turbo.
const LAB_ONLY = new Set(['GEMINI_API_KEY', 'LLM_WHISPERER_API_KEY']);

async function readRepoFile(path: string): Promise<string> {
  return readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

// Turbo's strict env mode hides a shell-set variable it doesn't list from every task. One direction
// only: Turbo also lists variables that only tests set.
test(".env.example's variables all reach Turbo's tasks", async () => {
  const turbo = JSON.parse(await readRepoFile('turbo.json')) as {
    globalEnv: string[];
    globalPassThroughEnv: string[];
  };
  const listed = [...turbo.globalEnv, ...turbo.globalPassThroughEnv].map(
    (pattern) => new RegExp(`^${pattern.replaceAll('*', '.*')}$`),
  );
  const variables = Object.keys(parseEnv(await readRepoFile('.env.example')));

  expect(
    variables.filter((name) => !LAB_ONLY.has(name) && !listed.some((p) => p.test(name))),
  ).toEqual([]);
});
