import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runRemoteStrict, uploadDirectory } from '../src/utils/ssh.js';

function mockSsh({ uploadResult = true, code = 0 } = {}) {
  const commands = [];
  return {
    commands,
    async execCommand(command) {
      commands.push(command);
      return { stdout: '', stderr: '', code };
    },
    async putDirectory() { return uploadResult; },
  };
}

test('runRemoteStrict rejects missing exit status', async () => {
  const ssh = mockSsh({ code: null });
  await assert.rejects(() => runRemoteStrict(ssh, 'true'), /exit unknown/);
});

test('upload mirrors verified staging content and preserves secrets', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-helper-upload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'index.js'), 'console.log(1);');
  const ssh = mockSsh();
  await uploadDirectory(ssh, dir, '/var/www/app');
  const commands = ssh.commands.join('\n');
  assert.match(commands, /rsync -a --delete/);
  assert.match(commands, /--exclude='\.env'/);
  assert.match(commands, /--exclude='\.deploy-config\.json'/);
  assert.doesNotMatch(commands, /--exclude='dist'/);
});

test('upload rejects an incomplete SFTP transfer', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-helper-upload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ssh = mockSsh({ uploadResult: false });
  await assert.rejects(() => uploadDirectory(ssh, dir, '/var/www/app'), /上传不完整/);
});
