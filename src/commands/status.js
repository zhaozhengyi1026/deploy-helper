import chalk from 'chalk';
import ora from 'ora';
import { connectSSH, runRemoteSilent } from '../utils/ssh.js';
import { loadConfig, resolveCredentials, selectServer } from '../utils/config.js';
import { getHttpHealthCheck } from '../utils/setup.js';

export async function deployStatus() {
  let config = loadConfig();

  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  config = await selectServer(config, '查看状态');
  await resolveCredentials(config);

  let ssh;
  const spinner = ora('连接服务器获取状态...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('已连接');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  console.log(chalk.bold('\n📊 服务器状态报告\n'));

  // 系统基本信息
  const [uptime, memInfo, diskInfo] = await Promise.all([
    runRemoteSilent(ssh, "uptime -p"),
    runRemoteSilent(ssh, "free -m | awk 'NR==2{printf \"%s MB / %s MB\", $3, $2}'"),
    runRemoteSilent(ssh, "df -h / | awk 'NR==2{printf \"%s / %s (%s)\", $3, $2, $5}'"),
  ]);

  console.log(chalk.gray('  系统运行时间：') + uptime.stdout);
  console.log(chalk.gray('  内存占用：    ') + memInfo.stdout);
  console.log(chalk.gray('  磁盘占用：    ') + diskInfo.stdout);

  // 应用状态
  console.log(chalk.bold('\n  应用状态：'));

  const appMode = config.appMode || 'web';

  // cron 模式：单独处理（不走 PM2 / supervisor / docker 分支）
  if (appMode === 'cron') {
    await showCronStatus(ssh, config);
  } else if (config.projectType === 'nodejs') {
    await showNodeStatus(ssh, config);
  } else if (config.projectType === 'python') {
    await showPythonStatus(ssh, config);
  } else if (config.projectType === 'docker') {
    await showDockerStatus(ssh, config);
  } else if (config.projectType === 'static') {
    console.log(chalk.gray(config.configureNginx === false
      ? '    静态文件已生成，但尚未配置公开访问入口'
      : '    静态站点，无独立进程（由 Nginx 直接托管）'));
  }

  // Nginx 状态（仅 web 服务需要）
  if (appMode === 'web' && config.configureNginx !== false) {
    console.log(chalk.bold('\n  Nginx 状态：'));
    const nginxStatus = await runRemoteSilent(ssh, `systemctl is-active nginx`);
    const isActive = nginxStatus.stdout.trim() === 'active';
    console.log(`  ${isActive ? chalk.green('● 运行中') : chalk.red('✗ 未运行')}`);

    // 访问地址
    const accessUrl = config.configureNginx === false
      ? `http://${config.host}:${config.appPort || 80}`
      : config.useHttps && config.domain
      ? `https://${config.domain}`
      : config.domain ? `http://${config.domain}` : `http://${config.host}`;
    console.log(chalk.bold('\n  访问地址：') + chalk.cyan.underline(accessUrl));
    const httpHealth = getHttpHealthCheck(config);
    if (httpHealth) {
      const httpResult = await runRemoteSilent(ssh, httpHealth.cmd);
      const httpStatus = httpHealth.parse(httpResult);
      console.log(chalk.gray('  HTTP 检查：') + (httpStatus.ok ? chalk.green(httpStatus.detail) : chalk.red(httpStatus.detail)));
    }
  } else if (appMode === 'web' && config.projectType === 'static') {
    console.log(chalk.yellow('\n  没有配置 Nginx，因此静态文件目前没有公开访问地址。'));
  } else if (appMode === 'web') {
    const accessUrl = `http://${config.host}:${config.appPort || 80}`;
    console.log(chalk.bold('\n  访问地址：') + chalk.cyan.underline(accessUrl));
    const httpHealth = getHttpHealthCheck(config);
    if (httpHealth) {
      const httpResult = await runRemoteSilent(ssh, httpHealth.cmd);
      const httpStatus = httpHealth.parse(httpResult);
      console.log(chalk.gray('  HTTP 检查：') + (httpStatus.ok ? chalk.green(httpStatus.detail) : chalk.red(httpStatus.detail)));
    }
  }

  if (config.deployedAt) {
    console.log(chalk.gray(`\n  上次部署：${new Date(config.deployedAt).toLocaleString('zh-CN')}\n`));
  }

  ssh.dispose();
}

async function showNodeStatus(ssh, config) {
  const pm2Status = await runRemoteSilent(ssh, `pm2 jlist`);
  try {
    const list = JSON.parse(pm2Status.stdout || '[]');
    const app = list.find(p => p.name === config.appName);
    if (app) {
      const statusColor = app.pm2_env.status === 'online' ? chalk.green : chalk.red;
      console.log(`  ${statusColor('●')} ${config.appName}`);
      console.log(chalk.gray(`    状态：${statusColor(app.pm2_env.status)}`));
      console.log(chalk.gray(`    PID：${app.pid}`));
      console.log(chalk.gray(`    重启次数：${app.pm2_env.restart_time}`));
      console.log(chalk.gray(`    运行时间：${formatUptime(app.pm2_env.pm_uptime)}`));
      console.log(chalk.gray(`    CPU：${app.monit?.cpu ?? 0}%  内存：${Math.round((app.monit?.memory ?? 0) / 1024 / 1024)}MB`));
    } else {
      console.log(chalk.red(`  ✗ 未找到 ${config.appName}，服务可能没有运行`));
    }
  } catch {
    console.log(chalk.yellow('  无法解析 PM2 状态'));
  }

  // 最近日志
  console.log(chalk.bold('\n  最近日志（最后 20 行）：'));
  const logs = await runRemoteSilent(ssh, `pm2 logs ${config.appName} --lines 20 --nostream 2>&1 | tail -20`);
  printLogLines(logs.stdout);
}

async function showPythonStatus(ssh, config) {
  const supStatus = await runRemoteSilent(ssh, `supervisorctl status ${config.appName} 2>&1`);
  const line = supStatus.stdout.trim();
  if (/RUNNING/.test(line)) {
    console.log(`  ${chalk.green('●')} ${line}`);
  } else if (/STOPPED|FATAL|EXITED|BACKOFF/.test(line)) {
    console.log(`  ${chalk.red('✗')} ${line}`);
  } else {
    console.log(`  ${chalk.yellow('?')} ${line || '未知状态'}`);
  }

  // 最近日志
  console.log(chalk.bold('\n  输出日志（最后 20 行）：'));
  const out = await runRemoteSilent(ssh, `tail -20 /var/log/${config.appName}.out.log 2>/dev/null || echo ""`);
  printLogLines(out.stdout);

  console.log(chalk.bold('\n  错误日志（最后 10 行）：'));
  const err = await runRemoteSilent(ssh, `tail -10 /var/log/${config.appName}.err.log 2>/dev/null || echo ""`);
  printLogLines(err.stdout || '（无错误日志）');
}

async function showDockerStatus(ssh, config) {
  if (config.composeFile) {
    const dockerStatus = await runRemoteSilent(
      ssh,
      `cd ${config.remotePath} && docker compose -f ${config.composeFile} ps`
    );
    console.log(chalk.gray('    ') + (dockerStatus.stdout || '（无运行容器）').split('\n').join('\n    '));

    // 最近日志
    console.log(chalk.bold('\n  最近日志（最后 20 行）：'));
    const logs = await runRemoteSilent(
      ssh,
      `cd ${config.remotePath} && docker compose -f ${config.composeFile} logs --tail=20 2>&1`
    );
    printLogLines(logs.stdout);
  } else {
    // 单容器模式
    const result = await runRemoteSilent(
      ssh,
      `docker inspect -f '{{.State.Status}} | PID:{{.State.Pid}} | StartedAt:{{.State.StartedAt}}' ${config.appName} 2>/dev/null || echo missing`
    );
    const line = result.stdout.trim();
    if (line === 'missing' || !line) {
      console.log(chalk.red(`  ✗ 未找到容器 ${config.appName}`));
    } else if (line.startsWith('running')) {
      console.log(`  ${chalk.green('●')} ${config.appName}`);
      console.log(chalk.gray(`    ${line}`));
    } else {
      console.log(`  ${chalk.red('✗')} ${line}`);
    }

    console.log(chalk.bold('\n  最近日志（最后 20 行）：'));
    const logs = await runRemoteSilent(ssh, `docker logs --tail=20 ${config.appName} 2>&1 || true`);
    printLogLines(logs.stdout);
  }
}

async function showCronStatus(ssh, config) {
  const marker = `deploy-helper:${config.appName}`;
  const cronResult = await runRemoteSilent(ssh, `crontab -l 2>/dev/null | grep -A1 -F "${marker}" || true`);

  if (!cronResult.stdout.trim()) {
    console.log(chalk.red(`  ✗ 未在 crontab 中找到 ${config.appName}`));
    console.log(chalk.gray(`    可能未部署或已被手动删除`));
  } else {
    console.log(`  ${chalk.green('●')} 定时任务已注册`);
    cronResult.stdout.trim().split('\n').forEach(line => {
      console.log(chalk.gray(`    ${line}`));
    });
  }

  // 上次执行时间（看日志文件 mtime）
  const logInfo = await runRemoteSilent(
    ssh,
    `stat -c '%y' /var/log/${config.appName}.log 2>/dev/null || echo missing`
  );
  if (logInfo.stdout.trim() !== 'missing' && logInfo.stdout.trim()) {
    console.log(chalk.gray(`    上次执行：${logInfo.stdout.trim()}`));
  }

  console.log(chalk.bold('\n  最近日志（最后 30 行）：'));
  const logs = await runRemoteSilent(ssh, `tail -30 /var/log/${config.appName}.log 2>/dev/null || echo "（无日志）"`);
  printLogLines(logs.stdout);
}

function printLogLines(stdout) {
  if (!stdout || !stdout.trim()) {
    console.log(chalk.gray('    （无）'));
    return;
  }
  stdout.split('\n').forEach(line => {
    if (/\berror\b/i.test(line) || /\bexception\b/i.test(line) || /\btraceback\b/i.test(line)) {
      console.log(chalk.red('    ' + line));
    } else {
      console.log(chalk.gray('    ' + line));
    }
  });
}

function formatUptime(timestamp) {
  if (!timestamp || isNaN(timestamp)) return '未知';
  const ms = Date.now() - timestamp;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}小时 ${m}分钟`;
}
