import chalk from 'chalk';
import ora from 'ora';
import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs';
import { connectSSH, runRemoteSilent, runRemoteStrict } from '../utils/ssh.js';
import { loadConfig, saveConfig, resolveCredentials, selectServer } from '../utils/config.js';

const BACKUP_BASE = '/var/deploy-helper/db-backups';

// POSIX 单引号转义：密码/用户名含 ' $ 等特殊字符时也能安全拼进 shell 命令
function shellQuote(str) {
  return `'` + String(str ?? '').replace(/'/g, `'\\''`) + `'`;
}

function writeRemoteFileCommand(remotePath, content) {
  const encoded = Buffer.from(content, 'utf-8').toString('base64');
  return `printf '%s' '${encoded}' | base64 -d > ${shellQuote(remotePath)}`;
}

function validateDatabaseConfig(config) {
  if (!['mysql', 'postgresql', 'mongodb'].includes(config?.type)) return '不支持的数据库类型';
  if (!/^[a-zA-Z0-9_.-]+$/.test(config.database || '')) return '数据库名只能包含字母、数字、点、下划线和连字符';
  if (!/^\d+$/.test(String(config.port || ''))) return '数据库端口必须是数字';
  if (!String(config.user || '').trim()) return '数据库用户名不能为空';
  return null;
}

async function ensureDatabaseTool(ssh, type) {
  const tools = {
    mysql: { command: 'mysqldump', install: 'apt-get install -y -qq default-mysql-client' },
    postgresql: { command: 'pg_dump', install: 'apt-get install -y -qq postgresql-client' },
    mongodb: { command: 'mongodump', install: null },
  };
  const tool = tools[type];
  const exists = await runRemoteSilent(ssh, `command -v ${tool.command}`);
  if (exists.code === 0) return;
  if (!tool.install) {
    throw new Error('服务器缺少 mongodump，请先安装 MongoDB Database Tools 后重试');
  }
  await runRemoteStrict(ssh, `export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && ${tool.install}`);
}

/**
 * 根据数据库类型生成备份命令。
 * passwordEnvInline=true：把密码以 ENV='xxx' 形式内联（仅用于一次性命令，命令一执行完进程就退出）
 * passwordEnvInline=false：用 cron 脚本里 source 的 credentials 文件（推荐）
 */
function buildDumpCommand(dbConfig, outputFile, passwordEnvInline = true) {
  const { type, host, port, user, password, database } = dbConfig;
  const h = host || '127.0.0.1';

  if (type === 'mysql') {
    const p = port || 3306;
    const pwd = passwordEnvInline ? `MYSQL_PWD=${shellQuote(password)} ` : '';
    return `${pwd}mysqldump -h ${shellQuote(h)} -P ${shellQuote(p)} -u ${shellQuote(user)} ${shellQuote(database)} > ${shellQuote(outputFile)}`;
  }
  if (type === 'postgresql') {
    const p = port || 5432;
    const pwd = passwordEnvInline ? `PGPASSWORD=${shellQuote(password)} ` : '';
    return `${pwd}pg_dump -h ${shellQuote(h)} -p ${shellQuote(p)} -U ${shellQuote(user)} ${shellQuote(database)} > ${shellQuote(outputFile)}`;
  }
  if (type === 'mongodb') {
    const p = port || 27017;
    const auth = password ? `--username ${shellQuote(user)} --password ${shellQuote(password)} --authenticationDatabase admin` : '';
    return `mongodump --host ${shellQuote(h)} --port ${shellQuote(p)} ${auth} --db ${shellQuote(database)} --archive=${shellQuote(outputFile)} --gzip`;
  }
  return null;
}

/**
 * 列出现有备份
 */
async function listBackups(ssh, appName) {
  const result = await runRemoteSilent(
    ssh,
    `ls -lt ${BACKUP_BASE}/${appName}/ 2>/dev/null | grep -E "\\.(sql|gz|archive)" | head -20 || echo ""`
  );
  if (!result.stdout.trim()) return [];

  return result.stdout.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.trim().split(/\s+/);
    const filename = parts[parts.length - 1];
    const size = parts[4];
    return { filename, size, line };
  });
}

