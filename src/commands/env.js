import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import fs from 'fs';
import path from 'path';
import { connectSSH, runRemoteSilent, runRemoteStrict } from '../utils/ssh.js';
import { loadConfig, resolveCredentials, selectServer } from '../utils/config.js';
import { getStartCommands } from '../utils/setup.js';

const ENV_BACKUP_DIR = '/var/deploy-helper/env-backups';

/**
 * 解析 .env 文件，返回键值对数组（过滤注释和空行）
 */
function parseEnvFile(content) {
  return content
    .split('\n')
    .map((line, i) => ({ line: line.trim(), num: i + 1 }))
    .filter(({ line }) => line && !line.startsWith('#'))
    .map(({ line, num }) => {
      const eqIdx = line.indexOf('=');
      if (eqIdx === -1) return null;
      const key = line.slice(0, eqIdx).trim().replace(/^export\s+/, '');
      const value = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      return { key, value, num };
    })
    .filter(Boolean);
}

/**
 * 展示 .env 内容预览（隐藏敏感值）
 */
function previewEnv(vars) {
  console.log(chalk.bold('\n  .env 文件内容预览：\n'));
  vars.forEach(({ key, value }) => {
    const isSensitive = /secret|password|key|token|pwd|pass|credential|auth|cookie|session|private|dsn|url|uri/i.test(key);
    const displayVal = isSensitive
      ? chalk.gray(`<已隐藏，${value.length} 个字符>`)
      : chalk.gray(value.length > 40 ? value.slice(0, 40) + '...' : value);
    console.log(`    ${chalk.cyan(key)}=${displayVal}`);
  });
  console.log('');
}

export async function deployEnv() {
  let config = loadConfig();
  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  config = await selectServer(config, '管理环境变量');
  await resolveCredentials(config);

  // 检查本地 .env 是否存在
  const localEnvPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(localEnvPath)) {
    console.log(chalk.yellow('\n本地没有找到 .env 文件。'));
    const { create } = await inquirer.prompt([{
      type: 'confirm',
      name: 'create',
      message: '是否从服务器拉取现有的 .env？',
      default: true,
    }]);
    if (create) {
      await pullEnv(config);
    }
    return;
  }

  const envContent = fs.readFileSync(localEnvPath, 'utf-8');
  const vars = parseEnvFile(envContent);

  if (vars.length === 0) {
    console.log(chalk.yellow('\n.env 文件是空的或只有注释。\n'));
    return;
  }

  previewEnv(vars);

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: '要做什么？',
    choices: [
      { name: '上传本地 .env 到服务器（覆盖）', value: 'push' },
      { name: '从服务器拉取 .env 到本地', value: 'pull' },
      { name: '对比本地和服务器的 .env 差异', value: 'diff' },
    ],
  }]);

  if (action === 'push') await pushEnv(config, envContent, vars);
  else if (action === 'pull') await pullEnv(config);
  else if (action === 'diff') await diffEnv(config, vars);
}

