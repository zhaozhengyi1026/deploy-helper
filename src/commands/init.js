import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import {
  connectSSH, runRemote, runRemoteSilent, runRemoteStrict, uploadDirectory,
} from '../utils/ssh.js';
import { saveConfig, loadConfig, configExists } from '../utils/config.js';
import fs from 'fs';
import {
  detectProjectType, detectNodeVersion, detectPythonFramework, detectPythonVersion,
  detectPythonEnvManager,
  detectPythonDependencySource, detectStaticOutputDir,
  getNodeStartCommand, getNodeBuildCommand, getPythonStartCommand,
  hasDockerfile, detectComposeFile, detectDockerPort,
  PROJECT_TYPE_LABELS, PYTHON_FRAMEWORK_LABELS,
} from '../utils/detect.js';
import {
  getSetupCommands, getStartCommands, getNginxConfig, getHealthCheck, getHttpHealthCheck, writeFileHeredoc,
} from '../utils/setup.js';
import {
  expandHome, findDefaultPrivateKey, parseSshCommand, validateCron, validateDomain,
  validateMajorVersion, validatePort, validatePythonVersion, validateRemotePath,
} from '../utils/input.js';
import { clearProgress, loadProgress, saveProgress } from '../utils/progress.js';
import { detectEnvironmentVariables, serializeEnvironment } from '../utils/environment.js';
import { getGitDeployCommand, getLocalGitInfo, validateGitBranch, validateGitUrl } from '../utils/source.js';
import { offerPasswordlessLogin, runLocalPreflight, runRecoverableStep } from '../utils/onboarding.js';
import { promptUser } from '../utils/prompt.js';

const step = (n, total, msg, next = '') => {
  console.log(chalk.cyan(`\n[${n}/${total}] `) + chalk.bold(msg));
  if (next) console.log(chalk.gray(`  完成后：${next}`));
};

const success = (msg) => console.log(chalk.green('  ✓ ') + msg);
const info = (msg) => console.log(chalk.gray('  ℹ ') + msg);

let activeProgress = null;

function checkpoint(stage, answers = {}, completedStep = null) {
  const completedSteps = new Set(activeProgress?.completedSteps || []);
  if (completedStep) completedSteps.add(completedStep);
  activeProgress = saveProgress({
    ...activeProgress,
    stage,
    answers: { ...(activeProgress?.answers || {}), ...answers },
    completedSteps: [...completedSteps],
  });
}

function stepCompleted(name) {
  return activeProgress?.completedSteps?.includes(name);
}

async function confirmAction(name, message, defaultValue = true) {
  if (stepCompleted(name)) {
    info(`上次运行已完成“${name}”，这次从下一步继续。`);
    return false;
  }
  const { execute } = await promptUser([{
    type: 'confirm', name: 'execute', message, default: defaultValue,
  }]);
  checkpoint(`confirm:${name}`, { [`execute_${name}`]: execute });
  return execute;
}

async function promptEnvironmentFile() {
  const detected = detectEnvironmentVariables();
  if (detected.variables.length === 0) return null;
  console.log(chalk.bold(`\n发现环境变量模板：${path.basename(detected.template)}`));
  console.log(chalk.gray(`我会逐个询问 ${detected.variables.length} 项，不需要你手动编辑文件。密码等敏感值不会保存到进度文件。`));
  const { configure } = await promptUser([{
    type: 'confirm', name: 'configure', message: '现在填写并在服务器创建 .env 文件吗？', default: true,
  }]);
  if (!configure) return null;
  const values = {};
  for (let index = 0; index < detected.variables.length; index++) {
    const variable = detected.variables[index];
    console.log(chalk.cyan(`\n  环境变量 ${index + 1}/${detected.variables.length}：${variable.name}`));
    if (variable.description) console.log(chalk.gray(`  用途：${variable.description}`));
    const result = await promptUser([{
      type: variable.sensitive ? 'password' : 'input',
      name: 'value',
      message: variable.sensitive ? '请输入（输入内容不会显示）：' : '请输入值：',
      mask: variable.sensitive ? '*' : undefined,
      default: variable.sensitive ? undefined : variable.defaultValue,
    }]);
    values[variable.name] = result.value;
    checkpoint('environment-variables', { environmentVariableIndex: index + 1 });
  }
  return serializeEnvironment(values);
}

function showDockerTemplateGuide() {
  console.log(chalk.yellow('\n  对于 Java、C++、Go、CUDA、conda 等环境，推荐 Docker 部署：'));
  console.log(chalk.gray('  在项目根目录创建 Dockerfile，然后选择 Docker 类型，deploy-helper 负责把容器跑起来。\n'));

  const templates = [
    {
      title: 'Python + conda / CUDA',
      lines: [
        'FROM continuumio/miniconda3',
        'WORKDIR /app',
        'COPY environment.yml .',
        'RUN conda env create -f environment.yml -n myenv',
        'COPY . .',
        'CMD ["conda", "run", "-n", "myenv", "--no-capture-output", "python", "main.py"]',
      ],
    },
    {
      title: 'Java (Maven + JDK 21)',
      lines: [
        'FROM maven:3.9-eclipse-temurin-21-alpine AS build',
        'WORKDIR /app',
        'COPY pom.xml .',
        'RUN mvn dependency:resolve -q',
        'COPY src ./src',
        'RUN mvn package -DskipTests -q',
        'FROM eclipse-temurin:21-jre-alpine',
        'COPY --from=build /app/target/*.jar app.jar',
        'EXPOSE 8080',
        'CMD ["java", "-jar", "app.jar"]',
      ],
    },
    {
      title: 'Go',
      lines: [
        'FROM golang:1.22-alpine AS build',
        'WORKDIR /app',
        'COPY go.mod go.sum ./',
        'RUN go mod download',
        'COPY . .',
        'RUN go build -o main .',
        'FROM alpine:latest',
        'COPY --from=build /app/main .',
        'EXPOSE 8080',
        'CMD ["./main"]',
      ],
    },
    {
      title: 'Node.js（含构建步骤）',
      lines: [
        'FROM node:20-alpine AS build',
        'WORKDIR /app',
        'COPY package*.json ./',
        'RUN npm ci',
        'COPY . .',
        'RUN npm run build',
        'FROM node:20-alpine',
        'WORKDIR /app',
        'COPY --from=build /app/dist ./dist',
        'COPY --from=build /app/node_modules ./node_modules',
        'EXPOSE 3000',
        'CMD ["node", "dist/index.js"]',
      ],
    },
  ];

  for (const { title, lines } of templates) {
    console.log(chalk.bold(`  ── ${title} ─`));
    for (const line of lines) {
      console.log(chalk.gray('  │ ') + chalk.white(line));
    }
    console.log('');
  }
  console.log(chalk.gray('  写好 Dockerfile 后，重新运行 deploy-helper 并选择 Docker 类型即可。\n'));
}

