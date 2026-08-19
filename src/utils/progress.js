import fs from 'fs';
import path from 'path';

export const PROGRESS_FILENAME = '.deploy-progress.json';
const progressPath = () => path.join(process.cwd(), PROGRESS_FILENAME);

function safeData(data) {
  const clone = JSON.parse(JSON.stringify(data || {}));
  const scrub = (value) => {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (/password|passphrase|secret|token|private|environmentVariables/i.test(key)) {
        delete value[key];
      } else {
        scrub(value[key]);
      }
    }
  };
  scrub(clone);
  return clone;
}

export function loadProgress() {
  try {
    const parsed = JSON.parse(fs.readFileSync(progressPath(), 'utf8'));
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function saveProgress(data) {
  const target = progressPath();
  const temporary = `${target}.tmp`;
  const payload = { ...safeData(data), version: 1, updatedAt: new Date().toISOString() };
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch { /* Windows does not use POSIX modes. */ }
  return payload;
}

export function clearProgress() {
  try { fs.unlinkSync(progressPath()); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export function progressExists() {
  return fs.existsSync(progressPath());
}
