import fs from 'fs';
import path from 'path';

export function detectProjectType(projectPath = process.cwd()) {
  const files = fs.readdirSync(projectPath);

  if (files.includes('package.json')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['next'] || deps['nuxt']) return 'nodejs';
    if (pkg.scripts?.build && !pkg.scripts?.start) return 'static';
    return 'nodejs';
  }

  if (
    files.includes('requirements.txt') || files.includes('pyproject.toml') ||
    files.includes('setup.py') || files.includes('environment.yml') || files.includes('conda-lock.yml')
  ) {
    return 'python';
  }

  if (files.includes('Dockerfile')) {
    return 'docker';
  }

  if (files.includes('index.html') || files.includes('index.htm')) {
    return 'static';
  }

  return 'unknown';
}

// 从 .nvmrc / .node-version / package.json engines.node 读取主版本号
export function detectNodeVersion(projectPath = process.cwd()) {
  for (const file of ['.nvmrc', '.node-version']) {
    const p = path.join(projectPath, file);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8').trim().replace(/^v/, '');
      const major = parseInt(raw);
      if (!isNaN(major)) return { version: String(major), source: file };
    }
  }

  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (pkg.engines?.node) {
      const match = pkg.engines.node.match(/(\d+)/);
      if (match) return { version: match[1], source: 'package.json engines.node' };
    }
  }

  return null;
}

// 检测 Python 依赖管理方式：conda（environment.yml）或 pip（requirements.txt）
export function detectPythonEnvManager(projectPath = process.cwd()) {
  if (
    fs.existsSync(path.join(projectPath, 'environment.yml')) ||
    fs.existsSync(path.join(projectPath, 'conda-lock.yml'))
  ) return 'conda';
  if (
    fs.existsSync(path.join(projectPath, 'requirements.txt')) ||
    fs.existsSync(path.join(projectPath, 'pyproject.toml'))
  ) return 'pip';
  return null;
}

// 从 requirements.txt 检测 Python 框架
export function detectPythonFramework(projectPath = process.cwd()) {
  const reqPath = path.join(projectPath, 'requirements.txt');
  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (!fs.existsSync(reqPath) && !fs.existsSync(pyprojectPath)) return null;

  const content = fs.readFileSync(fs.existsSync(reqPath) ? reqPath : pyprojectPath, 'utf-8').toLowerCase();
  // 按优先级检测，fastapi 优先（flask 是 fastapi 的间接依赖有时也会出现）
  if (/\bfastapi\b/.test(content)) return 'fastapi';
  if (/\bdjango\b/.test(content)) return 'django';
  if (/\bflask\b/.test(content)) return 'flask';
  return null;
}

// 从 .python-version 或 pyproject.toml 读取 Python 版本
export function detectPythonVersion(projectPath = process.cwd()) {
  const pyVersionPath = path.join(projectPath, '.python-version');
  if (fs.existsSync(pyVersionPath)) {
    const raw = fs.readFileSync(pyVersionPath, 'utf-8').trim();
    const match = raw.match(/^(\d+\.\d+)/);
    if (match) return { version: match[1], source: '.python-version' };
  }

  const pyprojectPath = path.join(projectPath, 'pyproject.toml');
  if (fs.existsSync(pyprojectPath)) {
    const content = fs.readFileSync(pyprojectPath, 'utf-8');
    const match = content.match(/python\s*=\s*["'][^"']*?(\d+\.\d+)/);
    if (match) return { version: match[1], source: 'pyproject.toml' };
  }

  return null;
}

// 读取 package.json scripts.start，或扫描常见入口文件
export function getNodeStartCommand(projectPath = process.cwd()) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

    if (pkg.scripts?.start) {
      return { cmd: 'npm start', source: 'package.json scripts.start' };
    }

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['next']) return { cmd: 'npm exec -- next start', source: 'next.js 依赖' };
    if (deps['nuxt']) return { cmd: 'npm exec -- nuxt start', source: 'nuxt.js 依赖' };
  }

  for (const file of ['index.js', 'app.js', 'server.js', 'main.js']) {
    if (fs.existsSync(path.join(projectPath, file))) {
      return { cmd: `node ${file}`, source: `检测到入口文件 ${file}` };
    }
  }

  return { cmd: 'node index.js', source: '默认值' };
}

