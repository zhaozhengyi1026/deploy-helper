import inquirer from 'inquirer';
import chalk from 'chalk';
import ora from 'ora';
import path from 'path';
import os from 'os';
import {
  connectSSH, runRemote, runRemoteSilent, runRemoteStrict, uploadDirectory,
} from '../utils/ssh.js';
import { saveConfig, loadConfig, configExists } from '../utils/config.js';
import fs from 'fs';
import {
  detectProjectType, detectNodeVersion, detectPythonFramework, detectPythonVersion,
  detectPythonEnvManager,
  getNodeStartCommand, getPythonStartCommand,
  hasDockerfile, detectComposeFile, detectDockerPort,
  PROJECT_TYPE_LABELS, PYTHON_FRAMEWORK_LABELS,
} from '../utils/detect.js';
import {
  getSetupCommands, getStartCommands, getNginxConfig, getHealthCheck, writeFileHeredoc,
} from '../utils/setup.js';

const step = (n, total, msg) =>
  console.log(chalk.cyan(`\n[${n}/${total}] `) + chalk.bold(msg));

const success = (msg) => console.log(chalk.green('  ✓ ') + msg);
const info = (msg) => console.log(chalk.gray('  ℹ ') + msg);

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

export async function deployInit() {
  // 已有配置，询问是否覆盖
  if (configExists()) {
    const existing = loadConfig();
    const { overwrite } = await inquirer.prompt([{
      type: 'confirm',
      name: 'overwrite',
      message: `检测到已有部署配置（服务器：${existing.host}），要重新配置吗？`,
      default: false,
    }]);
    if (!overwrite) {
      console.log(chalk.yellow('\n已取消。如需更新代码，运行：') + chalk.cyan(' deploy-helper update\n'));
      return;
    }
  }

  console.log(chalk.gray('回答几个问题，我来帮你搞定剩下的一切 👇\n'));

  // ── Step 1: 服务器信息 ──────────────────────────────────────────
  step(1, 5, '服务器连接信息');

  // 允许粘贴 SSH 连接命令自动解析
  const { sshString } = await inquirer.prompt([{
    type: 'input',
    name: 'sshString',
    message: '（可选）粘贴 SSH 连接命令自动填充，或直接回车手动填写：',
    default: '',
  }]);

  let sshDefaults = { host: '', port: '22', user: 'root' };
  if (sshString.trim()) {
    // 支持：ssh user@host -p port  /  user@host  /  host
    const m = sshString.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([\w][\w.-]*)(?:\s+-p\s+(\d+))?/i);
    if (m && m[2]) {
      sshDefaults = { host: m[2], port: m[3] || '22', user: m[1] || 'root' };
      console.log(chalk.gray(`  解析结果 → 用户: ${chalk.white(sshDefaults.user)}  主机: ${chalk.white(sshDefaults.host)}  端口: ${chalk.white(sshDefaults.port)}\n`));
    } else {
      console.log(chalk.yellow('  无法解析该格式，请手动填写。\n'));
    }
  }

  const serverAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'host',
      message: '服务器地址（IP 或域名）：',
      default: sshDefaults.host || undefined,
      validate: (v) => v.trim() ? true : '请输入服务器地址',
    },
    {
      type: 'input',
      name: 'port',
      message: 'SSH 端口：',
      default: sshDefaults.port,
    },
    {
      type: 'input',
      name: 'user',
      message: '登录用户名：',
      default: sshDefaults.user,
    },
    {
      type: 'list',
      name: 'authType',
      message: '登录方式（上下键选择）：',
      default: sshDefaults.user !== 'root' ? 'password' : 'key',
      choices: [
        {
          name: '密码',
          value: 'password',
          description: '输入用户名对应的登录密码（云平台如 Featurize、AutoDL、阿里云等通常用这种）',
        },
        {
          name: 'SSH 密钥',
          value: 'key',
          description: '使用本地 ~/.ssh/id_rsa 等私钥文件（自建 VPS 且已配置密钥登录时选这种）',
        },
      ],
    },
    {
      type: 'input',
      name: 'keyPath',
      message: 'SSH 密钥路径：',
      default: path.join(os.homedir(), '.ssh', 'id_rsa'),
      when: (a) => a.authType === 'key',
    },
    {
      type: 'password',
      name: 'password',
      message: '服务器密码：',
      when: (a) => a.authType === 'password',
      mask: '*',
    },
  ]);

  // 测试连接
  const spinner = ora('正在连接服务器...').start();
  let ssh;
  try {
    ssh = await connectSSH(serverAnswers);
    spinner.succeed(chalk.green('服务器连接成功！'));
  } catch (err) {
    spinner.fail(chalk.red('连接失败：' + err.message));
    const port = serverAnswers.port || 22;
    console.log(chalk.yellow('\n排查建议：'));
    if (err.code === 'ECONNREFUSED') {
      console.log(`  • 端口 ${port} 拒绝连接——确认 SSH 服务正在运行且监听该端口`);
      console.log('  • 检查服务器防火墙/安全组是否放行该端口');
      console.log('  • 如果是云平台（Featurize / AutoDL 等），确认实例正在运行');
    } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') {
      console.log(`  • 连接超时——服务器或防火墙未响应端口 ${port}`);
      console.log('  • 确认安全组/iptables 已放行该端口的入站流量');
    } else {
      console.log(`  • 检查服务器地址（${serverAnswers.host}）和端口（${port}）是否正确`);
      console.log('  • 确认服务器防火墙已放行 SSH 端口');
    }
    if (serverAnswers.authType === 'key') {
      console.log('  • 密钥登录：确认密钥路径正确且权限为 600（chmod 600 ~/.ssh/id_rsa）');
    }
    return;
  }

  // ── Step 2: 项目信息 ──────────────────────────────────────────
  step(2, 5, '项目信息');

  const detectedType = detectProjectType();
  info(`自动检测到项目类型：${PROJECT_TYPE_LABELS[detectedType]}`);

  // 第一步：确认类型和应用名
  const typeAnswers = await inquirer.prompt([
    {
      type: 'list',
      name: 'projectType',
      message: '确认项目类型：',
      default: detectedType,
      choices: Object.entries(PROJECT_TYPE_LABELS).map(([value, name]) => ({ name, value })),
    },
    {
      type: 'input',
      name: 'appName',
      message: '应用名称（用于进程管理）：',
      default: path.basename(process.cwd()),
      validate: (v) => /^[a-z0-9_-]+$/i.test(v) ? true : '只能包含字母、数字、下划线和连字符',
    },
  ]);

  const { projectType, appName } = typeAnswers;

  // 根据确认的类型做二次检测，结果全部展示给用户
  let detectedNodeVer = null;
  let detectedNodeCmd = null;
  let detectedPyFramework = null;
  let detectedPyVersion = null;
  let detectedPyEnvManager = null;
  let detectedDockerInfo = null;

  if (projectType === 'nodejs') {
    detectedNodeVer = detectNodeVersion();
    detectedNodeCmd = getNodeStartCommand();

    if (detectedNodeVer) {
      info(`检测到 Node.js 版本要求：v${detectedNodeVer.version}（来源：${detectedNodeVer.source}）`);
    } else {
      info('未检测到 Node.js 版本要求（.nvmrc / engines.node），将默认使用 Node.js 20 LTS');
    }
    info(`检测到启动命令：${detectedNodeCmd.cmd}（来源：${detectedNodeCmd.source}）`);
  }

  if (projectType === 'python') {
    detectedPyFramework = detectPythonFramework();
    detectedPyVersion = detectPythonVersion();
    detectedPyEnvManager = detectPythonEnvManager();

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
      info('检测到 pip 环境（requirements.txt ✓）');
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
      info(`检测到 Python 框架：${PYTHON_FRAMEWORK_LABELS[detectedPyFramework]}（来源：requirements.txt）`);
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
  const detailAnswers = await inquirer.prompt([
    {
      type: 'input',
      name: 'remotePath',
      message: '部署到服务器的路径：',
      default: `/var/www/${appName}`,
      validate: (v) => {
        const t = v.trim();
        if (!t.startsWith('/')) return '请输入绝对路径（以 / 开头）';
        if (/[^a-zA-Z0-9._/-]/.test(t)) return '路径只能包含字母、数字和 . _ - / 字符';
        return true;
      },
    },
    {
      type: 'input',
      name: 'staticDir',
      message: '站点根目录（构建产物所在子目录，如 dist / build；留空表示项目根目录）：',
      default: '',
      when: () => projectType === 'static',
      validate: (v) => /^[a-zA-Z0-9._/-]*$/.test(v.trim()) ? true : '只能包含字母、数字和 . _ - / 字符',
    },
    {
      type: 'input',
      name: 'nodeVersion',
      message: '确认 Node.js 版本（主版本号，如 18 / 20 / 22）：',
      default: detectedNodeVer?.version || '20',
      when: () => projectType === 'nodejs',
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
    },
    {
      type: 'list',
      name: 'pythonEnvManager',
      message: '确认依赖管理方式：',
      default: detectedPyEnvManager || 'pip',
      choices: [
        { name: 'pip + venv（从 requirements.txt 安装）', value: 'pip' },
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
        if (projectType === 'docker') return detectedDockerInfo?.dockerPort?.port || '8080';
        if (projectType === 'python') return '8000';
        return '3000';
      },
      when: (a) => ['nodejs', 'python', 'docker'].includes(projectType) && (a.appMode ?? 'web') === 'web',
    },
    {
      type: 'input',
      name: 'composeFile',
      message: 'docker-compose 文件名（留空则使用单容器模式）：',
      default: detectedDockerInfo?.composeFile || '',
      when: () => projectType === 'docker',
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
      validate: (v) => /^(\S+\s+){4}\S+$/.test(v.trim()) ? true : '格式：分 时 日 月 周，如 0 2 * * *（每天凌晨 2 点）',
      when: (a) => a.appMode === 'cron' && a.cronPreset === 'custom',
    },
  ]);

  const projectAnswers = { ...typeAnswers, ...detailAnswers };

  // 确定应用模式与步骤总数
  const appMode = projectType === 'static' ? 'web' : (detailAnswers.appMode || 'web');
  const cronSchedule = detailAnswers.appMode === 'cron'
    ? (detailAnswers.cronPreset === 'custom' ? detailAnswers.cronSchedule : detailAnswers.cronPreset)
    : null;
  const isWebService = appMode === 'web';
  const totalSteps = isWebService ? 5 : 4;

  // ── Step 3: 域名 & HTTPS（仅 web 服务需要）────────────────────
  let domainAnswers = {};
  if (isWebService) {
    step(3, totalSteps, '域名 & HTTPS（可选）');
    domainAnswers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'useDomain',
        message: '是否配置域名？（没有域名用 IP 也可以）',
        default: true,
      },
      {
        type: 'input',
        name: 'domain',
        message: '你的域名（如 example.com）：',
        when: (a) => a.useDomain,
        validate: (v) => {
          const t = v.trim();
          if (!t) return '请输入域名';
          if (!/^[a-zA-Z0-9.-]+$/.test(t)) return '域名只能包含字母、数字、点和连字符';
          return true;
        },
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
      },
    ]);
  } else {
    const modeLabel = appMode === 'cron' ? '定时任务' : '后台脚本';
    info(`跳过域名配置（${modeLabel}无需 Nginx 反向代理）`);
  }

  const config = {
    ...serverAnswers,
    ...projectAnswers,
    ...domainAnswers,
    appMode,
    cronSchedule,
    domain: domainAnswers.domain || serverAnswers.host,
    deployedAt: new Date().toISOString(),
  };

  // ── Step 4: 安装环境 ──────────────────────────────────────────
  step(isWebService ? 4 : 3, totalSteps, '在服务器上安装运行环境');
  console.log(chalk.gray('  首次部署需要安装依赖，大约需要 2-5 分钟...\n'));

  try {
    await runRemote(ssh, `mkdir -p ${config.remotePath}`, '创建部署目录');

    const setupSteps = getSetupCommands(config);
    for (const s of setupSteps) {
      const sp = ora(`  ${s.label}...`).start();
      try {
        await runRemoteStrict(ssh, s.cmd);
        sp.succeed(chalk.green(s.label));
      } catch (err) {
        // 安装步骤失败提示但继续（多数是"已安装"或网络抖动）
        sp.warn(chalk.yellow(`${s.label} 失败：${err.message.split('\n')[0].slice(0, 80)}`));
      }
    }
  } catch (err) {
    console.log(chalk.red('\n环境安装失败：' + err.message));
    ssh.dispose();
    return;
  }

  // ── Step 5: 上传代码 & 启动 ──────────────────────────────────
  step(isWebService ? 5 : 4, totalSteps, '上传代码并启动服务');

  try {
    // 上传代码（static 项目需要 dist 目录）
    const uploadSpinner = ora('  上传项目文件...').start();
    const skipPatterns = config.projectType === 'static'
      ? ['node_modules', '.git', '__pycache__', '.DS_Store', '.venv', 'venv']
      : undefined;
    await uploadDirectory(ssh, process.cwd(), config.remotePath, {
      uploadEnv: !!config.uploadEnv,
      skipPatterns,
    });
    uploadSpinner.succeed('项目文件上传完成');
    if (config.projectType === 'docker' && !config.uploadEnv && detectedDockerInfo?.localEnvExists) {
      console.log(chalk.yellow('  ℹ .env 未上传，如需环境变量可在服务器手动创建：') + chalk.gray(` ${config.remotePath}/.env`));
    }

    // 启动应用（每一步都必须成功，失败立即抛错）
    const startSteps = getStartCommands(config);
    for (const s of startSteps) {
      const sp = ora(`  ${s.label}...`).start();
      try {
        await runRemoteStrict(ssh, s.cmd);
        sp.succeed(s.label);
      } catch (err) {
        sp.fail(chalk.red(`${s.label} 失败`));
        throw err;
      }
    }

    // Nginx 只在 web 模式下配置
    if (isWebService) {
      const nginxConf = getNginxConfig(config);
      const nginxPath = `/etc/nginx/sites-available/${config.appName}`;
      await runRemoteStrict(ssh, writeFileHeredoc(nginxPath, nginxConf));
      await runRemoteStrict(ssh, `ln -sf ${nginxPath} /etc/nginx/sites-enabled/${config.appName}`);
      await runRemoteStrict(ssh, `rm -f /etc/nginx/sites-enabled/default`);
      await runRemoteStrict(ssh, `nginx -t && systemctl reload nginx`);
      success('Nginx 配置完成');

      if (domainAnswers.useHttps && domainAnswers.domain) {
        const httpsSpinner = ora('  申请 SSL 证书...').start();
        const emailArg = domainAnswers.certEmail && domainAnswers.certEmail.trim()
          ? `--email ${domainAnswers.certEmail.trim()}`
          : '--register-unsafely-without-email';
        const certResult = await runRemoteSilent(
          ssh,
          `certbot --nginx -d ${config.domain} --non-interactive --agree-tos ${emailArg} --redirect`
        );
        if (certResult.code === 0) {
          httpsSpinner.succeed('HTTPS 证书申请成功');
        } else {
          const tail = (certResult.stderr || certResult.stdout || '').split('\n').slice(-3).join(' ');
          httpsSpinner.warn(`HTTPS 申请失败（可能是域名还没解析）：${tail.slice(0, 120)}`);
        }
      }
    }

    // ── 健康检查 ─────────────────────────────────────────────
    const health = getHealthCheck(config);
    if (health) {
      const hSpinner = ora('  验证服务运行状态...').start();
      // 给服务 2 秒启动时间
      await runRemoteSilent(ssh, 'sleep 2');
      const result = await runRemoteSilent(ssh, health.cmd);
      const parsed = health.parse(result);
      if (parsed.ok) {
        hSpinner.succeed(chalk.green(`服务运行正常 — ${parsed.detail}`));
      } else {
        hSpinner.warn(chalk.yellow(`健康检查未通过 — ${parsed.detail}`));
        console.log(chalk.gray(`  可运行 ${chalk.cyan('deploy-helper status')} 进一步排查。`));
      }
    }

  } catch (err) {
    console.log(chalk.red('\n部署失败：' + err.message));
    ssh.dispose();
    return;
  }

  // 保存配置
  saveConfig(config);
  ssh.dispose();

  // 完成！
  console.log(chalk.green.bold('\n🎉 部署成功！\n'));

  if (isWebService) {
    const accessUrl = domainAnswers.useHttps && domainAnswers.domain
      ? `https://${config.domain}`
      : domainAnswers.domain
        ? `http://${config.domain}`
        : `http://${config.host}:${config.port || 80}`;
    console.log(`  访问地址：${chalk.cyan.underline(accessUrl)}`);
  } else if (appMode === 'cron') {
    console.log(`  定时计划：${chalk.cyan(config.cronSchedule)}`);
    console.log(`  日志查看：${chalk.cyan(`tail -f /var/log/${config.appName}.log`)}`);
    console.log(`  修改计划：${chalk.gray('crontab -e')}`);
  } else {
    console.log(`  进程状态：${chalk.cyan(`supervisorctl status ${config.appName}`)}`);
    console.log(`  输出日志：${chalk.cyan(`tail -f /var/log/${config.appName}.out.log`)}`);
    console.log(`  错误日志：${chalk.cyan(`tail -f /var/log/${config.appName}.err.log`)}`);
  }

  console.log(`  配置已保存至：${chalk.gray('.deploy-config.json')}`);
  console.log('\n后续操作：');
  console.log(`  更新代码 → ${chalk.cyan('deploy-helper update')}`);
  console.log(`  查看状态 → ${chalk.cyan('deploy-helper status')}\n`);
}
