import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';

const CONFIG_FILENAME = '.deploy-config.json';
const CONFIG_FILE = path.join(process.cwd(), CONFIG_FILENAME);

// 落盘前剥离所有密码字段，避免明文密码写进 .deploy-config.json
function stripCredentials(config) {
  const clone = JSON.parse(JSON.stringify(config));
  delete clone.password;
  if (clone.database) delete clone.database.password;
  if (Array.isArray(clone.servers)) {
    clone.servers.forEach((s) => {
      delete s.password;
      delete s.servers;
    });
  }
  return clone;
}

export function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(stripCredentials(config), null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows may not apply POSIX modes. */ }
  ensureGitignored();
}

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return null;
  try {
    return migrateConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')));
  } catch {
    return null;
  }
}

export function migrateConfig(input) {
  const config = JSON.parse(JSON.stringify(input));
  // 0.2.x 曾把 SSH 端口与应用端口共用为 port。旧文件无法还原自定义 SSH
  // 端口，因此按最安全、最常见的 SSH 22 迁移，并保留旧值作为应用端口。
  if (!config.schemaVersion && config.projectType && !config.appPort) {
    config.appPort = config.port;
    config.sshPort = config.sshPort || 22;
    config.port = config.sshPort;
  }
  if (!config.schemaVersion && config.projectType) config.schemaVersion = 2;
  return config;
}

export function configExists() {
  return fs.existsSync(CONFIG_FILE);
}

export async function selectServer(config, purpose = '执行此操作') {
  const serverList = Array.isArray(config?.servers) ? config.servers : [];
  let selected = config;

  if (serverList.length === 1) {
    selected = serverList[0];
  } else if (serverList.length > 1) {
    const { selectedIndex } = await inquirer.prompt([{
      type: 'list',
      name: 'selectedIndex',
      message: `${purpose}，请选择目标服务器：`,
      choices: serverList.map((server, index) => ({
        name: `${server.label || server.host} (${server.user}@${server.host}:${server.port || 22})`,
        value: index,
      })),
    }]);
    selected = serverList[selectedIndex];
  }

  const { servers: ignoredSelectedServers, ...serverConfig } = selected || {};
  const { servers: ignoredRootServers, ...sharedConfig } = config || {};
  const result = { ...sharedConfig, ...serverConfig };
  result.sshPort = selected && selected !== config
    ? (selected.sshPort || selected.port || sharedConfig.sshPort || 22)
    : (result.sshPort || result.port || 22);
  result.port = result.sshPort;
  Object.defineProperty(result, '__rootConfig', { value: config, enumerable: false });
  return result;
}

/**
 * 密码不落盘，所以从配置加载后需要按需补齐密码（仅在内存中）。
 * 处理三类：单/主服务器 SSH 密码、多服务器 SSH 密码、数据库密码。
 * 调用方应在 loadConfig() 之后、连接服务器之前调用。
 */
export async function resolveCredentials(config, { needDatabase = false } = {}) {
  if (!config) return config;

  // 单服务器 / 主服务器：密码登录但密码未存
  if (config.authType === 'password' && !config.password) {
    const { pwd } = await inquirer.prompt([{
      type: 'password', name: 'pwd', mask: '*',
      message: `服务器 ${config.host} 的登录密码：`,
    }]);
    config.password = pwd;
  }

  // 多服务器：逐台补齐
  if (Array.isArray(config.servers)) {
    for (const s of config.servers) {
      if (s.authType === 'password' && !s.password) {
        const isRootServer = s.host === config.host
          && String(s.sshPort || s.port || 22) === String(config.sshPort || config.port || 22)
          && s.user === config.user;
        if (isRootServer && config.password) {
          s.password = config.password;
          continue;
        }
        const { pwd } = await inquirer.prompt([{
          type: 'password', name: 'pwd', mask: '*',
          message: `服务器 ${s.label || s.host} 的登录密码：`,
        }]);
        s.password = pwd;
      }
    }
  }

  // 数据库密码（仅备份相关命令需要）
  if (needDatabase && config.database && config.database.password === undefined) {
    const { pwd } = await inquirer.prompt([{
      type: 'password', name: 'pwd', mask: '*',
      message: `数据库 ${config.database.database} 的密码（无密码直接回车）：`,
    }]);
    config.database.password = pwd;
  }

  return config;
}

// 如果项目目录是 git 仓库且 .gitignore 还没忽略 .deploy-config.json，自动追加一行。
// 配置虽已剥离密码，仍含服务器 IP / 路径等信息，不宜进 git。
function ensureGitignored() {
  const gitDir = path.join(process.cwd(), '.git');
  if (!fs.existsSync(gitDir)) return; // 非 git 项目跳过

  const gitignorePath = path.join(process.cwd(), '.gitignore');
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf-8');
    const already = content.split('\n').some(line => {
      const t = line.trim();
      return t === CONFIG_FILENAME || t === `/${CONFIG_FILENAME}` || t === `./${CONFIG_FILENAME}`;
    });
    if (already) return;
  }

  const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  const block = `${prefix}\n# deploy-helper：含服务器信息，请勿提交\n${CONFIG_FILENAME}\n`;
  fs.appendFileSync(gitignorePath, block);
}
