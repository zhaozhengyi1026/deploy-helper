import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectLocalPlatform, getInstallGuide } from '../src/utils/platform.js';
import { parseEnvironmentTemplate, serializeEnvironment } from '../src/utils/environment.js';
import { clearProgress, loadProgress, saveProgress } from '../src/utils/progress.js';
import { getGitDeployCommand, validateGitBranch, validateGitUrl } from '../src/utils/source.js';
import { classifyDeploymentError } from '../src/utils/onboarding.js';

test('platform detection and installation guidance are system-specific', () => {
  assert.equal(detectLocalPlatform('win32').name, 'Windows');
  assert.equal(detectLocalPlatform('darwin').name, 'macOS');
  assert.match(getInstallGuide('git', 'win32').join(' '), /winget/);
  assert.match(getInstallGuide('ssh', 'linux').join(' '), /openssh-client/);
});

test('environment templates become individual safe prompts', () => {
  const variables = parseEnvironmentTemplate('# public URL\nAPP_URL=http://localhost\n# keep private\nAPI_SECRET=\nexport PORT=3000');
  assert.deepEqual(variables.map(item => item.name), ['APP_URL', 'API_SECRET', 'PORT']);
  assert.equal(variables[1].sensitive, true);
  assert.match(serializeEnvironment({ APP_URL: 'hello world', API_SECRET: "a'b" }), /API_SECRET='a'\\''b'/);
});

test('progress survives restart without secrets', () => {
  const previousCwd = process.cwd();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-helper-progress-'));
  try {
    process.chdir(temporary);
    saveProgress({ stage: 'connected', answers: { host: 'server.test', password: 'nope', apiToken: 'nope' } });
    const restored = loadProgress();
    assert.equal(restored.stage, 'connected');
    assert.equal(restored.answers.host, 'server.test');
    assert.equal(restored.answers.password, undefined);
    assert.equal(restored.answers.apiToken, undefined);
    clearProgress();
    assert.equal(loadProgress(), null);
  } finally {
    process.chdir(previousCwd);
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('Git source validation and deployment command preserve remote env', () => {
  assert.equal(validateGitUrl('https://github.com/name/project.git'), true);
  assert.notEqual(validateGitUrl('file:///tmp/project'), true);
  assert.equal(validateGitBranch('release/v1'), true);
  assert.notEqual(validateGitBranch('-dangerous'), true);
  const command = getGitDeployCommand({
    repositoryUrl: 'https://github.com/name/project.git', repositoryBranch: 'main', remotePath: '/var/www/app',
  });
  assert.match(command, /git clone/);
  assert.match(command, /--exclude='\.env'/);
  assert.match(command, /pull --ff-only/);
});

test('deployment errors lead to distinct recovery paths', () => {
  assert.equal(classifyDeploymentError({ code: 'ETIMEDOUT' }), 'temporary');
  assert.equal(classifyDeploymentError({ message: 'address already in use' }), 'port');
  assert.equal(classifyDeploymentError({ message: 'Permission denied' }), 'connection');
  assert.equal(classifyDeploymentError({ message: 'package install failed' }), 'manual');
});