export async function deployBackup() {
  let config = loadConfig();
  if (!config) {
    console.log(chalk.red('\n没有找到部署配置，请先运行：') + chalk.cyan(' deploy-helper init\n'));
    return;
  }

  config = await selectServer(config, '管理数据库备份');
  await resolveCredentials(config);

  const { action } = await inquirer.prompt([{
    type: 'list',
    name: 'action',
    message: '数据库备份操作：',
    choices: [
      { name: '立即备份数据库', value: 'backup' },
      { name: '查看历史备份列表', value: 'list' },
      { name: '下载备份文件到本地', value: 'download' },
      { name: '配置定时自动备份', value: 'schedule' },
    ],
  }]);

  if (action === 'backup') await doBackup(config);
  else if (action === 'list') await listBackupFiles(config);
  else if (action === 'download') await downloadBackup(config);
  else if (action === 'schedule') await scheduleBackup(config);
}

async function doBackup(config, silent = false) {
  // 读取或询问数据库配置
  let dbConfig = config.database;

  if (!dbConfig) {
    if (!silent) {
      console.log(chalk.gray('\n首次使用，需要配置数据库连接信息。配置将保存到 .deploy-config.json\n'));
    }
    const answers = await inquirer.prompt([
      {
        type: 'list',
        name: 'type',
        message: '数据库类型：',
        choices: [
          { name: 'MySQL / MariaDB', value: 'mysql' },
          { name: 'PostgreSQL', value: 'postgresql' },
          { name: 'MongoDB', value: 'mongodb' },
        ],
      },
      { type: 'input', name: 'host', message: '数据库地址：', default: '127.0.0.1' },
      { type: 'input', name: 'port', message: '端口：', default: (a) => ({ mysql: '3306', postgresql: '5432', mongodb: '27017' }[a.type]), validate: v => /^\d+$/.test(v) ? true : '请输入数字端口' },
      { type: 'input', name: 'user', message: '用户名：', default: 'root', validate: v => v.trim() ? true : '请输入用户名' },
      { type: 'password', name: 'password', message: '密码：', mask: '*' },
      { type: 'input', name: 'database', message: '数据库名：', validate: v => /^[a-zA-Z0-9_.-]+$/.test(v) ? true : '只能包含字母、数字、点、下划线和连字符' },
    ]);
    dbConfig = answers;

    // 保存到 config（saveConfig 会自动剥离密码，不落盘）
    const updated = { ...(config.__rootConfig || config), database: dbConfig };
    saveConfig(updated);
  } else if (dbConfig.password === undefined) {
    // 已有数据库配置但密码未落盘，按需补齐
    await resolveCredentials(config, { needDatabase: true });
    dbConfig = config.database;
  }

  const validationError = validateDatabaseConfig(dbConfig);
  if (validationError) {
    console.log(chalk.red(`\n数据库配置无效：${validationError}\n`));
    return null;
  }

  let ssh;
  const connectSpinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    connectSpinner.succeed('连接成功');
  } catch (err) {
    connectSpinner.fail('连接失败：' + err.message);
    return null;
  }

  try {
    await ensureDatabaseTool(ssh, dbConfig.type);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const ext = dbConfig.type === 'mongodb' ? '.archive.gz' : '.sql.gz';
    const filename = `${dbConfig.database}_${timestamp}${ext}`;
    const backupDir = `${BACKUP_BASE}/${config.appName}`;
    const outputFile = `${backupDir}/${filename}`;
    const rawFile = outputFile.replace('.gz', '');

    await runRemoteStrict(ssh, `mkdir -p ${shellQuote(backupDir)} && chmod 700 ${shellQuote(backupDir)}`);

    // 生成备份（一次性命令：内联密码 OK，进程退出即消失）
    const dumpSpinner = ora(`备份 ${dbConfig.type} 数据库 [${dbConfig.database}]...`).start();
    const dumpCmd = buildDumpCommand(dbConfig, dbConfig.type === 'mongodb' ? outputFile : rawFile, true);
    const dumpResult = await runRemoteSilent(ssh, dumpCmd);

    if (dumpResult.code !== 0) {
      dumpSpinner.fail('备份失败');
      console.log(chalk.red(dumpResult.stderr || dumpResult.stdout));
      ssh.dispose();
      return null;
    }

    // MySQL/PostgreSQL 压缩
    if (dbConfig.type !== 'mongodb') {
      await runRemoteStrict(ssh, `gzip -f ${shellQuote(rawFile)}`);
    }

    await runRemoteStrict(ssh, `test -s ${shellQuote(outputFile)}`);
    await runRemoteStrict(ssh, `chmod 600 ${shellQuote(outputFile)}`);

    // 获取文件大小
    const sizeResult = await runRemoteStrict(ssh, `du -sh ${shellQuote(outputFile)} | cut -f1`);
    dumpSpinner.succeed(`备份完成 → ${chalk.cyan(filename)} ${chalk.gray('(' + sizeResult.stdout + ')')}`);

    // 只保留最近 10 个备份
    const cleanup = await runRemoteSilent(
      ssh,
      `ls -t ${backupDir} | tail -n +11 | xargs -r -I{} rm -f ${backupDir}/{}`
    );
    if (cleanup.code !== 0) console.log(chalk.yellow('  ⚠ 旧备份清理失败，请检查服务器磁盘空间'));

    ssh.dispose();
    return { filename, outputFile };

  } catch (err) {
    console.log(chalk.red('\n备份失败：' + err.message));
    ssh.dispose();
    return null;
  }
}

