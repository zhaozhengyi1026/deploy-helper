import fs from 'fs';
import os from 'os';
import path from 'path';

export function expandHome(inputPath) {
  const value = String(inputPath || '').trim();
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function findDefaultPrivateKey() {
  for (const name of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
    const candidate = path.join(os.homedir(), '.ssh', name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(os.homedir(), '.ssh', 'id_ed25519');
}

export function parseSshCommand(input) {
  const tokens = String(input || '').match(/"[^"]*"|'[^']*'|\S+/g)?.map(token => token.replace(/^("|')|("|')$/g, '')) || [];
  if (tokens[0]?.toLowerCase() === 'ssh') tokens.shift();
  let port = '22';
  let keyPath = null;
  let destination = null;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === '-p' && tokens[i + 1]) {
      port = tokens[++i];
    } else if (/^-p\d+$/.test(token)) {
      port = token.slice(2);
    } else if (token === '-i' && tokens[i + 1]) {
      keyPath = expandHome(tokens[++i]);
    } else if (token.startsWith('-i') && token.length > 2) {
      keyPath = expandHome(token.slice(2));
    } else if (token === '-o' && tokens[i + 1]) {
      i++;
    } else if (!token.startsWith('-')) {
      destination = token;
    }
  }

  if (!destination) return null;
  const match = destination.match(/^(?:([^@\s]+)@)?(?:\[([^\]]+)\]|([^\s]+))$/);
  if (!match) return null;
  return { user: match[1] || 'root', host: match[2] || match[3], port, keyPath };
}

export const validatePort = value => {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? true : '请输入 1-65535 之间的端口号';
};

export const validateMajorVersion = value => {
  const version = Number(value);
  return Number.isInteger(version) && version >= 18 ? true : '请输入不低于 18 的 Node.js 主版本号';
};
export const validatePythonVersion = value => {
  const match = String(value).trim().match(/^(\d+)\.(\d+)$/);
  return match && Number(match[1]) === 3 && Number(match[2]) >= 8 ? true : '请输入 Python 3.8 或更高版本，如 3.11';
};
export const validateCron = value => /^([\d*/?,\-]+\s+){4}[\d*/?,\-]+$/.test(String(value).trim()) ? true : '请输入安全的 5 段 Cron 表达式';
export const validateRemotePath = value => {
  const target = String(value).trim();
  if (!target.startsWith('/')) return '请输入以 / 开头的绝对路径';
  if (target === '/' || target === '/var' || target === '/etc' || target === '/usr' || target === '/home') return '部署路径不能是系统根目录';
  return /^[a-zA-Z0-9._/-]+$/.test(target) ? true : '路径只能包含字母、数字和 . _ - / 字符';
};

export const validateDomain = value => {
  const domain = String(value).trim();
  if (!domain) return '请输入域名';
  if (domain.length > 253 || !/^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(domain)) {
    return '请输入有效域名，如 example.com';
  }
  return true;
};
