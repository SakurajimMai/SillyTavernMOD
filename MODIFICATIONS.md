# SillyTavernchat (STC-MOD) 修改文档

> 本文件记录在官方 SillyTavern 基础上进行的二次开发，
> 以便后续官方版本升级时快速定位和维护这些修改点。
>
> **当前上游基线**：SillyTavern **1.19.0**（upstream tag / commit `7e8663cd9c184a550b37238218bdd32c6efc68e9`）。
> **最近同步**：2026-09-15，合并提交 `b217d36eec988d93b0fc28f90af447b3aa9b8198`（`Merge upstream SillyTavern 1.19.0`）。

## 架构概述

所有二次开发功能以 **Sidecar Module**（外挂模块）方式实现，集中在 `src/stc-mod/` 目录中。
对官方核心代码的修改仍集中在 **1 个文件**（`src/server-main.js`）：包含 **6 个 STC-MOD 钩子点**，以及 **1 处静态资源缓存策略调整**。

## 核心文件修改

### `src/server-main.js`

> **升级排查**：在仓库根目录执行 `rg "\[STC-MOD\]" src/server-main.js` 可列出全部注入点（当前共 **7 个功能标记 / 6 个挂钩 + Cookie 条件配置 + 1 处静态缓存替换**）。
> 下列行号基于 **SillyTavern 1.19.0 + 当前 MOD** 的 `src/server-main.js`（文件总行数 **539**）；合并上游后行号会漂移，以 `[STC-MOD]` 注释与相邻官方代码锚点为准。

| 钩子编号 | 行号（当前） | 官方锚点（插入位置） | 修改内容 | 目的 |
|---------|------------|---------------------|---------|------|
| **A** | **68–76** | `import { UPLOADS_DIRECTORY } from './constants.js';` 之后、`// Routers` 之前 | 动态 `import('./stc-mod/index.js')` → `stcMod` | 加载 Sidecar 模块 |
| **G** | **166–169** | `app.use(accessLoggerMiddleware());` 之后、会话配置之前 | `stcMod.configureTrustProxy(app)` | 反代：`deployment.trustProxy` → Express `trust proxy`（须在 session/CSRF 之前） |
| **B** | **209–214** | `csrfSync` 的 `skipCsrfProtection` 回调内 | `stcMod.shouldSkipCsrf(req)` 与官方 `proxyBypass` 取 OR | STC 公开 API 的最小 CSRF 豁免 |
| **C** | **238–239** | CSRF 中间件注册完毕之后、`app.get('/', ...)` **之前** | `stcMod.setupPublicRoutes(app)` | 欢迎页 / 登录页 / 注册页等路由覆盖 |
| **F** | **271–283** | 官方 `webpackMiddleware` / `userCssMiddleware` 之后的静态资源中间件 | 为 `public/` 静态资源增加 `maxAge` / `Cache-Control` | 降低 VPS 重复下载 JS/CSS |
| **D** | **288–289** | `app.use('/api/users', usersPublicRouter)` 之后、`requireLoginMiddleware` **之前** | `stcMod.setupPublicApi(app)` | 无需登录的 STC 公开 API |
| **E** | **324–325** | `setupPrivateEndpoints(app)` 之后 | `stcMod.setupPrivateRoutes(app)` | 需登录的 STC 私有 API |

#### `src/server-main.js` 注入代码全文（便于 diff / 合并上游）

**钩子 A — 第 68–76 行**

```javascript
// [STC-MOD] SillyTavernchat sidecar module loader
let stcMod = null;
try {
    // @ts-expect-error STC-MOD sidecar has no type declarations
    stcMod = await import('./stc-mod/index.js');
    console.log('[STC-MOD] SillyTavernchat module loaded.');
} catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') console.error('[STC-MOD] Load error:', e.message);
}
```

**钩子 G — 第 166–169 行**（⚠ 必须在 `cookieSession` 之前）

```javascript
// [STC-MOD] Trust reverse proxy before session / CSRF (see deployment.trustProxy in config.yaml)
if (stcMod?.configureTrustProxy) {
    stcMod.configureTrustProxy(app);
}
```

Sidecar 实现：`src/stc-mod/middleware/trust-proxy.js`；配置项：`config.yaml` → `deployment.trustProxy`。该值必须按实际网络拓扑显式配置，默认 `false`；不会再基于环境变量或请求头自动探测。

**同时替换 cookieSession 配置（第 171–184 行）**：

```javascript
const stcCookieSessionOptions = {
    name: getCookieSessionName(),
    sameSite: 'lax',
    httpOnly: true,
    maxAge: getSessionCookieAge(),
    secret: getCookieSecret(globalThis.DATA_ROOT),
};
if (app.locals.stcTrustProxyEnabled) {
    stcCookieSessionOptions.secure = 'auto';
}
app.use(cookieSession(stcCookieSessionOptions));
```

仅在 Sidecar 已启用可信反代时设置 `secure: 'auto'`，避免本地明文 HTTP 会话 Cookie 被浏览器丢弃。

**钩子 B — 第 203–205 行**（在 `skipCsrfProtection` 回调内）

```javascript
            // [STC-MOD] Custom CSRF exemption
            const stcBypass = stcMod?.shouldSkipCsrf?.(req) ?? false;
            return proxyBypass || stcBypass;
```

（原官方代码为 `return proxyBypass;`，需改为 `return proxyBypass || stcBypass;`。）

**钩子 C — 第 230–231 行**

```javascript
// [STC-MOD] Public routes and page overrides (must be BEFORE official / and /login routes)
if (stcMod?.setupPublicRoutes) await stcMod.setupPublicRoutes(app);
```

