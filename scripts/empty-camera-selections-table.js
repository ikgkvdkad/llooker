#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

function printHelp(exitCode = 0) {
  const helpText = `
Usage: node scripts/empty-camera-selections-table.js --force

Safely truncates the camera selections table defined by the CAMERA_SELECTIONS_TABLE env var (defaults to "camera_selections").

Options:
  --force    Required. Without this flag the script will refuse to run.
  -h, --help Show this help message.

Environment variables:
  DATABASE_URL or NETLIFY_DATABASE_URL  Postgres connection string (required)
  CAMERA_SELECTIONS_TABLE               Optional explicit table name
`.trim();

  console.log(helpText);
  process.exit(exitCode);
}

function resolveTableName() {
  const raw = process.env.CAMERA_SELECTIONS_TABLE;
  if (!raw) {
    return 'camera_selections';
  }

  const sanitized = raw.trim();
  const isSafe = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized);
  if (!isSafe) {
    console.error(`Invalid CAMERA_SELECTIONS_TABLE value "${raw}". Falling back to default "camera_selections".`);
    return 'camera_selections';
  }

  return sanitized;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp(0);
  }

  if (!args.includes('--force')) {
    console.error('Refusing to run without --force. This command wipes all camera selection records.');
    printHelp(1);
  }

  const databaseUrl = (process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || '').trim();

  if (!databaseUrl) {
    console.error('DATABASE_URL or NETLIFY_DATABASE_URL must be set to run this script.');
    process.exit(1);
  }

  const tableName = resolveTableName();
  const sslRequired = databaseUrl.includes('sslmode=require');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslRequired ? { rejectUnauthorized: false } : undefined
  });

  const client = await pool.connect();
  let rowCount = 0;

  try {
    await client.query('BEGIN');
    const countResult = await client.query(`SELECT COUNT(*)::int AS count FROM ${tableName};`);
    rowCount = countResult.rows?.[0]?.count ?? 0;

    await client.query(`TRUNCATE ${tableName} RESTART IDENTITY;`);
    await client.query('COMMIT');

    console.log(`✅ Truncated table "${tableName}". Removed ${rowCount} row${rowCount === 1 ? '' : 's'}.`);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors, we'll surface the original error.
    }

    if (error?.code === '42P01') {
      console.error(`Table "${tableName}" does not exist. Nothing was truncated.`);
    } else {
      console.error('Failed to truncate camera selections table.', {
        message: error?.message,
        code: error?.code
      });
    }
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }

  return rowCount;
}

main().catch((error) => {
  console.error('Unexpected error while emptying the camera selections table:', error);
  process.exit(1);
});