async function listBackupFiles(config) {
  let ssh;
  const spinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('连接成功');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  const backups = await listBackups(ssh, config.appName);
  ssh.dispose();

  if (backups.length === 0) {
    console.log(chalk.yellow('\n还没有任何备份记录。\n'));
    return;
  }

  console.log(chalk.bold(`\n  历史备份（共 ${backups.length} 个）：\n`));
  backups.forEach(({ filename, size }, i) => {
    const prefix = i === 0 ? chalk.green('  ● ') : chalk.gray('  ○ ');
    console.log(prefix + chalk.cyan(filename) + chalk.gray(`  ${size}`));
  });
  console.log('');
}

async function downloadBackup(config) {
  let ssh;
  const spinner = ora('连接服务器...').start();
  try {
    ssh = await connectSSH(config);
    spinner.succeed('连接成功');
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  const backups = await listBackups(ssh, config.appName);

  if (backups.length === 0) {
    console.log(chalk.yellow('\n没有备份文件可下载。先运行备份。\n'));
    ssh.dispose();
    return;
  }

  const { selected } = await inquirer.prompt([{
    type: 'list',
    name: 'selected',
    message: '选择要下载的备份：',
    choices: backups.map(b => ({
      name: `${b.filename}  ${chalk.gray(b.size)}`,
      value: b.filename,
    })),
  }]);

  const localPath = path.join(process.cwd(), selected);
  const remotePath = `${BACKUP_BASE}/${config.appName}/${selected}`;

  if (fs.existsSync(localPath)) {
    const { overwrite } = await inquirer.prompt([{
      type: 'confirm', name: 'overwrite', message: `本地已存在 ${selected}，确认覆盖？`, default: false,
    }]);
    if (!overwrite) {
      ssh.dispose();
      return;
    }
  }

  const dlSpinner = ora(`下载 ${selected}...`).start();
  try {
    await ssh.getFile(localPath, remotePath);
    try { fs.chmodSync(localPath, 0o600); } catch { /* Windows may not apply POSIX modes. */ }
    dlSpinner.succeed(`已下载到：${chalk.cyan(localPath)}`);
  } catch (err) {
    dlSpinner.fail('下载失败：' + err.message);
  }

  ssh.dispose();
}

async function scheduleBackup(config) {
  if (!config.database) {
    console.log(chalk.red('\n未配置数据库信息，请先运行一次备份完成配置。\n'));
    return;
  }
  const { frequency } = await inquirer.prompt([{
    type: 'list',
    name: 'frequency',
    message: '备份频率：',
    choices: [
      { name: '每天凌晨 2 点', value: '0 2 * * *' },
      { name: '每 6 小时', value: '0 */6 * * *' },
      { name: '每周一凌晨 2 点', value: '0 2 * * 1' },
      { name: '自定义 Cron 表达式', value: 'custom' },
    ],
  }]);

  let cronExpr = frequency;
  if (frequency === 'custom') {
    const { custom } = await inquirer.prompt([{
      type: 'input',
      name: 'custom',
      message: 'Cron 表达式（如 "0 3 * * *" 表示每天 3 点）：',
      validate: v => /^([\d*/?,\-]+\s+){4}[\d*/?,\-]+$/.test(v.trim()) ? true : '请输入安全的 5 段 Cron 表达式',
    }]);
    cronExpr = custom;
  }

  // 数据库密码不落盘，写凭据文件前先补齐
  if (config.database.password === undefined) {
    await resolveCredentials(config, { needDatabase: true });
  }

  let ssh;
  const spinner = ora('配置定时备份...').start();
  try {
    ssh = await connectSSH(config);
  } catch (err) {
    spinner.fail('连接失败：' + err.message);
    return;
  }

  try {
    const dbConfig = config.database;
    if (!dbConfig) {
      spinner.fail('未配置数据库信息，请先运行一次备份完成配置。');
      ssh.dispose();
      return;
    }
    const validationError = validateDatabaseConfig(dbConfig);
    if (validationError) throw new Error(`数据库配置无效：${validationError}`);
    await ensureDatabaseTool(ssh, dbConfig.type);

    const backupDir = `${BACKUP_BASE}/${config.appName}`;
    const ext = dbConfig.type === 'mongodb' ? '.archive.gz' : '.sql.gz';

    // 凭据文件单独存放，权限 600；脚本通过 . credentials.sh 加载
    const credPath = `/etc/deploy-helper/${config.appName}.creds`;
    const credContent = (() => {
      if (dbConfig.type === 'mysql') return `export MYSQL_PWD=${shellQuote(dbConfig.password)}\n`;
      if (dbConfig.type === 'postgresql') return `export PGPASSWORD=${shellQuote(dbConfig.password)}\n`;
      if (dbConfig.type === 'mongodb') return `export DH_MONGO_USER=${shellQuote(dbConfig.user)}\nexport DH_MONGO_PWD=${shellQuote(dbConfig.password)}\n`;
      return '';
    })();

    await runRemoteStrict(ssh, `mkdir -p /etc/deploy-helper && chmod 700 /etc/deploy-helper`);
    await runRemoteStrict(ssh, writeRemoteFileCommand(credPath, credContent));
    await runRemoteStrict(ssh, `chmod 600 ${credPath}`);

    // 生成备份命令（不内联密码，从 cred 文件加载）
    const dumpForScript = (() => {
      const h = dbConfig.host || '127.0.0.1';
      if (dbConfig.type === 'mysql') {
        return `mysqldump -h ${shellQuote(h)} -P ${shellQuote(dbConfig.port || 3306)} -u ${shellQuote(dbConfig.user)} ${shellQuote(dbConfig.database)} > "\${OUTFILE%.gz}"`;
      }
      if (dbConfig.type === 'postgresql') {
        return `pg_dump -h ${shellQuote(h)} -p ${shellQuote(dbConfig.port || 5432)} -U ${shellQuote(dbConfig.user)} ${shellQuote(dbConfig.database)} > "\${OUTFILE%.gz}"`;
      }
      if (dbConfig.type === 'mongodb') {
        const auth = dbConfig.password
          ? `--username "$DH_MONGO_USER" --password "$DH_MONGO_PWD" --authenticationDatabase admin`
          : '';
        return `mongodump --host ${shellQuote(h)} --port ${shellQuote(dbConfig.port || 27017)} ${auth} --db ${shellQuote(dbConfig.database)} --archive="$OUTFILE" --gzip`;
      }
      return '';
    })();

    // 生成备份脚本（heredoc 单引号 EOF：变量不展开，原样写入）
    const scriptContent = `#!/bin/bash
set -e
umask 077
. ${credPath}
TIMESTAMP=$(date +%Y-%m-%dT%H-%M-%S)
OUTFILE="${backupDir}/${dbConfig.database}_\${TIMESTAMP}${ext}"
mkdir -p ${backupDir}
${dumpForScript}
${dbConfig.type !== 'mongodb' ? `gzip -f "\${OUTFILE%.gz}"` : ''}
ls -t ${backupDir} | tail -n +11 | xargs -I{} rm -f ${backupDir}/{} 2>/dev/null || true
echo "[$(date)] Backup completed: \$OUTFILE" >> /var/log/deploy-helper-backup.log
`;

    const scriptPath = `/usr/local/bin/deploy-helper-backup-${config.appName}.sh`;
    await runRemoteStrict(ssh, writeRemoteFileCommand(scriptPath, scriptContent));
    // 脚本本身含密码加载逻辑——chmod 700 仅 root 可读
    await runRemoteStrict(ssh, `chmod 700 ${scriptPath} && chown root:root ${scriptPath}`);

    // 注入 crontab（root 用户的 crontab）
    await runRemoteStrict(
      ssh,
      `(crontab -l 2>/dev/null | grep -v "deploy-helper-backup-${config.appName}"; echo "${cronExpr} ${scriptPath}") | crontab -`
    );

    spinner.succeed('定时备份配置完成');
    console.log(chalk.gray(`  Cron 表达式：${cronExpr}`));
    console.log(chalk.gray(`  备份脚本：  ${scriptPath} (chmod 700)`));
    console.log(chalk.gray(`  凭据文件：  ${credPath} (chmod 600)`));
    console.log(chalk.gray(`  执行日志：  /var/log/deploy-helper-backup.log\n`));
    ssh.dispose();

  } catch (err) {
    spinner.fail('配置失败：' + err.message);
    ssh.dispose();
  }
}

// 供 update.js 调用：部署前自动备份
export { doBackup };
