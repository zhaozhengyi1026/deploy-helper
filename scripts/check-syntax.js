import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';

function listJavaScriptFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJavaScriptFiles(fullPath);
    return entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

const files = [
  ...listJavaScriptFiles('src'),
  ...listJavaScriptFiles('scripts'),
  ...listJavaScriptFiles('test'),
  ...listJavaScriptFiles('website'),
];
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) failed = true;
}

if (failed) process.exit(1);
console.log(`Syntax check passed (${files.length} files).`);
