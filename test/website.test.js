import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

test('project website covers purpose, usage, recovery and outcome', () => {
  const html = fs.readFileSync(path.join('website', 'index.html'), 'utf8');
  for (const id of ['why', 'route', 'result', 'start', 'demo']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /Windows、macOS 和 Linux/);
  assert.match(html, /Ctrl\+C/);
  assert.match(html, /deploy-helper init/);
  assert.match(html, /Docker、Compose/);
  assert.match(html, /Nginx/);
});

test('website assets are local and accessibility essentials are present', () => {
  const html = fs.readFileSync(path.join('website', 'index.html'), 'utf8');
  assert.equal(fs.existsSync(path.join('website', 'styles.css')), true);
  assert.equal(fs.existsSync(path.join('website', 'app.js')), true);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<img(?![^>]*alt=)/);
});
