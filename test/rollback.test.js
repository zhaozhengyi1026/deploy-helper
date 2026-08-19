import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshot } from '../src/commands/rollback.js';

function snapshotSsh() {
  const commands = [];
  return {
    commands,
    async execCommand(command) {
      commands.push(command);
      if (command.includes('find /var/www/app')) return { stdout: '/var/www/app/index.js', stderr: '', code: 0 };
      return { stdout: '', stderr: '', code: 0 };
    },
  };
}

test('pre-rollback snapshot can skip pruning the selected history', async () => {
  const ssh = snapshotSsh();
  const name = await createSnapshot(ssh, { appName: 'app', remotePath: '/var/www/app' }, { prune: false });
  assert.match(name, /^app_/);
  assert.doesNotMatch(ssh.commands.join('\n'), /tail -n \+6/);
});

test('normal deployment snapshots still prune old history', async () => {
  const ssh = snapshotSsh();
  await createSnapshot(ssh, { appName: 'app', remotePath: '/var/www/app' });
  assert.match(ssh.commands.join('\n'), /tail -n \+6/);
});
