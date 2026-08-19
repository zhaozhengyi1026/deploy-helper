import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  detectProjectType, detectPythonDependencySource, detectPythonFramework,
  detectStaticOutputDir, getNodeBuildCommand, getNodeStartCommand, getPythonStartCommand,
} from '../src/utils/detect.js';

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-helper-test-'));
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return dir;
}

test('detects modern Node build and uses npm-aware commands', t => {
  const dir = fixture({
    'package.json': JSON.stringify({ scripts: { build: 'next build' }, dependencies: { next: '15.0.0' } }),
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(detectProjectType(dir), 'nodejs');
  assert.equal(getNodeStartCommand(dir).cmd, 'npm exec -- next start');
  assert.equal(getNodeBuildCommand(dir).cmd, 'npm run build');
  assert.equal(detectStaticOutputDir(dir), 'out');
});

test('Vite output detection does not mistake public assets for build output', t => {
  const dir = fixture({
    'package.json': JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: 'latest' } }),
    'public/favicon.ico': 'x',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(detectStaticOutputDir(dir), 'dist');
});

test('supports pyproject dependencies and discovers Django module', t => {
  const dir = fixture({
    'pyproject.toml': '[project]\ndependencies = ["Django>=5"]\n',
    'config/wsgi.py': '',
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(detectPythonDependencySource(dir), 'pyproject');
  assert.equal(detectPythonFramework(dir), 'django');
  assert.match(getPythonStartCommand('django', 'wrong-name', '8000', dir), /config\.wsgi/);
});
