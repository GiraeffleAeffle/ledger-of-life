import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
const path = '.env.local';
let content = existsSync(path) ? readFileSync(path, 'utf8') : '';
const defaults = {
  APP_ORIGIN: 'http://localhost:4175',
  LOCAL_DATABASE_PATH: '.data/rental.sqlite',
  ALLOW_LOCAL_STORE: '1',
  ALLOW_HOME_ASSISTANT_PULL: '1',
  RECONCILE_SECRET: randomBytes(32).toString('hex'),
};
const added = [];
for (const [key, value] of Object.entries(defaults)) {
  if (new RegExp(`^${key}=`, 'm').test(content)) continue;
  content += `\n${key}=${value}\n`;
  added.push(key);
}
writeFileSync(path, content, { mode: 0o600 });
chmodSync(path, 0o600);
console.log(
  added.length
    ? `Local configuration prepared: ${added.join(', ')}. Secret values were not printed.`
    : 'Existing local configuration preserved.',
);
console.log('Start with npm run dev. Add provider credentials locally before connected tests.');