**改动 F — 第 263–275 行**（替换官方空配置的 `express.static`）

```javascript
app.use(express.static(path.join(serverDirectory, 'public'), {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (/\.(js|css|woff|woff2|ttf|svg|png|jpg|jpeg|gif|ico)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
        }
        if (/\.html$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
    },
}));
```

**钩子 D — 第 280–281 行**

```javascript
// [STC-MOD] Additional public API routes (no auth required)
if (stcMod?.setupPublicApi) await stcMod.setupPublicApi(app);
```

**钩子 E — 第 316–317 行**

```javascript
// [STC-MOD] Private routes (requires authentication)
if (stcMod?.setupPrivateRoutes) await stcMod.setupPrivateRoutes(app);
```

#### 合并上游时的推荐顺序

1. `rg "\[STC-MOD\]" src/server-main.js` — 若为空则整段按上表重新插入。  
2. 先恢复 **钩子 A**（后续钩子依赖 `stcMod`）。  
3. 在 **`cookieSession` 前** 插入 **钩子 G**（易漏，且不宜放到 `setupPublicRoutes` 里）。  
4. 恢复 **B → C → F → D → E**（C 仍在 `app.get('/')` 之前）。  
5. 启动后确认日志：`[STC-MOD] SillyTavernchat module loaded.`；若启用反代则另有 `Express trust proxy enabled:`。

> ⚠ **升级注意**：钩子 C 的位置至关重要——必须插入在 `app.get('/', ...)` **之前**，而非仅在 `app.get('/login', ...)` 之前。若顺序错误，未登录用户访问 `/` 时会被官方路由直接跳转到 `/login`，欢迎页永远不会显示。

### `src/endpoints/secrets.js`

新增 **STC-MOD API 密钥保险箱**适配层：在用户启用保险箱后，将 `secrets.json` 中的 API key `value` 字段以 AES-256-GCM 加密落盘；解锁后服务端仅在内存中短期持有派生密钥（TTL 可配置）。

设计约束（最低侵入）：
- **不改**各模型后端：仍通过官方 `readSecret()` 获取密钥；保险箱逻辑只接入 `secrets.js` 的读写层。
- 只加密用户 API key，不加密官方内部字段（例如 `csrfSecret`），避免破坏登录与 CSRF 流程。
- 前端提示与弹窗当前为 **简体中文硬编码**（为避免修改官方语言包文件）。

### `public/scripts/secrets.js`

配合服务端保险箱接口，在前端新增以下逻辑（**STC-MOD 代码块，约第 340–534 行**）：
- 维护前端的 `secret_vault_state`（是否启用、是否解锁）。
- 拦截 `writeSecret()`：保存新 API key 时，如保险箱未启用则引导设置密码；如已锁定则引导输入密码。
- 新增 `maybeOfferVaultMigration()`：当检测到用户有明文 key 且未启用保险箱时，主动弹出迁移提示。
- 在 `initSecrets()` 初始化阶段，读取状态并提示用户当前是否处于锁定状态。

**反代 / 保存失败的可读错误提示**不在此文件实现，而在 **`stc-admin-panel` 的全局 `fetch` 拦截器**（见下文），以避免继续扩大对官方前端的侵入。

所有新增的前端提示/弹窗为简体中文硬编码，避免了对上游 `public/locales/*.json` 多语言文件的修改。

### 具体代码差异

#### `src/endpoints/secrets.js` 后端接口注入
在核心逻辑中引入 STC-MOD API 密钥保险箱（`src/stc-mod/services/privacy-vault.js`）的方法；以下位置基于 1.19.0 合并结果：
- **`writeSecret`（约第 324–335 行）**：写入 API key 前拦截检测；状态合规时加密 `value` 后落盘，要求启用保险箱但尚未启用时抛出 `VaultRequiredError`。
- **`readSecret`（约第 415–432 行）**：检测密文并通过保险箱解密；锁定时抛出 `VaultLockedError`。
- **`getSecretState`（约第 514–529 行）**：加密 Key 在前端显示为 `*******`，并带 `encrypted: true` 标识，绝不返回密文负载。
- **`enableVault` / `resetVaultAndClearEncryptedKeys`**：由私有保险箱路由调用，分别用于批量加密已有 key，以及在确认不可恢复时清除保险箱与加密条目。
- **`/write`、`/read`、`/view`、`/find`（约第 682–792 行）**：捕获保险箱异常并通过 `sendVaultError` 返回 423 Locked 或 428 Precondition Required，同时保留上游 1.19.0 的路由校验与错误处理。

#### `public/scripts/secrets.js` 前端拦截注入
在前端增加相关的交互和校验代码（以下位置基于 1.19.0 合并结果）：
- **API 密钥保险箱模块（第 341–530 行）**：`STC-MOD` 代码块包含 `readSecretVaultStatus`、`askVaultPassphrase`、`enableSecretVault`、`unlockSecretVault`、`ensureSecretVaultReadyForWrite`、`retrySecretWriteAfterVaultAction`、`maybeOfferVaultMigration`。
- **`writeSecret` 拦截（第 541 行起）**：调用 `/api/secrets/write` 前执行 `ensureSecretVaultReadyForWrite()`；收到保险箱错误后以 `retrySecretWriteAfterVaultAction()` 引导用户。
- **`readSecretState`（第 613 行起）**：成功加载秘密状态后调用 `maybeOfferVaultMigration()`。
- **`initSecrets`（第 1375 行起）**：进入界面时读取保险箱状态；锁定状态显示 toast。

