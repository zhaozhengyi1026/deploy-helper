import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import { connectSSH, runRemoteSilent, runRemoteStrict, uploadDirectory } from '../utils/ssh.js';
import { loadConfig, saveConfig, resolveCredentials } from '../utils/config.js';
import { createSnapshot } from './rollback.js';
import { doBackup } from './backup.js';
import { getStartCommands, getHealthCheck, getHttpHealthCheck } from '../utils/setup.js';
import { expandHome, findDefaultPrivateKey, validatePort, validateRemotePath } from '../utils/input.js';
import { detectPythonDependencySource, detectStaticOutputDir, getNodeBuildCommand } from '../utils/detect.js';
import { getGitDeployCommand } from '../utils/source.js';

// quiet 模式（并行部署）下返回 no-op，避免多个 ora spinner 同时写 stdout 互相覆盖
function makeSpinner(quiet, text) {
  if (quiet) {
    const noop = () => {};
    return { succeed: noop, fail: noop, warn: noop, info: noop, stop: noop };
  }
  return ora(text).start();
}

/**
 * 对单台服务器执行部署流程
 *
 * 流程：连接 → 快照 → 上传代码 → 复用 init 的 getStartCommands → 健康检查
 *
 * quiet=true（并行部署时）：不显示逐步 spinner，仅在开始/结束各打印一行汇总
 */
async function deployToServer(serverConfig, quiet = false) {
  const label = serverConfig.label ? chalk.cyan(`[${serverConfig.label}] `) : '';
  const cfg = normalizeConfig(serverConfig);
  if (quiet) console.log(chalk.gray(`  → 开始部署 ${serverConfig.label || cfg.host}...`));

  let ssh;
  const connectSpinner = makeSpinner(quiet, `${label}连接服务器 ${cfg.host}...`);
  try {
    ssh = await connectSSH(cfg);
    connectSpinner.succeed(`${label}连接成功`);
  } catch (err) {
    connectSpinner.fail(`${label}连接失败：${err.message}`);
    if (quiet) console.log(chalk.red(`  ✗ ${serverConfig.label || cfg.host} 连接失败：${err.message.split('\n')[0]}`));
    return false;
  }

  try {
    const toolSpinner = makeSpinner(quiet, `${label}检查部署工具...`);
    await runRemoteStrict(
      ssh,
      `if ! command -v rsync >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1${cfg.sourceMode === 'git' ? ' || ! command -v git >/dev/null 2>&1' : ''}; then export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq rsync curl ca-certificates${cfg.sourceMode === 'git' ? ' git' : ''}; fi`
    );
    toolSpinner.succeed(`${label}部署工具就绪`);

    // 1. 创建快照（部署前备份当前版本）
    const snapSpinner = makeSpinner(quiet, `${label}创建版本快照...`);
    const snapName = await createSnapshot(ssh, cfg);
    if (snapName) {
      snapSpinner.succeed(`${label}快照已创建：${chalk.gray(snapName)}`);
    } else {
      snapSpinner.info(`${label}跳过快照（首次部署）`);
    }

    // 2. 使用 init 中选择的来源更新代码。
    const uploadSpinner = makeSpinner(quiet, `${label}${cfg.sourceMode === 'git' ? '用 Git 拉取代码' : '上传代码'}...`);
    if (cfg.sourceMode === 'git') {
      await runRemoteStrict(ssh, getGitDeployCommand(cfg));
    } else {
      const skipPatterns = cfg.projectType === 'static'
        ? ['node_modules', '.git', '__pycache__', '.DS_Store', '.venv', 'venv']
        : undefined;
      await uploadDirectory(ssh, process.cwd(), cfg.remotePath, {
        uploadEnv: !!cfg.uploadEnv,
        skipPatterns,
      });
    }
    uploadSpinner.succeed(`${label}代码已更新`);

    // 3. 复用 init 的启动命令（保证 update 与 init 行为一致）
    const startSteps = getStartCommands(cfg);
    for (const s of startSteps) {
      const sp = makeSpinner(quiet, `${label}${s.label}...`);
      try {
        await runRemoteStrict(ssh, s.cmd);
        sp.succeed(`${label}${s.label}`);
      } catch (err) {
        sp.fail(`${label}${s.label} 失败`);
        throw err;
      }
    }

    // 4. 健康检查
    const health = getHealthCheck(cfg);
    if (health) {
      const hSpinner = makeSpinner(quiet, `${label}验证服务运行状态...`);
      await runRemoteSilent(ssh, 'sleep 2');
      const result = await runRemoteSilent(ssh, health.cmd);
      const parsed = health.parse(result);
      if (parsed.ok) {
        hSpinner.succeed(`${label}服务正常 — ${chalk.gray(parsed.detail)}`);
      } else {
        hSpinner.fail(`${label}健康检查未通过 — ${chalk.yellow(parsed.detail)}`);
        throw new Error(`健康检查未通过：${parsed.detail}`);
      }
    }

    const httpHealth = getHttpHealthCheck(cfg);
    if (httpHealth) {
      const hSpinner = makeSpinner(quiet, `${label}验证 HTTP 入口...`);
      const result = await runRemoteSilent(ssh, httpHealth.cmd);
      const parsed = httpHealth.parse(result);
      if (!parsed.ok) {
        hSpinner.fail(`${label}HTTP 验证失败 — ${chalk.yellow(parsed.detail)}`);
        throw new Error(`HTTP 入口不可用：${parsed.detail}`);
      }
      hSpinner.succeed(`${label}HTTP 入口正常 — ${chalk.gray(parsed.detail)}`);
    }

    ssh.dispose();
    if (quiet) console.log(chalk.green(`  ✓ ${serverConfig.label || cfg.host} 部署成功`));
    return true;

  } catch (err) {
    if (quiet) {
      console.log(chalk.red(`  ✗ ${serverConfig.label || cfg.host} 部署失败：${err.message.split('\n')[0]}`));
    } else {
      console.log(chalk.red(`\n${label}部署失败：${err.message}`));
      console.log(chalk.gray(`  运行 ${chalk.cyan('deploy-helper rollback')} 可恢复上一个版本`));
    }
    ssh.dispose();
    return false;
  }
}

