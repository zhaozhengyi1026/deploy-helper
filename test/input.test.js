import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSshCommand, validateCron, validateDomain, validatePort, validateRemotePath } from '../src/utils/input.js';

test('parseSshCommand supports common option order and identity files', () => {
  assert.deepEqual(parseSshCommand('ssh -p 2222 deploy@example.com'), {
    user: 'deploy', host: 'example.com', port: '2222', keyPath: null,
  });
  const parsed = parseSshCommand('ssh -i ~/.ssh/id_ed25519 root@1.2.3.4 -p 2200');
  assert.equal(parsed.user, 'root');
  assert.equal(parsed.host, '1.2.3.4');
  assert.equal(parsed.port, '2200');
  assert.match(parsed.keyPath, /id_ed25519$/);
});

test('input validators reject unsafe or misleading values', () => {
  assert.equal(validatePort('65535'), true);
  assert.notEqual(validatePort('70000'), true);
  assert.equal(validateRemotePath('/var/www/app'), true);
  assert.notEqual(validateRemotePath('/'), true);
  assert.notEqual(validateRemotePath('/var/www/app name'), true);
  assert.equal(validateCron('0 */6 * * *'), true);
  assert.notEqual(validateCron('0 2 * * *; reboot'), true);
  assert.equal(validateDomain('app.example.com'), true);
  assert.notEqual(validateDomain('localhost;reboot'), true);
});
