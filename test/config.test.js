import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateConfig, selectServer } from '../src/utils/config.js';

test('single managed server inherits shared app settings without nested server lists', async () => {
  const root = {
    appName: 'app', projectType: 'nodejs', database: { type: 'mysql' },
    servers: [{ label: 'primary', host: '1.2.3.4', user: 'root', servers: [{ host: 'stale' }] }],
  };
  const selected = await selectServer(root, 'test');
  assert.equal(selected.appName, 'app');
  assert.equal(selected.host, '1.2.3.4');
  assert.equal(selected.servers, undefined);
  assert.equal(selected.__rootConfig, root);
  assert.equal(Object.keys(selected).includes('__rootConfig'), false);
});

test('legacy configuration separates application and SSH ports', () => {
  const migrated = migrateConfig({ projectType: 'nodejs', port: '3000', host: 'server.test' });
  assert.equal(migrated.appPort, '3000');
  assert.equal(migrated.sshPort, 22);
  assert.equal(migrated.port, 22);
});
