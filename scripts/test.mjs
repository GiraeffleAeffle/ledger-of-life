import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
function tests(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? tests(join(directory, entry.name))
      : entry.name.endsWith('.test.ts')
        ? [join(directory, entry.name)]
        : [],
  );
}
const result = spawnSync(
  process.execPath,
  ['--experimental-strip-types', '--test', ...tests('src'), 'host-connector/connector.test.mjs'],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