// 旧配置兼容：补齐 appMode 等新字段，方便老用户升级 deploy-helper 后 update
function normalizeConfig(serverConfig) {
  const cfg = { ...serverConfig };
  if (!cfg.appMode) {
    // appMode 与 script/cron 模式是同期引入的，更早的配置只支持 web 部署
    cfg.appMode = 'web';
  }
  if (cfg.projectType === 'python' && !cfg.pythonEnvManager) {
    cfg.pythonEnvManager = 'pip';
  }
  if (cfg.projectType === 'python' && cfg.pythonEnvManager === 'pip' && !cfg.pythonDependencySource) {
    cfg.pythonDependencySource = detectPythonDependencySource();
  }
  if ((cfg.projectType === 'nodejs' || cfg.projectType === 'static') && cfg.buildCmd === undefined) {
    cfg.buildCmd = getNodeBuildCommand()?.cmd || '';
  }
  if (cfg.projectType === 'static' && cfg.buildCmd && !cfg.staticDir) {
    cfg.staticDir = detectStaticOutputDir();
  }
  return cfg;
}

export async function deployUpdate() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  // 兼容单台和多台服务器配置
  const servers = Array.isArray(config.servers) && config.servers.length > 0
    ? config.servers
    : [{ ...config, label: null }];

  // 显示目标信息
  console.log('');
  if (servers.length === 1) {
    console.log(chalk.gray('  ℹ ') + `服务器：${servers[0].host}   应用：${config.appName}   模式：${config.appMode || 'web'}`);
  } else {
    console.log(chalk.gray('  ℹ ') + `将部署到 ${chalk.bold(servers.length)} 台服务器：`);
    servers.forEach(s => {
      console.log(chalk.gray(`    • ${s.label || s.host}  (${s.host})`));
    });
  }

  // 询问部署选项
  const promptList = [
    {
      type: 'confirm',
      name: 'confirm',
      message: '确认推送当前代码到服务器？',
      default: true,
    },
    {
      type: 'confirm',
      name: 'backupDb',
      message: '部署前备份数据库？',
      default: true,
      when: (a) => a.confirm && !!config.database,
    },
  ];

  if (servers.length > 1) {
    promptList.push({
      type: 'list',
      name: 'strategy',
      message: '多服务器部署策略：',
      choices: [
        { name: '并行（同时部署所有服务器，速度最快）', value: 'parallel' },
        { name: '串行（逐台部署，出错可停止）', value: 'serial' },
        { name: '滚动（每台完成后确认再继续下一台）', value: 'rolling' },
      ],
      when: (a) => a.confirm,
    });
  }

  const options = await inquirer.prompt(promptList);
  if (!options.confirm) return;

  // 用户确认后再询问凭据，避免取消部署时产生无意义的密码提示。
  await resolveCredentials(config, { needDatabase: !!options.backupDb });

  console.log('');

  // 部署前数据库备份
  if (options.backupDb && config.database) {
    console.log(chalk.bold('📦 部署前数据库备份\n'));
    const backup = await doBackup(config, true);
    if (!backup) {
      console.log(chalk.red('\n数据库备份失败，已中止部署，服务器代码未变更。\n'));
      return;
    }
    console.log('');
  }

  // 执行部署
  console.log(chalk.bold('🚀 开始部署\n'));
  const strategy = options.strategy || 'serial';
  const results = [];

  if (servers.length === 1) {
    results.push(await deployToServer(servers[0], false));

  } else if (strategy === 'parallel') {
    // 并行：用 quiet 模式，避免多个 spinner 抢同一个 stdout 导致输出错乱
    const outcomes = await Promise.all(servers.map(s => deployToServer(s, true)));
    results.push(...outcomes);

  } else if (strategy === 'serial') {
    for (const server of servers) {
      const ok = await deployToServer(server);
      results.push(ok);
      if (!ok) {
        const { continueAnyway } = await inquirer.prompt([{
          type: 'confirm',
          name: 'continueAnyway',
          message: chalk.yellow(`${server.label || server.host} 失败，继续其余服务器？`),
          default: false,
        }]);
        if (!continueAnyway) break;
      }
    }

  } else if (strategy === 'rolling') {
    for (let i = 0; i < servers.length; i++) {
      const ok = await deployToServer(servers[i]);
      results.push(ok);
      if (ok && i < servers.length - 1) {
        const { goNext } = await inquirer.prompt([{
          type: 'confirm',
          name: 'goNext',
          message: `继续下一台 ${servers[i + 1].label || servers[i + 1].host}？`,
          default: true,
        }]);
        if (!goNext) break;
      }
    }
  }

  // 汇总
  const successCount = results.filter(Boolean).length;
  const failCount = results.length - successCount;
  const skippedCount = servers.length - results.length;

  console.log('');
  if (failCount === 0 && skippedCount === 0) {
    console.log(chalk.green.bold(`✅ 全部 ${successCount} 台服务器部署成功！`));
  } else {
    console.log(chalk.yellow.bold(`⚠  ${successCount} 台成功，${failCount} 台失败，${skippedCount} 台未执行`));
    if (failCount > 0) console.log(chalk.gray('  运行 deploy-helper rollback 可回滚'));
  }

  if (successCount > 0) {
    if (Array.isArray(config.servers)) {
      config.servers = config.servers.map((server, index) => ({
        ...normalizeConfig(server),
        ...(results[index] ? { deployedAt: new Date().toISOString() } : {}),
      }));
    } else {
      Object.assign(config, normalizeConfig(config));
    }
    config.deployedAt = new Date().toISOString();
    saveConfig(config);
  }

  if (successCount === 0) return;
  const main = servers[results.findIndex(Boolean)];
  if ((main.appMode === 'web' || !main.appMode) && main.projectType === 'static' && main.configureNginx === false) {
    console.log(chalk.yellow('  静态文件已更新，但没有配置 Web 入口。\n'));
  } else if (main.appMode === 'web' || !main.appMode) {
    const url = main.configureNginx === false
      ? `http://${main.host}:${main.appPort || 80}`
      : main.useHttps && main.domain
      ? `https://${main.domain}`
      : main.domain ? `http://${main.domain}` : `http://${main.host}`;
    console.log(`  访问地址：${chalk.cyan.underline(url)}\n`);
  } else if (main.appMode === 'cron') {
    console.log(`  定时计划：${chalk.cyan(main.cronSchedule || '见 crontab -l')}\n`);
  } else {
    const statusCommand = main.projectType === 'nodejs'
      ? `pm2 status ${main.appName}`
      : main.projectType === 'docker'
        ? `docker ps --filter name=${main.appName}`
        : `supervisorctl status ${main.appName}`;
    console.log(`  进程状态：${chalk.cyan(statusCommand)}\n`);
  }
}