#### `public/scripts/extensions/third-party/stc-admin-panel/index.js` 悬浮用户面板集成

**全局 fetch 拦截（约第 24–120 行，`installStcFetchGuards`）**  
在原有 **507 存储配额** 提示基础上，增加对以下失败请求的 toast（不修改官方 `secrets.js`）：
- `POST /api/secrets/write`（跳过 423/428，由官方 `secrets.js` 触发解锁/启用流程；对其余状态如 **403** 提示反代 + `deployment.trustProxy`）
- `POST /api/stc/privacy-vault/enable`
- `POST /api/stc/privacy-vault/unlock`

在 STC Admin Panel 扩展的"我的账户"悬浮面板中新增功能卡片：

**API 密钥保险箱** 卡片：
- 展示当前状态徽章（未启用 / 已锁定 / 已解锁）。
- 按当前状态动态渲染操作按钮：`启用保险箱` / `解锁` / `立即锁定`。
- 在保险箱已启用（无论是否解锁）时额外显示"忘记密码 / 重置保险箱"入口，需二次输入 `RESET` 字样才能提交，调用 `POST /api/stc/privacy-vault/reset`。
- 所有与保险箱相关的交互都集中在该面板内，不影响官方 `public/scripts/secrets.js` 中既有的启用 / 解锁 / 写入拦截逻辑。

**密码安全** 卡片（新增）：
- 展示当前密码状态徽章（未设置 / 已设置）。
- OAuth 用户显示注册来源（GitHub/Discord/LinuxDO）并提示可设置密码用于用户名密码登录。
- 动态渲染操作按钮：`设置密码`（未设置时）/ `修改密码`（已设置时）。
- 设置/修改密码通过弹窗输入，要求至少 8 位字符。
- 修改密码时需验证当前密码。
- 成功后提示用户可使用用户名和刚设置的密码登录。

**密码提醒 Toast**（新增）：
- OAuth 用户首次登录后，若未设置密码，延迟 3 秒显示温馨提示 Toast。
- 每天每个会话只提示一次（使用 sessionStorage 防重）。
- 提供"立即设置"按钮（打开用户面板）和"稍后提醒"按钮。
- 15 秒后自动消失。

#### 钩子 A - 模块加载（第 68–76 行）

插入位置：`import { UPLOADS_DIRECTORY } from './constants.js';` 之后，`// Routers` 注释之前。

```javascript
// [STC-MOD] SillyTavernchat sidecar module loader
let stcMod = null;
try {
    // @ts-expect-error STC-MOD sidecar has no type declarations
    stcMod = await import('./stc-mod/index.js');
    console.log('[STC-MOD] SillyTavernchat module loaded.');
} catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') console.error('[STC-MOD] Load error:', e.message);
}
```

#### 钩子 G - 反代 trust proxy（第 166–169 行）

插入位置：`app.use(cookieSession({...}))` **之前**（须在会话与 CSRF 中间件之前）。完整说明见上文 **`src/server-main.js` 注入代码全文**。

#### 钩子 B - CSRF 豁免（第 203–205 行）

插入位置：`csrfSync({...})` 配置对象的 `skipCsrfProtection` 函数体内，紧接 `proxyBypass` 之后。

```javascript
skipCsrfProtection: (req) => {
    const proxyBypass = cliArgs.enableCorsProxy ? /^\/proxy\//.test(req.path) : false;
    // [STC-MOD] Custom CSRF exemption
    const stcBypass = stcMod?.shouldSkipCsrf?.(req) ?? false;
    return proxyBypass || stcBypass;
},
```

#### 钩子 C - 公开页面路由（第 230–231 行）

⚠ **插入位置：`// Static files` 注释和 `app.get('/', ...)` 之前。**

```javascript
// [STC-MOD] Public routes and page overrides (must be BEFORE official / and /login routes)
if (stcMod?.setupPublicRoutes) await stcMod.setupPublicRoutes(app);

// Static files
// Host index page
app.get('/', cacheBuster.middleware, (request, response) => {
    // ... 官方代码不变 ...
});
```

#### 钩子 D - 公开 API 路由（第 280–281 行）

插入位置：`app.use('/api/users', usersPublicRouter)` 之后、`app.use(requireLoginMiddleware)` 之前。

```javascript
// [STC-MOD] Additional public API routes (no auth required)
if (stcMod?.setupPublicApi) await stcMod.setupPublicApi(app);
```

#### 钩子 E - 私有 API 路由（第 316–317 行）

插入位置：`setupPrivateEndpoints(app)` 调用之后（已登录区域内）。

```javascript
// [STC-MOD] Private routes (requires authentication)
if (stcMod?.setupPrivateRoutes) await stcMod.setupPrivateRoutes(app);
```

#### 改动 F - 静态资源缓存策略（第 263–275 行）

替换位置：官方前端静态文件托管语句 `app.use(express.static(path.join(serverDirectory, 'public'), {}));`。

```javascript
app.use(express.static(path.join(serverDirectory, 'public'), {
    maxAge: '1d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (/\.(js|css|woff|woff2|ttf|svg|png|jpg|jpeg|gif|ico)$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=86400, must-revalidate');
        }
        if (/\.html$/i.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
        }
    },
}));
```

目的：
- JS、CSS、字体、图标、图片缓存 1 天，减少登录后主界面重复下载大量静态资源。
- HTML 缓存 1 小时并保留协商缓存，避免页面文件长期陈旧。
- 不改变路由顺序，不影响 STC-MOD 页面覆盖、登录鉴权和 API 行为。

## 新增依赖

在 `package.json` 中新增以下依赖（已写入）：