async function pushEnv(config, envContent, vars) {
  const { confirm } = await inquirer.prompt([{
    type: 'confirm',
    name: 'confirm',
    message: `确认上传 ${vars.length} 个变量到服务器 ${config.host}？（将覆盖服务器上现有的 .env）`,
    default: true,
  }]);
  if (!confirm) return;

  let ssh;
  const spinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('连接成功');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  try {
    // 备份服务器现有 .env
    const backupSpinner = ora('备份服务器现有 .env...').start();
    await runRemoteStrict(ssh, `mkdir -p ${ENV_BACKUP_DIR} && chmod 700 ${ENV_BACKUP_DIR}`);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const oldEnv = await runRemoteSilent(ssh, `test -f ${config.remotePath}/.env`);
    if (oldEnv.code === 0) {
      await runRemoteStrict(ssh, `cp ${config.remotePath}/.env ${ENV_BACKUP_DIR}/.env_${config.appName}_${timestamp}`);
      backupSpinner.succeed('已备份旧 .env');
    } else {
      backupSpinner.info('服务器上没有旧 .env，跳过备份');
    }

    // 上传新 .env：base64 编码后在服务器解码，彻底避开 shell 转义/heredoc sentinel 问题
    const uploadSpinner = ora('上传 .env 到服务器...').start();
    const b64 = Buffer.from(envContent, 'utf-8').toString('base64');
    await runRemoteStrict(ssh, `echo '${b64}' | base64 -d > ${config.remotePath}/.env`);
    await runRemoteStrict(ssh, `chmod 600 ${config.remotePath}/.env`);
    uploadSpinner.succeed('.env 上传完成，权限已设为 600');

    // cron 模式不需要重启（下次定时使用新环境变量）
    const appMode = config.appMode || 'web';
    if (appMode === 'cron') {
      console.log(chalk.gray('  ℹ 定时任务模式，新 .env 将在下次执行时生效'));
    } else {
      const { restart } = await inquirer.prompt([{
        type: 'confirm',
        name: 'restart',
        message: '是否重启服务让新变量生效？',
        default: true,
      }]);

      if (restart) {
        const restartSpinner = ora('重启服务...').start();
        try {
          if (config.projectType === 'nodejs') {
            await runRemoteStrict(ssh, `pm2 restart ${config.appName}`);
          } else if (config.projectType === 'python') {
            await runRemoteStrict(ssh, `supervisorctl restart ${config.appName}`);
          } else if (config.projectType === 'docker') {
            if (config.composeFile) {
              await runRemoteStrict(ssh, `cd ${config.remotePath} && docker compose -f ${config.composeFile} up -d --force-recreate`);
            } else {
              const startContainer = getStartCommands(config).find(step => step.label === '启动容器');
              if (!startContainer) throw new Error('无法生成 Docker 容器重建命令');
              await runRemoteStrict(ssh, startContainer.cmd);
            }
          }
          restartSpinner.succeed('服务已重启');
        } catch (err) {
          restartSpinner.fail('服务重启失败');
          throw err;
        }
      }
    }

    ssh.dispose();
    console.log(chalk.green.bold('\n✅ .env 同步完成！\n'));

  } catch (err) {
    console.log(chalk.red('\n环境变量同步失败：' + err.message));
    ssh.dispose();
  }
}

async function pullEnv(config) {
  const localEnvPath = path.join(process.cwd(), '.env');
  if (fs.existsSync(localEnvPath)) {
    const { overwrite } = await inquirer.prompt([{
      type: 'confirm',
      name: 'overwrite',
      message: '本地已有 .env，确认覆盖？',
      default: false,
    }]);
    if (!overwrite) return;
  }

  let ssh;
  const spinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('连接成功');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  try {
    const exists = await runRemoteSilent(ssh, `test -f ${config.remotePath}/.env`);
    if (exists.code !== 0) {
      console.log(chalk.yellow('\n服务器上没有 .env 文件。\n'));
      ssh.dispose();
      return;
    }
    await ssh.getFile(localEnvPath, `${config.remotePath}/.env`);
    try { fs.chmodSync(localEnvPath, 0o600); } catch { /* Windows may not apply POSIX modes. */ }
    ssh.dispose();
    console.log(chalk.green.bold('\n✅ 已从服务器拉取 .env 到本地。\n'));

  } catch (err) {
    console.log(chalk.red('\n拉取失败：' + err.message));
    ssh.dispose();
  }
}

async function diffEnv(config, localVars) {
  let ssh;
  const spinner = ora('获取服务器 .env...').start();
  try {
    ssh = await connectSSH(config);
    const result = await runRemoteSilent(ssh, `cat ${config.remotePath}/.env 2>/dev/null || echo ""`);
    ssh.dispose();
    spinner.succeed('获取完成');

    const remoteVars = parseEnvFile(result.stdout);
    const localMap = Object.fromEntries(localVars.map(v => [v.key, v.value]));
    const remoteMap = Object.fromEntries(remoteVars.map(v => [v.key, v.value]));

    const allKeys = new Set([...Object.keys(localMap), ...Object.keys(remoteMap)]);

    console.log(chalk.bold('\n  差异对比（本地 vs 服务器）：\n'));
    let hasDiff = false;

    for (const key of allKeys) {
      if (!(key in localMap)) {
        console.log(chalk.red(`  - ${key}`) + chalk.gray('（仅服务器有）'));
        hasDiff = true;
      } else if (!(key in remoteMap)) {
        console.log(chalk.green(`  + ${key}`) + chalk.gray('（仅本地有）'));
        hasDiff = true;
      } else if (localMap[key] !== remoteMap[key]) {
        console.log(chalk.yellow(`  ~ ${key}`) + chalk.gray('（值不同）'));
        hasDiff = true;
      }
    }

    if (!hasDiff) {
      console.log(chalk.green('  本地和服务器 .env 完全一致 ✓'));
    }
    console.log('');

  } catch (err) {
    spinner.fail('获取失败：' + err.message);
  }
}
