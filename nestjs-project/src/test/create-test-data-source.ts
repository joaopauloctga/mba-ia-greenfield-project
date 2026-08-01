import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';

interface TestDataSourceOptions {
  synchronize?: boolean;
  migrations?: (new () => MigrationInterface)[];
}

type EntityClass = new (...args: any[]) => object;

export function createTestDataSource(
  entities: (EntityClass | string | EntitySchema<any>)[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { synchronize = true, migrations } = options;
  return new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'db',
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? 'streamtube',
    password: process.env.DB_PASSWORD ?? 'streamtube',
    database: process.env.DB_DATABASE ?? 'streamtube',
    entities,
    synchronize,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

/**
 * Every table the suites share, ordered so that each one is emptied before the
 * tables it references. Deleting out of this order trips the foreign keys.
 */
const TABLES_IN_DELETE_ORDER = [
  'refresh_tokens',
  'verification_tokens',
  'videos',
  'channels',
  'users',
] as const;

/**
 * Empties every shared table. Suites must call this both in `beforeEach` (so a
 * leaking predecessor cannot corrupt them) and in `afterAll` before tearing the
 * connection down (so they do not become that predecessor). Rows surviving a
 * suite are not merely noise: `migrations.integration-spec.ts` drops `channels`
 * with CASCADE, which turns any leftover video into an orphan and makes the
 * `videos.channel_id` foreign key impossible to recreate — every later suite
 * then dies during `synchronize`.
 *
 * Tables that do not exist yet are skipped: suites declare different entity
 * subsets, and the migration suite deliberately drops tables mid-run.
 */
export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  const rows = await dataSource.query<{ table_name: string }[]>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [[...TABLES_IN_DELETE_ORDER]],
  );
  const existing = new Set(rows.map((row) => row.table_name));

  for (const table of TABLES_IN_DELETE_ORDER) {
    if (existing.has(table)) {
      await dataSource.query(`DELETE FROM "${table}"`);
    }
  }
}