export function getNodeBuildCommand(projectPath = process.cwd()) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  if (pkg.scripts?.build) return { cmd: 'npm run build', source: 'package.json scripts.build' };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return { cmd: 'npm exec -- next build', source: 'Next.js 默认构建命令' };
  if (deps.nuxt) return { cmd: 'npm exec -- nuxt build', source: 'Nuxt 默认构建命令' };
  return null;
}

export function detectStaticOutputDir(projectPath = process.cwd()) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['react-scripts']) return 'build';
    if (deps.next) return 'out';
    if (deps.vite || deps['@vue/cli-service'] || deps.nuxt) return 'dist';
  }
  for (const dir of ['dist', 'build', 'out', 'public']) {
    if (fs.existsSync(path.join(projectPath, dir))) return dir;
  }
  if (!fs.existsSync(pkgPath)) return '';
  return 'dist';
}

export function detectPythonDependencySource(projectPath = process.cwd()) {
  if (fs.existsSync(path.join(projectPath, 'requirements.txt'))) return 'requirements';
  if (fs.existsSync(path.join(projectPath, 'pyproject.toml'))) return 'pyproject';
  return null;
}

// 根据框架生成 Python 启动命令；framework 为 other 时扫描常见入口文件
export function getPythonStartCommand(framework, appName, port, projectPath = process.cwd()) {
  if (framework === 'fastapi') return `uvicorn main:app --host 0.0.0.0 --port ${port}`;
  if (framework === 'django') {
    const entries = fs.readdirSync(projectPath, { withFileTypes: true });
    const djangoDir = entries.find(entry => entry.isDirectory() && fs.existsSync(path.join(projectPath, entry.name, 'wsgi.py')));
    const moduleName = djangoDir?.name || appName;
    return `gunicorn ${moduleName}.wsgi:application --bind 0.0.0.0:${port}`;
  }
  if (framework === 'flask') return `gunicorn app:app --bind 0.0.0.0:${port}`;
  for (const file of ['main.py', 'app.py', 'run.py', 'server.py', 'manage.py']) {
    if (fs.existsSync(path.join(projectPath, file))) return `python ${file}`;
  }
  return 'python main.py';
}

export const PROJECT_TYPE_LABELS = {
  nodejs: 'Node.js 应用（Express / Koa / Next.js 等）',
  python: 'Python 应用（Flask / FastAPI / Django 等）',
  static: '静态网站（纯 HTML/CSS/JS）',
  docker: 'Docker 容器',
  unknown: '其他 / 我来手动指定',
};

export const PYTHON_FRAMEWORK_LABELS = {
  fastapi: 'FastAPI',
  django: 'Django',
  flask: 'Flask',
  other: '其他',
};

export function hasDockerfile(projectPath = process.cwd()) {
  return fs.existsSync(path.join(projectPath, 'Dockerfile'));
}

export function detectComposeFile(projectPath = process.cwd()) {
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    if (fs.existsSync(path.join(projectPath, name))) return name;
  }
  return null;
}

// 从 Dockerfile EXPOSE 或 docker-compose ports 映射读取宿主机端口
export function detectDockerPort(projectPath = process.cwd()) {
  const dockerfilePath = path.join(projectPath, 'Dockerfile');
  if (fs.existsSync(dockerfilePath)) {
    const content = fs.readFileSync(dockerfilePath, 'utf-8');
    const match = content.match(/^EXPOSE\s+(\d+)/m);
    if (match) return { port: match[1], source: 'Dockerfile EXPOSE' };
  }

  const composeName = detectComposeFile(projectPath);
  if (composeName) {
    const content = fs.readFileSync(path.join(projectPath, composeName), 'utf-8');
    // 匹配 "- 8080:3000" 或 "- '8080:3000'" 格式，取宿主机端口
    const match = content.match(/^\s*-\s*["']?(\d+):\d+/m);
    if (match) return { port: match[1], source: composeName };
  }

  return null;
}
