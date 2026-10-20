import { type Kysely, sql } from 'kysely';
import { writeGuardTrigger } from './_shared.ts';

// Which country each account is in, roughly, for `REQUIREMENTS.md` § Metrics. The web app maps the
// browser's time zone to a country (`apps/web/src/lib/server/country.ts`), so no address is read
// for it.
//
// The pattern CHECK makes the column an identifier, which is what lets `metrics.app_user` expose
// it under `metrics`' no-free-text rule.
//
// A deleted account keeps its country, as `011_metrics_tombstones` keeps the rest of what the view
// showed. It cannot go in `metrics.purged_user`: deleting the `auth.users` row cascades to
// `app_user` first, since the cascade's `RI_ConstraintTrigger_*` sorts before `metrics_tombstone`
// and a table's triggers fire in name order, so `tombstone_user()` finds the country gone. So
// `app_user` gets a tombstone of its own, and the view joins the two.
//
// No index beyond the primary keys: every query counts all accounts, and both joins are on one.

export async function up(database: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE app_user
      ADD COLUMN country text CONSTRAINT app_user_country_format CHECK (country ~ '^[A-Z]{2}$')
  `.execute(database);
  await sql`
    COMMENT ON COLUMN app_user.country IS
      'ISO 3166-1 alpha-2 code for the time zone the user''s browser last reported, null when it reported none that maps to a country. Set at onboarding and on each rename.'
  `.execute(database);

  await countryTombstone(database);

  // Replaced rather than recreated, since `country` goes at the end.
  await sql`
    CREATE OR REPLACE VIEW metrics.app_user AS
    SELECT u.id, u.created_at, u.email_confirmed_at, u.last_sign_in_at,
      NULL::timestamptz AS purged_at, a.country
    FROM auth.users u
    LEFT JOIN public.app_user a ON a.id = u.id
    UNION ALL
    SELECT p.id, p.created_at, p.email_confirmed_at, p.last_sign_in_at, p.purged_at, c.country
    FROM metrics.purged_user p
    LEFT JOIN metrics.purged_user_country c ON c.id = p.id
  `.execute(database);
  await sql`
    COMMENT ON VIEW metrics.app_user IS
      'One row per auth.users row, including deleted accounts. A row exists as soon as someone requests a sign-in code, so count email_confirmed_at, not created_at, for users who actually signed in. purged_at is the account''s deletion, null while the row exists. country is the ISO 3166-1 alpha-2 code of the browser''s time zone, null when unknown.'
  `.execute(database);
}

// Like `011`'s tombstones: SECURITY DEFINER with an empty search_path, AFTER so only a row that
// really went is kept, and ON CONFLICT DO NOTHING so the first account deleted under an id wins,
// as in `metrics.purged_user`. A null country writes nothing, which the view's join reads as null.
async function countryTombstone(database: Kysely<any>): Promise<void> {
  await sql`
    CREATE TABLE metrics.purged_user_country (
      id uuid CONSTRAINT purged_user_country_pkey PRIMARY KEY,
      country text NOT NULL CONSTRAINT purged_user_country_country_format
        CHECK (country ~ '^[A-Z]{2}$')
    )
  `.execute(database);
  await sql`
    COMMENT ON TABLE metrics.purged_user_country IS
      'The country of each deleted account that had one, keyed like metrics.purged_user.'
  `.execute(database);
  await writeGuardTrigger(database, 'metrics.purged_user_country');

  await sql`
    CREATE FUNCTION metrics.tombstone_user_country() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
    AS $$
    BEGIN
      IF OLD.country IS NOT NULL THEN
        INSERT INTO metrics.purged_user_country (id, country)
        VALUES (OLD.id, OLD.country)
        ON CONFLICT (id) DO NOTHING;
      END IF;
      RETURN NULL;
    END;
    $$
  `.execute(database);
  await sql`
    CREATE TRIGGER metrics_tombstone
      AFTER DELETE ON public.app_user
      FOR EACH ROW EXECUTE FUNCTION metrics.tombstone_user_country()
  `.execute(database);
}
