import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import { detectLocalPlatform, getPathExample, inspectLocalTools } from './platform.js';
import { expandHome, findDefaultPrivateKey } from './input.js';
import { runRemoteStrict } from './ssh.js';
import { promptUser } from './prompt.js';

export function printPlatformSummary(platform = process.platform) {
  const local = detectLocalPlatform(platform);
  console.log(chalk.blue(`本机系统：${local.name}`) + chalk.gray('（后续提示会使用适合此系统的命令格式）'));
  return local;
}

export async function runLocalPreflight(platform = process.platform) {
  const local = detectLocalPlatform(platform);
  console.log(chalk.bold('\n开始前检查：'));
  if (!local.supported) {
    console.log(chalk.yellow(`  ⚠ 暂未针对 ${local.name} 提供安装指引，但仍可尝试继续。`));
  }

  while (true) {
    const tools = inspectLocalTools(platform);
    for (const tool of tools) {
      const mark = tool.installed ? chalk.green('✓ 已安装') : chalk.yellow(tool.optional ? '○ 未安装（可选）' : '✗ 未安装');
      console.log(`  ${mark}  ${tool.name}`);
    }
    const missing = tools.filter(tool => !tool.installed && !tool.optional);
    if (missing.length === 0) {
      console.log(chalk.green('  本机工具检查通过，可以继续。\n'));
      return true;
    }

    console.log(chalk.yellow('\n缺少必要工具，请按下面的说明安装：'));
    for (const tool of missing) {
      console.log(chalk.bold(`\n${tool.name}`));
      tool.guide.forEach(line => console.log(`  ${line}`));
    }
    const { action } = await promptUser([{
      type: 'list',
      name: 'action',
      message: '安装完成后请选择：',
      choices: [
        { name: '我已安装，重新检查', value: 'retry' },
        { name: '暂时退出，安装好后再运行', value: 'exit' },
      ],
    }]);
    if (action === 'exit') return false;
  }
}

function createSshKey(keyPath) {
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  const result = spawnSync('ssh-keygen', ['-t', 'ed25519', '-f', keyPath, '-N', '', '-C', 'deploy-helper'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error('创建 SSH 密钥失败');
}

export async function offerPasswordlessLogin(ssh, serverAnswers) {
  console.log(chalk.bold('\n可选准备：SSH 免密登录'));
  console.log(chalk.gray('配置后，以后部署不必反复输入服务器密码。密钥只保存在你的电脑上。'));

  if (serverAnswers.authType === 'key') {
    console.log(chalk.green('  ✓ 你已经在使用 SSH 密钥，无需重复配置。'));
    return serverAnswers;
  }

  const { configure } = await promptUser([{
    type: 'confirm',
    name: 'configure',
    message: '现在配置免密登录吗？（推荐，也可以以后再配）',
    default: true,
  }]);
  if (!configure) {
    console.log(chalk.gray('  已跳过。后续仍可使用密码部署。'));
    return serverAnswers;
  }

  const suggested = findDefaultPrivateKey();
  const { keyPath } = await promptUser([{
    type: 'input',
    name: 'keyPath',
    message: `密钥保存位置（例如 ${getPathExample()}）：`,
    default: suggested,
    validate: value => String(value).trim() ? true : '请输入保存位置',
  }]);
  const resolved = path.resolve(expandHome(keyPath));
  if (!fs.existsSync(resolved)) {
    console.log(chalk.gray('  正在创建一把新的专用密钥……'));
    createSshKey(resolved);
  }
  const publicKeyPath = `${resolved}.pub`;
  if (!fs.existsSync(publicKeyPath)) throw new Error(`找不到公钥文件：${publicKeyPath}`);

  const publicKey = fs.readFileSync(publicKeyPath, 'utf8').trim();
  const encoded = Buffer.from(publicKey).toString('base64');
  await runRemoteStrict(ssh, `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF "$(printf '%s' '${encoded}' | base64 -d)" ~/.ssh/authorized_keys || printf '%s\\n' '${encoded}' | base64 -d >> ~/.ssh/authorized_keys) && chmod 600 ~/.ssh/authorized_keys`);
  console.log(chalk.green('  ✓ 免密登录配置完成。以后会自动使用这把密钥。'));
  return { ...serverAnswers, authType: 'key', keyPath: resolved, password: undefined };
}

export function classifyDeploymentError(error) {
  const text = `${error?.code || ''} ${error?.message || ''}`.toLowerCase();
  if (/etimedout|econnreset|timeout|timed out|network|temporary failure/.test(text)) return 'temporary';
  if (/econnrefused|authentication|permission denied|all configured authentication/.test(text)) return 'connection';
  if (/address already in use|port.+in use|eaddrinuse/.test(text)) return 'port';
  return 'manual';
}

export async function runRecoverableStep({ label, action, manualCommands = [], onEdit }) {
  while (true) {
    try {
      return await action();
    } catch (error) {
      const kind = classifyDeploymentError(error);
      console.log(chalk.red(`\n${label}没有完成：${error.message}`));
      if (kind === 'temporary') console.log(chalk.yellow('这通常是临时网络问题，稍后重试往往可以恢复。'));
      if (kind === 'port') console.log(chalk.yellow('应用端口可能已被其他程序占用，可以返回修改端口。'));
      if (kind === 'connection') console.log(chalk.yellow('服务器地址、端口、用户名或登录凭据可能不正确。'));
      if (manualCommands.length) {
        console.log(chalk.bold('\n如果自动处理一直失败，可登录服务器逐条运行：'));
        manualCommands.forEach(command => console.log(chalk.cyan(`  ${command}`)));
      }
      const choices = [{ name: '重试这一步', value: 'retry' }];
      if (onEdit) choices.push({ name: '返回上一步修改信息', value: 'edit' });
      if (manualCommands.length) choices.push({ name: '我已手动修复，继续检查', value: 'fixed' });
      choices.push({ name: '保存进度并退出', value: 'exit' });
      const { next } = await promptUser([{ type: 'list', name: 'next', message: '接下来怎么做？', choices }]);
      if (next === 'edit') {
        await onEdit(error);
        continue;
      }
      if (next === 'exit') {
        const exitError = new Error('用户选择保存进度并退出');
        exitError.code = 'DEPLOY_PAUSE';
        throw exitError;
      }
    }
  }
}