| 包名 | 用途 | 可选 |
|------|------|------|
| `nodemailer` | 邮件服务（注册验证、密码恢复、用户通知） | 是（不安装则邮件功能自动禁用） |
| `yaml` | 读写 config.yaml 配置文件 | 是（官方若已引入则无需重复安装） |

> `node-persist`（node-persist）为官方已有依赖，STC-MOD 在 `user-extend.js` 中直接复用，**无需额外安装**。

## 依赖的官方 `src/users.js` 导出接口

升级时需确认以下接口在新版 `users.js` 中仍然存在且签名未变：

| 导出名称 | 使用文件 | 用途 |
|---------|---------|------|
| `requireAdminMiddleware` | 所有 `private/` 路由 | 鉴权：仅管理员可访问 |
| `requireLoginMiddleware` | `index.js` 注册 | 鉴权：登录用户才可访问私有路由 |
| `getAllUserHandles` | `user-extend.js`、`scheduled-tasks.js` | 获取所有用户 handle 列表 |
| `getUserDirectories` | `user-extend.js` | 获取用户数据目录路径（用于清理数据） |
| `toKey` | `user-extend.js` | 将 handle 转换为 node-persist 存储 key |
| `getPasswordSalt` | `register-helper.js`、`services/account-security.js` | 生成密码盐 |
| `getAccountVersion` | `oauth.js`、`set-password.js` | 第三方登录/改密后写入 `session.version`（与官方登录一致） |
| `getIpAddress`、`retryAfter`（`src/express-common.js`） | `index.js`、`register.js` | 限流按 IP 计数（与官方登录限流同源） |
| `getPasswordHash` | `register-helper.js` | 生成密码哈希 |
| `ensurePublicDirectoriesExist` | `register-helper.js` | 确保用户公共目录存在 |
| `shouldRedirectToLogin` | 官方 `server-main.js`（参考） | 判断是否需要跳转登录 |

## 新增目录结构

```
src/stc-mod/
├── index.js                         # 模块入口（5个导出函数）
├── config.js                        # 配置系统（读写 config.yaml）
├── user-metadata.js                 # 扩展用户数据存储
├── middleware/
│   ├── csrf-exemption.js            # CSRF 豁免规则
│   ├── trust-proxy.js               # 反代 trust proxy 配置
│   └── expiration-check.js          # 用户过期检查中间件
├── routes/
│   ├── public/
│   │   ├── register.js              # 用户注册
│   │   ├── register-helper.js       # 注册辅助（调用官方用户创建）
│   │   ├── oauth.js                 # OAuth 第三方登录
│   │   ├── invitation-status.js     # 邀请码状态
│   │   ├── announcements-public.js  # 登录页公告
│   │   ├── email-status.js          # 邮件服务状态
│   │   └── public-config.js         # 公开配置（功能开关）
│   └── private/
│       ├── registration-config.js   # 注册开关（管理员）
│       ├── invitation-codes.js      # 邀请码管理（管理员）
│       ├── user-extend.js           # 用户扩展（续费、存储、签到）
│       ├── announcements.js         # 公告管理（管理员）
│       ├── email-config.js          # 邮件配置（管理员）
│       ├── oauth-config.js          # OAuth 配置（管理员）
│       ├── system-load.js           # 系统监控（管理员）
│       ├── user-storage.js          # 存储空间管理（管理员）
│       ├── privacy-vault.js         # API 密钥保险箱（用户）
│       ├── set-password.js          # 密码管理（用户）
│       ├── default-config.js        # 默认模板管理（管理员）
│       └── scheduled-tasks.js       # 定时任务（管理员）
├── services/
│   ├── email-service.js             # 邮件服务
│   ├── invitation-codes.js          # 邀请码逻辑
│   ├── system-monitor.js            # 系统监控
│   ├── storage-quota.js             # 存储配额
│   ├── privacy-vault.js             # API 密钥保险箱（用户口令加密）
│   ├── site-config.js               # 页面背景与站点信息（config.yaml `site`，校验 + 页面注入）
│   └── default-template.js          # 默认用户模板
└── public/
    ├── login.html                   # 自定义登录页（含 OAuth 按钮）
    ├── register.html                # 注册页
    └── welcome.html                 # 欢迎页
```

## 数据存储

所有外挂模块数据存储在 `data/stc-mod/` 目录中，**不修改**官方用户数据结构：

| 文件/目录 | 内容 |
|-----------|------|
| `user-metadata.json` | 扩展用户字段（OAuth ID、邮箱、过期时间、存储限额、密码状态等） |
| `invitation-codes.json` | 邀请码数据 |
| `storage-codes.json` | 存储激活码数据 |
| `announcements/` | 公告数据 |
| `default-template/` | 新用户默认配置模板 |
| `privacy-vaults/` | API 密钥保险箱元数据（不含明文密钥） |
| `system-monitor-history.json` | 系统监控历史 |

## 配置项

在 `config.yaml` 中添加的配置项（首次启动时自动写入默认值）：

