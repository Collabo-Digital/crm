// Run prisma/scripts/db-size-report.sql against DIRECT_URL (or DATABASE_URL)
// through a throwaway postgres:17-alpine container, so the result rows are
// actually printed (`prisma db execute` discards them). Chained after
// print-target.js by `npm run db:report:size`, which shows the host first.
//
// Requires Docker. On the droplet: `cd /opt/crm/server && npm run db:report:size`.
try {
  require('dotenv/config');
} catch {
  // container image has no dotenv; env vars are already set there
}
const { execFileSync } = require('child_process');
const { openSync } = require('fs');
const { join } = require('path');

const url = process.env.DIRECT_URL || process.env.DATABASE_URL;
if (!url) {
  console.error('DIRECT_URL / DATABASE_URL not set');
  process.exit(1);
}
const sql = openSync(join(__dirname, 'db-size-report.sql'), 'r');
execFileSync(
  'docker',
  ['run', '--rm', '-i', 'postgres:17-alpine', 'psql', url, '-v', 'ON_ERROR_STOP=1', '-f', '-'],
  { stdio: [sql, 'inherit', 'inherit'] },
);
