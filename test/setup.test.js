import test from 'node:test';
import assert from 'node:assert/strict';
import { getHealthCheck, getHttpHealthCheck, getSetupCommands, getStartCommands } from '../src/utils/setup.js';

test('Node build installs build dependencies, builds, then prunes', () => {
  const commands = getStartCommands({
    projectType: 'nodejs', remotePath: '/var/www/app', appName: 'app', appMode: 'web',
    startCmd: 'npm start', buildCmd: 'npm run build',
  });
  const joined = commands.map(step => step.cmd).join('\n');
  assert.match(joined, /npm ci/);
  assert.match(joined, /npm run build/);
  assert.match(joined, /npm prune --omit=dev/);
  const startScript = commands.find(step => step.label === '写入启动脚本').cmd;
  const encoded = startScript.match(/printf '%s' '([^']+)'/)[1];
  assert.match(Buffer.from(encoded, 'base64').toString('utf-8'), /\. \.\/\.env/);
});

test('pyproject install and static builds are complete', () => {
  const python = getStartCommands({
    projectType: 'python', remotePath: '/var/www/api', appName: 'api', appMode: 'web',
    startCmd: 'gunicorn api:app', pythonDependencySource: 'pyproject', pythonFramework: 'flask',
  });
  assert.match(python.map(step => step.cmd).join('\n'), /pip install \/var\/www\/api/);

  const site = getStartCommands({
    projectType: 'static', remotePath: '/var/www/site', staticDir: 'dist', buildCmd: 'npm run build',
  });
  const joined = site.map(step => step.cmd).join('\n');
  assert.match(joined, /npm run build/);
  assert.match(joined, /test -f \/var\/www\/site\/dist\/index.html/);
});

test('cron validation command fails when the job fails and loads env', () => {
  const commands = getStartCommands({
    projectType: 'nodejs', remotePath: '/var/www/job', appName: 'job', appMode: 'cron',
    startCmd: 'npm start', cronSchedule: '0 2 * * *', buildCmd: '',
  });
  const verify = commands.find(step => step.label.includes('立即执行'));
  assert.doesNotMatch(verify.cmd, /\|\| true/);
  assert.match(verify.cmd, /\. \.\/\.env/);
});

test('cron entries preserve runtime variables and escape percent signs', () => {
  const commands = getStartCommands({
    projectType: 'nodejs', remotePath: '/var/www/job', appName: 'job', appMode: 'cron',
    startCmd: 'echo "$TOKEN" $(date +%F)', cronSchedule: '0 2 * * *', buildCmd: '',
  });
  const install = commands.find(step => step.label.includes('写入定时'));
  assert.match(install.cmd, /\$TOKEN/);
  assert.match(install.cmd, /\\%F/);
});

test('setup installs rsync and HTTP health distinguishes gateway failures', () => {
  const setup = getSetupCommands({ projectType: 'static' });
  assert.ok(setup.some(step => step.cmd.includes('rsync') && step.cmd.includes('curl')));
  const health = getHttpHealthCheck({ appMode: 'web', domain: 'example.com' });
  assert.equal(health.parse({ stdout: '200' }).ok, true);
  assert.equal(health.parse({ stdout: '404' }).ok, true);
  assert.equal(health.parse({ stdout: '502' }).ok, false);
  assert.match(getHttpHealthCheck({ appMode: 'web', domain: 'example.com', useHttps: true }).cmd, /--resolve/);
  assert.equal(getHealthCheck({ projectType: 'static', appMode: 'web' }).parse({ stdout: 'active' }).ok, true);
});

test('SSH and application ports stay separate and no-domain checks the app directly', () => {
  const commands = getStartCommands({
    projectType: 'docker', remotePath: '/var/www/app', appName: 'app', appMode: 'web',
    port: '2222', appPort: '8080', composeFile: '',
  });
  assert.match(commands.map(step => step.cmd).join('\n'), /-p 8080:8080/);
  assert.doesNotMatch(commands.map(step => step.cmd).join('\n'), /-p 2222:2222/);
  const direct = getHttpHealthCheck({ appMode: 'web', configureNginx: false, host: 'example.com', port: '2222', appPort: '8080' });
  assert.match(direct.cmd, /127\.0\.0\.1:8080/);
});
