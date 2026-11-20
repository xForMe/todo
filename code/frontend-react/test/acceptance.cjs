// TEST-025: run the isolated checks only; never include the live-service scripts.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const frontend = path.resolve(__dirname, '..');
const scripts = path.resolve(frontend, '../scripts');
const env = { ...process.env,
  NODE_PATH: [path.join(frontend, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
};
const isolated = [
  'verify-drawer-dismiss', 'verify-daily-review', 'verify-event-dependencies', 'verify-plan-history',
  'verify-follow-people', 'verify-daily-follow-up', 'verify-event-images', 'verify-image-actions',
  'verify-matter-decomposition', 'verify-chat-results', 'verify-memory', 'verify-working-memory', 'verify-memory-candidates',
  'verify-module-choices', 'verify-action-pagination',
];
const failures = [];

for (const name of isolated) {
  console.log(`\n[react] ${name}`);
  const result = spawnSync(process.execPath, [path.join(scripts, `${name}.cjs`)],
    { cwd: frontend, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) failures.push(`${name}: ${result.error || result.signal || result.status}`);
}

if (failures.length) {
  console.error(`\nIsolated acceptance failures:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${isolated.length} isolated React specialist runs passed.`);
}
