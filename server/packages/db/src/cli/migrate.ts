#!/usr/bin/env node
/**
 * Migration CLI.
 *
 *   app-migrate status     what is applied, pending, changed or missing
 *   app-migrate dry-run    run the pending files in one transaction, then roll back
 *   app-migrate up         apply the pending files, one transaction each
 *
 * Environment: MIGRATION_DATABASE_URL (a direct PostgreSQL URL, not PgBouncer;
 * falls back to DATABASE_URL), MIGRATIONS_DIR (default: this package's
 * migrations/), MIGRATION_LOCK_TIMEOUT_MS, MIGRATION_STATEMENT_TIMEOUT_MS.
 */
import { fileURLToPath } from 'node:url';
import { MigrationError, migrationStatus, runMigrations, type MigrationOptions } from '../migrate.js';

const DEFAULT_DIRECTORY = fileURLToPath(new URL('../../migrations', import.meta.url));

function intFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) throw new MigrationError(`${name} must be a non-negative integer`);
  return Number(raw);
}

function optionsFromEnv(): MigrationOptions {
  const connectionString = process.env['MIGRATION_DATABASE_URL'] || process.env['DATABASE_URL'];
  if (!connectionString) throw new MigrationError('set MIGRATION_DATABASE_URL (or DATABASE_URL)');
  return {
    connectionString,
    directory: process.env['MIGRATIONS_DIR'] || DEFAULT_DIRECTORY,
    lockTimeoutMs: intFromEnv('MIGRATION_LOCK_TIMEOUT_MS'),
    statementTimeoutMs: intFromEnv('MIGRATION_STATEMENT_TIMEOUT_MS'),
  };
}

async function main(command: string | undefined): Promise<number> {
  const options = optionsFromEnv();
  switch (command) {
    case 'status': {
      const status = await migrationStatus(options);
      console.log(`applied: ${status.applied.length}`);
      for (const name of status.pending) console.log(`pending: ${name}`);
      for (const name of status.changed) console.log(`CHANGED: ${name}`);
      for (const name of status.missing) console.log(`MISSING: ${name}`);
      return status.changed.length > 0 || status.missing.length > 0 ? 2 : 0;
    }
    case 'dry-run':
    case 'up': {
      const report = await runMigrations({ ...options, dryRun: command === 'dry-run' });
      console.log(
        `${report.dryRun ? 'would apply' : 'applied'} ${report.applied.length} file(s); ` +
          `${report.alreadyApplied} were already applied`,
      );
      return 0;
    }
    default:
      console.error('usage: app-migrate status | dry-run | up');
      return 64;
  }
}

main(process.argv[2]).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