/**
 * 多服务器配置管理命令
 */
export async function manageServers() {
  const config = loadConfig();
  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  const servers = config.servers || [{ ...config, label: '主服务器' }];

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: '服务器管理：',
    choices: [
      { name: `查看列表（当前 ${servers.length} 台）`, value: 'list' },
      { name: '添加服务器', value: 'add' },
      { name: '删除服务器', value: 'remove' },
    ],
  }]);

  if (action === 'list') {
    console.log(chalk.bold(`\n  服务器列表（${servers.length} 台）：\n`));
    servers.forEach((s, i) => {
      console.log(`  ${chalk.cyan(i + 1 + '.')} ${chalk.bold(s.label || s.host)}`);
      console.log(chalk.gray(`     ${s.user}@${s.host}:${s.sshPort || s.port || 22}  →  ${s.remotePath}  [${s.authType === 'password' ? '密码' : '密钥'}]`));
    });
    console.log('');

  } else if (action === 'add') {
    const newServer = await inquirer.prompt([
      { type: 'input', name: 'label', message: '服务器别名（如"备用节点"）：' },
      { type: 'input', name: 'host', message: 'IP 地址：', validate: v => v.trim() ? true : '必填' },
      { type: 'input', name: 'port', message: 'SSH 端口：', default: '22', validate: validatePort },
      { type: 'input', name: 'user', message: '用户名：', default: config.user || 'root', validate: v => v.trim() ? true : '必填' },
      {
        type: 'list', name: 'authType', message: '登录方式：',
        choices: [
          { name: 'SSH 密钥（推荐）', value: 'key' },
          { name: '密码', value: 'password' },
        ],
        default: config.authType,
      },
      {
        type: 'input', name: 'keyPath', message: 'SSH 密钥路径：',
        default: config.keyPath || findDefaultPrivateKey(), when: a => a.authType === 'key',
        filter: expandHome, validate: v => v.trim() ? true : '请输入私钥路径',
      },
      {
        type: 'password', name: 'password', message: '密码：',
        mask: '*', when: a => a.authType === 'password',
      },
      { type: 'input', name: 'remotePath', message: '部署路径：', default: config.remotePath, validate: validateRemotePath },
    ]);

    newServer.sshPort = newServer.port;
    const sp = ora('测试连接...').start();
    try {
      const ssh = await connectSSH({ ...config, ...newServer });
      ssh.dispose();
      sp.succeed('连接测试成功');
    } catch (err) {
      sp.fail('连接测试失败：' + err.message);
      return;
    }

    const { servers: ignoredServers, ...sharedConfig } = config;
    const updatedServers = [...servers, { ...sharedConfig, ...newServer }];
    saveConfig({ ...config, servers: updatedServers });
    console.log(chalk.green(`\n✅ 服务器 "${newServer.label || newServer.host}" 已添加。\n`));

  } else if (action === 'remove') {
    if (servers.length === 1) {
      console.log(chalk.yellow('\n只剩一台服务器，无法删除。\n'));
      return;
    }
    const { toRemove } = await inquirer.prompt([{
      type: 'checkbox',
      name: 'toRemove',
      message: '选择要删除的服务器：',
      choices: servers.map((s, i) => ({ name: `${s.label || s.host} (${s.host})`, value: i })),
      validate: selected => selected.length < servers.length ? true : '至少保留一台服务器',
    }]);
    if (toRemove.length === 0) {
      console.log(chalk.gray('\n未选择服务器，配置没有变化。\n'));
      return;
    }
    const { confirmRemove } = await inquirer.prompt([{
      type: 'confirm', name: 'confirmRemove',
      message: `确认从配置中删除 ${toRemove.length} 台服务器？（不会删除远端文件）`, default: false,
    }]);
    if (!confirmRemove) {
      console.log(chalk.gray('\n已取消，配置没有变化。\n'));
      return;
    }
    const remaining = servers.filter((_, i) => !toRemove.includes(i));
    const { servers: nestedServers, ...primary } = remaining[0];
    saveConfig({ ...config, ...primary, servers: remaining });
    console.log(chalk.green(`\n✅ 已删除 ${toRemove.length} 台服务器。\n`));
  }
}
