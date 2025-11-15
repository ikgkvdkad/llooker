#!/usr/bin/env node
'use strict';

const { Pool } = require('pg');

function printHelp(exitCode = 0) {
  const helpText = `
Usage: node scripts/clear-all-photos.js --force

Safely truncates BOTH the camera selections and portrait analyses tables, removing all photos from the database.

Options:
  --force    Required. Without this flag the script will refuse to run.
  -h, --help Show this help message.

Environment variables:
  DATABASE_URL or NETLIFY_DATABASE_URL  Postgres connection string (required)
  CAMERA_SELECTIONS_TABLE               Optional explicit table name (defaults to "camera_selections")
  ANALYSES_TABLE                        Optional explicit table name (defaults to "portrait_analyses")
`.trim();

  console.log(helpText);
  process.exit(exitCode);
}

function resolveTableName(envKey, defaultName) {
  const raw = process.env[envKey];
  if (!raw) {
    return defaultName;
  }

  const sanitized = raw.trim();
  const isSafe = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(sanitized);
  if (!isSafe) {
    console.error(`Invalid ${envKey} value "${raw}". Falling back to default "${defaultName}".`);
    return defaultName;
  }

  return sanitized;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printHelp(0);
  }

  if (!args.includes('--force')) {
    console.error('Refusing to run without --force. This command wipes ALL photos from the database.');
    printHelp(1);
  }

  const databaseUrl = (process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || '').trim();

  if (!databaseUrl) {
    console.error('DATABASE_URL or NETLIFY_DATABASE_URL must be set to run this script.');
    process.exit(1);
  }

  const selectionsTable = resolveTableName('CAMERA_SELECTIONS_TABLE', 'camera_selections');
  const analysesTable = resolveTableName('ANALYSES_TABLE', 'portrait_analyses');
  
  const sslRequired = databaseUrl.includes('sslmode=require');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: sslRequired ? { rejectUnauthorized: false } : undefined
  });

  const client = await pool.connect();
  let selectionsCount = 0;
  let analysesCount = 0;
  let totalCount = 0;

  try {
    await client.query('BEGIN');
    
    // Count and truncate camera_selections
    try {
      const selectionsCountResult = await client.query(`SELECT COUNT(*)::int AS count FROM ${selectionsTable};`);
      selectionsCount = selectionsCountResult.rows?.[0]?.count ?? 0;
      await client.query(`TRUNCATE ${selectionsTable} RESTART IDENTITY;`);
      console.log(`✅ Truncated table "${selectionsTable}". Removed ${selectionsCount} row${selectionsCount === 1 ? '' : 's'}.`);
    } catch (error) {
      if (error?.code === '42P01') {
        console.warn(`⚠️  Table "${selectionsTable}" does not exist. Skipping.`);
      } else {
        throw error;
      }
    }

    // Count and truncate portrait_analyses
    try {
      const analysesCountResult = await client.query(`SELECT COUNT(*)::int AS count FROM ${analysesTable};`);
      analysesCount = analysesCountResult.rows?.[0]?.count ?? 0;
      await client.query(`TRUNCATE ${analysesTable} RESTART IDENTITY;`);
      console.log(`✅ Truncated table "${analysesTable}". Removed ${analysesCount} row${analysesCount === 1 ? '' : 's'}.`);
    } catch (error) {
      if (error?.code === '42P01') {
        console.warn(`⚠️  Table "${analysesTable}" does not exist. Skipping.`);
      } else {
        throw error;
      }
    }

    await client.query('COMMIT');
    
    totalCount = selectionsCount + analysesCount;
    console.log(`\n🎉 Successfully cleared all photos from database. Total records removed: ${totalCount}`);
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback errors, we'll surface the original error.
    }

    console.error('Failed to clear photos from database.', {
      message: error?.message,
      code: error?.code
    });
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }

  return totalCount;
}

main().catch((error) => {
  console.error('Unexpected error while clearing all photos:', error);
  process.exit(1);
});
