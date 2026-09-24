# SillyTavern + SillyTavernchat (STC-MOD)

LLM Frontend for Power Users  
本仓库当前基于 **SillyTavern 1.19.0 官方版本**（2026-09-15 已同步），在其上通过「外挂模块 / Sidecar Module」方式集成
`SillyTavernchat (STC-MOD)` 的管理与运营功能，同时尽量保持对上游的 **低侵入、易升级**。详细二开边界、上游基线与升级记录见
[MODIFICATIONS.md](MODIFICATIONS.md)。本仓库派生自 [zhaiiker/SillyTavernMOD](https://github.com/zhaiiker/SillyTavernMOD)。

---

## 目录

- [项目概览](#项目概览)
- [部署使用教程](#部署使用教程)
  - [1. 选择部署方式](#1-选择部署方式)
  - [2. 安装与启动](#2-安装与启动)
  - [3. 首次登录与安全设置](#3-首次登录与安全设置)
  - [4. 上线前配置清单](#4-上线前配置清单)
  - [5. STC 管理面板](#5-stc-管理面板)
  - [6. 日常运维](#6-日常运维)
  - [7. 常见问题](#7-常见问题)
  - [8. 从旧版本升级（必读）](#8-从旧版本升级必读)
- [用户数据存储到 S3（R2 / B2，JuiceFS）](#用户数据存储到-s3r2--b2juicefs)
- [QRole 会员登录与注册开关](#qrole-会员登录与注册开关)
- [页面背景与站点信息](#页面背景与站点信息)
- [反向代理部署（nginx / OpenResty / Cloudflare）](#反向代理部署nginx--openresty--cloudflare)
- [STC-MOD 功能概览](#stc-mod-功能概览)
- [升级与二次开发注意事项](#升级与二次开发注意事项)
- [修改记录 (MODIFICATIONS)](#修改记录-modifications)
- [上游资源与协议](#上游资源与协议)

---

## 项目概览

- 官方前端：保留原生 SillyTavern 体验（聊天、角色管理、扩展系统等）。
- Sidecar 模块：新增在 `src/stc-mod/` 目录下，所有二开逻辑集中于此：
  - 管理后台（STC 管理面板，作为 SillyTavern 扩展加载）。
  - 注册 / 欢迎 / 登录等页面的外挂实现。
  - 账户有效期、储存空间配额、签到扩容、邀请码注册与续期等后台逻辑。
- 对官方核心代码的修改仅限极少数钩子（主要在 `src/server-main.js`），具体见
  [MODIFICATIONS.md](MODIFICATIONS.md)。

本仓库既可当作「开箱即用的 SillyTavern + 站点运营套件」，也可作为后续跟进官方版本时的二开基线。

---

## 部署使用教程

> 本章面向站点运营者，按「选择方式 → 安装启动 → 首次登录 → 上线前检查 → 日常运维」的顺序编写。示例仓库地址为 `https://github.com/SakurajimMai/SillyTavernMOD`，默认端口为 `8000`。
>
> 默认分支 `release` 是维护分支，Docker Hub 镜像也由它构建；安装、更新都基于它进行（`git clone` 默认就是这个分支）。远端还有其他分支，但它们不用于部署，无需切换。

### 1. 选择部署方式

| 方式 | 适合 | 运行的代码 | 数据保存在 |
|------|------|------------|------------|
| **A. Docker 镜像**（最省事） | 不想安装 Node.js，只想尽快跑起来 | Docker Hub 上的 `sakurajiamai/sillytavernmod:latest`（见下方提示） | 你创建的目录，例如 `~/sillytavern/config`、`~/sillytavern/data` |
| **B. Docker Compose 从源码构建** | 需要 GitHub 仓库中的最新代码（Docker Hub 镜像可能滞后） | `git clone` 下来的源码，在本机构建镜像 | `SillyTavernMOD/docker/config`、`SillyTavernMOD/docker/data` |
| **C. 直接运行 Node.js（可配合 PM2）** | 不用 Docker，熟悉命令行 | `git clone` 下来的源码 | 项目根目录的 `config.yaml`、`data/` |
| **D. Docker + S3 存储** | 用户数据放到 Cloudflare R2 / Backblaze B2 等对象存储 | 同 A（加 `--build` 时同 B） | 存储桶 + 元数据库，见 [用户数据存储到 S3](#用户数据存储到-s3r2--b2juicefs) |

> **镜像版本提示（方式 A / D）**：Docker Hub 镜像由 GitHub Actions 在代码推送到 `release` 分支后自动构建（`linux/amd64` + `linux/arm64`，标签 `latest` 与 `release-<短 SHA>`，也可手动触发并附加标签；仓库维护者需先在 GitHub 仓库 Settings → Secrets and variables → Actions 中配置 `DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN`，未配置时跳过发布，详见 `.github/workflows/dockerhub-publish.yml` 顶部说明）。**本地或未推送的改动、构建失败的提交都不会出现在镜像中。**
>
> 较早构建的镜像可能不包含本文介绍的 QRole 会员登录、开放注册开关、`site` 站点外观、禁止无密码账号仅凭用户名登录等改动（在这样的镜像中，没有密码的普通账号仍可仅凭用户名登录，务必为所有账号设置密码）。用下面的命令检查：输出 `0` 表示镜像较旧，请改用方式 B / C，或等待新镜像。
>
> 该命令检查的是**本机**的 `sakurajiamai/sillytavernmod:latest`：本机还没有这个镜像时会先从 Docker Hub 拉取；做过方式 B（或方式 D 加了 `--build`）的机器上，它检查的是本地构建的镜像，不代表 Docker Hub 上的版本。

```bash
docker run --rm --entrypoint grep sakurajiamai/sillytavernmod:latest -c enableRegistration default/config.yaml
```

**环境要求**

| 项目 | 要求 |
|------|------|
| 操作系统 | 云服务器推荐 Linux（镜像支持 amd64 / arm64）；方式 C 也可在 Windows / macOS 上运行 |
| Node.js（仅方式 C） | `package.json` 要求 `>= 20`；直接运行请使用 **22.x LTS**（本文命令在 Node 22 上实测通过）。Node 20 已于 2026 年 4 月停止维护，不建议新装。Docker 镜像基于 `node:22-alpine`（Node 22 LTS）构建，自带 Node，无需另装 |
| Docker（方式 A / B / D） | Docker Engine 与 `docker compose` 插件；本文命令在 Docker 29.5、Compose v5.1 上实测通过 |
| Git（方式 B / C / D） | 用于获取和更新代码；方式 D 需要仓库中的 `docker-compose.s3.yml`、`docker/juicefs/` 等文件 |
| 磁盘 | 镜像约 0.9 GB；源码加依赖约 0.6 GB；另需存放用户数据 |
| 端口 | 直接访问需在防火墙 / 安全组放行 TCP `8000`；放在反向代理后只需放行 `80` / `443`，`8000` 只对本机开放 |

### 2. 安装与启动

#### A. Docker 镜像

1. 创建数据目录并启动容器（示例目录为 `~/sillytavern`，可自行更换）：

```bash
mkdir -p ~/sillytavern/{config,data,plugins,extensions}
cd ~/sillytavern
docker run -d \
  --name sillytavernmod \
  --restart unless-stopped \
  -p 8000:8000 \
  -v "$PWD/config:/home/node/app/config" \
  -v "$PWD/data:/home/node/app/data" \
  -v "$PWD/plugins:/home/node/app/plugins" \
  -v "$PWD/extensions:/home/node/app/public/scripts/extensions/third-party" \
  sakurajiamai/sillytavernmod:latest
```

2. 查看启动日志：`docker logs -f sillytavernmod`（按 `Ctrl+C` 只是退出查看，容器继续运行）。
3. 浏览器打开 `http://服务器IP:8000/`，继续 [第 3 步：首次登录](#3-首次登录与安全设置)。日志最后一行的 `Go to: http://127.0.0.1:8000/` 是容器内部地址，请以宿主机映射的端口为准。

挂载目录说明（容器内应用目录为 `/home/node/app`）：

| 宿主机目录 | 容器内路径 | 用途 |
|------------|------------|------|
| `config/` | `/home/node/app/config` | `config.yaml`：首次启动时自动从默认配置复制生成；容器内根目录的 `config.yaml` 是指向它的链接 |
| `data/` | `/home/node/app/data` | 全部用户数据：账号、聊天、角色卡、上传文件，以及 STC-MOD 数据（`data/stc-mod/`） |
| `plugins/` | `/home/node/app/plugins` | 服务端插件（可选） |
| `extensions/` | `/home/node/app/public/scripts/extensions/third-party` | 第三方前端扩展。容器**每次启动**时，若其中缺少 `stc-admin-panel/manifest.json`，就从镜像复制 **STC 管理面板**；已存在的不会被覆盖（更新方法见 [更新](#更新)） |

参数与注意事项：

- `-p 8000:8000`：左边是宿主机端口，可改成 `-p 8080:8000` 等。放在同一台机器的反向代理后面时改为 **`-p 127.0.0.1:8000:8000`**，只允许本机访问。
- 容器启动时总是带 `--listen` 参数，`config.yaml` 里的 `listen: false` 在 Docker 中不起作用，谁能访问只由 `-p` 决定。
- 每次启动都会执行 `npm run init`，自动补全 `config.yaml` 中缺失的配置项。
- `--restart unless-stopped`：Docker 或服务器重启后自动拉起容器（手动 `docker stop` 的除外）。
- `config` 与 `data` 不能对调。**不要**把宿主机目录挂载到整个 `/home/node/app/public`，否则会盖住镜像中构建好的前端文件，导致页面空白或版本不一致。
- 容器默认以 root 运行，宿主机上生成的文件属于 root。希望文件属于普通用户时，在 `docker run` 中加上 `-e PUID=1000 -e PGID=1000`（换成该用户 `id -u` / `id -g` 的结果），启动时会自动调整目录权限（日志 `Mode: PUID/PGID (UID:1000 GID:1000)`）。
- `docker run` 没有健康检查；方式 B / D 的 Compose 文件自带健康检查。

#### B. Docker Compose 从源码构建

```bash
git clone https://github.com/SakurajimMai/SillyTavernMOD.git
cd SillyTavernMOD/docker
docker compose up -d --build
docker compose logs -f sillytavern   # 按 Ctrl+C 只是退出查看，容器继续运行
```

- **一定要加 `--build`**：`docker/docker-compose.yml` 同时写了 `build: ..` 和 `image: sakurajiamai/sillytavernmod:latest`。不加 `--build` 时，本机没有该镜像就从 Docker Hub 拉取，本机已有就直接用已有的旧镜像；两种情况都**不会**使用你刚下载或更新的源码。
- 本地构建出的镜像同样叫 `sakurajiamai/sillytavernmod:latest`。方式 B 下不要执行 `docker compose pull` 或 `docker pull`，否则会换回 Docker Hub 版本（再执行一次 `docker compose up -d --build` 即可恢复）。
- 首次构建要下载 `node:22-alpine` 基础镜像和 npm 依赖并编译前端库，实测约 1 分钟起，视网络而定。
- 数据目录位于 `SillyTavernMOD/docker/` 下的 `config/`、`data/`、`plugins/`、`extensions/`，用途与方式 A 的挂载表相同。
- 容器名同样是 `sillytavernmod`、端口同样是 `8000`，**不要与方式 A 同时使用**。
- Compose 文件自带健康检查和心跳（`SILLYTAVERN_HEARTBEATINTERVAL=30`），`docker compose ps` 中应显示 `healthy`。
- 默认把 `8000` 端口发布到所有网卡。放在同一台机器的反向代理后面时，在 `docker/` 目录新建 `docker-compose.override.yml`（Compose 会自动合并同目录下的这个文件），然后再执行一次 `docker compose up -d --build`：

```yaml
services:
  sillytavern:
    ports: !override
      - "127.0.0.1:8000:8000"
```

必须写 `!override`（需要较新的 Compose，实测 v5.1 可用）：不写时新端口是**追加**的，`8000` 仍会对外开放。这个自动合并只对默认的 `docker-compose.yml` 生效，方式 D 用 `-f docker-compose.s3.yml` 时的写法见 [第 3 步第 6 条](#3-首次登录与安全设置)。

#### C. 直接运行 Node 与 PM2

前台运行（适合首次试用和排查问题）：

```bash
git clone https://github.com/SakurajimMai/SillyTavernMOD.git
cd SillyTavernMOD
./start.sh
```

- `start.sh` 会切换到项目目录，设置 `NODE_ENV=production`，安装生产依赖（`npm install --no-save --no-audit --no-fund --omit=dev --ignore-scripts` 等参数），然后执行 `node server.js`；额外参数会原样传给 `server.js`，例如 `./start.sh --port 8001`。
- 请用 `./start.sh` 或 `bash start.sh`，**不要用 `sh start.sh`**：它是 bash 脚本，在 Debian / Ubuntu 上用 `sh`（dash）运行会误报 `npm could not be found in PATH`。Windows 请双击 `Start.bat`（作用相同）。
- 首次运行要安装依赖并编译前端库，约 30 秒后页面才能打开；之后启动约 5 秒。
- 端口和监听地址来自 `config.yaml`，默认 `listen: true`、`listenAddress.ipv4: 0.0.0.0`、`port: 8000`，即**对所有网卡开放**。命令行可用 `--port`、`--listen`、`--listenAddressIPv4` 覆盖；**没有 `--host` 参数**（写了会被静默忽略）。也可以用环境变量覆盖官方配置项，例如 `SILLYTAVERN_PORT=8001 ./start.sh`。
- **不经 `start.sh` 启动时必须设置 `NODE_ENV=production`**（`start.sh`、`Start.bat` 和 Docker 已自动设置）：不设置时，出错的请求会在响应中返回代码堆栈和服务器上的文件路径。启动日志中以 `Node version:` 开头的一行应包含 `Running in production environment`，显示 `Running in undefined environment` 就是没设置。
- `npm run start` 等价于不带参数的 `node server.js`，不会安装依赖，也不会设置 `NODE_ENV`；使用时请写成 `NODE_ENV=production npm run start`。

后台常驻（PM2）：

```bash
npm install -g pm2
cd SillyTavernMOD
npm install --no-save --no-audit --no-fund --omit=dev --ignore-scripts   # 与 start.sh 相同；运行过 ./start.sh 可跳过
NODE_ENV=production pm2 start server.js --name sillytavern
pm2 save
pm2 startup
```

- **必须带 `NODE_ENV=production`**，原因见上文。PM2 会记住启动时的环境变量，之后 `pm2 restart` 和开机自启都会沿用。
- **必须在项目根目录执行 `pm2 start`**：官方代码按启动目录读取 `./config.yaml`，STC-MOD 始终读取项目目录下的 `config.yaml`，在其他目录启动会让两者读到不同的文件。
- 需要改端口时：`NODE_ENV=production pm2 start server.js --name sillytavern -- --port 8001`。
- `pm2 startup` 设置开机自启：以 root 运行时会直接安装开机自启服务；以普通用户运行时会打印一条 `sudo` 开头的命令，复制并执行它即可。
- 安装依赖时**不要**执行 `npm audit fix --force`：它会改动锁定的依赖版本，可能让程序无法运行。上面的命令带 `--no-audit`，不会输出安全审计提示。
- 放在同一台机器的反向代理后面时，把 `config.yaml` 中 `listenAddress` 下的 `ipv4` 改为 `127.0.0.1` 并重启，只监听本机；保持 `listen: true`，Basic Auth 才会继续生效（`listen: false` 也只监听本机，但会同时关闭 Basic Auth）。

#### 确认启动成功

首次启动会自动生成 `config.yaml`：方式 C 的日志出现 `Warning: config.yaml not found at ./config.yaml. Creating a new one with default values.`；Docker 的日志开头出现 `Resource not found, copying from defaults: config.yaml` 和 `STC-MOD: Seeding stc-admin-panel (...)`。随后应能看到以下几行（顺序可能略有不同）：

```text
Node version: v…. Running in production environment. Server directory: …
[STC-MOD] Default configuration values added to config.yaml
[STC-MOD] SillyTavernchat module loaded.
[STC-MOD] Storage quota enforcement middleware registered.
[STC-MOD] Public routes registered.
[STC-MOD] Public API routes registered.
[STC-MOD] System monitoring started
[STC-MOD] Private API routes registered.
A friendly reminder that the following users are not password protected:
default-user (admin)
SillyTavern is listening on IPv4: 0.0.0.0:8000
Go to: http://127.0.0.1:8000/ to open SillyTavern
```

- 出现 `[STC-MOD] Load error: ...` 说明 STC-MOD 模块加载失败，欢迎页、管理面板等功能不可用。
- `A friendly reminder ... not password protected` 下面列出**所有**没有密码的账号（不只是 `default-user`），为它们都设置密码后才不再出现（见第 3 步）。这条提醒只在 `listen: true` 时打印（Docker 中始终开启）。
- `Cookie secret is missing from data root. Generating a new one...`：只在首次启动时出现，属正常现象。
- `Warning: listen is enabled but private request filter is disabled...`：表示没有启用内网访问防护，对应 [上线前配置清单](#4-上线前配置清单) 中的「内网访问防护（可选）」，不影响使用。
- 第一次有人访问页面后会出现 `[STC-MOD] Password migration: 0 OAuth account(s) secured`，全新安装也会出现，无害。
- 在服务器上看到的 `Launching in a browser` 等提示可以忽略。
- **首次启动后 `config.yaml` 中的注释会全部消失**：STC-MOD 补全默认值时会整体重写该文件，属正常现象。各配置项的说明请查看 `default/config.yaml`。

`config.yaml` 的位置与生效方式：

| 方式 | 文件位置 |
|------|----------|
| A | `~/sillytavern/config/config.yaml`（你创建的目录下） |
| B / D | `SillyTavernMOD/docker/config/config.yaml` |
| C | 项目根目录 `config.yaml` |

- 官方配置项（端口、Basic Auth、限流、`forwardedHeaders`、`hostWhitelist` 等）和 `deployment.trustProxy` **修改后需要重启**。
- `site` 段（页面背景与站点信息）刷新页面即生效；在 STC 管理面板中保存的设置无需重启（面板上另有提示的除外，如「用户空间」）。
- 环境变量 `SILLYTAVERN_<配置项>` 可覆盖官方配置项并优先于 `config.yaml`，例如 `SILLYTAVERN_PORT`、`SILLYTAVERN_BASICAUTHUSER_PASSWORD`；STC-MOD 自己的配置项不支持环境变量。

### 3. 首次登录与安全设置

以下步骤所有部署方式通用。重启命令：方式 A `docker restart sillytavernmod`；方式 B 在 `docker/` 目录执行 `docker compose restart sillytavern`；方式 C 前台运行时按 `Ctrl+C` 后重新 `./start.sh`，PM2 执行 `pm2 restart sillytavern`；方式 D 在 `docker/` 目录执行 `docker compose -f docker-compose.s3.yml restart sillytavern`。

1. **通过 Basic Auth**：浏览器打开 `http://服务器IP:8000/`，在浏览器弹出的登录框输入默认口令 **`admin` / `123456`**。Basic Auth 作用于**整个站点**，包括欢迎页、登录页、注册页和第三方登录（OAuth）回调地址：开启时，每个访客都必须先输入这组共用口令才能看到任何页面。它仅在 `listen: true` 且 `basicAuthMode: true` 时启用（两者默认都开启，Docker 中 `listen` 始终开启）。同一 IP 在 60 秒内连续输错 5 次后会被暂时拒绝（HTTP 429）。
2. **立即修改 Basic Auth 口令**：编辑 `config.yaml` 中的以下内容，保存后**重启才生效**（重启前仍是旧口令）：

   ```yaml
   basicAuthUser:
     username: 你的用户名
     password: "你的强密码"
   ```

   Docker 也可以用环境变量设置（优先于 `config.yaml`，但能被 `docker inspect` 看到）：
   - 方式 A：在 `docker run` 中加 `-e SILLYTAVERN_BASICAUTHUSER_USERNAME='你的用户名' -e SILLYTAVERN_BASICAUTHUSER_PASSWORD='你的强密码'`。环境变量在创建容器时确定，修改时要先 `docker stop sillytavernmod && docker rm sillytavernmod`，再重新执行 `docker run`（挂载目录中的数据不会丢失）。
   - 方式 B：写进 `docker/docker-compose.override.yml`（可以和端口设置写在同一个文件里），然后在 `docker/` 目录执行 `docker compose up -d --build`。`docker compose restart` **不会**读取新的环境变量。密码中的 `$` 要写成 `$$`。方式 D 的 override 文件写法相同，但要执行 `docker compose -f docker-compose.s3.yml -f docker-compose.override.yml up -d`（从源码构建时再加 `--build`），原因见第 6 条。

     ```yaml
     services:
       sillytavern:
         environment:
           - SILLYTAVERN_BASICAUTHUSER_USERNAME=你的用户名
           - SILLYTAVERN_BASICAUTHUSER_PASSWORD=你的强密码
     ```

3. **以 `default-user` 登录**：欢迎页点「登录账号」，用户名填 `default-user`，密码留空，点登录。`default-user`（显示名 User）是首次启动自动创建的管理员，也是**唯一**允许不填密码登录的账号；其他没有密码的账号会被拒绝，并提示「该账号尚未设置密码……」。首次登录会弹出「欢迎来到 SillyTavern！」对话框，要求填写「用户设定名称」（聊天中你的名字，默认为 User），点「保存」即可。
4. **为 `default-user` 和所有管理员设置强密码**：
   - 自己的账号：顶部栏「用户设置」（人像齿轮图标）→「帐户」→「修改密码」。
   - 其他账号：「用户设置」→「管理员面板」→「管理用户」→ 在该用户一行点钥匙图标（提示 `Change user password.`）→ 填写「新密码：」「确认新密码：」→ 点「Change」按钮（该按钮没有中文翻译）。管理员修改时不需要填当前密码。
   - **新密码不能留空**：留空提交会清除该账号的密码。
   - 以上中文名称在界面语言为简体中文时显示。STC 管理面板里的「用户管理」标签**不能**设置密码。
   - 所有账号都设置密码后重启，启动日志中不再出现 `A friendly reminder that the following users are not password protected`。
5. **决定是否保留 Basic Auth**：
   - **私人站点**（只给自己或少数熟人使用）：建议保留 Basic Auth，把口令告诉要用的人。
   - **公开站点**（开放注册，或使用 QRole 会员登录等第三方登录）：Basic Auth 开启时，陌生人连欢迎页和注册页都打不开，第三方登录回调也会被拦住，所以**必须关闭**；而且只能在**所有管理员都设置密码之后**关闭：在 `config.yaml` 中设 `basicAuthMode: false` 并重启。
   - 若仍有管理员没有密码（且未启用 `whitelistMode` 或 `securityOverride`），服务器会在启动时报错并退出：`If you are not using basic authentication or whitelisting, you should set a password for all admin users.`。Docker 中容器会不断重启（`docker ps` 显示 `Restarting`），`docker exec` 基本用不了；PM2 下也会反复重启。处理方法：先把 `basicAuthMode` 改回 `true` 并重启（例如 `docker restart sillytavernmod`，方式 B 为 `docker compose restart sillytavern`），为管理员设置密码后再关闭。
6. **放在反向代理后**：先让 `8000` 端口只对本机开放，再按 [反向代理部署](#反向代理部署nginx--openresty--cloudflare) 配置 `deployment.trustProxy`：
   - 方式 A：`-p 127.0.0.1:8000:8000`。
   - 方式 B：上面的 `docker-compose.override.yml`。
   - 方式 C：把 `config.yaml` 中 `listenAddress` 下的 `ipv4` 设为 `127.0.0.1`。
   - 方式 D：用了 `-f docker-compose.s3.yml` 时，Compose **不会**自动合并 `docker-compose.override.yml`。在 `docker/` 目录建一个与方式 B 内容相同的 override 文件，之后所有命令都同时指定两个文件，例如 `docker compose -f docker-compose.s3.yml -f docker-compose.override.yml up -d`；或者直接把 `docker-compose.s3.yml` 中的端口改成 `"127.0.0.1:8000:8000"`（之后 `git pull` 遇到该文件有更新时，需要先处理本地改动）。

### 4. 上线前配置清单

| 项目 | 在哪里设置 | 说明 |
|------|------------|------|
| Basic Auth 口令 | `config.yaml` → `basicAuthUser`、`basicAuthMode` | 默认 `admin` / `123456`，务必修改；重启生效。Basic Auth 作用于整个站点（包括欢迎页、注册页、第三方登录回调），开启时所有访客都必须先输入这组口令：私人站点建议保留；开放注册或使用 QRole 会员登录的公开站点，必须在所有管理员设置密码后关闭（见 [第 3 步](#3-首次登录与安全设置)） |
| 管理员密码 | 「用户设置」→「管理员面板」→「管理用户」 | `default-user` 与所有管理员都要设置 |
| 端口只对本机开放 | Docker：`-p 127.0.0.1:8000:8000`；Compose：override 文件（方式 D 要同时指定两个 `-f`）；Node：`listenAddress.ipv4: 127.0.0.1` | 有反向代理时必做，防止有人绕过反代直连（各方式写法见 [第 3 步第 6 条](#3-首次登录与安全设置)） |
| 反向代理 / HTTPS | `config.yaml` → `deployment.trustProxy` | 自建反代设 `1`，反代必须发送 `X-Forwarded-Proto: https`；设置后**只能通过 HTTPS 登录**；重启生效（见 [反向代理部署](#反向代理部署nginx--openresty--cloudflare)） |
| 登录限流按访客计数 | `config.yaml` → `rateLimiting.preferRealIpHeader: true` | 默认按连接来源 IP 计数，反代后所有访客共用反代的 IP，几次失败就会一起被限流；只在端口不对外开放时开启（见 [访客真实 IP 与登录限流](#访客真实-ip-与登录限流)） |
| 域名白名单 | `config.yaml` → `hostWhitelist.hosts`、`hostWhitelist.enabled` | 用域名访问时控制台会提示 `Request from untrusted host: <域名>`。`hostWhitelist.enabled` 默认 `false`，此时把域名加入 `hosts` 只会让提示消失，不会拦截其他 Host；要拒绝其他 Host，再设 `enabled: true`（IP 与 localhost 无需加入）；重启生效 |
| OAuth 回调地址 | STC 管理面板「OAuth 配置」→ Callback URL（`oauth.<提供商>.callbackUrl`） | GitHub / Discord / Linux.do 默认是 `http://127.0.0.1:8000/api/stc/oauth/<提供商>/callback`，上线前改为 `https://你的域名/api/stc/oauth/<提供商>/callback`；QRole 留空时按请求的协议和 Host 自动生成，反代后请填写完整 https 地址 |
| 站点外观 | `config.yaml` → `site` | 刷新即生效（见 [页面背景与站点信息](#页面背景与站点信息)） |
| 开放注册 / 邀请码 | STC 管理面板「邀请码」→「注册设置」；邀请码功能需 `config.yaml` 中 `enableInvitationCodes: true` | 默认开放注册、不要求邀请码（见 [关闭注册](#关闭注册)） |
| QRole 会员登录 | STC 管理面板「OAuth 配置」→ QRole | 需要 QRole 运营方开通 OAuth 应用（见 [QRole 会员登录与注册开关](#qrole-会员登录与注册开关)） |
| 邮件 | STC 管理面板「邮件配置」；`config.yaml` → `email.siteUrl`（邮件中的站点链接） | 保存后可发送测试邮件验证 |
| 存储配额 | STC 管理面板「用户空间」（`userStorage`） | 默认启用，每个用户（包括管理员）上限 50 MiB，超出后写入返回 HTTP 507；新账号自带约 15 MiB 默认内容（默认背景图、示例角色等），实际可用约 35 MiB；保存后建议重启 |
| API 密钥保险箱 | `config.yaml` → `privacy.secretsVault.requireForApiKeys`（默认 `true`） | 用户须先在个人面板「API 密钥保险箱」中启用并解锁，才能保存 API 密钥；解锁状态只保存在内存中，服务重启或超过 `privacy.secretsVault.unlockTtlMinutes`（默认 1440 分钟，即 24 小时）后需重新解锁（见 [API 密钥保险箱](#api-密钥保险箱与-requireforapikeys)） |
| 内网访问防护（可选） | `config.yaml` → `privateAddressWhitelist.enabled: true` | 官方建议在对不受信任的用户开放时启用，阻止服务器代为访问内网地址（本机 `127.0.0.1` 默认放行）；启用后用户无法连接内网中的模型服务 |
| 数据存到 S3 | `docker/docker-compose.s3.yml` | 见 [用户数据存储到 S3](#用户数据存储到-s3r2--b2juicefs) |

### 5. STC 管理面板

- **谁能看到**：只有管理员账号（`default-user` 以及在「管理用户」中设为管理员的账号）。页面加载时通过 `/api/users/me` 判断是否为管理员。
- **入口**：
  - 屏幕宽度大于 900px 时，右下角有紫色圆形悬浮按钮（扳手图标，提示「STC 管理面板（可拖动）」）。按钮可以拖动，位置保存在当前浏览器中。
  - 任何屏幕宽度下，「用户设置」抽屉中「登出」按钮后面都有「STC管理」入口。宽度不超过 900px（如手机）时只有这个入口。
- **普通用户**：点击页面上显示用户名的悬浮信息框，或「用户设置」中的「我的账户」（启用存储配额时显示），可打开个人面板，其中有「密码安全」「API 密钥保险箱」等功能。

| 标签 | 功能 |
|------|------|
| 系统监控 | CPU、内存、活跃用户、运行时间与用户统计 |
| 邀请码 | 「注册设置」（开放注册开关）、续费购买链接、创建与管理邀请码（邀请码功能需在 `config.yaml` 中设 `enableInvitationCodes: true`） |
| 公告管理 | 创建、启用 / 禁用、删除公告 |
| 邮件配置 | SMTP 服务器与发件人设置，发送测试邮件 |
| OAuth 配置 | GitHub / Discord / Linux.do / QRole 的 Client ID、Client Secret、回调地址等 |
| 默认模板 | 从现有用户生成新用户的默认配置模板 |
| 用户空间 | 存储配额（默认上限、每日签到奖励）与空间扩容激活码 |
| 用户管理 | 用户存储占用分析、多选与批量删除、清理长期未登录用户 |
| 定时任务 | 立即清理备份文件、自动定时清理配置 |

设置密码、授予管理员权限在官方「用户设置」→「管理员面板」→「管理用户」中完成，手动创建账号在同一面板的「新用户」中完成，都不在 STC 管理面板中。

### 6. 日常运维

#### 更新

更新前建议先 [备份](#备份)。

方式 A（Docker 镜像）：

```bash
docker pull sakurajiamai/sillytavernmod:latest
docker stop sillytavernmod && docker rm sillytavernmod   # 挂载目录中的数据不会被删除
rm -rf ~/sillytavern/extensions/stc-admin-panel          # 让新版 STC 管理面板在启动时重新复制（文件属于 root 时在前面加 sudo）
# 然后在 ~/sillytavern 目录重新执行第 2 步中完整的 docker run 命令
```

方式 B（Compose 从源码构建）：

```bash
cd SillyTavernMOD
git pull
cd docker
rm -rf extensions/stc-admin-panel
docker compose up -d --build
```

方式 C（前台运行，`start.sh` 会自动安装 / 更新依赖）：先按 `Ctrl+C` 停止，再执行

```bash
cd SillyTavernMOD
git pull
./start.sh
```

方式 C（PM2）：

```bash
cd SillyTavernMOD
git pull
npm install --no-save --no-audit --no-fund --omit=dev --ignore-scripts
pm2 restart sillytavern
```

方式 D（S3），使用 Docker Hub 镜像时：

```bash
cd SillyTavernMOD
git pull                                        # 更新 compose 文件与 JuiceFS 脚本
cd docker
docker compose -f docker-compose.s3.yml pull
rm -rf extensions/stc-admin-panel
docker compose -f docker-compose.s3.yml up -d
```

方式 D（S3），从源码构建时（启动时加过 `--build`）：

```bash
cd SillyTavernMOD
git pull
cd docker
rm -rf extensions/stc-admin-panel
docker compose -f docker-compose.s3.yml up -d --build
```

- 从源码构建时**不要**执行 `docker compose -f docker-compose.s3.yml pull`：它会用 Docker Hub 版本覆盖本地构建的同名镜像，悄悄换回旧代码。
- 方式 D 按 [第 3 步第 6 条](#3-首次登录与安全设置) 用 override 文件绑定了 `127.0.0.1`（或在其中设置了环境变量）的，以上方式 D 的命令都要写成 `docker compose -f docker-compose.s3.yml -f docker-compose.override.yml <子命令>`；方式 B 不需要加（Compose 会自动合并 `docker-compose.override.yml`）。

> 为什么要删除 `stc-admin-panel`（容器默认以 root 创建这些文件，普通用户执行 `rm -rf` 报 Permission denied 时在前面加 `sudo`）：Docker 容器只在挂载目录中**缺少**它时才从镜像复制，已存在的旧版本不会被覆盖。不删除的话，更新镜像后管理面板（以及保存 API 密钥失败时的提示）仍是旧版本，可能与后端不匹配。该目录只包含扩展代码，删除不会丢失数据。

#### 备份

| 部署方式 | 需要备份的内容 |
|----------|----------------|
| A | `~/sillytavern/` 下的 `config/`、`data/`，以及自行放入的 `plugins/`、`extensions/` |
| B | `SillyTavernMOD/docker/` 下的 `config/`、`data/`，以及 `plugins/`、`extensions/` |
| C | 项目根目录的 `config.yaml`、`data/`，以及 `plugins/`、`public/scripts/extensions/third-party/` 中自行安装的扩展 |
| D（S3 / JuiceFS） | 存储桶 + 元数据库（云 MariaDB / MySQL 用其自带备份；本地 Redis 则备份 `docker/juicefs/redis/`）、`docker/s3.env`、`docker/config/`，以及 `docker/plugins/`、`docker/extensions/`。JuiceFS 每小时还会自动把元数据备份到桶内 `<JFS_NAME>/meta/`，见 [元数据库丢失时的恢复](#5-元数据库丢失时的恢复) |

`data/` 中包含全部账号、聊天、角色卡和 STC-MOD 数据，建议先停止服务再复制。以方式 A 为例：

```bash
docker stop sillytavernmod
tar czf ~/sillytavern-backup-$(date +%F).tar.gz -C ~/sillytavern config data plugins extensions
docker start sillytavernmod
```

#### 查看日志

| 部署方式 | 命令 |
|----------|------|
| A | `docker logs -f --tail 200 sillytavernmod` |
| B | 在 `docker/` 目录执行 `docker compose logs -f sillytavern` |
| C | 前台运行时直接看终端；PM2：`pm2 logs sillytavern` |
| D | 在 `docker/` 目录执行 `docker compose -f docker-compose.s3.yml logs -f sillytavern juicefs` |

#### 忘记密码

**账号密码（包括管理员）**，使用官方的恢复码流程：

1. 打开登录页 `/login`，输入用户名，点「忘记密码？」。
2. 服务器日志中会打印 `<显示名>, your password recovery code is: 123456` 形式的 6 位恢复码，有效期 5 分钟（查看方法见上表；`default-user` 的显示名为 User）。恢复码只打印在服务器日志中，普通用户忘记密码时需要由管理员把恢复码转交给用户。
3. 在登录页填写「恢复码」和「新密码」，点「确认」，成功后自动登录。「新密码」不要留空，留空会清除密码。
4. 同一 IP 在 5 分钟内最多发起 5 次恢复请求。

**命令行重置**（服务运行中也可以执行，立即生效，并会重新启用被停用的账号）：

```bash
node recover.js 用户名 '新密码'                                # 方式 C，在项目根目录执行
docker exec -it sillytavernmod node recover.js 用户名 '新密码'   # 方式 A / B
```

- 一定要带上新密码参数，否则会把该账号的密码清空。
- S3 部署（方式 D）中 `recover.js` 读不到 JuiceFS 上的数据目录，请改用「忘记密码？」。

**Basic Auth 口令**：直接查看或修改 `config.yaml` 中的 `basicAuthUser`，然后重启。按 [第 3 步第 2 条](#3-首次登录与安全设置) 用环境变量设置过的，以 `SILLYTAVERN_BASICAUTHUSER_*` 为准（环境变量优先于 `config.yaml`），修改方法见该条。

### 7. 常见问题

**登录后又跳回欢迎页 / 保存 API 密钥时报 403**

- 几乎都是会话 Cookie 没有下发给浏览器。设置 `deployment.trustProxy`（非 `false`）后，只有被识别为 HTTPS 的请求才能拿到会话 Cookie，以下情况都会失败：用 `http://IP:8000` 直接访问；nginx 只提供 HTTP 或没有发送 `X-Forwarded-Proto`；经自建 nginx 时 Cloudflare 使用 Flexible 模式；前面有自建 nginx / cloudflared，却设成了 `'cloudflare'`。
- 处理：按 [反向代理部署](#反向代理部署nginx--openresty--cloudflare) 修正转发头和 `trustProxy`（有自建反代时用 `1`）后重启；只想临时用 IP 访问时，把 `trustProxy` 改回 `false` 并重启。
- 如果在 Cloudflare 上配置过「缓存全部内容」之类的规则，也可能返回旧页面，见 [Cloudflare 缓存规则](#2-缓存规则)。

**改了 `config.yaml`，页面没有变化**

- 确认改的是正确的文件：Docker 要改宿主机挂载目录中的 `config/config.yaml`（位置见 [确认启动成功](#确认启动成功)）。
- 官方配置项和 `deployment.trustProxy` 需要重启才生效。
- `site` 段刷新即生效；仍没有变化时，清除 CDN（如 Cloudflare）缓存，并在浏览器中强制刷新（js / css 默认缓存 1 天）。
- 文件有 YAML 语法错误时，运行中的服务继续使用最后一次正确的设置，日志出现 `[STC-MOD] Failed to read config.yaml (using the last valid settings, saving is disabled until it is fixed)`。此时 STC 管理面板的保存不会写入文件：「注册设置」「OAuth 配置」会提示保存失败，「邮件配置」「用户空间」「定时任务」和购买链接仍显示保存成功，但实际没有写入。
- **此时不要重启**：带语法错误的 `config.yaml` 会让服务启动失败（日志 `FATAL: Failed to read config.yaml. Please check the file for syntax errors.`，Docker 容器会不断重启）。先修正语法再重启。
- 常见原因是在文件末尾另外追加了一个 `site:` 段（日志中有 `Map keys must be unique`）：同一个键只能出现一次，请在已有的 `site:` 段里修改对应的行（见 [页面背景与站点信息](#页面背景与站点信息)）。

**注册按钮不见了 / 访问 `/register` 跳回登录页**

- 「开放注册」已关闭（`enableRegistration: false`），登录页会提示「管理员已关闭注册」。在 STC 管理面板「邀请码」→「注册设置」中勾选「开放注册」并保存即可，立即生效。

**QRole 登录提示「无法确认您的 QRole 会员状态，请联系管理员」**

- QRole 返回的用户信息（userinfo）中找不到会员等级字段，或到期时间格式无法识别。服务器日志会出现 `[STC-MOD] QRole membership could not be determined; check oauth.qrole.tierClaims/expiryClaims. Userinfo claim keys: ...`，列出 userinfo 实际返回的字段名。
- 在 STC 管理面板「OAuth 配置」→ QRole →「高级：会员字段映射」中，把「等级字段」「到期字段」改成对应的字段名后保存；或请 QRole 运营方在 userinfo 中返回会员等级。详见 [QRole 会员登录与注册开关](#qrole-会员登录与注册开关)。

**登录提示「该账号尚未设置密码，为保护账号安全已禁止仅凭用户名登录，请联系管理员设置密码」**

- 除 `default-user` 外，没有密码的账号不能仅凭用户名登录。由管理员在「管理员面板」→「管理用户」中为其设置密码（见 [第 3 步](#3-首次登录与安全设置)）；或让用户在登录页点「忘记密码？」，再由管理员从服务器日志中找到恢复码转交用户（见 [忘记密码](#忘记密码)）。

**Docker 部署后看不到 STC 管理面板**

- 悬浮按钮只对管理员显示，且只在宽度大于 900px 的屏幕上出现；窄屏请在「用户设置」中点「STC管理」。
- 挂载的 `extensions` 目录为空或缺少 `stc-admin-panel/manifest.json` 时，容器**每次启动**都会从镜像复制一份（日志 `STC-MOD: Seeding stc-admin-panel ...`），执行 `docker restart sillytavernmod` 即可。同时确认挂载目标是 `/home/node/app/public/scripts/extensions/third-party`，而不是整个 `public`。
- 更新镜像后面板版本不对：删除宿主机上的 `extensions/stc-admin-panel` 后重启容器。

**启动时报错退出：`If you are not using basic authentication or whitelisting, you should set a password for all admin users.`**

- 关闭了 Basic Auth，但仍有管理员（通常是 `default-user`）没有密码。Docker 中容器会不断重启（`docker ps` 显示 `Restarting`），`docker exec` 基本用不了；PM2 下也会反复重启。
- 处理：编辑 `config.yaml`（Docker 为宿主机挂载目录中的 `config/config.yaml`），把 `basicAuthMode` 改回 `true`，再重启（方式 A `docker restart sillytavernmod`；方式 B 在 `docker/` 目录执行 `docker compose restart sillytavern`；其他方式见 [第 3 步](#3-首次登录与安全设置) 开头）。登录后为管理员设置密码，再关闭 Basic Auth。方式 C 也可以先用 `node recover.js` 设置密码（见 [忘记密码](#忘记密码)）。

**登录时提示 `Too many attempts`（HTTP 429）**

- 在反向代理后面，默认所有访客共用反代的 IP 计数，见 [访客真实 IP 与登录限流](#访客真实-ip-与登录限流)。等待 1 分钟后重试，或按该节开启 `rateLimiting.preferRealIpHeader`。

**端口被占用**

- 方式 C 的日志出现 `Address ... is already in use. Another SillyTavern instance may already be running. Stop the other process or change "port" in config.yaml.`：可能已有另一个 SillyTavern 在运行（例如用 `npm run start` 启动后只结束了 npm 进程，node 子进程仍在监听）。用 `ss -ltnp | grep :8000` 找到占用端口的进程并结束，或修改 `config.yaml` 中的 `port`（也可以 `./start.sh --port 8001`）。
- Docker：`docker run` 报端口已被占用时，换一个宿主机端口，例如 `-p 8001:8000`（容器内保持 `8000`）。

### 8. 从旧版本升级（必读）

以下变化针对从旧版 STC-MOD 升级的站点。使用 Docker Hub 镜像时，请先确认镜像已包含这些改动（见 [镜像版本提示](#1-选择部署方式)）。

1. **论坛与公共角色卡库已移除**：`/forum`、`/public-characters` 及其 API 不再存在（原实现存在路径穿越、存储型 XSS 等问题）。`config.yaml` 中残留的 `enableForum` / `enablePublicCharacters` 不再起作用；旧数据目录 `data/stc-mod/forum_data/`、`data/stc-mod/public_characters/` 不再被读取，可自行备份后删除。
2. **第三方登录账号改为随机密码**：旧版通过 GitHub / Discord / Linux.do 等第三方登录创建的账号没有密码，知道用户名就能在登录页直接进入。升级后服务收到第一个请求时，会为这些账号设置一个不公开的随机密码（日志 `[STC-MOD] Password migration: N OAuth account(s) secured`），其现有会话随之失效，用户用原来的第三方按钮重新登录即可；之后可在个人面板「密码安全」中直接设置自己的密码（无需旧密码）。
   - 若某种登录方式已停用（未启用或未填写 Client ID），使用该方式的普通用户加固后将无法登录，日志会列出这些账号，请管理员在「管理用户」中为其重置密码。
   - 关联了已停用登录方式的**管理员**账号不会被加固（日志会给出警告），请尽快为其手动设置密码。
3. **没有密码的账号不能再仅凭用户名登录**（`default-user` 除外），例如早期注册时未填密码的用户。第一个请求之后，日志会列出这些账号：`[STC-MOD] 以下账号没有密码，已禁止仅凭用户名登录，请在用户管理中为其设置密码：...`。处理方法见 [常见问题](#7-常见问题)。
4. **注册规则收紧**：本地注册必须设置 8–128 位密码；注册、发送验证码和第三方补全注册接口都需要 CSRF 令牌（自行编写脚本调用这些接口时，需先请求 `/csrf-token`，再在请求头中带上 `X-CSRF-Token`）；第三方登录的状态和待补全身份保存在服务端会话中，无法再伪造。
5. **新配置项自动写入**：启动时自动补上 `enableRegistration`（默认 `true`）、`oauth.qrole`、`site`、`deployment.trustProxy`（默认 `false`）等缺失的配置项，已有的值不会被修改；重写后文件中的注释会消失。
6. **`config.yaml` 改为原子写入**：STC-MOD 保存配置时先写临时文件再替换（保留 Docker 中的符号链接）；文件有语法错误时拒绝写入，运行中的服务继续使用最后一次正确的设置。拒绝写入时，「注册设置」「OAuth 配置」会提示保存失败；「邮件配置」「用户空间」「定时任务」和购买链接仍会显示保存成功，但实际没有写入。此时不要重启：带语法错误的 `config.yaml` 会让服务启动失败（`FATAL: Failed to read config.yaml...`，Docker 容器会不断重启），先修正语法再重启。
7. **反代信任改为手动配置**：旧版的自动探测已移除，经反向代理用 HTTPS 部署时需在 `config.yaml` 中设置 `deployment.trustProxy`（见 [反向代理部署](#反向代理部署nginx--openresty--cloudflare)）。
8. **Docker 用户要手动更新 STC 管理面板**：容器不会覆盖挂载目录中已有的 `stc-admin-panel`，更新镜像后请先删除宿主机上的 `extensions/stc-admin-panel` 再启动容器（见 [更新](#更新)）。

---

## 用户数据存储到 S3（R2 / B2，JuiceFS）

`docker/docker-compose.s3.yml` 把 **整个数据目录**（所有用户的角色卡、聊天、世界书、头像、设置、账号库、STC-MOD 数据等）存到 S3 兼容对象存储，本机只保留有上限的读缓存。
SillyTavern 代码无需改动：[JuiceFS](https://juicefs.com/) 把存储桶挂载为普通文件系统，SillyTavern 通过 `SILLYTAVERN_DATAROOT` 指向该挂载点。

| 组成 | 保存内容 | 位置 |
|------|----------|------|
| 存储桶（R2 / B2） | 所有文件内容 | 云端 |
| 元数据库（推荐云 MariaDB / MySQL） | 目录树、文件名、文件由哪些对象组成、S3 密钥 | 云端（或本地 Redis，见下） |
| `sillytavernmod-juicefs` 容器 | 挂载卷；本地读缓存 `docker/juicefs/cache`（上限 `JFS_CACHE_SIZE_MIB`） | 本机 |
| `sillytavernmod` 容器 | SillyTavern，数据根目录 `/mnt/jfs/fs/data` | 本机 |

### 1. 准备存储桶、密钥与数据库

- **Cloudflare R2**：创建 Bucket → R2 API Token（Object Read & Write，限定该 Bucket）。桶地址 `https://<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>`。
- **Backblaze B2**：创建 Private Bucket → Application Key（限定该 Bucket）。桶地址 `https://s3.<REGION>.backblazeb2.com/<BUCKET>`（REGION 见 Bucket 详情里的 Endpoint）。
- **云 MariaDB / MySQL**：选择与服务器 **同地域**（最好内网连接）的实例；每次打开/保存文件都要访问数据库，跨地域会明显变慢。新建空库与账号：

  ```sql
  CREATE DATABASE juicefs CHARACTER SET utf8mb4;
  CREATE USER 'juicefs'@'%' IDENTIFIED BY '强密码';
  GRANT ALL ON juicefs.* TO 'juicefs'@'%';
  ```

  在云数据库的白名单 / 安全组中只放行本服务器 IP。

### 2. 配置并启动

```bash
git clone https://github.com/SakurajimMai/SillyTavernMOD.git && cd SillyTavernMOD/docker   # 已有仓库时直接 cd SillyTavernMOD/docker
cp s3.env.example s3.env      # 填写 JFS_BUCKET / JFS_ACCESS_KEY / JFS_SECRET_KEY / JFS_META_URL / META_PASSWORD
chmod 600 s3.env
docker compose -f docker-compose.s3.yml up -d
docker compose -f docker-compose.s3.yml logs -f sillytavern   # 应看到 Using data root: /mnt/jfs/fs/data
```

- `JFS_META_URL=mysql://juicefs:@(数据库地址:3306)/juicefs`，密码单独写在 `META_PASSWORD`（含 `@ : / #` 等特殊字符也无需转义）。云数据库强制 TLS 时在 URL 末尾加 `?tls=true`。
- 首次启动会自动 `juicefs format`（只执行一次）。服务器需支持 FUSE（`/dev/fuse` 存在；绝大多数 VPS 默认支持，OpenVZ/LXC 可能不支持）。
- **不用云数据库时**：可改用本机 Redis 保存元数据 —— `JFS_META_URL=redis://redis:6379/1`，并以 `docker compose -f docker-compose.s3.yml --profile redis up -d` 启动（元数据在本地 `docker/juicefs/redis`，需自行备份）。
- `sillytavern` 服务同样默认从 Docker Hub 拉取 `sakurajiamai/sillytavernmod:latest`（注意 [镜像版本提示](#1-选择部署方式)）；要使用仓库当前代码，请在 `up -d` 后加 `--build`。
- 配置文件与扩展目录与方式 B 相同，位于 `docker/config/`、`docker/extensions/`；端口同样默认发布为 `8000:8000`（所有网卡）。放在反向代理后时，Compose 不会自动合并 `docker-compose.override.yml`（因为用了 `-f`），绑定 `127.0.0.1` 的写法见 [第 3 步第 6 条](#3-首次登录与安全设置)。
- **用了 override 文件时，本节所有 `docker compose` 命令都要在 `-f docker-compose.s3.yml` 后再加 `-f docker-compose.override.yml`**，否则重建容器时端口会重新对所有网卡开放、override 中的环境变量（如 Basic Auth 口令）也会丢失。

### 3. 迁移已有的本地数据（可选）

> **有旧数据要迁移时，第 2 步只做到 `chmod 600 s3.env`，不要执行其中的 `up -d`，直接按本节操作。** 如果已经启动过 S3 版站点，JuiceFS 上已生成新站点的数据，迁移脚本会报 `Target … is not empty` 并拒绝复制（以免覆盖）。

```bash
cd SillyTavernMOD/docker                                    # 已在该目录可跳过
docker compose -f docker-compose.s3.yml up -d juicefs      # 使用本地 Redis 时加 --profile redis
docker stop sillytavernmod 2>/dev/null
sh juicefs/migrate-local-data.sh ./data     # 旧的数据目录，只复制不删除
docker rm sillytavernmod 2>/dev/null        # 删除旧容器，避免与 S3 版容器重名
docker compose -f docker-compose.s3.yml up -d
```

- 旧容器若是用 `docker run --name sillytavernmod` 创建的，**必须先 `docker rm`**，否则 S3 版容器（同名 `sillytavernmod`）无法创建。
- 迁移脚本只检查名为 `sillytavernmod` 的容器是否在运行；容器名不同时请自行先停止旧容器。
- 旧数据不在 `docker/data` 时（例如方式 A 的 `~/sillytavern/data`），把脚本参数换成实际目录；旧的 `config.yaml` 与自行安装的扩展也要分别复制到 `docker/config/`、`docker/extensions/`。

确认站点正常后再自行删除旧的本地 `data/`，才会真正释放本地空间。

### 4. 更换 S3 密钥

修改 `s3.env` 中的 `JFS_ACCESS_KEY` / `JFS_SECRET_KEY`，然后**重新创建**容器（`restart` 不会重新读取 `s3.env`）：

```bash
docker compose -f docker-compose.s3.yml up -d --force-recreate juicefs sillytavern
```

JuiceFS 启动脚本每次启动都会把 `s3.env` 中的密钥同步到元数据。

### 5. 元数据库丢失时的恢复

存储桶 + 元数据库 合起来才是完整数据。JuiceFS 每小时自动把元数据备份到桶内 `<JFS_NAME>/meta/dump-*.json.gz`（`JFS_BACKUP_META`）。
若元数据库被清空（或 `JFS_META_URL` 指向了空库），JuiceFS 会 **拒绝格式化**（不会覆盖桶内数据）：`juicefs` 容器打印恢复方法后退出并不断重启（用 `docker compose -f docker-compose.s3.yml logs juicefs` 查看），SillyTavern 容器则一直显示 `Waiting for JuiceFS mount at /mnt/jfs/fs ...`。恢复步骤：

```bash
cd docker
# 1. 从存储桶下载最新的 <JFS_NAME>/meta/dump-*.json.gz，保存为 ./dump.json.gz
# 2. 导入到（空的）元数据库
docker compose -f docker-compose.s3.yml run --rm -v "$PWD/dump.json.gz:/dump.json.gz:ro" \
  --entrypoint sh juicefs -c 'juicefs load "$JFS_META_URL" /dump.json.gz'
# 3. 重启（备份不含 S3 密钥，启动脚本会自动从 s3.env 补回）
docker compose -f docker-compose.s3.yml restart juicefs sillytavern
```

恢复到的是最近一次备份时的状态（最多丢失约 1 小时的改动）；使用云数据库自带的自动备份 / 时间点恢复可以更精确。

### 注意事项

- 元数据库中保存着 S3 访问密钥（JuiceFS 社区版明文保存），请限制数据库访问来源；`docker/s3.env` 保持仅 root 可读。二者均已加入 `.gitignore` / `.dockerignore`。
- 在 R2 / B2 控制台里看到的是 `<JFS_NAME>/chunks/...` 数据块，不是一个个角色卡文件；查看或导出文件请通过 `docker/juicefs/mnt/fs/data` 或 SillyTavern 本身。
- 不要在存储桶上开启会自动删除/转存对象的生命周期规则；删除的文件会先进入 JuiceFS 回收站（默认 7 天，`JFS_TRASH_DAYS`；该值只在首次格式化时生效，之后修改 `s3.env` 不起作用）。
- 启动顺序已做保护：SillyTavern 会等待 JuiceFS 挂载就绪后才启动（即使服务器重启后 Docker 以任意顺序拉起容器），不会把数据误写到本地目录。
- JuiceFS 容器重启后需同时重启 SillyTavern：`docker compose -f docker-compose.s3.yml restart juicefs sillytavern`。
- 如需把数据加密后再上传（桶内数据对服务商不可读），可在首次启动前参考 JuiceFS 文档启用 `--encrypt-rsa-key`；私钥丢失将无法恢复数据。
- S3 部署中 `recover.js` 只读取 `config.yaml` 里的 `dataRoot`，找不到 JuiceFS 上的账号数据；忘记密码请用登录页的「忘记密码？」（见 [忘记密码](#忘记密码)）。

---

## QRole 会员登录与注册开关

### QRole（qqy.one）会员直接登录

只有 **QRole VIP / SVIP 会员**可以用「QRole 会员登录」按钮直接进入本站；首次登录自动开户（即使已关闭注册、即使开启了邀请码），之后每次登录都会重新校验会员身份。

**需要 QRole 方提供 / 确认的内容**（QRole 没有自助开发者后台，需找 QRole 运营方开通）：

1. 一个 OAuth 应用：`client_id`、`client_secret`，并登记回调地址 `https://<你的域名>/api/stc/oauth/qrole/callback`（必须与管理面板中填写的回调地址完全一致）。
2. **`/api/oauth/userinfo` 必须返回会员等级**，例如 `membershipTierId`（`free` / `vip` / `svip`），最好同时返回到期时间 `membershipExpiresAt`。QRole 目前公开的授权范围（`openid profile email account:role …`）里没有会员信息；若 userinfo 不含会员等级，**所有人都会被拒绝登录**（提示「无法确认您的 QRole 会员状态」），服务器日志会列出 userinfo 实际返回的字段名，可在管理面板 QRole 配置的「高级：会员字段映射」中改成对应字段路径。
3. 令牌端点的客户端认证方式（`client_secret_post` 或 `client_secret_basic`）以及是否支持 PKCE（默认开启 S256，不支持时可在面板关闭）。

**配置步骤**：管理员登录 → STC 管理面板 → 「OAuth 配置」标签 → QRole：填写 Client ID / Secret、Callback URL（**部署在反向代理后必须填写完整 https 回调地址**；留空时按请求的协议与 Host 自动生成，依赖正确的 `deployment.trustProxy`），勾选「启用」和「仅允许会员登录」，「允许的会员等级」默认 `vip,svip`，保存后立即生效。

**会员校验规则**：

- 每次 QRole 登录都会检查：会员等级在允许列表内、未过期、QRole 账号状态为 active；否则拒绝并在登录页给出原因。
- 已登录的会话也会持续校验：已知到期时间一到、管理员从允许列表移除该等级时立即下线；另外每隔「会员状态复核间隔」（默认 24 小时，`oauth.qrole.reverifyHours`）需要重新用 QRole 登录一次以确认会员仍有效（页面刷新时按 24 小时，聊天等 API 请求有 48 小时宽限，避免对话中途被踢出）。设为 0 则只按已知到期时间和等级判断。
- 为防止绕过会员校验，QRole 账号**不能用密码登录**；可以在「密码安全」中设置密码，但仅用于重置数据等确认操作。
- QRole 的管理员角色不会映射成本站管理员。
- 取消「仅允许会员登录」后，任何 QRole 用户都可登录，但此时 QRole 新用户与其他第三方登录一样受「开放注册」与邀请码约束。

### 关闭注册

管理面板 → 「邀请码」标签 → 「注册设置」→ 取消勾选「开放注册」并保存（立即生效，对应 `config.yaml` 中的 `enableRegistration`）。关闭后：

- 欢迎页、登录页不再显示注册按钮；访问 `/register` 会跳转到登录页并提示「管理员已关闭注册」；注册与发送验证码接口一律拒绝。
- GitHub / Discord / Linux.do 新用户无法开户（已绑定的老用户照常登录）。
- **QRole 会员首次登录仍会自动开户**；管理员仍可在官方「用户设置」→「管理员面板」→「新用户」中手动创建账号。

### 账号安全相关变更（升级必读）

第三方登录账号改用随机密码、无密码账号禁止仅凭用户名登录、注册需要密码与 CSRF 令牌、`config.yaml` 原子写入等变更，已统一整理在 [从旧版本升级（必读）](#8-从旧版本升级必读)。

---

## 页面背景与站点信息

欢迎页（`/`）、登录页（`/login`）、注册页（`/register`）的背景与站点文字都在 `config.yaml` 的 `site` 段中配置。**修改后刷新页面即生效，无需重启**；未修改时与原先的页面完全一致。首次启动时 STC 会自动写入缺失的默认值（包括 4 张默认功能卡片）。

> **怎么修改**：`config.yaml` 中已经有一个 `site:` 段。下面的示例只列出要改的键，请在已有的 `site:` 段里找到并修改对应的行，**不要**在文件末尾另外追加一个 `site:`（同一个键出现两次是 YAML 语法错误，见 [常见问题](#7-常见问题)）。首次启动后文件会被改写成不带引号的写法（例如 `name: SillyTavern`，功能卡片也会展开成多行的 `- icon: ...`），搜索时不要带引号。

```yaml
site:
  name: 'SillyTavern'                 # 站点名：网页标题、欢迎页大标题、登录框 Logo 旁文字
  badge: 'Silly Tavern'               # 欢迎页顶部角标（'' = 不显示）
  subtitle: 'AI 角色扮演与对话平台'      # 欢迎页副标题第一行
  subtitle2: 'Creative · Immersive · Extensible'   # 副标题第二行（两行都为 '' 时不显示）
  logoUrl: 'img/logo.png'             # Logo：站内相对路径或 http(s) 地址
  background:
    pcVideoUrl: 'https://t.alcy.cc/acg'        # 电脑端背景视频（mp4）；'' = 改用 pcImageUrl
    pcImageUrl: ''                             # 电脑端背景图片；有视频时作为视频加载前的封面和视频失败时的替代图
    mobileImageUrl: 'https://t.alcy.cc/moemp'  # 手机端背景图片；'' = 改用 pcImageUrl
    fallback: 'linear-gradient(125deg,#06040f 0%,#180d3a 40%,#0d1b3e 70%,#06040f 100%)'  # 无背景或加载失败时的底色
    overlayOpacity: 0.52                       # 背景暗色遮罩不透明度 0-1
    sakura: true                               # 樱花飘落动画
  features:                                    # 欢迎页功能卡片（最多 8 个；[] = 不显示）
    - { icon: 'fa-solid fa-comments', title: 'AI 对话', text: '支持多种 LLM 模型' }
    - { icon: 'fa-solid fa-masks-theater', title: '角色扮演', text: '丰富的角色卡系统' }
    - { icon: 'fa-solid fa-palette', title: '个性化', text: '主题和界面定制' }
    - { icon: 'fa-solid fa-puzzle-piece', title: '扩展', text: '强大的扩展生态' }
```

| 配置项 | 作用 | 规则 |
|--------|------|------|
| `name` | 浏览器标签页标题（登录页为「站点名 - 登录」、注册页为「站点名 - 注册账号」）、欢迎页大标题、登录框 Logo 旁文字、Logo 的替代文字 | 最多 60 字；不能为空（为空时使用默认值） |
| `badge` | 欢迎页卡片顶部的小角标 | 最多 60 字；`''` 隐藏 |
| `subtitle` / `subtitle2` | 欢迎页大标题下方的两行副标题 | 各最多 120 字；两行都为 `''` 时隐藏 |
| `logoUrl` | 欢迎页与登录页的 Logo 图片 | 站内相对路径（如 `img/logo.png`）或 `http(s)://` 地址；不能为空 |
| `background.pcVideoUrl` | 电脑端背景视频（`<video>` 静音循环播放，需浏览器可播放的 mp4） | `''` 时改用 `pcImageUrl` |
| `background.pcImageUrl` | 电脑端背景图片：`pcVideoUrl` 为 `''` 时直接显示；有视频时作为视频加载前的封面，视频加载失败时改为显示这张图。也是手机端的备用图片 | 可为 `''` |
| `background.mobileImageUrl` | 手机端（屏宽 ≤ 1023px 或移动设备）背景图片 | `''` 时改用 `pcImageUrl`；都为空则只显示 `fallback` |
| `background.fallback` | 没有设置背景、或背景加载失败时显示的底色 | CSS 颜色或渐变，最多 300 字符；不允许 `url(`、引号、`;`、`{}`、`<>`、`\` |
| `background.overlayOpacity` | 背景上方暗色遮罩的不透明度，数值越大背景越暗、文字越清晰 | `0`–`1`（`0` = 无遮罩） |
| `background.sakura` | 樱花飘落动画 | `true` / `false` |
| `features` | 欢迎页功能卡片列表，每项 `icon`（[Font Awesome 6](https://fontawesome.com/search?ic=free) 图标类名，如 `fa-solid fa-book`）、`title`（最多 30 字，必填）、`text`（最多 80 字，可为 `''`） | 最多 8 个，多余的忽略；`[]` 不显示卡片区域；图标无效时显示星形图标 |

**校验规则**：所有地址只接受站内相对路径或 `http://` / `https://` 地址（`javascript:`、`data:` 等一律拒绝）；文字会去掉控制字符和首尾空格，超出长度的部分被截断；任何无效值（类型不对、地址不合法、数值越界等）都会被忽略并改用该项的默认值，不会导致页面无法打开。页面上的文字一律按纯文本显示（写入 HTML 标签不会生效）。空值请写成 `''`，不要只写 `name:`（YAML 中会变成 null，按无效值处理并恢复默认）。

### 常见示例

**换成自己的背景视频 / 图片**：默认背景来自第三方随机图站 `t.alcy.cc`（国内访问可能较慢或不稳定），建议换成自己的 CDN 地址，或把文件放到仓库的 `public/img/` 目录下，然后用站内路径 `/img/...` 引用（该目录无需登录即可访问）。Docker 部署请只挂载一个子目录，例如 `-v "$PWD/site-img:/home/node/app/public/img/site"`，再用 `/img/site/bg.mp4` 引用；不要把整个 `public/img` 挂载覆盖掉，否则内置图标会丢失。

```yaml
site:
  background:
    pcVideoUrl: '/img/bg.mp4'                  # public/img/bg.mp4
    pcImageUrl: '/img/bg-pc.jpg'               # 视频加载前的封面 + 视频失败时的替代图
    mobileImageUrl: 'https://cdn.example.com/bg-mobile.webp'
```

只想用静态图片（电脑端不播放视频）：

```yaml
site:
  background:
    pcVideoUrl: ''
    pcImageUrl: '/img/bg-pc.jpg'
    mobileImageUrl: ''                         # 手机端也用 pcImageUrl
```

完全不用背景媒体、只用纯色或渐变：三个地址都设为 `''`，再修改 `fallback`，例如 `fallback: '#101820'` 或 `fallback: 'linear-gradient(135deg,#1e1b4b,#0f172a)'`。

**关闭樱花动画 / 调整遮罩**：

```yaml
site:
  background:
    sakura: false
    overlayOpacity: 0.3        # 背景更亮；0.7 则更暗
```

**修改站点名称与文字**：

```yaml
site:
  name: '星海酒馆'
  badge: 'Star Tavern'
  subtitle: '和你的角色一起冒险'
  subtitle2: ''                # 只显示一行副标题
  logoUrl: '/img/my-logo.png'
```

**自定义功能卡片**（整个列表会替换默认卡片；`features: []` 则不显示卡片）：

```yaml
site:
  features:
    - icon: 'fa-solid fa-book-open'
      title: '新手教程'
      text: '先看公告再开始'
    - icon: 'fa-solid fa-bolt'
      title: '高速线路'
      text: ''
```

> 页面访问时由服务端读取 `config.yaml` 并把配置注入页面（`window.STC_SITE`），因此修改保存后刷新浏览器即可看到效果；如果前面有 CDN（如 Cloudflare）缓存了 HTML，需要清除缓存。若 `config.yaml` 存在语法错误，运行中的服务会继续使用最后一次正确解析的设置；但此时不要重启，带语法错误的文件会让服务启动失败（见 [常见问题](#7-常见问题)），先修正语法。

---

## 反向代理部署（nginx / OpenResty / Cloudflare）

生产环境常见拓扑为：**浏览器 → 反代（HTTPS）→ SillyTavern（HTTP 8000，只对本机开放）**。
经反代后若出现 **登录后跳回欢迎页、API 密钥无法保存（403）、保险箱已解锁仍写不进去** 等现象，多半是会话 Cookie 没能下发到浏览器（CSRF 令牌保存在会话中，也会随之失效），而非业务逻辑本身损坏。最常见的原因是 `deployment.trustProxy` 与实际拓扑不符，见下文。

### 必须手动配置 `trust proxy`

> **从本版本起，反代信任改为手动显式配置，不再自动探测。**  
> 旧版本的「环境变量自动探测」在 Node/Express 中实际无效（`HTTP_X_FORWARDED_*`、`CF_RAY` 等并不会出现在 `process.env` 里）；而运行时按请求头探测又可被直连容器伪造 `X-Forwarded-*` 头攻击，从而伪造来源 IP。因此现在统一要求在 `config.yaml` 中明确声明部署拓扑。

在 `config.yaml`（Docker 为挂载目录中的 **`config/config.yaml`**）中按你的实际拓扑设置，修改后**重启**生效：

```yaml
deployment:
  # false        不信任任何反代（默认；本地 / 内网 HTTP 直连用）
  # 1            单层反代：自建 nginx / OpenResty / Caddy 直接连到 SillyTavern
  # 2            双层反代（例如 Cloudflare + 自建 nginx；效果与 1 相同，也可以用 1）
  # 'cloudflare' 仅信任 Cloudflare IP 段；只适用于 Cloudflare 边缘节点直接连接 SillyTavern 端口（条件见下表）
  # true         信任全部跳数（不推荐，易被伪造）
  trustProxy: 1
```

**这个设置影响什么**：

- 设为非 `false` 后，会话 Cookie 启用 `secure: 'auto'`：只有 Express 判断为 HTTPS 的请求才会下发会话 Cookie。判断方法是：**直接连到 SillyTavern 的那一方**是否受信任，以及它发来的 `X-Forwarded-Proto` 是否为 `https`。
- 因此设置后：
  - 必须通过 HTTPS 域名访问，并且反代要发送 `X-Forwarded-Proto: https`；
  - 直接访问 `http://IP:8000`、只提供 HTTP 的 nginx、经自建 nginx 时的 Cloudflare Flexible 模式都**无法登录**（拿不到会话 Cookie）。
- Express 判断出的协议还用于自动生成 OAuth 回调地址（例如 QRole 回调地址留空时）。
- 它**不影响**日志、限流、IP 白名单使用的访客 IP，那些由 `forwardedHeaders` 和 `rateLimiting.preferRealIpHeader` 控制（见 [访客真实 IP 与登录限流](#访客真实-ip-与登录限流)）。
- 保持 `false` 时经 HTTPS 反代也能正常登录，只是会话 Cookie 不带 Secure 标记。

常见选择：

| 部署拓扑 | 建议值 |
|----------|--------|
| 仅本机 / 内网 HTTP 直连 | `false`（默认） |
| 单层 nginx / OpenResty / Caddy（HTTPS）→ 源站 | `1` |
| Cloudflare 橙云 → 自建 nginx → 源站 | `1` 或 `2`（**不要**用 `'cloudflare'`） |
| Cloudflare 边缘节点直接连接 SillyTavern 端口（中间没有任何自建反代或本机转发） | `'cloudflare'`：需开启 `ssl.enabled` 并配置证书，使用 Cloudflare 支持的 HTTPS 端口（443 / 2053 / 2083 / 2087 / 2096 / 8443，或用 Origin Rules 改端口），且该端口只对 [Cloudflare IP 段](https://www.cloudflare.com/ips/) 开放 |

> **为什么有自建反代时不能用 `'cloudflare'`**：该模式只信任 Cloudflare 的 IP 段。连接先经过 nginx、cloudflared 等本机转发时，直接连到 SillyTavern 的是 `127.0.0.1` 或 Docker 内网地址，不在信任范围内，Express 不会读取 `X-Forwarded-Proto`，所有请求都被当作 HTTP，结果是拿不到会话 Cookie，出现登录循环或 403。

修改后重启容器/进程，启动日志应出现（`1` 或 `2` 时为第一行，`'cloudflare'` 时为后两行）：

```text
[STC-MOD] Express trust proxy enabled (config): 1
[STC-MOD] Express trust proxy enabled (cloudflare): trusting Cloudflare IP ranges
[STC-MOD] Auto-enabled forwardedHeaders.cfConnectingIp for CF visitor IP detection
```

> 设为 `false`（或留空）时不打印该日志。`'cloudflare'` 模式会同时把 `forwardedHeaders.cfConnectingIp: true` 写入 `config.yaml`，该项在**下一次重启后**才生效。

### 访客真实 IP 与登录限流

- 日志、IP 白名单和限流不使用上面的 trust proxy，而是直接读取请求头，依次取：`X-Real-IP`（`forwardedHeaders.xRealIp`，默认开启）→ `CF-Connecting-IP`（`forwardedHeaders.cfConnectingIp`，默认关闭）→ `X-Forwarded-For` 中的第一个地址（`forwardedHeaders.xForwardedFor`，默认开启）。
- 登录、Basic Auth、找回密码的限流（默认各 5 次）**默认只按连接来源 IP 计数**（`rateLimiting.preferRealIpHeader: false`）。在反代后面，所有访客的连接来源都是反代的 IP，短时间内几次失败尝试就会让**所有访客**一起被限流（HTTP 429，提示 `Too many attempts`）。
- 解决方法：先确认 SillyTavern 端口只对本机开放，且反代用 `proxy_set_header X-Real-IP $remote_addr;` 覆盖该请求头，然后在 `config.yaml` 中设置 `rateLimiting.preferRealIpHeader: true` 并重启。此后限流按「连接 IP + 转发头中的访客 IP」分别计数。**端口能被外部直连时不要开启**，否则攻击者可以伪造请求头绕过限流。
- 经 Cloudflare → 自建 nginx 时，nginx 的 `$remote_addr` 是 Cloudflare 边缘节点的 IP，而 `X-Real-IP` 的优先级高于 `CF-Connecting-IP`，所以日志和限流看到的是边缘节点 IP。需要访客真实 IP 时，要在 nginx 侧先还原访客地址（例如使用 nginx 的 real_ip 模块），具体请参考 nginx 与 Cloudflare 官方文档。
- 用域名访问时，控制台会提示 `Request from untrusted host: <域名>`，把域名加入 `hostWhitelist.hosts` 即可（再设 `hostWhitelist.enabled: true` 可拒绝其它 Host）。

### 推荐配置清单

| 项 | 建议 |
|----|------|
| 源站端口 | 只对本机开放：Docker 用 `-p 127.0.0.1:8000:8000`，Node 直接运行时设 `listenAddress.ipv4: 127.0.0.1`；Compose（方式 B / D）见 [第 3 步第 6 条](#3-首次登录与安全设置) |
| 反代层数 | 尽量 **单 upstream** 指向一个 SillyTavern 实例；多副本需 sticky session |
| 转发头 | 必须正确传递 `Host`、**`X-Forwarded-Proto: https`**（HTTPS 站点）与 `X-Real-IP` |
| HTTPS Cookie | 设置 `trustProxy` 为非 `false` 后自动联动 `secure: 'auto'`，会话 Cookie 带 Secure 标记；此后只有被识别为 HTTPS 的请求才能登录 |
| 登录限流 | 端口不对外开放时设 `rateLimiting.preferRealIpHeader: true`，避免所有访客共用反代 IP 被一起限流 |
| CSRF | **不要**长期依赖 `disableCsrfProtection: true` 作为生产方案 |
| API 密钥保险箱 | 解锁密钥仅保存在 **进程内存**；服务重启或超过 `privacy.secretsVault.unlockTtlMinutes`（默认 1440 分钟）后需重新解锁 |

### OpenResty / nginx 示例

以下示例假设 SillyTavern 监听 `127.0.0.1:8000`（Docker 映射端口），公网域名为 `your-domain.com`。

完整生产示例（HTTPS，推荐）：

```nginx
# WebSocket 升级映射（放在 http {} 块内，全局只需一次）
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# HTTP 自动跳转 HTTPS
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;

    # ===== 证书（替换为你的实际路径）=====
    ssl_certificate     /etc/nginx/ssl/your-domain.com.crt;
    ssl_certificate_key /etc/nginx/ssl/your-domain.com.key;

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # 上传体积上限（导入角色卡/图片时按需调大）
    client_max_body_size 100m;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        # ===== 关键转发头 =====
        # X-Forwarded-Proto：配合 deployment.trustProxy 识别 HTTPS（决定会话 Cookie 能否下发）
        # X-Real-IP：日志 / 限流使用的访客 IP（覆盖客户端自带的同名请求头）
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ===== WebSocket（SillyTavern 本身不使用，个别第三方扩展可能需要）=====
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;

        # ===== 长连接超时（避免长回复被截断）=====
        proxy_read_timeout  86400;
        proxy_send_timeout  86400;

        # ===== 关闭缓冲：流式输出是普通 HTTP 流，需要立即转发 =====
        proxy_buffering off;
    }
}
```

最小示例（仅 HTTP，只用于本机 / 内网测试）。此时 `$scheme` 为 `http`，**`deployment.trustProxy` 必须保持 `false`**，否则无法登录：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 86400;
        proxy_buffering off;
    }
}
```

**注意：**

1. 必须保证 `X-Forwarded-Proto` 与 `Host` 被正确转发，并在 `config.yaml` 中
   **手动设置 `deployment.trustProxy`**（单层 nginx 设 `1`）。STC-MOD 据此启用
   `trust proxy` 并联动 Secure Cookie（实现细节见 [MODIFICATIONS.md](MODIFICATIONS.md) 中「钩子 G - 反代 trust proxy」一节）。
2. 测试配置并重载：

   ```bash
   nginx -t && nginx -s reload
   ```

3. 若仍出现「登录后跳回欢迎页 / API 密钥保存失败」，多为转发头缺失、Cloudflare SSL 模式不对，
   或 `deployment.trustProxy` 与拓扑不符（例如有自建 nginx 却设成了 `'cloudflare'`）。请按上文逐项确认。

**请勿**对 `/api/*` 或 HTML 做 aggressive 缓存；Cloudflare 上应对动态 API 使用 **Bypass cache**（见下文 Cloudflare 专章）。

### Cloudflare 部署专项配置

若使用 **Cloudflare 橙云代理**（DNS Proxied），需额外配置：

#### 1. SSL/TLS 模式（必须）

Dashboard → **SSL/TLS** → Overview → 选择 **Full (strict)**

- ❌ **Flexible**：Cloudflare → 源站走 HTTP。配合源站的 HTTP→HTTPS 跳转会无限重定向；即使不跳转，nginx 发出的 `X-Forwarded-Proto` 也是 `http`，设置 `trustProxy` 后无法登录。
- ✅ **Full (strict)**：Cloudflare → 源站走 HTTPS，源站需要有效证书，或使用 Cloudflare Origin CA 证书。
- 自签名证书只能配合 **Full**（非 strict）模式使用，此时 Cloudflare 不校验源站证书，不推荐。

> **真实访客 IP（Cloudflare）**：`deployment.trustProxy` 不决定日志 / 限流使用的访客 IP。经 Cloudflare → 自建 nginx 时的处理方法见 [访客真实 IP 与登录限流](#访客真实-ip-与登录限流)。

#### ⚠ 安全：不要直接暴露源站端口

本版本默认 `whitelistMode: false`（反代后所有请求的来源 IP 都是反代 IP，IP 白名单失去意义）。
一旦有人绕过 Cloudflare / nginx **直连 SillyTavern 端口**，就能绕开反代层的所有防护，并可伪造 `X-Real-IP` 等请求头。因此务必：

- Docker 端口映射绑定到本机环回：`-p 127.0.0.1:8000:8000`（而非 `-p 8000:8000`）；Compose 见 [方式 B](#b-docker-compose-从源码构建) 的 override 文件（方式 D 要同时指定两个 `-f` 文件，见 [第 3 步第 6 条](#3-首次登录与安全设置)）；Node 直接运行时设 `listenAddress.ipv4: 127.0.0.1`；
- 由反代（nginx / CF）作为唯一公网入口；
- 若使用 Cloudflare，可配合防火墙仅放行 [CF IP 段](https://www.cloudflare.com/ips/) 访问 443，
  防止攻击者绕过 CF 直连源站。

#### 2. 缓存规则

**说明**：Cloudflare 默认不缓存 HTML 与 API 响应；但如果添加过「Cache Everything（缓存全部内容）」之类的规则，就可能把页面或 API 缓存下来，导致登录后看到旧页面、API key 读写失败。另外，SillyTavern 对 js / css / 图片返回 `Cache-Control: public, max-age=86400`，对静态 `.html` 文件返回 `max-age=3600`，**升级后请清除 Cloudflare 缓存**（Purge Everything）。

**建议规则**：Dashboard → **Caching** → Cache Rules → Create rule

**规则 1：绕过 API 缓存**
- **If**：`URI Path` → `starts with` → `/api/`
- **Then**：Cache eligibility → **Bypass cache**

**规则 2：绕过页面缓存**
- 欢迎页、登录页、注册页的地址是 `/`、`/login`、`/register`，没有 `.html` 后缀，只按「以 `.html` 结尾」匹配是覆盖不到的。
- **If**：`URI Path` 等于 `/`、`/login`、`/register`，或以 `.html` 结尾
- **Then**：Cache eligibility → **Bypass cache**

或直接设置：
- **If**：`Hostname` → `equals` → `your-domain.com`
- **Then**：**Bypass cache** for everything（简单但会增加源站负载）

#### 3. Always Use HTTPS（推荐）

Dashboard → **SSL/TLS** → Edge Certificates → **Always Use HTTPS**：`On`

#### 4. 排查缓存问题

若看到「登录后刷新又回到欢迎页」：
1. CF Dashboard → **Caching** → **Purge Cache** → Purge Everything
2. 确认上述 Cache Rules 已生效
3. 浏览器开发者工具 → Network → 看 Response Headers 中 `cf-cache-status` 应为 `BYPASS` 或 `DYNAMIC`

### API 密钥保险箱与 `requireForApiKeys`

默认配置中 `privacy.secretsVault.requireForApiKeys: true` 表示：**保存 API key 前必须启用并解锁保险箱**，写入链为：

```text
启用/解锁保险箱 → POST /api/stc/privacy-vault/*
→ POST /api/secrets/write → 加密写入 data/{用户}/secrets.json
```

在反代与会话不稳定时，该链路比「仅浏览页面」更容易失败。排查步骤：

1. 浏览器 **开发者工具 → Network**，保存 API key 时查看：
   - `POST /api/stc/privacy-vault/enable` 或 `unlock` 的状态码
   - `POST /api/secrets/write` 的状态码（**403** 多为 CSRF/会话；**423** 为保险箱未解锁）
2. 若 `secrets.json` 仍为 `{}`，说明 **write 从未成功**；按上文检查 `trustProxy` 与反代转发头。
3. **临时缓解**（不推荐长期使用）：`privacy.secretsVault.requireForApiKeys: false`，允许未启用保险箱时明文保存（仍建议启用保险箱加密）。

自本版本起，保存失败时 **`stc-admin-panel` 扩展** 的全局 `fetch` 拦截会弹出具体 HTTP 状态与反代提示（不修改官方 `secrets.js`），便于与静默失败区分。需确保扩展已加载且为当前版本：Docker 容器每次启动时，若挂载目录中缺少 `stc-admin-panel` 会自动从镜像复制，但不会覆盖已有的旧版本（见 [更新](#更新)）。

### 不建议的做法

- 为「修反代」而扩大 STC 路由的 CSRF 豁免范围（会降低安全性）。
- 多实例负载均衡 **且** 无 sticky session **且** 强制 `requireForApiKeys: true`（解锁状态不跨进程共享）。
- 将 `disableCsrfProtection: true` 当作正式部署配置。

更多实现细节见 [MODIFICATIONS.md](MODIFICATIONS.md) 中「部署 / trust proxy / 保险箱」相关说明。

---

## STC-MOD 功能概览

STC-MOD 的主要能力包括（非完整列表）：

- 自定义欢迎页 / 登录 / 注册页（玻璃拟态风格，含激活码与邮箱校验等）。
- 页面背景（视频 / 图片 / 渐变、遮罩、樱花动画）与站点名称、Logo、副标题、功能卡片均可在 `config.yaml` 的 `site` 段修改，刷新即生效（见[页面背景与站点信息](#页面背景与站点信息)）。
- QRole（qqy.one）VIP / SVIP 会员一键登录（自动开户、会员状态持续校验），管理员可一键关闭注册。
- 基于邀请码的注册与续期系统（支持多种时长，对接购买链接）。
- 账户有效期与空间配额控制（到期/超限限制登录或写入，并在前端明确提示）。
- 用户「签到扩容」与个人空间使用情况展示。
- API 密钥保险箱：用户可设置独立保险箱密码，将 API key 加密落盘（防止服务器文件系统直接读取明文）。当前提示与弹窗为简体中文硬编码。
- STC 管理面板（系统监控、用户管理多选与批量删除、定时任务、不活跃用户清理等，入口与各标签说明见 [STC 管理面板](#5-stc-管理面板)）。

所有后端路由均通过 `src/stc-mod/index.js` 注册，前端管理与入口则通过
`public/scripts/extensions/third-party/stc-admin-panel/` 扩展注入。

---

## 升级与二次开发注意事项

> 默认分支 `release` 是维护分支，Docker Hub 镜像由它构建（推送到 `release` 后自动发布）。远端还有其他分支，但它们不用于部署。

为了在跟进上游 SillyTavern 版本时减少冲突，本项目遵循以下原则：

- 尽可能 **不修改** 官方源文件；确需修改时：
  - 仅插入一个「调用钩子函数」或最小逻辑。
  - 所有改动都在 [MODIFICATIONS.md](MODIFICATIONS.md) 中记录行号、目的与注意事项。
- 所有自定义逻辑（路由、服务、配置解析、前端 UI）集中在：
  - 后端：`src/stc-mod/` 目录（`routes/`、`services/`、`user-metadata.js` 等）。
  - 前端：`src/stc-mod/public/` 与 `public/scripts/extensions/third-party/stc-admin-panel/`。

升级官方 SillyTavern 版本时，建议流程：

1. **先从上游合并官方更新**，保证仓库处于干净状态。
2. 打开 [MODIFICATIONS.md](MODIFICATIONS.md)，按钩子编号逐条核对：
   - 对应文件是否仍存在。
   - Hook 附近逻辑是否有破坏性变动。
3. 若官方结构发生变化，优先调整 `src/stc-mod/` 内部实现，而不是继续扩散对官方代码的修改范围。

---

## 修改记录 (MODIFICATIONS)

本仓库相对于官方 SillyTavern 的所有 **核心文件改动** 与 **新增 Sidecar 结构说明**，已完整记录在：

- [`MODIFICATIONS.md`](MODIFICATIONS.md)

若你准备：

- 升级到新的官方版本；
- 调整 / 扩展 STC-MOD 功能；
- 或排查「为何官方行为与文档不一致」的问题，

请务必先阅读该文件。

---

## 上游资源与协议

**Upstream Resources**

- GitHub: <https://github.com/SillyTavern/SillyTavern>
- Docs: <https://docs.sillytavern.app/>
- Discord: <https://discord.gg/sillytavern>
- Reddit: <https://reddit.com/r/SillyTavernAI>

**License**

本项目沿用上游 SillyTavern 许可协议：

- AGPL-3.0


