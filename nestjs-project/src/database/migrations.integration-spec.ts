import { DataSource } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Video } from '../videos/entities/video.entity';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';

const MANAGED_TABLES = [
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
];

const MANAGED_ENUM_TYPES = ['verification_tokens_type_enum'];

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = createTestDataSource(
      [User, Channel, RefreshToken, VerificationToken, Video],
      {
        synchronize: false,
        migrations: [
          CreateUsersAndChannels1775687773260,
          CreateAuthTokens1777579850478,
        ],
      },
    );

    await dataSource.initialize();

    // Dropping "channels" below cascade-drops the FK from videos.channel_id
    // without touching the videos rows themselves. Any row a previous suite
    // left behind would survive as an orphan and make the FK impossible to
    // recreate, so empty everything first.
    await cleanAllTables(dataSource);

    await dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`);
    await Promise.all(
      MANAGED_TABLES.map((table) =>
        dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`),
      ),
    );
    // DROP TABLE ... CASCADE removes columns but not the standalone enum
    // types they used; a prior successful run leaves these behind and the
    // next CREATE TYPE in the migration's up() collides with them.
    await Promise.all(
      MANAGED_ENUM_TYPES.map((type) =>
        dataSource.query(`DROP TYPE IF EXISTS "${type}" CASCADE`),
      ),
    );
  });

  afterAll(async () => {
    // The second test undoes the last migration, leaving token tables missing.
    // Re-apply so the shared DB is fully migrated when subsequent suites run.
    await dataSource.runMigrations();

    // The tests above insert nothing, but the FK restored below only holds on
    // an empty table — clean again so the suite hands the DB over spotless.
    await cleanAllTables(dataSource);

    // Dropping "channels" above cascade-drops the FK from videos.channel_id,
    // even though videos isn't a table this suite manages. Restore it so
    // other suites don't see videos with a dangling foreign key.
    //
    // "videos" itself may legitimately be absent: this suite runs only the two
    // migrations it imports, so on a fresh database the table exists only once
    // another suite's `synchronize` has created it. Nothing to restore then.
    const [{ table_missing, constraint_exists }] = await dataSource.query<
      [{ table_missing: boolean; constraint_exists: boolean }]
    >(
      `SELECT to_regclass('public.videos') IS NULL AS table_missing,
              EXISTS (
                SELECT 1 FROM pg_constraint
                 WHERE conname = 'FK_023a8e4f3f1a34ff3d8ca04a4cc'
              ) AS constraint_exists`,
    );
    if (!table_missing && !constraint_exists) {
      await dataSource.query(
        `ALTER TABLE "videos" ADD CONSTRAINT "FK_023a8e4f3f1a34ff3d8ca04a4cc" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
      );
    }

    await dataSource.destroy();
  });

  it('should apply all migrations and create all four tables', async () => {
    const ranMigrations = await dataSource.runMigrations();

    expect(ranMigrations).toHaveLength(2);

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    const tableNames = result.map((r) => r.table_name);
    expect(tableNames).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
    ]);
  });

  it('should revert the last migration and remove token tables', async () => {
    await dataSource.undoLastMigration();

    const result = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [['refresh_tokens', 'verification_tokens']],
    );
    expect(result).toHaveLength(0);
  });
});
