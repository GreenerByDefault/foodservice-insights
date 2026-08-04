import { json } from '@sveltejs/kit';
import { sql } from 'kysely';
import { DATABASE } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Liveness probe, including the database. */
export const GET: RequestHandler = async () => {
  try {
    await sql`SELECT 1`.execute(DATABASE);
    return json({ status: 'ok' });
  } catch (error) {
    console.error('Health check failed to reach the database:', error);
    return json({ status: 'degraded' }, { status: 503 });
  }
};