```yaml
enableInvitationCodes: false    # 启用邀请码系统
enableRegistration: true        # 开放注册（false：隐藏注册入口并拒绝注册；QRole 会员首次登录仍自动开户）
purchaseLink: ''                # 续费购买链接

oauth:
  github:
    enabled: false
    clientId: ''
    clientSecret: ''
    callbackUrl: ''
  discord:
    enabled: false
    clientId: ''
    clientSecret: ''
    callbackUrl: ''
  linuxdo:
    enabled: false
    clientId: ''
    clientSecret: ''
    callbackUrl: ''
  qrole:                         # QRole（qqy.one）会员登录
    enabled: false
    clientId: ''
    clientSecret: ''
    callbackUrl: ''              # 反代部署时务必填写完整 https 回调地址
    authUrl: 'https://www.qqy.one/api/oauth/authorize'
    tokenUrl: 'https://www.qqy.one/api/oauth/token'
    userInfoUrl: 'https://www.qqy.one/api/oauth/userinfo'
    scope: 'openid profile email'
    tokenAuthMethod: client_secret_post   # 或 client_secret_basic
    usePkce: true
    requireMembership: true      # 仅允许 allowedTiers 中的会员登录
    allowedTiers: [vip, svip]    # 由 STC 自动写入；default/config.yaml 中不预置数组（避免 lodash 按下标合并）
    tierClaims: [membershipTierId, membership_tier, membership.tierId, membership.tier, tier]
    expiryClaims: [membershipExpiresAt, membership_expires_at, membership.expiresAt]
    reverifyHours: 24            # 会员状态复核间隔（小时），0 = 仅按已知到期时间/等级

email:
  enabled: false
  smtp:
    host: ''
    port: 587
    secure: false
    user: ''
    password: ''
  from: ''
  fromName: 'SillyTavern'

userStorage:
  enabled: false
  defaultLimitMiB: 500
  dailyCheckInMiB: 0

privacy:
  secretsVault:
    requireForApiKeys: true          # 是否强制保存 API key 前启用保险箱
    unlockTtlMinutes: 1440           # 保险箱解锁后服务端内存密钥保留时间 (24小时)

deployment:
  trustProxy: false                  # false = 不信任反代（默认）；1 = 单层；2 = 双层；'cloudflare' = 仅信任 CF IP 段；true = 信任全部

site:                                # 欢迎页 / 登录页 / 注册页的站点信息与背景（刷新页面即生效）
  name: 'SillyTavern'                # 网页标题、欢迎页大标题、登录框 Logo 旁文字（≤60）
  badge: 'Silly Tavern'              # 欢迎页角标（≤60，'' 隐藏）
  subtitle: 'AI 角色扮演与对话平台'     # ≤120，'' 隐藏
  subtitle2: 'Creative · Immersive · Extensible'
  logoUrl: 'img/logo.png'            # 站内相对路径或 http(s)
  background:
    pcVideoUrl: 'https://t.alcy.cc/acg'        # 电脑端背景视频（mp4）；'' = 用 pcImageUrl
    pcImageUrl: ''                             # 电脑端背景图片（有视频时作封面/视频失败时替代）
    mobileImageUrl: 'https://t.alcy.cc/moemp'  # 手机端背景图片；'' = 用 pcImageUrl
    fallback: 'linear-gradient(125deg,#06040f 0%,#180d3a 40%,#0d1b3e 70%,#06040f 100%)'  # CSS 颜色/渐变
    overlayOpacity: 0.52                       # 遮罩不透明度 0-1
    sakura: true                               # 樱花动画
  features:                          # 欢迎页功能卡片（≤8；[] = 不显示）；由 STC 自动写入，default/config.yaml 中仅为注释示例
    - { icon: 'fa-solid fa-comments', title: 'AI 对话', text: '支持多种 LLM 模型' }
    - { icon: 'fa-solid fa-masks-theater', title: '角色扮演', text: '丰富的角色卡系统' }
    - { icon: 'fa-solid fa-palette', title: '个性化', text: '主题和界面定制' }
    - { icon: 'fa-solid fa-puzzle-piece', title: '扩展', text: '强大的扩展生态' }
```

