import { randomBytes } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';

const path = new URL('../.env', import.meta.url);
const env = await readFile(path, 'utf8');
if (/^CRON_SECRET=.+$/m.test(env)) {
  console.log('CRON_SECRET already exists; keep the scheduler and API values in sync.');
} else {
  await appendFile(path, `\nCRON_SECRET=${randomBytes(32).toString('base64url')}\n`);
  console.log('CRON_SECRET saved to ignored .env. Copy it privately to the API host and scheduler.');
}
