import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tiny .env loader (avoids a dotenv dependency). Existing process env always
 * wins, so container/CI variables override the file.
 */
export function loadEnv(file = '.env'): void {
  const path = join(process.cwd(), file);
  if (!existsSync(path)) return;

  for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