**手动配置（无自动探测）**：
- `deployment.trustProxy` 仅从 `config.yaml` 读取，需按实际拓扑手动设置。
- 旧版的环境变量探测（`HTTP_X_FORWARDED_*` / `CF_RAY` / `CF_CONNECTING_IP`）在 Node/Express 中**从不生效**（这些是 CGI/PHP 约定，不会进入 `process.env`），已移除。
- 运行时按 `X-Forwarded-*` 请求头探测也已移除：它可被直连容器的伪造头触发，让应用信任伪造来源 IP。
- 启动日志：设为非 `false` 时显示 `[STC-MOD] Express trust proxy enabled (config): <值>`；`'cloudflare'` 模式显示 `... (cloudflare): trusting Cloudflare IP ranges + CF-Connecting-IP`。
- `'cloudflare'` 模式：仅信任 [Cloudflare 公布 IP 段](https://www.cloudflare.com/ips/)，并用 `CF-Connecting-IP` 取真实访客 IP。
- Cookie `secure: 'auto'` 仅在 `trustProxy` 为非 `false` 时联动开启，避免本地 HTTP 下会话 Cookie 被丢弃。

## 部署与性能相关默认配置

为降低中国网络环境下登录后主界面黑屏或长时间等待的概率，默认配置中调整了以下项目：

```yaml
cacheBuster:
  enabled: false

extensions:
  autoUpdate: false
  models:
    autoDownload: false

enableDownloadableTokenizers: false
```

说明：
- `cacheBuster.enabled: false`：避免启动或首次加载时强制清理浏览器端 JS/CSS 缓存。
- `extensions.autoUpdate: false`：避免登录后主界面初始化阶段自动访问 GitHub 更新第三方扩展。
- `extensions.models.autoDownload: false`：避免自动从 HuggingFace 下载 transformers 模型。
- `enableDownloadableTokenizers: false`：避免缺失 tokenizer 时自动访问 GitHub 下载，改为使用本地 fallback。

> 运行中的 VPS 如果已经生成根目录 `config.yaml`，升级默认配置不会自动覆盖该文件。需要手动确认运行配置中的上述开关也为 `false`。

## API 路由汇总

### 公开 API（无需认证）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/stc/public-config/public-pages` | 获取功能开关状态 |
| GET | `/api/stc/invitation-codes/status` | 邀请码系统状态 |
| GET | `/api/stc/announcements/login/current` | 登录页公告 |
| GET | `/api/stc/email/status` | 邮件服务状态 |
| POST | `/api/stc/users/register` | 用户注册 |
| POST | `/api/stc/users/send-verification` | 发送邮箱验证码 |
| POST | `/api/stc/users/renew-expired` | 过期用户续费 |
| GET | `/api/stc/oauth/:provider` | 发起 OAuth 登录 |
| GET | `/api/stc/oauth/:provider/callback` | OAuth 回调 |
| GET | `/api/stc/oauth/pending` | 查询服务端会话中待补全（需邀请码）的第三方身份 |
| POST | `/api/stc/oauth/complete-registration` | 完成 OAuth 注册（仅接收 `{inviteCode}`，身份取自服务端会话；需 CSRF） |

### 私有 API（需认证）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/stc/users/me-ext` | 获取当前用户扩展信息 |
| POST | `/api/stc/users/renew` | 续费（使用邀请码） |
| POST | `/api/stc/users/heartbeat` | 心跳（更新在线时间） |
| GET | `/api/stc/users/storage` | 获取存储信息 |
| POST | `/api/stc/users/check-in` | 每日签到 |
| POST | `/api/stc/users/use-storage-code` | 使用存储激活码 |
| GET | `/api/stc/users/password-status` | 检查当前用户密码状态 |
| POST | `/api/stc/users/set-password` | 设置/修改密码（首次设置或修改） |
| POST | `/api/stc/users/verify-password` | 验证当前密码 |
| GET | `/api/stc/announcements/current` | 获取当前公告 |

### 管理员 API

| 方法 | 路径 | 功能 |
|------|------|------|
| GET/POST | `/api/stc/registration-config/config` | 获取/设置开放注册（`{enableRegistration}`） |
| POST | `/api/stc/invitation-codes/create` | 创建邀请码 |
| GET | `/api/stc/invitation-codes/list` | 列出所有邀请码 |
| POST | `/api/stc/invitation-codes/delete` | 删除邀请码 |
| GET/POST | `/api/stc/email-config/config` | 获取/设置邮件配置 |
| POST | `/api/stc/email-config/test` | 测试邮件发送 |
| GET/POST | `/api/stc/oauth-config/config` | 获取/设置 OAuth 配置 |
| GET | `/api/stc/system-load/current` | 当前系统负载 |
| GET | `/api/stc/system-load/history` | 系统负载历史 |
| GET/POST | `/api/stc/user-storage/config` | 存储配额配置 |
| POST | `/api/stc/user-storage/create-code` | 创建存储激活码 |
| POST | `/api/stc/user-storage/delete-code` | 删除存储激活码 |
| GET | `/api/stc/users/all-meta` | 所有用户扩展元数据 |
| GET | `/api/stc/users/expiration-list` | 用户过期列表 |
| POST | `/api/stc/users/delete-inactive` | 彻底删除长期未登录用户（账号+数据目录+元数据），支持 `dryRun` 预览、`minStorageMB` 存储过滤、`sendEmailNotice` 通知 |
| POST | `/api/stc/users/warn-inactive` | 向未登录用户发送提醒邮件（不删除），支持 `minStorageMB` 存储过滤 |
| GET | `/api/stc/announcements/list` | 所有公告列表 |
| POST | `/api/stc/announcements/create` | 创建公告 |
| PUT | `/api/stc/announcements/:id` | 更新公告 |
| POST | `/api/stc/announcements/delete` | 删除公告 |
| GET | `/api/stc/scheduled-tasks/storage-analysis` | 用户存储分析（按用户统计聊天/角色卡/备份等） |
| POST | `/api/stc/scheduled-tasks/clean-backups` | 立即清理备份文件（指定用户或全部） |
| GET/POST | `/api/stc/scheduled-tasks/config` | 获取/保存定时清理配置 |
| GET/POST | `/api/stc/default-config/template` | 获取/保存新用户默认配置模板 |
| POST | `/api/stc/privacy-vault/status` | 当前用户 API 密钥保险箱状态 |
| POST | `/api/stc/privacy-vault/enable` | 启用保险箱并加密已有 API key |
| POST | `/api/stc/privacy-vault/unlock` | 解锁保险箱以使用已加密 API key |
| POST | `/api/stc/privacy-vault/lock` | 立即锁定保险箱 |
| POST | `/api/stc/privacy-vault/reset` | 重置保险箱（忘记密码时使用；需 `{confirm:"RESET"}`，会清空已加密密钥） |

## 升级指南

当官方 SillyTavern 发布新版本时：

### 必须操作

1. **拉取官方更新**：正常合并/覆盖官方代码
2. **恢复 `src/server-main.js` 全部 STC 注入点**（6 钩子 + 改动 F）：
   - 运行 `rg "\[STC-MOD\]" src/server-main.js`，当前应有 **7 行**注释标记
   - 若被上游覆盖，按上文 **「`src/server-main.js` 注入代码全文」** 与行号表逐一插回
   - **特别注意钩子 G**：必须在 `app.use(cookieSession(` **之前**，不可挪到 `setupPublicRoutes`
   - **特别注意钩子 C**：必须在 `app.get('/', ...)` 之前，不能只放在 `/login` 之前

3. **恢复静态资源缓存策略**：
   - 检查 `app.use(express.static(path.join(serverDirectory, 'public'), ...))`
   - 若被上游覆盖为空配置 `{}`，按「改动 F - 静态资源缓存策略」恢复缓存头配置

4. **同步部署默认配置**：
   - 确认 `cacheBuster.enabled: false`
   - 确认 `extensions.autoUpdate: false`
   - 确认 `extensions.models.autoDownload: false`
   - 确认 `enableDownloadableTokenizers: false`

5. **保留目录**（升级时不要删除）：
   - `src/stc-mod/` — 全部外挂模块代码
   - `public/scripts/extensions/third-party/stc-admin-panel/` — 管理面板前端扩展
   - `data/stc-mod/` — 所有运行时数据（用户元数据、公告、邀请码等）

### 需要验证的兼容性

| 检查项 | 说明 |
|--------|------|
| `src/users.js` 导出接口 | 见上方「依赖的官方导出接口」表格，逐一确认签名未变 |
| `node-persist` API | `storage.removeItem(key)` 接口是否变更 |
| `cookie-session` 中的 `req.session.handle` | STC-MOD 用此字段判断登录态 |
| `req.user.profile.handle` | 私有路由用此获取当前用户 handle |
| `csrfSync` 配置结构 | `skipCsrfProtection` 回调参数是否变更 |
| `express.static` 调用位置 | 静态资源缓存策略应仍位于 `webpackMiddleware` 之后、公开 API 路由之前 |

### 快速验证步骤

```bash
# 启动后观察控制台，应出现：
# [STC-MOD] SillyTavernchat module loaded.
# [STC-MOD] Public routes registered.
# [STC-MOD] Public API routes registered.
# [STC-MOD] Private API routes registered.

# 若出现 [STC-MOD] Load error: ... 则说明模块加载失败，需排查
```

访问测试：
- `GET /` → 未登录应显示欢迎页（`welcome.html`），已登录应显示主界面
- `GET /login` → 应显示自定义登录页（含 OAuth 按钮）
- `GET /register` → 应显示注册页
- `GET /api/stc/public-config/public-pages` → 应返回 JSON（无需登录）

## QRole 会员登录、注册开关与账号安全加固

全部实现位于 `src/stc-mod/` 与 `stc-admin-panel/`，**未新增 `server-main.js` 钩子**（仍为 6 个）。

| 文件 | 说明 |
|------|------|
| `routes/public/oauth.js` | 新增 `qrole` 提供商（PKCE S256、`client_secret_post/basic`）；state 与 PKCE verifier 绑定服务端会话、一次性、10 分钟有效；待补全身份存于 `req.session.stcOauthPending`，`complete-registration` 只接收 `{inviteCode}`；所有失败重定向 `/login?oauth_error=<固定代码>`；Linux.do 不再信任未验签 JWT；过期关联（官方删除后同名重建）自动清理 |
| `services/qrole-membership.js` | 会员等级/到期/状态判定（字段路径可配置，缺失时拒绝） |
| `services/qrole-session.js` | 会话持续校验：到期、等级被移除、超过 `reverifyHours`（页面 1 倍、API 2 倍宽限）即下线（API 401 `code: QROLE_MEMBERSHIP`，页面跳登录页） |
| `services/registration.js` | `isRegistrationEnabled()` / 统一 403 `REGISTRATION_CLOSED` |
| `services/account-security.js` | 随机密码（不可逆随机串）、`passwordAutoGenerated` 判定、过期元数据识别 `isMetaForRecord` |
| `services/password-migration.js` | 首个请求前把无密码第三方账号加固为随机密码（批量、秒级）；日志列出仍无密码的本地账号与需管理员重置密码的账号 |
| `routes/private/registration-config.js` | 管理员注册开关 API |
| `index.js` | `setupPublicRoutes` 内：迁移闸门 → 挂在 `/api/users` 路由器上的登录拦截（与官方路由相同匹配语义，防 `//login` 绕过；缺省 password 视为空串）：QRole 会员账号禁止密码登录、无密码账号（`default-user` 除外）禁止仅凭用户名登录，拒绝按 IP 限流 → QRole 会话校验 → `/register` 在关闭注册时跳转 |
| `routes/public/register.js` | 关闭注册时拒绝；密码必填 8–128；元数据先写再使用邀请码（修复限时码变永久）；`renew-expired` 统一错误、按 IP 限流、仅对已过期账号生效 |
| `routes/public/register-helper.js` | 建号互斥锁；存在孤儿数据目录（官方删除未清数据）的用户名视为已占用；失败回滚 |
| `routes/private/oauth-config.js` | 提供商白名单；GET 不再返回 `clientSecret`（只返回 `hasClientSecret`）；空 Secret 表示保持不变；一次原子写入 |
| `routes/private/set-password.js`、`user-extend.js` | 随机密码账号可免旧密码设置密码；QRole 账号可设密码但不能用于登录；`/renew` 不会把永久账号降级为限时 |
| `config.js` | 原子写入（保留 Docker 符号链接与权限）；YAML 解析失败时拒绝写入并沿用最后一次正确配置；键名防原型污染；`setStcConfigs` 批量写 |
| `middleware/csrf-exemption.js` | 移除 `/api/stc/oauth*`、`/api/stc/users/register`、`/send-verification` 的 CSRF 豁免 |
| `public/login.html`、`register.html`、`welcome.html` | QRole 按钮、按 `enableRegistration` 显示注册入口、固定文案的错误提示（`oauth_error` / `notice`）、修复 `?handle=` 反射型 XSS、购买链接仅允许 http(s) |
| `stc-admin-panel/admin-panel.js`、`index.js` | OAuth 标签新增 QRole 配置；「注册设置」开关；密码安全卡片与 QRole 会话下线提示 |

升级 SillyTavern 时需额外确认：官方 `POST /api/users/login` 仍挂在 `app.use('/api/users', …)` 下（QRole 密码登录拦截依赖相同挂载路径），`setUserDataMiddleware` 仍在 STC `setupPublicRoutes` 之前执行（会话校验依赖 `req.user`），`getAccountVersion` / `getPasswordSalt` 仍从 `src/users.js` 导出。

## 页面背景与站点信息（`site` 配置）

欢迎页 / 登录页 / 注册页原先写死的背景（`t.alcy.cc` 视频与图片、渐变底色、遮罩、樱花）与站点文字（标题、角标、副标题、Logo、功能卡片）改为读取 `config.yaml` 的 `site` 段，默认值与原页面完全一致。全部实现位于 `src/stc-mod/` 与 `default/config.yaml`，**未新增 `server-main.js` 钩子**（仍为 6 个）。

| 文件 | 说明 |
|------|------|
| `services/site-config.js`（新增） | `SITE_DEFAULTS`（冻结）；`getSiteConfig()` 每次调用读取 `site` 并逐项校验（文字去控制字符、去首尾空格、超长截断；地址仅允许相对路径与 http(s)，拒绝 `javascript:` / `data:` 等；`fallback` 拒绝 `<>;{}\`、引号、`url(`、`expression(`；`overlayOpacity` 0–1（接受数字字符串）；`features` ≤ 8 且标题必填、图标须为 `fa-` 类名），无效值回落到该项默认值，从不抛错；`renderSitePage(fileName, pageKind)` 把首个 `<title>` 替换为 HTML 转义后的站点标题，并在 `</head>` 前注入 `<script>window.STC_SITE = {...};</script>`（JSON 中 `< > & U+2028 U+2029` 转义为 `\uXXXX`）；`sendSitePage()` 以 `text/html; charset=utf-8`、`Cache-Control: no-cache` 发送，渲染失败时记录日志并回退为原静态文件 |
| `index.js` | `/`（未登录）、`/login`（未登录）、`/register`（开放注册时）改为 `sendSitePage(...)`；过期跳转、关闭注册跳转、已登录放行等条件不变 |
| `config.js` | `ensureDefaultConfig` 增加 `site` 默认值（含 `features` 数组，仅在缺少该键时写入） |
| `public/welcome.html`、`login.html`、`register.html` | 内置同样的 `STC_SITE_DEFAULTS`，读取 `window.STC_SITE`（经 `/stc-assets/` 直接访问时无注入则用默认值）；背景脚本按配置选择视频 / 图片 / 底色、遮罩透明度与樱花开关；站点文字一律用 `textContent` 写入，地址在前端再次校验 |
| `default/config.yaml` | 新增带中文注释的 `site` 段；`features` 仅以注释示例给出（官方 `config-init` 的 lodash `defaultsDeep` 会按下标合并数组，把默认卡片追加到较短的自定义列表中） |

升级 SillyTavern 时需额外确认：官方 `config-init` 仍只在缺失键时补默认值（`defaultsDeep`），`public/img/logo.png` 仍存在（默认 Logo）。

## S3 存储部署（Docker）

新增文件（不修改官方代码）：

| 文件 | 作用 |
|------|------|
| `docker/docker-compose.s3.yml` | JuiceFS + SillyTavern（+ 可选 `--profile redis` 本地 Redis）；元数据默认走外部 MariaDB/MySQL（`JFS_META_URL`）；通过 `SILLYTAVERN_DATAROOT=/mnt/jfs/fs/data` 把数据根目录放到 JuiceFS |
| `docker/juicefs/entrypoint.sh` | 首次运行 `juicefs format`（仅当元数据报告未格式化；桶内已有数据时 JuiceFS 拒绝格式化并提示恢复）；已格式化时每次启动 `juicefs config` 同步 `s3.env` 中的密钥；之后前台 `juicefs mount` |
| `docker/juicefs/migrate-local-data.sh` | 把旧本地 `data/` 一次性复制进 JuiceFS（有运行中/挂载/非空目标检查） |
| `docker/s3.env.example` | 存储桶与密钥模板（实际 `docker/s3.env` 已忽略） |

`.dockerignore` 排除了 `docker/juicefs`：构建上下文是仓库根目录，若不排除，`docker build` 会遍历整个挂载的存储桶。
依赖上游行为：`src/healthcheck.js` 与 `getConfigValue('dataRoot')` 均读取 `SILLYTAVERN_DATAROOT`；STC-MOD 的 `getDataRoot()` 使用 `globalThis.DATA_ROOT`。

## 已移除功能

- **社区论坛**（`/forum`、`/api/stc/forum/*`）与 **公共角色卡库**（`/public-characters`、`/api/stc/public-characters/*`）已整体移除：
  论坛图片接口存在任意文件读取（路径穿越）与同源 HTML/SVG 上传，帖子内容存在存储型 XSS。
  对应的 `enableForum` / `enablePublicCharacters` 配置项已废弃，旧 `config.yaml` 中残留该键无任何作用。
  旧部署中的 `data/stc-mod/forum_data/`、`data/stc-mod/public_characters/` 不再被读取，可按需手动备份或删除。

## 延迟功能

以下功能因侵入性过高暂缓实现，将在后续版本中考虑：

- **聊天文件分段存储优化**：需要深度修改核心数据读写逻辑，与非侵入式架构冲突