function printConnectionHelp(err, answers) {
  const port = answers.port || 22;
  console.log(chalk.yellow('\n排查建议：'));
  if (err.code === 'ECONNREFUSED') {
    console.log(`  • 端口 ${port} 拒绝连接：确认 SSH 服务和云实例正在运行`);
  } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
    console.log(`  • 连接超时：确认安全组、防火墙已放行端口 ${port}`);
  } else {
    console.log(`  • 检查地址 ${answers.host}、端口 ${port}、用户名和登录凭据`);
  }
  if (answers.authType === 'key') {
    console.log(`  • 当前密钥：${answers.keyPath}`);
  }
}

async function promptAndConnect(initialDefaults) {
  let defaults = { ...initialDefaults };
  while (true) {
    const answers = await promptUser([
      { type: 'input', name: 'host', message: '服务器地址（IP 或域名）：', default: defaults.host || undefined, validate: v => v.trim() ? true : '请输入服务器地址' },
      { type: 'input', name: 'port', message: 'SSH 端口：', default: defaults.port || '22', validate: validatePort },
      { type: 'input', name: 'user', message: '登录用户名：', default: defaults.user || 'root', validate: v => v.trim() ? true : '请输入用户名' },
      {
        type: 'list', name: 'authType', message: '登录方式（上下键选择）：',
        default: defaults.authType || (defaults.user !== 'root' ? 'password' : 'key'),
        choices: [
          { name: 'SSH 密钥（推荐，适合已配置密钥的 VPS）', value: 'key' },
          { name: '密码（适合云平台临时实例）', value: 'password' },
        ],
      },
      {
        type: 'input', name: 'keyPath', message: 'SSH 私钥路径：',
        default: defaults.keyPath || findDefaultPrivateKey(), when: a => a.authType === 'key',
        filter: expandHome,
        validate: v => fs.existsSync(expandHome(v)) ? true : '找不到该私钥文件，请检查路径',
      },
      { type: 'password', name: 'password', message: '服务器密码：', when: a => a.authType === 'password', mask: '*', validate: v => v ? true : '请输入密码' },
    ]);

    const spinner = ora('正在连接服务器并检查权限...').start();
    try {
      const ssh = await connectSSH(answers);
      spinner.succeed(chalk.green('服务器连接成功，权限检查通过！'));
      return { serverAnswers: answers, ssh };
    } catch (err) {
      spinner.fail(chalk.red('连接失败：' + err.message));
      printConnectionHelp(err, answers);
      const { next } = await promptUser([{
        type: 'list', name: 'next', message: '下一步：',
        choices: [
          { name: '修改连接信息后重试', value: 'edit' },
          { name: '使用相同信息重试', value: 'retry' },
          { name: '取消部署', value: 'cancel' },
        ],
      }]);
      if (next === 'cancel') return null;
      defaults = next === 'retry' ? answers : { ...answers, password: undefined };
      if (next === 'retry') {
        const retrySpinner = ora('重新连接...').start();
        try {
          const ssh = await connectSSH(answers);
          retrySpinner.succeed('服务器连接成功！');
          return { serverAnswers: answers, ssh };
        } catch (retryError) {
          retrySpinner.fail('重试失败：' + retryError.message);
          defaults = { ...answers, password: undefined };
        }
      }
    }
  }
}

