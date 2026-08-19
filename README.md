# deploy-helper

> Deploy your project to any VPS by answering a few questions.

No need to know Nginx, PM2, Certbot, or supervisor — deploy-helper handles server configuration, process management, HTTPS certificates, and code updates for you.

[中文文档](#中文文档)

---

## Quick Start

```bash
npx @zhengyizhao/deploy-helper init
```

Or install globally:

```bash
npm i -g @zhengyizhao/deploy-helper
deploy-helper init
```

Project website source is in `website/`. Contributors can preview it locally with `npm run site:preview` and open `http://127.0.0.1:4173`.

---

## How It Works

Before the wizard begins, deploy-helper identifies Windows, macOS, or Linux, then checks Git and SSH with platform-specific installation guidance. An optional passwordless SSH step is offered before deployment.

**Web service** (7 guided stages):

```
[1/7] Connect server        → Enter IP, SSH port, user and password/key
[2/7] Confirm project       → Detect type, runtime, application port and start command
[3/7] Source & environment  → Upload or Git pull; answer .env.example variables one by one
[4/7] Domain & HTTPS        → Optional; no domain skips Nginx and certificates
[5/7] Install server env    → Git, Docker/Compose, runtime and optional web tools
[6/7] Build & start         → Install dependencies, build images and start services
[7/7] Configure & verify    → Optional Nginx/HTTPS, process check and HTTP check
```

Every executable stage asks for confirmation. Correctable errors can return to the previous input, temporary network failures can retry, and failed automatic installs show manual repair commands. Progress is written after each stage to `.deploy-progress.json`; passwords, tokens and environment values are excluded. Ctrl+C, `exit`, terminal closure and power loss can therefore resume from the last saved stage.

**Background scripts / cron jobs** use the same flow; domain, Nginx and HTTPS are explicitly skipped.

After deployment:

```
🎉 Deployment successful!

  # Web service
  URL: https://example.com

  # Cron job
  Schedule:  0 2 * * *
  Logs:      tail -f /var/log/myapp.log

  # Background script
  Status:    supervisorctl status myapp
  Stdout:    tail -f /var/log/myapp.out.log
```

---

## Commands

| Command | Description |
|---------|-------------|
| `deploy-helper init` | First-time deployment, fully guided |
| `deploy-helper update` | Push latest code and restart (supports multiple servers) |
| `deploy-helper status` | View process status, memory usage, recent logs |
| `deploy-helper rollback` | Roll back to a previous snapshot |
| `deploy-helper env` | Upload / pull / diff `.env` files |
| `deploy-helper backup` | Database backup (MySQL / PostgreSQL / MongoDB) |
| `deploy-helper servers` | Manage multiple servers |

---

## Run Modes

Choose one during `init`. This determines process management and whether Nginx is configured:

| Mode | Use case | Process manager | Nginx |
|------|----------|----------------|-------|
| **Web service** | API, website, Next.js | PM2 / supervisor (auto-restart) | ✓ Reverse proxy |
| **Background script** | Crawler, queue consumer, long-running task | PM2 / supervisor (restart on crash only) | ✗ |
| **Cron job** | Scheduled sync, periodic cleanup | System crontab | ✗ |

---

## Supported Project Types

### Node.js

Auto-detects: `.nvmrc` / `.node-version` / `package.json engines.node` → Node.js version; `package.json scripts.start` / common entry files → start command.

- Process manager: **PM2** (auto-restart, starts on boot)
- Uses npm-aware startup commands, so local binaries such as Next.js and Nuxt resolve correctly
- Runs `npm run build` when detected, then prunes build-only dependencies
- **Script mode**: PM2 restarts crashes but does not restart a process that exits cleanly
- **Cron mode**: writes to crontab, logs to `/var/log/<appname>.log`

### Python

Auto-detects: `.python-version` / `pyproject.toml` → Python version; `requirements.txt` / `pyproject.toml` → framework (FastAPI / Django / Flask) → recommended start command; `environment.yml` / `conda-lock.yml` → conda mode.

Process manager: **supervisor** (auto-restart, starts on boot, logs to `/var/log/<appname>.out.log` + `.err.log`)

**pip mode** (has `requirements.txt` or `pyproject.toml`)
- Installs Python automatically if missing (deadsnakes PPA, supports 3.8–3.13), skips if already installed
- Creates a virtualenv and installs from `requirements.txt` or the local `pyproject.toml` project
- FastAPI → uvicorn; Django / Flask → gunicorn
- **Script mode**: supervisor `autorestart=unexpected` — only restarts on crash, not on clean exit
- **Cron mode**: writes to crontab, runs using the venv Python

**conda mode** (has `environment.yml`)
- Installs Miniconda to `/opt/miniconda3` automatically, skips if already present
- Creates the conda environment from `environment.yml` (`conda env create -n <appname>`); on re-deploy, runs `--prune` for incremental updates
- Start command runs via `conda run -n <appname> --no-capture-output` — no `conda activate` needed

**Generate environment.yml locally**

```bash
conda activate <your-env-name>
conda env export > environment.yml
```

> If your environment includes CUDA / cudatoolkit or other system-level packages, use Docker instead (see below) to avoid GPU driver version mismatches.

### Docker

Works for **everything** deploy-helper doesn't natively support: Java, Go, Rust, C++, CUDA, multi-service orchestration… As long as you have a Dockerfile, the deployment is language-agnostic.

Auto-detects:
- `Dockerfile` — noted if present, guided if missing
- `docker-compose.yml` / `docker-compose.yaml` / `compose.yml` / `compose.yaml` — used automatically
- `EXPOSE` in Dockerfile or `ports` in compose file — reads the host port

Two deploy modes:

| Mode | Condition | Command |
|------|-----------|---------|
| Compose mode | compose file detected | `docker compose -f <file> up -d --build --remove-orphans` |
| Single-container mode | Dockerfile only | `docker build` + `docker run --restart unless-stopped` |

**Docker install**: the tool checks `command -v docker` first and skips installation if Docker is already present. Many cloud provider images ship with Docker pre-installed.

**.env files**: not uploaded by default (may contain secrets). If a local `.env` is detected, you'll be asked whether to upload it; if you decline, the tool shows the server path where you can create it manually.

### Static Sites

Plain HTML / CSS / JS, served directly by Nginx. For Vite/React-style projects, the detected build command runs on the server and the output directory is verified before Nginx reloads. Gzip and SPA fallback routing are configured automatically.

---

## Other Languages

> Java, C++, Go, Rust, CUDA, R…

Recommended path: write a Dockerfile to package your runtime environment, then choose the Docker type. deploy-helper doesn't need to know your language — it just runs the container. When you select `Other`, the tool prints these starter templates:

**Python + conda / CUDA**
```dockerfile
FROM continuumio/miniconda3
WORKDIR /app
COPY environment.yml .
RUN conda env create -f environment.yml -n myenv
COPY . .
CMD ["conda", "run", "-n", "myenv", "--no-capture-output", "python", "main.py"]
```

**Java (Maven + JDK 21)**
```dockerfile
FROM maven:3.9-eclipse-temurin-21-alpine AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:resolve -q
COPY src ./src
RUN mvn package -DskipTests -q
FROM eclipse-temurin:21-jre-alpine
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
CMD ["java", "-jar", "app.jar"]
```

**Go**
```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o main .
FROM alpine:latest
COPY --from=build /app/main .
EXPOSE 8080
CMD ["./main"]
```

Dockerfile reference: https://docs.docker.com/get-started/

---

## update

```bash
deploy-helper update
```

- Creates a code snapshot before deploying and mirrors local source, removing stale remote files while preserving `.env` and dependency directories
- Reuses init's startup logic: appMode / conda / composeFile all respected
- Process and HTTP checks after restart; a failed check makes the deployment fail instead of reporting success
- Multi-server support: parallel, serial, or rolling strategies

---

## rollback

```bash
deploy-helper rollback
```

Every `update` creates a snapshot automatically (last 5 kept). Rolling back:

1. Backs up the current version without pruning the snapshot selected for restore
2. Stops the service
3. Restores code via rsync (preserves `venv/` / `node_modules/`, only replaces code)
4. Restarts the service + health check

---

## env

```bash
deploy-helper env
```

- **Push**: local `.env` → server (backs up the old one first, sets permissions to 600, restarts service)
- **Pull**: server `.env` → local
- **Diff**: shows key-level differences (added / missing / changed values)

---

## backup

```bash
deploy-helper backup
```

Supports MySQL, PostgreSQL, and MongoDB:

- Immediate backup (dump + gzip)
- List / download previous backups (last 10 kept)
- Scheduled automatic backups (crontab)

**Security**: database credentials for scheduled backups are stored in `/etc/deploy-helper/<appname>.creds` (chmod 600, owned by root). The backup script itself is chmod 700 — passwords are never exposed in world-readable locations.

---

## Requirements

**Local machine**
- Node.js 20.12+

**Server**
- Ubuntu 20.04 / 22.04 / 24.04
- Root access or sudo
- Ports open: 22 (SSH), 80 (HTTP), 443 (HTTPS if needed)

**Nothing needs to be pre-installed on the server** — Nginx, Node.js, Python, Docker, PM2, supervisor, and certbot are all installed on demand, and skipped if already present.

---

## Config File

After the first deployment, `.deploy-config.json` is written to your project root. It stores server addresses, deploy paths, and commands, but strips SSH and database passwords before writing. The tool adds it to `.gitignore`; it still contains infrastructure details and should not be committed.

---

## License

MIT

---

# 中文文档

> 把项目部署到任意 VPS，回答几个问题就够了。

不需要懂 Nginx、PM2、Certbot、supervisor——工具替你搞定服务器配置、进程管理、HTTPS 证书、代码更新。

[English Documentation](#deploy-helper)

---

## 快速开始

```bash
npx @zhengyizhao/deploy-helper init
```

或全局安装后使用：

```bash
npm i -g @zhengyizhao/deploy-helper
deploy-helper init
```

---

## 工作流程

向导开始前会先识别 Windows、macOS 或 Linux，再检查 Git 与 SSH，并给出对应系统的安装方法。正式部署前还会询问是否配置 SSH 免密登录。

**Web 服务**（7 个引导阶段）：

```
[1/7] 连接服务器          → 填写 IP、SSH 端口、用户和密码/密钥
[2/7] 确认项目            → 检测类型、运行环境、应用端口和启动命令
[3/7] 代码与环境变量      → 选择本地上传或 Git 拉取，逐个填写模板变量
[4/7] 域名与 HTTPS        → 完全可选；没有域名便跳过 Nginx 和证书
[5/7] 安装服务器环境      → Git、Docker/Compose、运行环境和可选 Web 工具
[6/7] 构建并启动          → 安装依赖、构建镜像、启动服务
[7/7] 配置并验证          → 可选 Nginx/HTTPS、进程检查和网页检查
```

每个实际执行步骤都会先征得同意。可修改的错误能返回上一步，网络问题能重试，自动安装失败会显示手动修复命令。每一阶段结束后，非敏感进度会写入 `.deploy-progress.json`，密码、令牌和环境变量值不会写入。按 Ctrl+C、输入 `exit`、关闭终端或意外断电后，下次运行都可以从最近保存的位置继续。

**后台脚本 / 定时任务**使用同一流程，并明确跳过域名、Nginx 和 HTTPS。

完成后：

```
🎉 部署成功！

  # Web 服务
  访问地址：https://example.com

  # 定时任务
  定时计划：0 2 * * *
  日志查看：tail -f /var/log/myapp.log

  # 后台脚本
  进程状态：supervisorctl status myapp
  输出日志：tail -f /var/log/myapp.out.log
```

---

## 命令

| 命令 | 说明 |
|------|------|
| `deploy-helper init` | 首次部署，全程引导 |
| `deploy-helper update` | 推送最新代码并重启（支持多服务器） |
| `deploy-helper status` | 查看进程状态、内存、最近日志 |
| `deploy-helper rollback` | 从历史快照中选择一个版本回滚 |
| `deploy-helper env` | 上传 / 拉取 / 对比 .env 文件 |
| `deploy-helper backup` | 数据库备份（MySQL / PostgreSQL / MongoDB） |
| `deploy-helper servers` | 管理多台服务器 |

---

## 应用运行方式

init 时选择三种模式之一，影响进程管理和是否配置 Nginx：

| 模式 | 适用场景 | 进程管理 | Nginx |
|------|---------|---------|-------|
| **Web 服务** | API、网站、Next.js | PM2 / supervisor（自动重启） | ✓ 反向代理 |
| **后台脚本** | 爬虫、消息消费、长任务 | PM2 / supervisor（崩溃才重启） | ✗ |
| **定时任务** | 数据同步、定期清理 | 系统 crontab | ✗ |

---

## 支持的项目类型

### Node.js

自动检测：`.nvmrc` / `.node-version` / `package.json engines.node` → Node.js 版本；`package.json scripts.start` / 常见入口文件 → 启动命令。

- 进程管理：**PM2**（自动重启、开机自启）
- 使用 npm 感知的启动命令，Next.js / Nuxt 等本地二进制可以正确解析
- 检测到构建脚本时自动执行 `npm run build`，之后裁剪仅构建期依赖
- **后台脚本模式**：PM2 在异常退出时重启，进程正常退出后不重启
- **定时任务模式**：写入 crontab，日志写入 `/var/log/<appname>.log`

### Python

自动检测：`.python-version` / `pyproject.toml` → Python 版本；`requirements.txt` / `pyproject.toml` → 框架（FastAPI / Django / Flask）→ 推荐启动命令；`environment.yml` / `conda-lock.yml` → conda 模式。

进程管理：**supervisor**（自动重启、开机自启、日志写入 `/var/log/<appname>.out.log` + `.err.log`）

**pip 模式**（有 `requirements.txt` 或 `pyproject.toml`）
- 服务器无 Python 时自动安装（deadsnakes PPA，支持 3.8–3.13），已有则跳过
- 自动创建 virtualenv，并从 `requirements.txt` 或本地 `pyproject.toml` 项目安装依赖
- FastAPI → uvicorn；Django / Flask → gunicorn
- **后台脚本模式**：supervisor `autorestart=unexpected`（只有崩溃才重启，正常退出不重启）
- **定时任务模式**：写入 crontab，用 venv 内的 Python 执行

**conda 模式**（有 `environment.yml`）
- 服务器自动安装 Miniconda 到 `/opt/miniconda3`，已有则跳过
- 从 `environment.yml` 创建 conda 环境（`conda env create -n <appname>`），二次部署时 `--prune` 增量更新
- 启动命令通过 `conda run -n <appname> --no-capture-output` 执行，无需 `conda activate`

**本地生成 environment.yml**

```bash
conda activate <你的环境名>
conda env export > environment.yml
```

> 如果环境包含 CUDA / cudatoolkit 等系统级包，建议改用 Docker 方案（见下文），避免服务器 GPU 驱动版本不一致。

### Docker

适合**所有** deploy-helper 原生不支持的场景：Java、Go、Rust、C++、CUDA、conda 环境、多服务编排……只要你有 Dockerfile，部署流程就与语言无关。

自动检测：
- `Dockerfile` — 存在则提示，不存在时给出引导
- `docker-compose.yml` / `docker-compose.yaml` / `compose.yml` / `compose.yaml` — 自动选用
- Dockerfile `EXPOSE` 或 compose `ports` — 读取宿主机端口

两种部署模式：

| 模式 | 条件 | 命令 |
|------|------|------|
| Compose 模式 | 检测到 compose 文件 | `docker compose -f <file> up -d --build --remove-orphans` |
| 单容器模式 | 仅有 Dockerfile | `docker build` + `docker run --restart unless-stopped` |

**Docker 是否需要安装**：工具先检查服务器是否已有 Docker（`command -v docker`），已有则跳过安装步骤。许多云服务商镜像预装了 Docker，无需重复安装。

**.env 文件**：默认不上传（含敏感信息）。检测到本地 `.env` 时会询问是否上传；选择不上传时，工具会告知在服务器手动创建的路径。

### 静态网站

纯 HTML / CSS / JS 直接由 Nginx 托管。Vite/React 等项目会在服务器执行检测到的构建命令，并在重载 Nginx 前验证构建目录和 `index.html`，同时自动配置 gzip 和 SPA 回退路由。

---

## 对于不在列表里的语言

> Java、C++、Go、Rust、CUDA、R……

推荐路线：写 Dockerfile 把运行环境封装进镜像，然后选 Docker 类型。deploy-helper 不需要了解你的语言细节，只负责把容器跑起来。选择 `其他` 类型时，工具会在终端直接展示以下模板：

**Python + conda / CUDA**
```dockerfile
FROM continuumio/miniconda3
WORKDIR /app
COPY environment.yml .
RUN conda env create -f environment.yml -n myenv
COPY . .
CMD ["conda", "run", "-n", "myenv", "--no-capture-output", "python", "main.py"]
```

**Java（Maven + JDK 21）**
```dockerfile
FROM maven:3.9-eclipse-temurin-21-alpine AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:resolve -q
COPY src ./src
RUN mvn package -DskipTests -q
FROM eclipse-temurin:21-jre-alpine
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
CMD ["java", "-jar", "app.jar"]
```

**Go**
```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o main .
FROM alpine:latest
COPY --from=build /app/main .
EXPOSE 8080
CMD ["./main"]
```

Dockerfile 入门：https://docs.docker.com/get-started/

---

## update — 代码更新

```bash
deploy-helper update
```

- 部署前自动创建代码快照，并镜像同步本地源码；删除远端陈旧文件，但保留 `.env` 和依赖目录
- 复用 init 的启动逻辑，appMode / conda / composeFile 全部生效
- 重启后同时检查进程和 HTTP；检查失败会判定部署失败，不再显示假成功
- 支持多台服务器：并行 / 串行 / 滚动三种策略

---

## rollback — 版本回滚

```bash
deploy-helper rollback
```

每次 `update` 前自动创建快照，保留最近 5 个版本。回滚时：

1. 备份当前版本，且不会在此时裁剪用户选中的待恢复快照
2. 停止服务
3. 用 rsync 还原代码（保留 `venv/` / `node_modules/`，只换代码）
4. 重启服务 + 健康检查

---

## env — 环境变量管理

```bash
deploy-helper env
```

- **上传**：本地 `.env` → 服务器（先备份旧 `.env`，权限自动设为 600，上传后重启服务）
- **拉取**：服务器 `.env` → 本地
- **对比**：显示本地和服务器的 key 差异（新增 / 缺失 / 值不同）

---

## backup — 数据库备份

```bash
deploy-helper backup
```

支持 MySQL / PostgreSQL / MongoDB，功能：

- 立即备份（导出 + gzip 压缩）
- 查看 / 下载历史备份（保留最近 10 个）
- 配置定时自动备份（写入 crontab）

**安全设计**：定时脚本的数据库密码存放在 `/etc/deploy-helper/<appname>.creds`（chmod 600，root 所有），脚本本身 chmod 700，不在可读位置明文暴露密码。

---

## 前提条件

**本地**
- Node.js 20.12+

**服务器**
- Ubuntu 20.04 / 22.04 / 24.04
- root 权限或可 sudo
- 开放 22（SSH）、80（HTTP）、443（HTTPS，如需 HTTPS）端口

**不需要**提前在服务器安装任何东西——Nginx、Node.js、Python、Docker、PM2、supervisor、certbot，工具按需安装，已装的跳过。

---

## 配置文件

首次部署后，项目根目录生成 `.deploy-config.json`，记录服务器地址、部署路径和命令等；SSH 与数据库密码会在写入前剥离。工具会自动将其加入 `.gitignore`，因为其中仍包含基础设施信息，请勿提交到 git。

---

## License

MIT
