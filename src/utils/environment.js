import fs from 'fs';
import path from 'path';

const CANDIDATES = ['.env.example', '.env.sample', '.env.template', '.env.defaults'];

export function findEnvironmentTemplate(cwd = process.cwd()) {
  return CANDIDATES.map(name => path.join(cwd, name)).find(fs.existsSync) || null;
}

export function parseEnvironmentTemplate(content) {
  const variables = [];
  let description = '';
  for (const rawLine of String(content).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) {
      description = line.replace(/^#+\s*/, '');
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, name, rawDefault] = match;
    const defaultValue = rawDefault.replace(/^(['"])(.*)\1$/, '$2');
    variables.push({
      name,
      defaultValue,
      description,
      sensitive: /password|passwd|secret|token|api_?key|private/i.test(name),
    });
    description = '';
  }
  return variables;
}

export function detectEnvironmentVariables(cwd = process.cwd()) {
  const template = findEnvironmentTemplate(cwd);
  if (!template) return { template: null, variables: [] };
  return {
    template,
    variables: parseEnvironmentTemplate(fs.readFileSync(template, 'utf8')),
  };
}

export function serializeEnvironment(values) {
  return Object.entries(values).map(([name, value]) => {
    const escaped = String(value ?? '').replace(/'/g, "'\\''");
    return `${name}='${escaped}'`;
  }).join('\n') + '\n';
}