export async function deployInit() {
  const preflightOk = await runLocalPreflight();
  if (!preflightOk) {
    console.log(chalk.gray('\n进度未开始。安装好必要工具后，再运行 deploy-helper init。\n'));
    return;
  }

  const previous = loadProgress();
  let resumed = false;
  if (previous) {
    const time = previous.updatedAt ? new Date(previous.updatedAt).toLocaleString() : '未知时间';
    const { resume } = await promptUser([{
      type: 'confirm',
      name: 'resume',
      message: `发现 ${time} 保存的未完成部署，要从上次进度继续吗？`,
      default: true,
    }]);
    if (resume) {
      resumed = true;
      activeProgress = previous;
      console.log(chalk.green(`  ✓ 已恢复进度：${previous.stage || '准备阶段'}`));
    } else {
      clearProgress();
      activeProgress = saveProgress({ stage: 'started', answers: {}, completedSteps: [] });
      console.log(chalk.gray('  已放弃旧进度，开始一次全新的部署。'));
    }
  } else {
    activeProgress = saveProgress({ stage: 'started', answers: {}, completedSteps: [] });
  }

  // 已有配置，询问是否覆盖
  if (configExists() && !resumed) {
    const existing = loadConfig();
    const { overwrite } = await promptUser([{
      type: 'confirm',
      name: 'overwrite',
      message: existing
        ? `检测到已有部署配置（服务器：${existing.host}），要重新配置吗？`
        : '检测到损坏或无法解析的 .deploy-config.json，要重新生成吗？',
      default: false,
    }]);
    if (!overwrite) {
      clearProgress();
      console.log(chalk.yellow('\n已取消。如需更新代码，运行：') + chalk.cyan(' deploy-helper update\n'));
      return;
    }
  }

  console.log(chalk.gray('回答几个问题，我来帮你搞定剩下的一切 👇\n'));

  // ── Step 1: 服务器信息 ──────────────────────────────────────────
  step(1, 7, '连接服务器', '可选配置免密登录，然后确认项目信息');

  // 允许粘贴 SSH 连接命令自动解析
  const { sshString } = await promptUser([{
    type: 'input',
    name: 'sshString',
    message: '（可选）粘贴 SSH 连接命令自动填充，或直接回车手动填写：',
    default: activeProgress?.answers?.sshString || '',
  }]);
  checkpoint('server-command', { sshString });

  let sshDefaults = {
    host: activeProgress?.answers?.host || '',
    port: activeProgress?.answers?.sshPort || activeProgress?.answers?.port || '22',
    user: activeProgress?.answers?.user || 'root',
    authType: activeProgress?.answers?.authType,
    keyPath: activeProgress?.answers?.keyPath || null,
  };
  if (sshString.trim()) {
    const parsed = parseSshCommand(sshString);
    if (parsed) {
      sshDefaults = parsed;
      console.log(chalk.gray(`  解析结果 → 用户: ${chalk.white(sshDefaults.user)}  主机: ${chalk.white(sshDefaults.host)}  端口: ${chalk.white(sshDefaults.port)}\n`));
    } else {
      console.log(chalk.yellow('  无法解析该格式，请手动填写。\n'));
    }
  }

  const connection = await promptAndConnect(sshDefaults);
  if (!connection) {
    console.log(chalk.gray('\n已取消部署。\n'));
    return;
  }
  let { serverAnswers, ssh } = connection;
  checkpoint('server-connected', { ...serverAnswers, sshPort: serverAnswers.port }, 'server-connected');

  try {
    serverAnswers = await offerPasswordlessLogin(ssh, serverAnswers);
    checkpoint('passwordless-offered', { ...serverAnswers, sshPort: serverAnswers.port }, 'passwordless-offered');
  } catch (error) {
    console.log(chalk.yellow(`  免密登录没有配置成功：${error.message}`));
    console.log(chalk.gray('  不影响本次部署，将继续使用密码连接。'));
  }

  // ── Step 2: 项目信息 ──────────────────────────────────────────
  step(2, 7, '确认项目和运行方式', '逐项填写环境变量');

  const detectedType = detectProjectType();
  info(`自动检测到项目类型：${PROJECT_TYPE_LABELS[detectedType]}`);

  // 第一步：确认类型和应用名
  const typeAnswers = await promptUser([
    {
      type: 'list',
      name: 'projectType',
      message: '确认项目类型：',
      default: activeProgress?.answers?.projectType || detectedType,
      choices: Object.entries(PROJECT_TYPE_LABELS).map(([value, name]) => ({ name, value })),
    },
    {
      type: 'input',
      name: 'appName',
      message: '应用名称（用于进程管理）：',
      default: activeProgress?.answers?.appName || path.basename(process.cwd()),
      validate: (v) => /^[a-z0-9_-]+$/i.test(v) ? true : '只能包含字母、数字、下划线和连字符',
    },
  ]);
  checkpoint('project-type', typeAnswers);

  const { projectType, appName } = typeAnswers;

  // 根据确认的类型做二次检测，结果全部展示给用户
  let detectedNodeVer = null;
  let detectedNodeCmd = null;
  let detectedBuildCmd = null;
  let detectedStaticDir = '';
  let detectedPyFramework = null;
  let detectedPyVersion = null;
  let detectedPyEnvManager = null;
  let detectedPyDependencySource = null;
  let detectedDockerInfo = null;

  if (projectType === 'nodejs') {
    detectedNodeVer = detectNodeVersion();
    detectedNodeCmd = getNodeStartCommand();
    detectedBuildCmd = getNodeBuildCommand();

    if (detectedNodeVer) {
      info(`检测到 Node.js 版本要求：v${detectedNodeVer.version}（来源：${detectedNodeVer.source}）`);
    } else {
      info('未检测到 Node.js 版本要求（.nvmrc / engines.node），将默认使用 Node.js 20 LTS');
    }
    info(`检测到启动命令：${detectedNodeCmd.cmd}（来源：${detectedNodeCmd.source}）`);
    if (detectedBuildCmd) info(`检测到构建命令：${detectedBuildCmd.cmd}（来源：${detectedBuildCmd.source}）`);
  }

  if (projectType === 'static') {
    detectedBuildCmd = getNodeBuildCommand();
    detectedStaticDir = detectStaticOutputDir();
    if (detectedBuildCmd) {
      detectedNodeVer = detectNodeVersion();
      info(`检测到静态站点构建命令：${detectedBuildCmd.cmd}`);
      info(`预计构建产物目录：${detectedStaticDir}`);
    }
  }

  if (projectType === 'python') {
    detectedPyFramework = detectPythonFramework();
    detectedPyVersion = detectPythonVersion();
    detectedPyEnvManager = detectPythonEnvManager();
    detectedPyDependencySource = detectPythonDependencySource();

    // 依赖管理方式
    if (detectedPyEnvManager === 'conda') {
      const hasEnvYml = fs.existsSync(path.join(process.cwd(), 'environment.yml'));
      if (hasEnvYml) {
        info('检测到 conda 环境（environment.yml ✓）');
      } else {
        console.log(chalk.yellow('\n  ⚠ 检测到 conda 项目（conda-lock.yml），但未找到 environment.yml'));
        console.log(chalk.gray('  部署需要 environment.yml 来在服务器上重建 conda 环境。'));
        console.log(chalk.gray('  请在本地激活 conda 环境后运行：\n'));
        console.log(chalk.cyan('    conda activate <你的环境名>'));
        console.log(chalk.cyan('    conda env export > environment.yml\n'));
        console.log(chalk.gray('  或者改用 Docker 部署（见下方模板），跳过这个问题。\n'));
      }
    } else if (detectedPyEnvManager === 'pip') {
      info(`检测到 pip 环境（${detectedPyDependencySource === 'pyproject' ? 'pyproject.toml' : 'requirements.txt'} ✓）`);
    } else {
      console.log(chalk.yellow('\n  ⚠ 未找到 requirements.txt 或 environment.yml'));
      console.log(chalk.gray('  部署时无法自动安装依赖，请先生成依赖文件：\n'));
      console.log(chalk.gray('  conda 项目：'));
      console.log(chalk.cyan('    conda activate <你的环境名>'));
      console.log(chalk.cyan('    conda env export > environment.yml\n'));
      console.log(chalk.gray('  pip 项目：'));
      console.log(chalk.cyan('    pip freeze > requirements.txt\n'));
      console.log(chalk.gray('  或者用 Docker 把整个环境封装进镜像（见下方模板）。\n'));
    }

    if (detectedPyFramework) {
      const source = detectedPyDependencySource === 'pyproject' ? 'pyproject.toml' : 'requirements.txt';
      info(`检测到 Python 框架：${PYTHON_FRAMEWORK_LABELS[detectedPyFramework]}（来源：${source}）`);
    } else {
      info('未检测到已知 web 框架（FastAPI / Django / Flask），将按纯脚本处理');
    }
    if (detectedPyVersion) {
      info(`检测到 Python 版本：${detectedPyVersion.version}（来源：${detectedPyVersion.source}）`);
    } else {
      info('未检测到 Python 版本要求（.python-version / pyproject.toml），将默认使用 3.11');
    }
  }

  if (projectType === 'docker') {
    const dockerfileExists = hasDockerfile();
    const composeFile = detectComposeFile();
    const dockerPort = detectDockerPort();

    if (!dockerfileExists && !composeFile) {
      console.log(chalk.yellow('\n  ⚠ 未检测到 Dockerfile 或 docker-compose 文件'));
      console.log(chalk.gray('    Docker 部署需要 Dockerfile 或 docker-compose.yml。'));
      console.log(chalk.gray('    如果你的语言/框架比较特殊（Java、C++、CUDA 等），'));
      console.log(chalk.gray('    推荐用 Dockerfile 把运行环境完整封装，deploy-helper 只负责把它跑起来。'));
    } else if (dockerfileExists) {
      info('检测到 Dockerfile ✓');
    }

    if (composeFile) {
      info(`检测到编排文件：${composeFile}（将使用 docker compose 启动）`);
    } else {
      info('未检测到 docker-compose 文件，将以单容器模式（docker build + docker run）启动');
    }

    if (dockerPort) {
      info(`检测到容器映射端口：${dockerPort.port}（来源：${dockerPort.source}）`);
    } else {
      info('未从 Dockerfile/compose 文件中读取到端口，请手动填写');
    }

    const localEnvExists = fs.existsSync(path.join(process.cwd(), '.env'));
    if (localEnvExists) {
      console.log(chalk.gray('\n  本地存在 .env 文件（默认不上传，包含敏感信息请谨慎）'));
    }

    detectedDockerInfo = { dockerfileExists, composeFile, dockerPort, localEnvExists };
  }

  if (projectType === 'unknown') {
    showDockerTemplateGuide();
    ssh.dispose();
    console.log(chalk.yellow('已停止部署：请先补充 Dockerfile，再重新运行 init。\n'));
    return;
  }

  // 推断默认应用模式，供用户确认
  let detectedAppMode = null;
  if (projectType === 'static') {
    detectedAppMode = 'web';
  } else if (projectType === 'nodejs') {
    detectedAppMode = 'web';
  } else if (projectType === 'python' && detectedPyFramework) {
    detectedAppMode = 'web';
  } else if (projectType === 'docker' && detectedDockerInfo?.dockerPort) {
    detectedAppMode = 'web';
  }

  if (detectedAppMode === 'web') {
    info('应用模式：Web 服务（将配置端口 + Nginx 反向代理）');
  } else if (projectType !== 'unknown') {
    info('应用模式未能自动判断，请手动选择（影响是否配置 Nginx 和端口）');
  }

  // 第二步：让用户确认所有检测结果，port 在 startCmd 之前以便生成默认命令
  const detailAnswers = await promptUser([
    {
      type: 'input',
      name: 'remotePath',
      message: '部署到服务器的路径：',
      default: activeProgress?.answers?.remotePath || `/var/www/${appName}`,
      validate: validateRemotePath,
    },
    {
      type: 'input',
      name: 'staticDir',
      message: '站点根目录（构建产物所在子目录，如 dist / build；留空表示项目根目录）：',
      default: detectedStaticDir,
      when: () => projectType === 'static',
      validate: (v) => !v.includes('..') && /^[a-zA-Z0-9._/-]*$/.test(v.trim()) ? true : '请输入不含 .. 的相对目录',
    },
    {
      type: 'input',
      name: 'nodeVersion',
      message: '确认 Node.js 版本（主版本号，如 18 / 20 / 22）：',
      default: detectedNodeVer?.version || '20',
      when: () => projectType === 'nodejs' || (projectType === 'static' && !!detectedBuildCmd),
      validate: validateMajorVersion,
    },
    {
      type: 'list',
      name: 'pythonFramework',
      message: '确认 Python 框架：',
      default: detectedPyFramework || 'other',
      choices: [
        { name: 'FastAPI（uvicorn 启动）', value: 'fastapi' },
        { name: 'Django（gunicorn 启动）', value: 'django' },
        { name: 'Flask（gunicorn 启动）', value: 'flask' },
        { name: '其他（手动填写启动命令）', value: 'other' },
      ],
      when: () => projectType === 'python',
    },
    {
      type: 'input',
      name: 'pythonVersion',
      message: '确认 Python 版本（如 3.11）：',
      default: detectedPyVersion?.version || '3.11',
      when: () => projectType === 'python',
      validate: validatePythonVersion,
    },
    {
      type: 'list',
      name: 'pythonEnvManager',
      message: '确认依赖管理方式：',
      default: detectedPyEnvManager || 'pip',
      choices: [
        { name: 'pip + venv（从 requirements.txt / pyproject.toml 安装）', value: 'pip' },
        { name: 'conda（从 environment.yml 安装，服务器将安装 Miniconda）', value: 'conda' },
      ],
      when: () => projectType === 'python',
    },
    {
      type: 'list',
      name: 'appMode',
      message: '确认应用运行方式：',
      default: detectedAppMode || 'web',
      choices: [
        { name: 'Web 服务（监听端口，通过浏览器 / API 访问）', value: 'web' },
        { name: '后台脚本（长期运行，不对外提供 HTTP 服务）', value: 'script' },
        { name: '定时任务（按计划执行，跑完自动退出）', value: 'cron' },
      ],
      when: () => projectType !== 'static',
    },
    {
      type: 'input',
      name: 'port',
      message: '应用监听的端口（宿主机端口，Nginx 将代理到此）：',
      default: () => {
        if (activeProgress?.answers?.appPort) return activeProgress.answers.appPort;
        if (projectType === 'docker') return detectedDockerInfo?.dockerPort?.port || '8080';
        if (projectType === 'python') return '8000';
        return '3000';
      },
      when: (a) => ['nodejs', 'python', 'docker'].includes(projectType) && (a.appMode ?? 'web') === 'web',
      validate: validatePort,
    },
    {
      type: 'input',
      name: 'composeFile',
      message: 'docker-compose 文件名（留空则使用单容器模式）：',
      default: detectedDockerInfo?.composeFile || '',
      when: () => projectType === 'docker',
      validate: v => {
        const name = v.trim();
        if (!name) return detectedDockerInfo?.dockerfileExists ? true : '没有 Dockerfile 时必须指定 compose 文件';
        if (name.includes('..') || !/^[a-zA-Z0-9._/-]+$/.test(name)) return '请输入安全的相对文件名';
        return fs.existsSync(path.join(process.cwd(), name)) ? true : `本地找不到 ${name}`;
      },
    },
    {
      type: 'confirm',
      name: 'uploadEnv',
      message: '是否将本地 .env 文件上传到服务器？（包含数据库密码等敏感信息，请谨慎）',
      default: false,
      when: () => projectType === 'docker' && detectedDockerInfo?.localEnvExists,
    },
    {
      type: 'input',
      name: 'buildCmd',
      message: '构建命令（无需构建可留空）：',
      default: detectedBuildCmd?.cmd || '',
      when: () => projectType === 'nodejs' || projectType === 'static',
    },
    {
      type: 'input',
      name: 'startCmd',
      message: '确认启动命令：',
      default: (a) => {
        if (projectType === 'nodejs') return detectedNodeCmd.cmd;
        if (projectType === 'python') {
          return getPythonStartCommand(a.pythonFramework, appName, a.port);
        }
        return '';
      },
      when: () => ['nodejs', 'python'].includes(projectType),
      validate: v => v.trim() ? true : '请输入启动命令',
    },
    {
      type: 'list',
      name: 'cronPreset',
      message: '执行频率：',
      choices: [
        { name: '每天凌晨 2 点      (0 2 * * *)',   value: '0 2 * * *' },
        { name: '每小时整点         (0 * * * *)',   value: '0 * * * *' },
        { name: '每 6 小时          (0 */6 * * *)', value: '0 */6 * * *' },
        { name: '每周一凌晨 2 点    (0 2 * * 1)',   value: '0 2 * * 1' },
        { name: '自定义 cron 表达式',               value: 'custom' },
      ],
      when: (a) => a.appMode === 'cron',
    },
    {
      type: 'input',
      name: 'cronSchedule',
      message: 'Cron 表达式（分 时 日 月 周）：',
      default: '0 2 * * *',
      validate: validateCron,
      when: (a) => a.appMode === 'cron' && a.cronPreset === 'custom',
    },
  ]);
  const { port: answeredAppPort, ...savedDetails } = detailAnswers;
  checkpoint('project-details', { ...savedDetails, appPort: answeredAppPort });

  const projectAnswers = { ...typeAnswers, ...detailAnswers };

  if (projectType === 'python') {
    if (detailAnswers.pythonEnvManager === 'pip' && !detectedPyDependencySource) {
      console.log(chalk.red('\n缺少 requirements.txt 或 pyproject.toml，无法安装 Python 依赖。请补充后重试。\n'));
      ssh.dispose();
      return;
    }
    if (detailAnswers.pythonEnvManager === 'conda' && !fs.existsSync(path.join(process.cwd(), 'environment.yml'))) {
      console.log(chalk.red('\n缺少 environment.yml，无法在服务器重建 conda 环境。请生成后重试。\n'));
      ssh.dispose();
      return;
    }
  }

  // 确定应用模式与步骤总数
  const appMode = projectType === 'static' ? 'web' : (detailAnswers.appMode || 'web');
  const cronSchedule = detailAnswers.appMode === 'cron'
    ? (detailAnswers.cronPreset === 'custom' ? detailAnswers.cronSchedule : detailAnswers.cronPreset)
    : null;
  const isWebService = appMode === 'web';
  step(3, 7, '准备项目文件和环境变量', '根据需要配置域名和 HTTPS');
  const localGit = getLocalGitInfo();
  const sourceAnswers = await promptUser([
    {
      type: 'list',
      name: 'sourceMode',
      message: '项目代码怎样送到服务器？',
      default: activeProgress?.answers?.sourceMode || 'upload',
      choices: [
        { name: '直接上传当前文件夹（最简单，推荐新手）', value: 'upload' },
        { name: '让服务器用 Git 拉取仓库（仓库需公开或已配置访问权限）', value: 'git' },
      ],
    },
    {
      type: 'input',
      name: 'repositoryUrl',
      message: 'Git 仓库地址：',
      default: activeProgress?.answers?.repositoryUrl || localGit.url,
      when: answers => answers.sourceMode === 'git',
      validate: validateGitUrl,
    },
    {
      type: 'input',
      name: 'repositoryBranch',
      message: '要部署的分支：',
      default: activeProgress?.answers?.repositoryBranch || localGit.branch,
      when: answers => answers.sourceMode === 'git',
      validate: validateGitBranch,
    },
  ]);
  checkpoint('source-selected', sourceAnswers);
  const environmentAlreadyWritten = stepCompleted('environment-file');
  if (environmentAlreadyWritten) info('上次运行已在服务器写入 .env，这次无需再次填写敏感值。');
  const generatedEnv = environmentAlreadyWritten ? null : await promptEnvironmentFile();
  const hasEnvironmentFile = environmentAlreadyWritten || !!generatedEnv;
  checkpoint('environment-ready', { createEnvironmentFile: hasEnvironmentFile }, 'environment-answered');

  // ── Step 3: 域名 & HTTPS（仅 web 服务需要）────────────────────
  let domainAnswers = {};
  if (isWebService) {
    step(4, 7, '域名、Nginx 和 HTTPS（全部可跳过）', '确认计划并安装服务器环境');
    domainAnswers = await promptUser([
      {
        type: 'confirm',
        name: 'useDomain',
        message: '是否配置域名？（没有域名用 IP 也可以）',
        default: activeProgress?.answers?.useDomain ?? false,
      },
      {
        type: 'input',
        name: 'domain',
        message: '你的域名（如 example.com）：',
        default: activeProgress?.answers?.domain,
        when: (a) => a.useDomain,
        validate: validateDomain,
      },
      {
        type: 'confirm',
        name: 'useHttps',
        message: '是否自动申请 HTTPS 证书？（免费，需要域名已解析到此服务器）',
        default: true,
        when: (a) => a.useDomain,
      },
      {
        type: 'input',
        name: 'certEmail',
        message: 'Let\'s Encrypt 续期通知邮箱（留空则不注册邮箱）：',
        default: '',
        when: (a) => a.useHttps,
        validate: v => !v.trim() || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? true : '请输入有效邮箱或留空',
      },
    ]);
  } else {
    const modeLabel = appMode === 'cron' ? '定时任务' : '后台脚本';
    step(4, 7, '域名、Nginx 和 HTTPS');
    info(`跳过域名配置（${modeLabel}无需 Nginx 反向代理）`);
  }
  checkpoint('domain-options', domainAnswers);

  const config = {
    ...serverAnswers,
    ...projectAnswers,
    ...domainAnswers,
    appMode,
    cronSchedule,
    pythonDependencySource: detectedPyDependencySource,
    ...sourceAnswers,
    createEnvironmentFile: hasEnvironmentFile,
    configureNginx: isWebService && !!domainAnswers.useDomain,
    schemaVersion: 2,
    sshPort: String(serverAnswers.port || 22),
    port: String(serverAnswers.port || 22),
    appPort: detailAnswers.port ? String(detailAnswers.port) : undefined,
    domain: domainAnswers.domain || serverAnswers.host,
    deployedAt: null,
  };

  const osCheck = await runRemoteSilent(ssh, `. /etc/os-release 2>/dev/null && echo "$ID $VERSION_ID"`);
  if (!/^ubuntu\s/.test(osCheck.stdout)) {
    console.log(chalk.red(`\n当前服务器系统为 ${osCheck.stdout || '未知'}，本版本仅支持 Ubuntu，已停止部署。\n`));
    ssh.dispose();
    return;
  }

  console.log(chalk.bold('\n部署计划确认：'));
  console.log(`  服务器：${config.user}@${config.host}:${config.sshPort}`);
  console.log(`  项目：  ${PROJECT_TYPE_LABELS[config.projectType]} / ${config.appMode}`);
  console.log(`  路径：  ${config.remotePath}`);
  if (config.buildCmd) console.log(`  构建：  ${config.buildCmd}`);
  if (config.startCmd) console.log(`  启动：  ${config.startCmd}`);
  if (isWebService) console.log(`  入口：  ${domainAnswers.domain || config.host}${domainAnswers.useHttps ? '（申请 HTTPS）' : ''}`);
  console.log(chalk.yellow('  注意：将安装系统软件，并镜像同步项目文件（保留 .env、依赖目录）。'));
  const { confirmPlan } = await promptUser([{
    type: 'confirm', name: 'confirmPlan', message: '确认按以上计划部署？', default: true,
  }]);
  checkpoint('plan-confirmed', { confirmPlan });
  if (!confirmPlan) {
    ssh.dispose();
    clearProgress();
    console.log(chalk.gray('\n已取消，服务器未做部署变更。\n'));
    return;
  }

  // ── Step 5: 安装环境 ──────────────────────────────────────────
  step(5, 7, '安装服务器运行环境', '传送项目文件并启动应用');
  const setupSteps = getSetupCommands(config);
  const shouldSetup = await confirmAction('server-setup', `需要我自动安装 ${setupSteps.map(item => item.label).join('、')} 吗？`);
  if (shouldSetup) {
    await runRemote(ssh, `mkdir -p ${config.remotePath}`, '创建部署目录');
    for (let index = 0; index < setupSteps.length; index++) {
      const setupItem = setupSteps[index];
      const itemKey = `server-setup-${index}`;
      const executeItem = await confirmAction(itemKey, `下一项是“${setupItem.label}”，需要执行吗？`);
      if (!executeItem) continue;
      await runRecoverableStep({
        label: setupItem.label,
        manualCommands: [setupItem.cmd],
        action: async () => {
          const spinner = ora(`  ${setupItem.label}...`).start();
          try {
            await runRemoteStrict(ssh, setupItem.cmd);
            spinner.succeed(chalk.green(setupItem.label));
          } catch (error) {
            spinner.fail(chalk.red(`${setupItem.label} 失败`));
            throw error;
          }
        },
      });
      checkpoint(`${itemKey}-complete`, {}, itemKey);
    }
    checkpoint('server-setup-complete', {}, 'server-setup');
  } else if (!stepCompleted('server-setup')) {
    info('已按你的选择跳过自动安装。若服务器缺少依赖，后续启动会提示修复方法。');
  }

  // ── Step 6: 项目文件 & 启动 ──────────────────────────────────
  step(6, 7, '传送项目文件并启动应用', '按需配置域名、安全访问并做最终检查');

  try {
    const shouldTransfer = await confirmAction(
      'source-transfer',
      config.sourceMode === 'git'
        ? `需要我从 ${config.repositoryUrl} 拉取项目代码吗？`
        : '需要我把当前文件夹上传到服务器吗？'
    );
    if (shouldTransfer) {
      await runRecoverableStep({
        label: config.sourceMode === 'git' ? 'Git 拉取代码' : '上传项目文件',
        manualCommands: config.sourceMode === 'git'
          ? [`git clone --branch ${config.repositoryBranch} ${config.repositoryUrl} ${config.remotePath}`]
          : [],
        action: async () => {
          if (config.sourceMode === 'git') {
            await runRemote(ssh, getGitDeployCommand(config), '用 Git 拉取最新代码');
          } else {
            const uploadSpinner = ora('  上传项目文件...').start();
            const skipPatterns = config.projectType === 'static'
              ? ['node_modules', '.git', '__pycache__', '.DS_Store', '.venv', 'venv']
              : undefined;
            try {
              await uploadDirectory(ssh, process.cwd(), config.remotePath, {
                uploadEnv: !!config.uploadEnv,
                skipPatterns,
              });
              uploadSpinner.succeed('项目文件上传完成');
            } catch (error) {
              uploadSpinner.fail('项目文件上传失败');
              throw error;
            }
          }
        },
      });
      checkpoint('source-transfer-complete', {}, 'source-transfer');
    }

    if (generatedEnv) {
      const shouldWriteEnv = await confirmAction('environment-file', '需要我根据刚才填写的内容，在服务器创建 .env 文件吗？');
      if (shouldWriteEnv) {
        await runRemoteStrict(ssh, `${writeFileHeredoc(`${config.remotePath}/.env`, generatedEnv)} && chmod 600 '${config.remotePath}/.env'`);
        success('环境变量文件已安全写入服务器');
        checkpoint('environment-file-complete', {}, 'environment-file');
      }
    } else if (config.projectType === 'docker' && !config.uploadEnv && detectedDockerInfo?.localEnvExists) {
      console.log(chalk.yellow('  ℹ .env 未上传。之后可运行 deploy-helper env，由工具引导同步。'));
    }

    const shouldStart = await confirmAction('application-start', '需要我安装项目依赖、构建并启动应用吗？');
    if (shouldStart) {
      const startSteps = getStartCommands(config);
      for (let index = 0; index < startSteps.length; index++) {
        const startItem = startSteps[index];
        const itemKey = `application-start-${index}`;
        const executeItem = await confirmAction(itemKey, `下一项是“${startItem.label}”，需要执行吗？`);
        if (!executeItem) continue;
        await runRecoverableStep({
          label: startItem.label,
          action: async () => {
          const spinner = ora(`  ${startItem.label}...`).start();
          try {
            await runRemoteStrict(ssh, startItem.cmd);
            spinner.succeed(startItem.label);
          } catch (error) {
            spinner.fail(chalk.red(`${startItem.label} 失败`));
            throw error;
          }
          },
          manualCommands: [startItem.cmd],
          onEdit: async () => {
            if (config.appMode !== 'web') return;
            const oldPort = String(config.appPort);
            const { newPort } = await promptUser([{
              type: 'input', name: 'newPort', message: '请输入新的应用端口：', default: oldPort, validate: validatePort,
            }]);
            config.appPort = String(newPort);
            if (config.startCmd) config.startCmd = config.startCmd.replace(new RegExp(`(?<!\\d)${oldPort}(?!\\d)`, 'g'), config.appPort);
            checkpoint('port-updated', { appPort: config.appPort, startCmd: config.startCmd });
            // 端口变化会影响后续生成命令；本项重试仍使用原命令，返回外层重新运行可重建全部命令。
            throw Object.assign(new Error('端口已更新，请重新运行 init，从保存的进度继续'), { code: 'DEPLOY_PAUSE' });
          },
        });
        checkpoint(`${itemKey}-complete`, {}, itemKey);
      }
      checkpoint('application-start-complete', {}, 'application-start');
    } else if (!stepCompleted('application-start')) {
      info('已跳过启动应用。工具不会把未启动的服务显示为部署成功。');
      config.skippedStart = true;
    }

    // 没有域名时直接访问 IP + 应用端口，不安装或配置 Nginx。
    if (config.configureNginx) {
      step(7, 7, '配置域名、安全访问并检查结果', '显示最终访问地址和后续操作');
      const shouldNginx = await confirmAction('nginx', `需要我为域名 ${config.domain} 配置并重新加载 Nginx 吗？`);
      if (shouldNginx) {
        const nginxConf = getNginxConfig(config);
        const nginxPath = `/etc/nginx/sites-available/${config.appName}`;
        await runRecoverableStep({
          label: 'Nginx 配置',
          manualCommands: ['nginx -t', 'systemctl reload nginx'],
          action: async () => {
            await runRemoteStrict(ssh, writeFileHeredoc(nginxPath, nginxConf));
            await runRemoteStrict(ssh, `ln -sf ${nginxPath} /etc/nginx/sites-enabled/${config.appName}`);
            await runRemoteStrict(ssh, 'rm -f /etc/nginx/sites-enabled/default');
            await runRemoteStrict(ssh, 'nginx -t && systemctl reload nginx');
          },
        });
        success('Nginx 配置完成');
        checkpoint('nginx-complete', {}, 'nginx');
      } else if (!stepCompleted('nginx')) {
        config.configureNginx = false;
        config.useHttps = false;
        info('已跳过 Nginx。将改为直接检查应用端口，也不会申请 HTTPS 证书。');
      }

      if (config.configureNginx && domainAnswers.useHttps && domainAnswers.domain) {
        const shouldHttps = await confirmAction('https', '需要我现在申请免费的 HTTPS 安全证书吗？');
        if (shouldHttps) {
          const emailArg = domainAnswers.certEmail && domainAnswers.certEmail.trim()
            ? `--email ${domainAnswers.certEmail.trim()}`
            : '--register-unsafely-without-email';
          await runRecoverableStep({
            label: 'HTTPS 证书申请',
            manualCommands: [`certbot --nginx -d ${config.domain}`],
            action: async () => {
              const result = await runRemoteSilent(
                ssh,
                `certbot --nginx -d ${config.domain} --non-interactive --agree-tos ${emailArg} --redirect`
              );
              if (result.code !== 0) {
                const tail = (result.stderr || result.stdout || '').split('\n').slice(-3).join(' ');
                throw new Error(tail || '证书服务没有返回成功结果');
              }
            },
          });
          success('HTTPS 证书申请成功');
          checkpoint('https-complete', {}, 'https');
        } else if (!stepCompleted('https')) {
          config.useHttps = false;
          info('已跳过 HTTPS，将暂时使用 HTTP。');
        }
      }
    } else if (isWebService) {
      step(7, 7, '检查部署结果', '显示直接访问服务器的地址');
      info('你没有填写域名，因此已跳过 Nginx 和 HTTPS。应用将通过服务器 IP 与应用端口访问。');
    }

    // ── 健康检查 ─────────────────────────────────────────────
    const shouldCheck = !config.skippedStart && await confirmAction('health-check', '需要我检查应用是否真的启动并可以访问吗？');
    const health = shouldCheck ? getHealthCheck(config) : null;
    if (health) {
      const hSpinner = ora('  验证服务运行状态...').start();
      // 给服务 2 秒启动时间
      await runRemoteSilent(ssh, 'sleep 2');
      const result = await runRemoteSilent(ssh, health.cmd);
      const parsed = health.parse(result);
      if (parsed.ok) {
        hSpinner.succeed(chalk.green(`服务运行正常 — ${parsed.detail}`));
      } else {
        hSpinner.fail(chalk.yellow(`健康检查未通过 — ${parsed.detail}`));
        throw new Error(`健康检查未通过：${parsed.detail}`);
      }
    }

    const httpHealth = getHttpHealthCheck(config);
    if (shouldCheck && httpHealth) {
      const httpSpinner = ora('  验证 HTTP 入口...').start();
      const result = await runRemoteSilent(ssh, httpHealth.cmd);
      const parsed = httpHealth.parse(result);
      if (!parsed.ok) {
        httpSpinner.fail(`HTTP 验证失败 — ${parsed.detail}`);
        throw new Error(`HTTP 入口不可用：${parsed.detail}`);
      }
      httpSpinner.succeed(`HTTP 入口可访问 — ${parsed.detail}`);
    }
    if (shouldCheck) checkpoint('health-check-complete', {}, 'health-check');

  } catch (err) {
    if (err.code === 'DEPLOY_PAUSE') throw err;
    console.log(chalk.red('\n部署失败：' + err.message));
    console.log(chalk.yellow('进度已经保存。修复问题后重新运行 deploy-helper init，即可继续。'));
    ssh.dispose();
    return;
  }

  // 保存配置
  config.deployedAt = config.skippedStart ? null : new Date().toISOString();
  saveConfig(config);
  ssh.dispose();
  clearProgress();

  // 完成！
  console.log(config.skippedStart
    ? chalk.yellow.bold('\n部署引导已完成，但应用尚未启动。\n')
    : chalk.green.bold('\n🎉 部署成功！\n'));

  if (isWebService && !(config.projectType === 'static' && config.configureNginx === false)) {
    const accessUrl = config.configureNginx === false
      ? `http://${config.host}:${config.appPort || 80}`
      : config.useHttps && domainAnswers.domain
      ? `https://${config.domain}`
      : domainAnswers.domain
        ? `http://${config.domain}`
        : `http://${config.host}:${config.appPort || 80}`;
    console.log(`  访问地址：${chalk.cyan.underline(accessUrl)}`);
  } else if (config.projectType === 'static' && config.configureNginx === false) {
    console.log(chalk.yellow('  站点文件已构建，但你跳过了 Web 入口，因此目前没有公开访问地址。'));
    console.log(chalk.gray('  重新运行 deploy-helper init 并配置域名后，可由工具设置 Nginx。'));
  } else if (appMode === 'cron') {
    console.log(`  定时计划：${chalk.cyan(config.cronSchedule)}`);
    console.log(`  日志查看：${chalk.cyan(`tail -f /var/log/${config.appName}.log`)}`);
    console.log(`  修改计划：${chalk.gray('crontab -e')}`);
  } else {
    if (config.projectType === 'nodejs') {
      console.log(`  进程状态：${chalk.cyan(`pm2 status ${config.appName}`)}`);
      console.log(`  日志查看：${chalk.cyan(`pm2 logs ${config.appName}`)}`);
    } else if (config.projectType === 'docker') {
      console.log(`  进程状态：${chalk.cyan(`docker ps --filter name=${config.appName}`)}`);
      console.log(`  日志查看：${chalk.cyan(`docker logs -f ${config.appName}`)}`);
    } else {
      console.log(`  进程状态：${chalk.cyan(`supervisorctl status ${config.appName}`)}`);
      console.log(`  输出日志：${chalk.cyan(`tail -f /var/log/${config.appName}.out.log`)}`);
      console.log(`  错误日志：${chalk.cyan(`tail -f /var/log/${config.appName}.err.log`)}`);
    }
  }

  console.log(`  配置已保存至：${chalk.gray('.deploy-config.json')}`);
  console.log('\n后续操作：');
  console.log(`  更新代码 → ${chalk.cyan('deploy-helper update')}`);
  console.log(`  查看状态 → ${chalk.cyan('deploy-helper status')}\n`);
}
