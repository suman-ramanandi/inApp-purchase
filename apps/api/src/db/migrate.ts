// CLI: node src/db/migrate.ts [latest|down]
import { loadConfig } from '../config.ts';
import { createDb } from './client.ts';
import { migrate } from './migrator.ts';

const target = process.argv[2] ?? 'latest';
if (target !== 'latest' && target !== 'down') {
  console.error(`Unknown migration target "${target}". Use "latest" or "down".`);
  process.exit(2);
}

const db = createDb(loadConfig().DATABASE_URL);
try {
  const results = await migrate(db, target);
  if (results.length === 0) {
    console.log('No migrations to run.');
  }
  for (const r of results) {
    console.log(`${r.direction} ${r.migrationName}: ${r.status}`);
  }
} finally {
  await db.destroy();
}
