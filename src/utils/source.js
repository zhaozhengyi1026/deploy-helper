import { execFileSync } from 'child_process';

export function getLocalGitInfo(cwd = process.cwd()) {
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd, encoding: 'utf8', windowsHide: true }).trim();
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8', windowsHide: true }).trim() || 'main';
    return { url, branch };
  } catch {
    return { url: '', branch: 'main' };
  }
}

export function validateGitUrl(value) {
  const url = String(value || '').trim();
  if (/^https:\/\/[\w.-]+\/[\w./-]+(?:\.git)?$/.test(url)) return true;
  if (/^git@[\w.-]+:[\w./-]+(?:\.git)?$/.test(url)) return true;
  return '请输入完整仓库地址，例如 https://github.com/name/project.git';
}

export function validateGitBranch(value) {
  const branch = String(value || '').trim();
  return /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.includes('..') && !branch.startsWith('-')
    ? true
    : '分支名只能包含字母、数字、点、斜杠、下划线和连字符';
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

export function getGitDeployCommand({ repositoryUrl, repositoryBranch = 'main', remotePath }) {
  const url = shellQuote(repositoryUrl);
  const branch = shellQuote(repositoryBranch);
  const target = shellQuote(remotePath);
  return `if [ -d ${target}/.git ]; then git -C ${target} fetch --prune origin && git -C ${target} checkout ${branch} && git -C ${target} pull --ff-only origin ${branch}; else tmp_dir="$(mktemp -d)" && git clone --branch ${branch} --single-branch ${url} "$tmp_dir/project" && mkdir -p ${target} && rsync -a --delete --exclude='.env' "$tmp_dir/project/" ${target}/ && rm -rf "$tmp_dir"; fi`;
}
