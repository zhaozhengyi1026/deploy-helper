import { spawnSync } from 'child_process';

const PLATFORM_NAMES = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};

export function detectLocalPlatform(platform = process.platform) {
  return {
    id: platform,
    name: PLATFORM_NAMES[platform] || platform,
    supported: Object.hasOwn(PLATFORM_NAMES, platform),
  };
}

export function localCommandExists(command, platform = process.platform) {
  const probe = platform === 'win32' ? 'where.exe' : 'sh';
  const args = platform === 'win32' ? [command] : ['-lc', `command -v ${command}`];
  return spawnSync(probe, args, { stdio: 'ignore', windowsHide: true }).status === 0;
}

export function inspectLocalTools(platform = process.platform) {
  return [
    {
      id: 'git',
      name: 'Git（读取项目版本和仓库地址）',
      installed: localCommandExists('git', platform),
      guide: getInstallGuide('git', platform),
    },
    {
      id: 'ssh',
      name: 'SSH 客户端（连接服务器）',
      installed: localCommandExists('ssh', platform),
      guide: getInstallGuide('ssh', platform),
    },
    {
      id: 'ssh-keygen',
      name: 'SSH 密钥工具（配置免密登录时使用）',
      installed: localCommandExists('ssh-keygen', platform),
      guide: getInstallGuide('ssh', platform),
      optional: true,
    },
  ];
}

export function getInstallGuide(tool, platform = process.platform) {
  if (platform === 'win32') {
    if (tool === 'git') return ['打开“终端（管理员）”，运行：winget install --id Git.Git -e', '安装后关闭并重新打开终端。'];
    return ['打开“设置 → 系统 → 可选功能”，添加“OpenSSH 客户端”。', '或在管理员 PowerShell 运行：Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0'];
  }
  if (platform === 'darwin') {
    return ['打开“终端”，运行：xcode-select --install', '按系统窗口提示完成安装，再重新运行本工具。'];
  }
  return tool === 'git'
    ? ['Ubuntu / Debian：sudo apt update && sudo apt install -y git', 'Fedora：sudo dnf install -y git']
    : ['Ubuntu / Debian：sudo apt update && sudo apt install -y openssh-client', 'Fedora：sudo dnf install -y openssh-clients'];
}

export function getPathExample(platform = process.platform) {
  if (platform === 'win32') return 'C:\\Users\\你的名字\\.ssh\\id_ed25519';
  return '~/.ssh/id_ed25519';
}
