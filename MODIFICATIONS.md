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
| `getAccountVersion` | `oauth.js`、`set-password.js`、`services/qrole-export.js` | 第三方登录/改密后写入 `session.version`（与官方登录一致）；QRole 数据导出会话绑定账号版本 |
| `createBackupArchive` | `routes/public/qrole-export.js` | QRole 仅导出页面下载数据（与官方「备份全部数据」相同的 ZIP，按官方规则排除 API 密钥文件） |
| `getIpAddress`、`retryAfter`（`src/express-common.js`） | `index.js`、`register.js` | 限流按 IP 计数（与官方登录限流同源） |
| `getPasswordHash` | `register-helper.js` | 生成密码哈希 |
| `ensurePublicDirectoriesExist` | `register-helper.js` | 确保用户公共目录存在 |
| `shouldRedirectToLogin` | 官方 `server-main.js`（参考） | 判断是否需要跳转登录 |

## 新增目录结构

```
src/stc-mod/
├── index.js                         # 模块入口（5个导出函数）
├── config.js                        # 配置系统（读写 config.yaml）
├── user-metadata.js                 # 扩展用户数据存储（内存缓存 + 分级刷盘）
├── middleware/
│   ├── csrf-exemption.js            # CSRF 豁免规则
│   ├── trust-proxy.js               # 反代 trust proxy 配置
│   ├── storage-enforce.js           # 存储配额拦截（请求分类、不增大的保存放行、异步统计）
│   └── expiration-check.js          # 用户过期检查中间件
├── routes/
│   ├── public/
│   │   ├── register.js              # 用户注册
│   │   ├── register-helper.js       # 注册辅助（调用官方用户创建）
│   │   ├── oauth.js                 # OAuth 第三方登录
│   │   ├── invitation-status.js     # 邀请码状态
│   │   ├── announcements-public.js  # 登录页公告
│   │   ├── email-status.js          # 邮件服务状态
│   │   ├── qrole-export.js          # QRole 会员过期后的仅导出数据 API
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
│       ├── qrole-status.js          # 当前用户 QRole 会员状态（到期提醒）
│       ├── qrole-accounts.js        # QRole 账号列表、复核与过期账号清理（管理员）
│       └── scheduled-tasks.js       # 定时任务（管理员）
├── services/
│   ├── json-store.js                # JSON 数据文件读写（错误分类、.bak / .corrupt、原子写入、挂载检测与看门狗、503 映射）
│   ├── data-root-watchdog.js        # 挂载看门狗检查循环（工作线程入口；挂载无响应时 SIGKILL）
│   ├── announcements.js             # 公告数据（公开与管理路由共用）
│   ├── email-service.js             # 邮件服务
│   ├── invitation-codes.js          # 邀请码逻辑
│   ├── system-monitor.js            # 系统监控
│   ├── storage-quota.js             # 存储配额、异步占用统计缓存、签到与扩容激活码
│   ├── privacy-vault.js             # API 密钥保险箱（用户口令加密）
│   ├── site-config.js               # 页面背景与站点信息（config.yaml `site`，校验 + 页面注入）
│   ├── oauth-client.js              # OAuth HTTP / 客户端认证 / 身份解析（登录与后台复核共用）
│   ├── qrole-lifecycle.js           # QRole 会员到期处理的纯逻辑（配置、会话判定、账号状态、清理日期）
│   ├── qrole-token-crypto.js        # QRole 刷新令牌加密（AES-256-GCM，本地密钥文件）
│   ├── qrole-reverify.js            # 用刷新令牌向 QRole 后台复核会员
│   ├── qrole-export.js              # QRole 仅导出数据会话
│   ├── qrole-cleanup.js             # QRole 账号列表与过期账号自动清理
│   ├── user-deletion.js             # 删除账号（记录 + 数据目录 + 元数据），路由与清理任务共用
│   ├── flush-scheduler.js           # 两级刷盘调度（活跃时间 60 s / 真实变更 5 s，单计时器，可注入时钟）
│   ├── settings-safeguard.js        # POST /api/settings/get 前补齐缺失的 settings.json
│   ├── user-content-seed.js         # 新账号默认内容（newUserContent: full / minimal）与 settings.json 补齐
│   └── default-template.js          # 默认用户模板
├── tests/
│   ├── qrole-lifecycle.test.mjs     # QRole 到期处理纯逻辑测试（node 直接运行）
│   ├── user-metadata-flush.test.mjs # user-metadata.json 刷盘策略测试（假时钟 / 模拟计时器 + 临时目录）
│   ├── settings-safeguard.test.mjs  # settings.json 保护测试（临时目录 + 默认 settings.json 补齐）
│   ├── user-content-seed.test.mjs   # 新账号默认内容与补齐测试（临时目录 + 官方内容索引）
│   ├── json-store.test.mjs          # 读取分类（ENOENT / EIO / EACCES / EISDIR）、.bak 恢复（含主文件缺失）、.corrupt 保留、expect-missing 冲突、挂载检测（启动失败、观察到的故障永久化）、看门狗（含工作线程）
│   ├── user-metadata-unavailable.test.mjs # 元数据首次读取失败：抛错、节流重试、从不写入
│   ├── stc-stores.test.mjs          # 保险箱 / 邀请码 / 公告 / 默认模板 / 监控历史 / QRole 清理在读取失败时的行为
│   ├── register-unavailable.test.mjs # 注册在数据不可用时不建号；挂载消失时不解除 OAuth 绑定、不覆盖已有账号
│   ├── gates-unavailable.test.mjs   # QRole 会话校验与到期检查在元数据不可用时返回 503
│   ├── storage-quota.test.mjs       # 配额请求分类（对照官方路由）、变小 / 不变的保存、角色卡编辑额度、按增量预估、占用缓存（单飞 / 超时不叠加 / 预估 / 重新统计 / 未知）、限流器与统计的内存和并发上限
│   └── storage-codes.test.mjs       # 存储激活码读取失败返回 503、不消耗激活码；上限保存失败时 persisted: false 并重试；数据不可用时不删除账号
└── public/
    ├── login.html                   # 自定义登录页（含 OAuth 按钮）
    ├── register.html                # 注册页
    ├── qrole-expired.html           # QRole 会员过期后的仅导出数据页面
    └── welcome.html                 # 欢迎页
```

## 数据存储

所有外挂模块数据存储在 `data/stc-mod/` 目录中，**不修改**官方用户数据结构：

| 文件/目录 | 内容 |
|-----------|------|
| `user-metadata.json` | 扩展用户字段（OAuth ID、邮箱、过期时间、存储限额、密码状态、QRole 会员快照与加密的刷新令牌等） |
| `user-metadata.json.bak` | 上一份 `user-metadata.json`，只在写入真实变更时刷新（即最近一次真实变更之前的状态，`lastActiveAt` 可能较旧）；主文件损坏时自动从它恢复 |
| `invitation-codes.json` | 邀请码数据 |
| `storage-codes.json` | 存储激活码数据 |
| `announcements/` | 公告数据 |
| `default-template/` | 新用户默认配置模板 |
| `privacy-vaults/` | API 密钥保险箱元数据（不含明文密钥） |
| `system-monitor-history.json` | 系统监控历史 |
| `qrole-cleanup-state.json` | QRole 过期账号清理的上次运行时间与结果 |
| `qrole-cleanup-log.json` | QRole 过期账号清理的删除记录（最近 200 条） |

以上文件都通过 `services/json-store.js` 读写：只有「文件不存在」视为空；内容无法解析时先从 `<文件>.bak` 恢复，没有可用备份时从空开始并把原文件复制为 `<文件>.corrupt-<时间戳>`；其他读取错误（EIO、ENOTCONN、EACCES、挂载消失等）抛出 `StoreUnavailableError`，接口返回 503，从不当成空数据、也不写回（见 [存储故障保护与配额统计](#存储故障保护与配额统计)）。写入均为临时文件 + rename（保留原权限）。

QRole 刷新令牌的加密密钥 `stc-mod-token.key` **不在** `data/` 中，而是与 `config.yaml` 同目录（Docker：`config/stc-mod-token.key`），因为数据目录可能位于远程对象存储；需与配置一起备份。

## 配置项

在 `config.yaml` 中添加的配置项（首次启动时自动写入默认值）：

```yaml
enableInvitationCodes: false    # 启用邀请码系统
stcDataRootWatchdog: true       # 数据根目录挂载看门狗（代码默认值，不自动写入；只在数据根目录是单独挂载时生效）
stcDataRootMustBeMount: false   # true：数据根目录不是单独挂载时 STC 数据不可用（503），看门狗开启时退出（代码默认值，不自动写入）
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
    scope: 'openid profile email membership'   # membership：QRole userinfo 返回 membership_tier / membership_expires_at
    tokenAuthMethod: client_secret_post   # 或 client_secret_basic
    usePkce: true                # PKCE S256（QRole 端可对本应用勾选「强制 PKCE」）
    requireMembership: true      # 仅允许 allowedTiers 中的会员登录
    allowedTiers: [vip, svip]    # 由 STC 自动写入；default/config.yaml 中不预置数组（避免 lodash 按下标合并）
    tierClaims: [membershipTierId, membership_tier, membership.tierId, membership.tier, tier]
    expiryClaims: [membershipExpiresAt, membership_expires_at, membership.expiresAt]
    reverifyHours: 24            # 会员状态复核间隔（小时），0 = 仅按已知到期时间/等级
    # 以下为会员到期处理配置：代码内置默认值（统一由 qrole-lifecycle.js 读取），STC 启动时不写入；
    # default/config.yaml 中带注释列出（官方 config-init 会为已有 config.yaml 补上同样的值）
    backgroundReverify: true     # 加密保存 QRole 刷新令牌，到期/到达复核间隔时后台向 QRole 复核
    renewUrl: 'https://www.qqy.one/membership'   # 「去续费」链接（仅 http(s)，无效用默认值）
    expiryReminderDays: 7        # 到期前 N 天显示续费提醒，0-60，0 = 不提醒
    expiredDataExport: true      # 过期 / 非会员的已有账号 QRole 登录后进入仅导出数据页面
    expiredCleanup:
      enabled: false             # 自动清理过期 QRole 账号
      afterDays: 90              # 保留天数，30-3650

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
| GET | `/api/stc/qrole-export/status` | QRole 仅导出会话的账号与会员信息（需 QRole 回调建立的导出会话，否则 401 `EXPORT_EXPIRED`） |
| GET | `/api/stc/qrole-export/archive` | 下载该账号数据 ZIP（官方 `createBackupArchive`；403 `EXPORT_DISABLED` / 409 `EXPORT_BUSY` / 429 `EXPORT_RATE_LIMITED`） |
| POST | `/api/stc/qrole-export/logout` | 结束导出会话（需 CSRF） |

### 私有 API（需认证）

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/api/stc/users/me-ext` | 获取当前用户扩展信息 |
| POST | `/api/stc/users/renew` | 续费（使用邀请码） |
| POST | `/api/stc/users/heartbeat` | 心跳（更新在线时间） |
| GET | `/api/stc/users/storage` | 获取存储信息（新增 `unknown` / `pending` / `pendingMiB` / `computedAt`；未知时 `usedMiB` 等为 `null`、`canWrite: true`） |
| POST | `/api/stc/users/check-in` | 每日签到 |
| POST | `/api/stc/users/use-storage-code` | 使用存储激活码 |
| GET | `/api/stc/users/password-status` | 检查当前用户密码状态 |
| POST | `/api/stc/users/set-password` | 设置/修改密码（首次设置或修改） |
| POST | `/api/stc/users/verify-password` | 验证当前密码 |
| GET | `/api/stc/announcements/current` | 获取当前公告 |
| GET | `/api/stc/qrole/status` | 当前用户的 QRole 会员状态（到期提醒；非 QRole 账号与管理员返回 `{qrole:false}`） |
| POST | `/api/stc/qrole/refresh-status` | 立即用刷新令牌向 QRole 复核（每账号每分钟 1 次；需 CSRF） |

### 管理员 API

| 方法 | 路径 | 功能 |
|------|------|------|
| GET/POST | `/api/stc/registration-config/config` | 获取/设置开放注册（`{enableRegistration}`） |
| POST | `/api/stc/invitation-codes/create` | 创建邀请码 |
| GET | `/api/stc/invitation-codes/list` | 列出所有邀请码 |
| POST | `/api/stc/invitation-codes/delete` | 删除邀请码 |
| GET/POST | `/api/stc/email-config/config` | 获取/设置邮件配置 |
| POST | `/api/stc/email-config/test` | 测试邮件发送 |
| GET/POST | `/api/stc/oauth-config/config` | 获取/设置 OAuth 配置（QRole 含会员到期处理配置） |
| GET | `/api/stc/qrole-accounts` | QRole 账号列表（状态、到期、占用空间、刷新令牌、计划清理）与清理设置 / 上次结果 |
| POST | `/api/stc/qrole-accounts/verify` | 用刷新令牌立即复核一个账号（`{handle}`） |
| POST | `/api/stc/qrole-accounts/cleanup/preview` | 预览下次清理将删除的账号（不联网复核） |
| POST | `/api/stc/qrole-accounts/cleanup/run` | 立即执行一次清理（与定时任务相同的代码路径；需已开启自动清理） |
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
| GET | `/api/stc/scheduled-tasks/storage-analysis` | 用户存储分析（按用户统计聊天/角色卡/备份等；读缓存，约 5 秒后返回部分结果，行内 `unknown` / `pending`，响应含 `pendingCount` / `unknownCount` / `complete`） |
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

### OAuth 自动开户的账号名

`routes/public/register-helper.js` 的 `getOAuthHandleCandidates`：候选账号名依次为第三方用户名（非保留名、至少 2 个字符）、`<提供商>-<用户名>`（新增，如 `qrole-admin`）、`<提供商>-<用户 ID>`，都被占用时再加随机后缀。此前保留名用户（如 QRole 用户名 `admin`）会直接得到 `qrole-<用户 ID>` 这类难以辨认的账号名。已创建的账号不受影响。

### QRole `membership` 授权范围适配

QRole 新增 `membership` 授权范围：userinfo 返回 `membership_tier`（有效等级，小写；过期的付费会员为 `free`）、`membership_tier_name`、`membership_expires_at`（ISO-8601 UTC，仅 `free` 为 `null`），并支持 PKCE S256（客户端可设「强制 PKCE」）；QRole 管理员在后台「系统设置 → OAuth 应用」创建本站客户端，无需修改 QRole 的 `.env`。STC 侧改动：

| 文件 | 说明 |
|------|------|
| `config.js` | `oauth.qrole.scope` 默认值改为 `openid profile email membership`；启动时若该值仍是旧默认 `openid profile email` 且 `requireMembership` 未关闭，自动升级为新默认（日志 `oauth.qrole.scope upgraded`），自定义 Scope 不改动 |
| `routes/public/oauth.js` | `PROVIDER_DEFAULTS.qrole.scope`（`scope` 留空时的回退值）同步为 `openid profile email membership`；PKCE（S256）流程不变 |
| `default/config.yaml` | 新安装的 `oauth.qrole.scope` 默认值同上，并注明 `membership` 与 PKCE 的作用 |
| `stc-admin-panel/admin-panel.js` | QRole Scope 输入框占位符改为新默认值，并提示「仅允许会员登录」时必须包含 `membership` |
| `services/qrole-membership.js` | 未改动：默认等级 / 到期字段已包含 `membership_tier` / `membership_expires_at`，ISO 时间字符串与 `null` 均已支持 |

### QRole 会员到期处理

会员过期的 QRole 用户：到期前提醒；续费后由服务器用刷新令牌在后台复核，无需重新登录；确实过期时只能进入仅导出数据的页面；管理员可查看过期账号并可选开启自动清理。全部实现位于 `src/stc-mod/`、`stc-admin-panel/` 与 `default/config.yaml`，**未新增 `server-main.js` 钩子**（仍为 6 个）。

| 文件 | 说明 |
|------|------|
| `services/qrole-lifecycle.js`（新增） | 纯逻辑：`getQroleLifecycleConfig()`（新配置项的唯一读取入口，含默认值与范围校验）、`evaluateQroleSession`、`decideQroleSession`（会话守卫决策表，依赖注入便于测试）、`isLapseRecentlyConfirmed`（QRole 5 分钟内刚确认过未付费时不再复核）、账号状态 `active / expired / not_member`、`computeCleanupAt`、`getCleanupEligibility` / `checkCleanupStillDue`（清理删除前的最终检查）、`buildMembershipSnapshot`（QRole 把过期会员报告为 `free` 且无到期时间时保留上次的过去到期时间；`qroleDeniedAt` 在每次被拒绝登录时更新，后台复核只在缺失时设置）、`planVerificationOutcome` |
| `services/qrole-token-crypto.js`（新增） | 刷新令牌 AES-256-GCM 加密，信封 `v1.<iv>.<tag>.<密文>`（base64url），AAD = 账号 handle；密钥 32 字节，存于 `config.yaml` 同目录的 `stc-mod-token.key`（`wx` + 0600，并发安全创建）；密钥不可用时功能降级并只记录一次警告；无法解密的令牌视为不存在并删除 |
| `services/oauth-client.js`（新增） | 从 `oauth.js` 移出的共用代码：`requestJson`、令牌端点客户端认证（`client_secret_post/basic`）、身份 id 解析、`refresh_token` 授权 + userinfo |
| `services/qrole-reverify.js`（新增） | `verifyQroleMembership(handle)`：刷新令牌 → userinfo（总超时 8 秒）→ 与登录相同的会员判定；userinfo 的用户 id 必须等于账号绑定的 `oauthUserId`。结果 `ok`（更新快照、`qroleVerifiedVia: 'refresh'`）、`definitive`（400 `invalid_grant`、格式错误的令牌响应、身份不符、账号被封：删除令牌）、`transient`（网络、超时、429、5xx、其他 4xx、缺少会员字段，以及 401 / `invalid_client`：保留令牌并冷却 5 分钟）、`no_token`；`invalid_client` 是本站客户端凭据的问题而非账号的问题，因此不删除令牌，并每 5 分钟最多记录一条面向管理员的警告；同一账号并发调用共享一次请求；从不抛错、不记录令牌 |
| `services/qrole-session.js` | 守卫改为异步：快照无效且有可用令牌、未在冷却中时先后台复核，已续费则放行；QRole 在 5 分钟内刚确认过未付费（`qroleDeniedAt` 非空且 `qroleCheckedAt` 在 5 分钟内）时直接拒绝、不再复核（防止重放旧会话 Cookie 反复请求 QRole）；复核暂时失败时，仅 `membership_reverify` 在距上次复核 2 倍间隔内放行，`membership_expired` / `not_member` 一律拒绝 |
| `services/qrole-export.js`（新增） | 仅导出会话 `req.session.stcQroleExport = {handle, oauthUserId, version, reason, createdAt}`（不设置 `req.session.handle`，官方与 STC 中间件都不会视为已登录）；每次请求校验：30 分钟内、账号存在且启用、非管理员、仍绑定同一 QRole 用户、账号版本未变、功能仍开启 |
| `routes/public/oauth.js` | QRole 令牌响应额外读取 `refresh_token` / `refresh_token_expires_in`；登录成功时按规则保存或删除加密令牌（`requireMembership` 与 `backgroundReverify` 均开启才保存）；会员 `membership_expired` / `not_member` 且已有启用的非管理员账号时，更新快照（`qroleDeniedAt`）、保存令牌、建立导出会话并跳转 `/qrole-expired`；成功登录清除导出会话；查找已绑定账号时若该账号正在被删除，等待删除结束后重新查找（不会登录进正在删除的账号） |
| `routes/public/qrole-export.js`（新增） | `/api/stc/qrole-export/status`、`/archive`（每账号并发 1、每小时 3 次；需官方 `backups.allowFullDataBackup`）、`/logout`；无效会话 401 `EXPORT_EXPIRED`，浏览器页面请求跳转 `/login?oauth_error=export_expired` |
| `routes/private/qrole-status.js`（新增） | `/api/stc/qrole/status` 与 `/refresh-status`（返回的 `valid` / `reason` 与守卫在下一次页面加载时的判定一致；`valid: false` 时横幅直接跳转 `/login?oauth_error=<reason>`） |
| `services/qrole-cleanup.js`、`routes/private/qrole-accounts.js`（新增） | 管理员账号列表（`hasRefreshToken` 与用户自己的状态接口规则一致：功能开启、令牌未过期且密钥可用）、单账号复核、清理预览与执行；定时器每小时检查（`unref`），每 24 小时最多执行一次、每次最多删除 20 个、最多联网复核 50 个（连续 3 次暂时失败，或一次 `invalid_client`，即停止复核并顺延）；每个账号处理前重新读取配置（清理被关闭则停止任务）与记录 / 元数据，持有令牌的先复核（复核期间账号变化 `no_account` → 跳过）；先统计占用空间，再在删除锁内做最终检查（`checkCleanupStillDue`：续费、改绑、被设为管理员、有新活动、清理被关闭 → 不删除）后立即删除；`POST /cleanup/run` 支持 `{background: true}`（202，管理面板轮询 `GET /cleanup/status`）；运行状态与删除日志写入 `data/stc-mod/qrole-cleanup-*.json` |
| `services/user-deletion.js`（新增） | `deleteUserWithLock` 从 `user-extend.js` 移出，`delete-single` / `delete-batch` 与自动清理共用；可选 `precheck`（持锁后、删除前执行，返回原因即取消删除）；`isUserDeletionInProgress` / `waitForUserDeletion` 供登录流程使用 |
| `user-metadata.js` | `sanitizeMeta()`（去除 `qroleRefreshToken`，`/api/stc/users/all-meta`、`/expiration-list` 使用）、`unsetUserMetaFields()`；新增字段 `qroleRefreshToken`（加密，永不返回）、`qroleRefreshTokenExpiresAt`、`qroleTierName`、`qroleDeniedAt`、`qroleVerifiedVia` |
| `routes/private/oauth-config.js` | GET 返回新配置项（已填默认值）；POST 校验 `backgroundReverify`、`expiredDataExport`、`renewUrl`（`''` = 默认）、`expiryReminderDays`（0–60）、`expiredCleanup: {enabled?, afterDays?}`（30–3650） |
| `index.js` | `/qrole-expired` 页面路由（已登录跳 `/`，无导出会话跳 `/login`，会话失效跳 `/login?oauth_error=export_expired`，否则 `sendSitePage`）；挂载上述路由并启动清理定时器；密码登录前清除导出会话 |
| `config.js`、`services/site-config.js`、`services/storage-quota.js` | `getConfigDir()`（解析 Docker 符号链接后的配置目录）；页面类型 `qrole-expired`；`calculateUserStorageAsync()` |
| `public/qrole-expired.html`（新增）、`public/login.html` | 仅导出页面（站点背景 / 品牌与登录页相同）；登录页 `membership_expired` / `not_member` 提示数据仍保留、续费后重新登录可恢复原账号，新增 `export_expired` |
| `stc-admin-panel/index.js`、`style.css` | 非管理员已登录用户的到期提醒横幅（启动时与每 6 小时查询一次；关闭后按账号 + 到期时间在 24 小时内不再显示）；只有刷新令牌晚于会员到期时间失效时才提示「续费后无需重新登录」；`esc()` 同时转义引号 |
| `stc-admin-panel/admin-panel.js` | 「OAuth 配置」QRole 新增「会员到期处理」（续费链接只在修改后才提交，未改动保存不会把空值写成默认链接）；新增「QRole 会员」标签（筛选、复核、删除 / 批量删除、自动清理设置、预览、立即执行（后台运行并轮询结果）、上次结果）；`esc()` 同时转义引号（QRole 返回的等级名称用于 `title` 属性） |
| `default/config.yaml` | 带中文注释的新配置项 |
| `tests/qrole-lifecycle.test.mjs`（新增） | `node src/stc-mod/tests/qrole-lifecycle.test.mjs`：令牌信封（篡改 / 错误 AAD 失败）、状态与清理日期、刷新失败分类（含 `invalid_client` 保留令牌）、守卫决策表（含 5 分钟内重放不再复核）、清理最终检查、`sanitizeMeta` |

运维注意：
- `stc-mod-token.key` 须与 `config/` 一起备份；丢失后会自动生成新密钥，旧令牌无法解密而被删除，影响仅是 QRole 用户需要重新登录一次。直接运行时该文件在项目根目录（未加入 `.gitignore`），不要提交。
- 生产环境数据根目录在 JuiceFS 上：被自动清理删除的文件会先进入 JuiceFS 回收站（`JFS_TRASH_DAYS`，默认 7 天），代码不依赖回收站。

升级 SillyTavern 时需额外确认：`createBackupArchive(handle, res)` 仍从 `src/users.js` 导出且仍在未开启 `allowKeysExposure` 时排除 `secrets.json`；`backups.allowFullDataBackup` 仍是官方完整备份开关；`setUserDataMiddleware` 只根据 `req.session.handle` 识别登录用户（导出会话依赖这一点）；`/csrf-token` 仍在登录中间件之前（导出页面退出需要 CSRF 令牌）。

## 对象存储写入优化（元数据刷盘策略、新用户默认内容与 settings.json 保护）

生产数据根目录位于 JuiceFS（Backblaze B2）：每次整文件改写都会上传新数据块，旧版本进入 JuiceFS 回收站。全部实现位于 `src/stc-mod/`，**未修改官方文件，也未新增 `server-main.js` 钩子**。

| 文件 | 说明 |
|------|------|
| `services/flush-scheduler.js`（新增） | `createFlushScheduler({ flush, realDelayMs, activityDelayMs, retryDelayMs?, clock?, onError? })`：待写状态 `none` → `activity` → `real`（只升不降，写入后归零）；单个 unref 计时器，截止时间取最早者（真实变更把待写的活跃时间提前到 5 s 内，活跃心跳不会推迟已排定的写入，也不会延长 60 s 窗口）；截止时间使用单调时钟（`performance.now()`，与计时器一致），系统时间跳变（NTP 校时、虚拟机恢复）不会把真实变更推迟到 60 s；`flushNow()` 同步写入全部待写内容；`flush` 回调返回 `false` / 抛错时保留待写状态并在 `retryDelayMs`（默认 60 s）后重试。无文件 I/O，时钟与计时器可注入 |
| `user-metadata.js` | `FLUSH_DEBOUNCE_MS = 5000`、`ACTIVITY_FLUSH_MS = 60_000`；`setUserMeta()` 的补丁只含 `lastActiveAt` 时（`isActivityOnlyPatch()`，即 `recordActivity()` / 心跳）按活跃变更处理，其余（含 `recordLogin()` 的 `lastLoginAt`、`unsetUserMetaFields()`、`deleteUserMeta()`、迁移）为真实变更；`immediate: true`、`flushMetadata()`（现返回是否成功）、`invalidateCache()` 与 `exit` / `SIGINT` / `SIGTERM` 钩子都会同步写入全部待写内容（含活跃时间）；写入仍为临时文件 + rename，`.bak` 只在包含真实变更的写入时刷新。主文件无法解析（或不是 JSON 对象）时从 `.bak` 恢复，恢复后下一次写入不会用损坏的主文件覆盖 `.bak`；`.bak` 也不可用时，两个文件改名保留为 `<文件名>.corrupt-<时间戳>`（改名失败则复制），元数据从空开始。`invalidateCache()` 写入失败时保留缓存（改动仍待写、已安排重试）并返回 `false`。`SIGINT` / `SIGTERM` 钩子写入后，只在没有其他监听器时才 `process.exit(0)`：官方 `server-main.js` 的 `exitProcess`（统计、插件清理、磁盘缓存）随后照常执行，其 `process.exit()` 触发 `exit` 钩子再写一次（无待写内容时不写）。新增 `getMetadataFlushState()`（诊断 / 测试，`dueAt` 为单调时钟毫秒）。内存缓存仍是唯一数据源，读取立即可见 |
| `services/user-content-seed.js`（新增） | 新账号 / 重置账号的默认内容。`config.yaml` 顶层 `newUserContent`（每次注册时读取，无需重启）：`full`（默认，官方行为）或 `minimal`。`seedNewUserContent(directories)`：`minimal` 时先写 `content.log`（列出除 SETTINGS / AVATAR 类型与 `default/scaffold` 内容之外的全部用户级默认内容，`wx` 从不覆盖），再调用与官方创建用户相同的 `checkForNewContent([directories], [CONTENT_TYPES.SETTINGS])`，官方逻辑因此只复制 `settings.json`、`User Avatars/user-default.png` 与 scaffold 内容（以及全局内容）；`full` 时直接调用官方逻辑；写 `content.log` 失败时回退为完整内容。`restoreUserSettings(directories)`（settings.json 保护使用）：`minimal` 且 `content.log` 不存在（官方重置账号）时按新账号处理，否则只复制缺失的默认 `settings.json` 与默认用户头像（`COPYFILE_EXCL`，从不覆盖、不改 `content.log`），**从不** 复制完整默认内容。默认内容索引按官方 `getContentIndex` 的方式读取 `default/scaffold/index.json` 与 `default/content/index.json`（该函数未导出） |
| `routes/public/register-helper.js` | `ensureUserDirectories()` 改为调用 `seedNewUserContent(directories)`（本地注册与 OAuth / QRole 注册共用） |
| `services/settings-safeguard.js`（新增） | `ensureUserSettingsFile`：`req.user.directories` 存在、用户根目录存在而 `settings.json` 缺失时，`await restoreUserSettings(directories)`（见上），每次补齐记录一条日志，同一用户的并发请求共用一次补齐；然后 `next()`。任何错误只记录日志，从不抛出；文件存在、未登录或根目录不存在（账号正在删除）时不做任何事。`createEnsureUserSettingsFile({ seed })` 供测试注入 |
| `index.js` | `setupPublicRoutes` 中紧接 QRole 会话校验之后，以挂在 `/api/settings` 上的路由器注册 `POST /get` → `ensureUserSettingsFile`（与官方 `settingsRouter` 相同的挂载与匹配语义），在官方处理器之前执行 |

背景：`skipContentCheck: true` 时，官方 `POST /api/users/reset-step2` 删除用户根目录后调用未强制 SETTINGS 的 `checkForNewContent([directories])`，该调用直接返回，用户没有 `settings.json`，官方 `POST /api/settings/get` 读取失败返回 500。官方创建用户（`users-admin.js` 与 STC 注册共用的 `checkForNewContent([directories], [SETTINGS])`）会复制 `content.log` 中未记录的 **全部** 默认内容（约 190 个文件、约 15 MiB），`skipContentCheck` 只跳过启动时对所有用户的内容检查（每个用户每次启动改写一次 `content.log`）与账号重置后的补齐，不减少新用户的默认内容，因此另设 `newUserContent: minimal`。settings.json 保护若沿用官方补齐，重置后的第一次 `settings/get` 会在请求中同步复制全部默认内容（对象存储上阻塞整个服务器），因此只补 `settings.json` 与默认头像。官方管理员「创建用户」（`/api/users/create`）不经过 STC，仍复制完整默认内容。

升级 SillyTavern 时需额外确认：`src/endpoints/content-manager.js` 仍导出 `checkForNewContent(directoriesList, forceCategories)`、`getUserTargetByType(type, directories)` 与 `CONTENT_TYPES`（`SETTINGS`、`AVATAR`），`seedContent` 仍跳过 `content.log` 中已记录（且未被强制）的条目并把 `content.log` 存为以换行分隔的文件名，默认内容索引仍为 `default/scaffold/index.json` 与 `default/content/index.json`（`[{ filename, type }]`），`src/constants.js` 仍导出 `SETTINGS_FILE`，`src/util.js` 仍导出 `setPermissionsSync`，官方设置接口仍为 `app.use('/api/settings', …)` 下的 `POST /get` 并从 `request.user.directories.root` 读取 `settings.json`，`setUserDataMiddleware` 仍在 `setupPublicRoutes` 之前执行；`server-main.js` 仍在加载 STC 模块之后才注册 `SIGINT` / `SIGTERM` 的 `exitProcess` 并以 `process.exit()` 结束。

其他周期性写入（已检查，未修改）：`services/system-monitor.js` 每 5 分钟改写 `system-monitor-history.json`（最多 288 个点）并复制一份 `.bak`；`services/qrole-cleanup.js` 每小时检查、每 24 小时最多运行一次并写入状态 / 日志；`routes/private/scheduled-tasks.js` 每分钟检查，仅在备份清理到期时写 `config.yaml`。以上均不高于每 5 分钟一次。

测试：`node src/stc-mod/tests/user-metadata-flush.test.mjs`、`node src/stc-mod/tests/settings-safeguard.test.mjs`、`node src/stc-mod/tests/user-content-seed.test.mjs`（不需要启动服务器，不访问网络；元数据测试的模拟计时器需要 Node ≥ 20.11）。

## 存储故障保护与配额统计

生产数据根目录位于 JuiceFS（Backblaze B2）FUSE 挂载上：juicefs 容器重启后应用容器内的挂载可能消失，同一路径随之指向下面 **空的** 本地目录（处处 ENOENT）；FUSE 进程异常时读取返回 ENOTCONN / EIO。远程读取故障绝不能被当成「没有数据」。全部实现位于 `src/stc-mod/` 与 `stc-admin-panel/`，**未修改官方文件，也未新增 `server-main.js` 钩子**。

### 读取故障不等于空数据

| 文件 | 说明 |
|------|------|
| `services/json-store.js`（新增） | `readJsonFile(file, { validate, backup, guard })` 返回 `ok` / `missing`（ENOENT，挂载检测仍通过，且没有可用的 `.bak`；损坏的 `.bak` 先复制为 `.bak.corrupt-<ts>`）/ `recovered`（主文件损坏或不存在、`.bak` 可用；损坏文件复制为 `.corrupt-<ts>`，下次写入不会用它覆盖 `.bak`；主文件不存在时带 `mainMissing: true`，首次写入按 expect-missing 创建）/ `corrupt`（无可用备份；主文件与损坏的 `.bak` 复制保留，复制失败则按不可用处理）；其他任何错误抛出 `StoreUnavailableError`（`code: 'STORE_UNAVAILABLE'`，`status: 503`，技术原因在 `.detail`）。读取前后都检查挂载（读到的也可能是挂载消失后下面的旧副本）；「无法读取」「已从 .bak 恢复」日志对同一文件版本最多每 10 分钟一条。`writeJsonFileAtomic()`：临时文件（保留原权限、fsync）+ rename，可选 `.bak`；`expectMissing`（数据按 `missing` 读入时）用硬链接创建目标，目标已存在则 `StoreConflictError`（重新读取而不覆盖），不支持硬链接时退回独占创建；链接成功后删除临时文件失败只记录日志（写入已完成，不报 503）。`createJsonStore({ label, file, validate, empty })` 提供 `read` / `load` / `update(mutator)`（冲突最多重试 3 次，未变化不写入；mutator 可能执行多次）/ `write`。挂载检测：`initDataRootGuard({ requireMount })` 在加载时记录数据根目录的设备号，设备号与 `/` 不同即视为单独挂载（生产中 `/mnt/jfs/fs/data` 位于挂载点 `/mnt/jfs/fs` 之内）；启动时 stat 出现 ENOENT 以外的错误（如 `ENOTCONN`），或 `stcDataRootMustBeMount: true` 而数据根目录不是单独挂载时，记为永久丢失（`lostReason`），直到重启都返回 503。此后每次读写 STC 数据前 `assertDataRootAvailable()` 确认仍可 stat 且设备号未变，否则 `StoreUnavailableError`（挂载消失导致的 ENOENT 不算 `missing`）。设备号检测发现不了「短暂消失后以相同设备号重新挂载」（Linux 复用匿名设备号），因此看门狗运行时，任何一次读写观察到的故障都是永久的（`markLost`）：之后不再读写，约 1 s 后退出（留时间发出 503 响应）。`startDataRootWatchdog()`：默认在工作线程（`services/data-root-watchdog.js`）中每 5 s 异步 stat 一次，失败或设备号变化时通知主线程记录错误、永久拒绝 STC 读写并 `process.exit(1)`（10 s 内仍未退出则由工作线程 SIGKILL）；stat 卡住 60 s（挂载无响应）时工作线程直接写 fd 2 日志并 SIGKILL（`process.exit` 会等待卡在 stat 中的线程池线程，永远不返回；主线程被同步调用卡住时计时器也照常运行）；stat 已等待 5 s 以上时 `checkDataRoot()` 直接拒绝，不再在主线程上同步 stat 卡住的挂载。启动时已不可用则立即退出。注入 `statAsync`（测试）时在主线程运行。HTTP：`sendStoreUnavailable` / `respondStoreError` / `storeErrorHandler` 返回 503 `{ error: '数据存储暂时不可用，请稍后重试', code: 'STORE_UNAVAILABLE' }`（`Retry-After: 30`；页面返回一行 503 文字） |
| `middleware/data-root-write-guard.js`（新增） | 数据根目录不可用时，任意路径的 POST / PUT / PATCH / DELETE（`/api/users/logout` 除外）一律 503 `STORE_UNAVAILABLE`。`setupPublicRoutes` 最先注册一次；再用 `useRightAfter(app, multerMonkeyPatch, …)` 在官方 `app.use(multerMonkeyPatch)` 之后、官方路由之前注册第二次（只包装实例上的 `app.use`，注册后立即恢复；`setupPrivateRoutes` 时若未注册成功则恢复并告警）。`middleware/storage-enforce.js`：`StoreUnavailableError` 返回 503 而不是放行，等待用量统计前后各检查一次挂载 |
| `services/data-root-watchdog.js`（新增） | 看门狗检查循环 `createWatchdogLoop()`（主线程与工作线程共用）与工作线程入口；与主线程通过 `SharedArrayBuffer` 共享「stat 等待起始时间」和「已丢失」标记（时间用 `performance.timeOrigin + performance.now()`，不受 `Date.now()` 改写影响） |
| `config.js` | `getStcDataDir()` 先检查挂载，用 stat 判断目录，只在 ENOENT 时、并再次确认挂载后创建；其他错误为不可用。挂载消失时从不在下面的本地目录中创建目录 |
| `user-metadata.js` | 首次读取失败（不可用）时不创建空缓存：每次访问都抛出，最多每 5 s（`LOAD_RETRY_MS`）重试一次；读取成功之前从不写入（包括退出钩子）。读取成功后内存缓存仍为唯一数据来源，写入失败保持待写并重试。按 `missing` 读入（或主文件不存在、从 `.bak` 恢复）后若文件在首次写入前出现，则合并进缓存（内存中的值优先）而不是覆盖。新增 `ensureUserMetadataLoaded()`、`getMetadataLoadState()`；`setUserMeta()` 返回布尔值（`immediate: true` 且写入失败时为 `false`） |
| `services/invitation-codes.js`、`services/storage-quota.js`（存储激活码） | 改用 `createJsonStore`（读取错误抛出，不再返回 `[]`）。使用邀请码 / 激活码时先读取元数据（此时已不可用则不消耗任何码），再标记已用，再延长到期时间 / 提高上限（立即写入）。两次写入之间挂载恰好消失时，新值留在内存中待写并重试，记录一条带用户名、激活码和数值的错误日志，结果带 `persisted: false`；进程在重试成功前退出时激活码已用而新值未落盘，需要按日志手动补上 |
| `services/announcements.js`（新增）、`routes/private/announcements.js`、`routes/public/announcements-public.js` | 公告读写集中到服务；读取错误返回 503；目录只在写入时创建 |
| `services/privacy-vault.js`、`routes/private/privacy-vault.js`、`index.js` | 只有记录不存在才表示「未启用」；读取错误为 `StoreUnavailableError`（503），记录损坏为 `VaultRecordCorruptError`（500 `VAULT_RECORD_CORRUPT`，文件保留，可通过重置恢复）。启用使用 expect-missing，从不覆盖已有记录；重置先检查挂载，非 ENOENT 的删除错误视为不可用（官方代码因此不会在故障时清空已加密的密钥）。`index.js` 在官方 `POST /api/secrets/write` 之前检查受保护密钥的保险箱记录（503 / 500），密钥绝不会被当成未启用保险箱而明文保存。密钥 TTL 计时器改为 unref |
| `services/default-template.js`、`routes/private/default-config.js` | 不存在或损坏 = 没有模板（损坏时记录日志并保留文件）；其他错误 503；目录只在保存时创建 |
| `services/qrole-cleanup.js` | 状态与日志文件改用 json-store；运行前检查挂载、元数据与状态文件，任一不可用则跳过本次（不记录，下一次每小时检查重试）；删除前的最终检查在挂载失效时否决；运行中遇到不可用时以 `stopped: 'store_unavailable'` 停止，不记录为已完成 |
| `services/system-monitor.js` | 历史只读取一次后保存在内存；读取失败期间新快照只保存在内存、从不写文件（不会用较短的历史覆盖），恢复后合并；首次读取成功前路由返回 503；无法测量数据根目录时磁盘信息带 `unknown: true` |
| `services/user-deletion.js` | `deleteUserWithLock()` 在持锁后、调用方 precheck 之前检查挂载并加载元数据，不可用时返回 `{ success: false, skipped: 'store_unavailable' }`，不删除任何东西；每次删除尝试后使该用户的占用缓存失效 |
| `services/settings-safeguard.js` | 挂载失效时不补写 `settings.json` |
| `index.js`、`middleware/expiration-check.js`、`services/qrole-session.js` | 加载时初始化挂载检测、启动看门狗（`stcDataRootWatchdog`，默认 `true`；启动时 `getStcDataDir()` 失败只记录日志）；`storeErrorHandler` 最后注册，把任何 STC 路由抛出或 `next()` 的 `StoreUnavailableError` 映射为 503。登录拦截先查官方账号记录（无账号直接交给官方登录），元数据不可读时返回 503 而不是放行；QRole 会话校验在 `requireMembership` 开启时、元数据不可读返回 503 并保留会话（例外：管理员、未登录、`requireMembership: false`）；到期检查对非管理员返回 503；`/` 与 `/qrole-expired` 返回 503 页面 |
| `routes/public/oauth.js`、`routes/public/register-helper.js`、`routes/public/register.js` | `findUserByOAuth` 不可用时抛出（不会为已绑定的身份新建第二个账号），回调重定向 `server_error`；建号前检查挂载并加载元数据（`createUser` 返回 `unavailable: true`，注册接口返回 503）；账号创建后兑换邀请码时存储不可用则回滚账号并返回 503；应用默认模板失败不影响注册。node-persist 把 ENOENT 读成「没有记录」，挂载消失时所有记录都「不存在」：`resolveLinkedAccount()` 只有在 `isAccountRecordGone()`（读取前后检查挂载、`_storage` 目录存在、重新读取记录）确认后才清除绑定，记录存在但不匹配时也先检查挂载；`createUser` / `createOAuthUser` 在写入官方记录与 `dropStaleMeta` 之前再用 `isAccountRecordGone()` 确认用户名空闲（前面的查找可能正好碰上挂载消失），否则不建号 |
| 其余路由（`user-extend.js`、`user-storage.js`、`invitation-codes.js`、`set-password.js`、`qrole-status.js`、`qrole-accounts.js`、`qrole-export.js`、`scheduled-tasks.js`） | 所有 try/catch 先 `respondStoreError()`（503），同步路由经 `storeErrorHandler`。批量 / 单个删除用户、清理不活跃用户先检查挂载与元数据，挂载丢失时立即停止；候选只从已加载的元数据中选出；「重置用户」与备份清理在挂载失效时返回 503，不在本地目录中重建文件夹 |

已检查、无需修改（均为失败即拒绝）：`password-migration`（记录日志、不写入；无密码仅凭用户名的登录仍由拦截器阻止）、`qrole-reverify`（错误视为暂时性，从不删除）。

官方数据（node-persist `_storage`、用户目录）不在范围内：挂载消失后已登录请求一般先因官方会话查找失败返回 403，看门狗随后重启进程。

### 存储配额：删除与不增大的保存从不拦截

`middleware/storage-enforce.js`（在 `setupPublicRoutes` 中注册，位于全局 body parser 与 `setUserDataMiddleware` 之后、官方路由与 multer 之前）改为异步中间件，`classifyRequest(method, path)` 先按 Express 的匹配方式规范化路径（小写、合并重复斜杠、去掉结尾斜杠；此前 `/API/Files/Upload/` 可绕过配额），`/api/stc/*` 与 GET/HEAD 从不检查：

- **free（从不拦截，成功后约 1.5 s 重新统计）**：任何 `DELETE` 请求，以及最后一段为 `delete` / `remove` / `rename` / `clear` / `purge` 的 `/api/...` POST。
- **write（超额时 507）**：`BLOCKED_ROUTES` 中的精确路由，以及四个上传前缀下除只读路由外的所有 POST（官方以后新增的上传路由默认受限）。
- **read / none（从不拦截）**：上传前缀下的只读路由，以及其他所有请求。

对照 `src/endpoints/*.js` 中官方 `router.post(...)` 的分类（`tests/storage-quota.test.mjs` 读取 13 个官方路由文件，新增或改变分类而未更新此表时测试失败）：

| 前缀 | write（超额拦截） | read / 不检查 | free（从不拦截） |
|------|------------------|---------------|------------------|
| `/api/files` | `upload` | `sanitize-filename`、`verify` | `delete` |
| `/api/images` | `upload` | `list`、`list/:folder`、`folders` | `delete` |
| `/api/sprites` | `upload`、`upload-zip` | （`GET /get`） | `delete` |
| `/api/backgrounds` | `upload` | `all`、`folders` | `delete`、`rename` |
| `/api/chats` | `save`（变小或内容不变时放行）、`group/save`（同上）、`import`、`group/import` | `get`、`export`、`group/get`、`group/info`、`search`、`recent` 等 | `delete`、`rename`、`group/delete` |
| `/api/characters` | `create`、`import`、`duplicate`、`edit-avatar`；`edit`、`edit-attribute`、`merge-attributes`（请求 ≤ 1 MiB 时放行） | `all`、`get`、`chats`、`export` | `delete`、`rename` |
| `/api/worldinfo` | `edit`（不增大时放行）、`import` | `list`、`get` | `delete` |
| `/api/backups` | – | `chat/get`、`chat/download` | `chat/delete` |
| `/api/avatars` | `upload` | `get` | `delete` |
| `/api/groups` | `create` | `all`、`edit` | `delete` |
| `/api/content` | `importURL`、`importUUID` | – | – |
| `/api/assets` | `download` | `get`、`character` | `delete` |
| `/api/extensions` | `install` | `update`、`branches`、`switch`、`move`、`version` | `delete` |

超额时的保存检查（`resolveSaveTargetPath()` / `resolveShrinkTarget()` / `checkShrinkingSave()`）按官方处理器解析目标文件：聊天 `chats/<avatar_url 去掉 .png>/sanitize(<file_name>.jsonl)`（含 `avatar_url` 校验与 `isPathUnderParent`），新大小为 `chat.map(JSON.stringify).join('\n')` 的字节数；群聊 `groupChats/sanitize(<id>.jsonl)`（必须直接位于该目录）；世界书 `worlds/sanitize(<name>.json)`（同官方的 `entries` 检查），新大小为 `JSON.stringify(data, null, 4)`。聊天与群聊只在新大小 **小于** 现有大小时放行：官方每次保存聊天都会（每个聊天最多每 10 s 一次）写入一份 **完整** 的备份，每个角色 / 群聊最多保留 `backups.common.numberOfBackups`（默认 50）份，`backups.chat.maxTotalBackups` 默认 `-1` 没有总数上限，所以反复提交「不变大」的保存会把备份放大到聊天大小的数十倍。大小相同时读取现有文件逐字节比较：完全相同（酒馆在切换角色等操作时会重新保存未改动的聊天）由中间件直接返回官方的 `{ ok: true }`，不调用官方处理器（无需写入，也不产生备份）；内容不同则 507。世界书没有备份，新大小 ≤ 现有大小即放行。无法安全解析、文件不存在、不是文件或无法读取（EIO 等）时仍拦截。启用配额的部署建议设置 `backups.chat.maxTotalBackups`。角色卡编辑（`edit`、`edit-attribute`、`merge-attributes`）在 multer 之前无法解析 multipart 表单、找不到对应的卡片，超额时按 Content-Length ≤ `CARD_EDIT_ALLOWANCE_BYTES`（1 MiB）放行（没有 Content-Length 时拦截）：每张卡片最多增大几 MiB，超额时无法新建卡片。507 响应结构不变（`error`、`code: 'STORAGE_QUOTA_EXCEEDED'`、`message`、`usedMiB`、`limitMiB`、`percent`），`message` 提示删除聊天或消息、角色卡、背景图片或聊天备份（删除不受限制），或联系管理员扩容。检查失败时的「Storage quota check failed ... allowing」警告每个用户每分钟最多一条（附带省略的次数）。

仍不受配额限制的写入（单个文件被整体替换、不会无限累积，或属于维护操作）：`/api/settings/save` 与设置快照、预设 / 主题 / 快速回复 / 界面布局保存、`/api/groups/edit`、`/api/vector/insert`、扩展更新 / 切换 / 移动。

### 占用统计：不再在保存前同步扫描用户目录

`services/storage-quota.js` 删除了同步的 `calculateUserStorage`；每个用户的占用缓存为 `{ bytes, categories, computedAt, pendingBytes, errorAt, error }`（`categories`：按顶层目录统计的字节数，供存储分析使用）：

- **统计**：`measureDirectory()` 完全异步，所有统计共用一个限流器，并发文件操作数为 libuv 线程池大小减 1（`UV_THREADPOOL_SIZE`，默认 4 → 3，最多 16），其他异步文件读写（官方请求、看门狗）总有空闲线程；限流队列按下标出队（`Array#shift` 在大队列上是 O(n)，12 万个文件的统计因此变成平方级）。每次统计固定数量的工作协程按「先文件、后子目录」深度优先处理，只保存正在处理的目录列表，不会为每个文件预先创建任务；可用 `AbortSignal` 中止（下一个文件操作前停止）。统计期间被删除的文件跳过；统计前后都检查挂载（统计中途挂载消失时剩余目录看起来「已删除」，结果按未知处理而不是缓存一个偏小的值）。同一用户同时只有一次统计（单飞，直到统计真正结束）；`invalidate()` 丢弃并中止正在进行的统计。
- **未知而不是 0**：任何错误（包括用户目录不存在、挂载检测报告挂载丢失或设备变化）得到 `null`（未知），不会缓存为 0；失败后 30 s 内不重试。
- **超过 2 分钟的统计**：不再有人等待它（从未统计过的用户显示未知、错误 `ETIMEDOUT`，已有旧值的继续使用旧值），但仍占用该用户的单飞位置，不会再为同一目录开始第二次统计；它最终完成时结果照常缓存（以前超时后结果被丢弃，30 s 后又开始新的统计，同一目录的统计越叠越多，占用永远未知，配额不再生效）。
- **新鲜度与等待**：结果 10 分钟内直接使用；配额检查最多等待 8 s，`/me-ext`、`/storage`、`/can-write` 最多等待 3 s，超时后使用旧值或未知值，统计在后台继续。
- **未知时放行**：占用未知时允许写入，每个用户最多每 5 分钟记录一条警告。
- **写入后**：2xx 写入把预估增量加入 `pendingBytes`，并在第一次写入后 30 s 内重新统计（后续写入不会推迟）；统计期间发生的写入保持待计入。聊天 / 群聊 / 世界书保存（`estimateSaveGrowth()`）按目标文件增大的字节数计入（写入前 stat 现有文件；聊天的新大小用 Content-Length 近似，不再重复序列化；新文件全额计入），而不是每次都把整份聊天当作新数据，接近上限的用户不会因为连续两次保存被误判超额；其他写入按 Content-Length（或上传文件大小 + 请求体大小）计入。
- **仅因预估超额**：用户只是因为 `pendingBytes` 超出上限时，拒绝前先重新统计（上次统计不足 5 s 时除外），避免每次保存整份聊天的预估造成误报 507。
- **删除 / 改名后**：约 1.5 s 后重新统计；此时若有统计正在进行，结束后再统计一次。
- **管理员列表**：`/api/stc/user-storage/all-users`、QRole 账号列表 / 清理预览、存储分析同时最多统计 4 个用户，5 s 后返回部分结果（未完成的为 `unknown` / `pending`），统计在后台继续填充缓存；按名称排序时只统计当前页。清理不活跃用户 / 发送提醒按存储过滤时，占用未知的用户会被跳过（从不作为删除候选）。
- **返回字段**：原有字段含义不变，新增 `unknown`、`pending`、`pendingMiB`、`computedAt`；未知时 `usedMiB`、`percent`、`remainingMiB` 为 `null`，`canWrite` 为 `true`。`getUserStorageInfo()` / `canUserWrite()` 仍保留，但只读缓存（从不扫描）；异步版本为 `getUserStorageInfoAsync()` / `canUserWriteAsync()`。
- **缓存失效**：删除用户（`deleteUserWithLock`）、重置用户、管理员修改用户上限时立即失效；重新开启配额功能时清空全部缓存。签到与激活码只修改上限（上限不缓存）。官方 `/api/users/delete` 无法挂钩，重新创建同名账号最多约 10 分钟内可能看到旧的占用。
- **备份清理**：`/api/stc/scheduled-tasks/clean-backups` 与定时清理改为异步、同时最多 4 个用户，完成后触发重新统计；挂载失效时拒绝执行。
- **管理面板**（`stc-admin-panel/index.js`、`admin-panel.js`）：显示「统计中…」「未知」「约 X MiB」，未知时不显示进度条；存储分析表显示待统计数量。

负载：每个活跃写入的用户大约每 30 s 触发一次异步统计（远少于以前每次保存前的同步全量扫描）；间隔常量均从 `storage-quota.js` 导出，可按需调大。

测试：`node src/stc-mod/tests/json-store.test.mjs`、`user-metadata-unavailable.test.mjs`、`stc-stores.test.mjs`、`register-unavailable.test.mjs`、`gates-unavailable.test.mjs`、`storage-quota.test.mjs`、`storage-codes.test.mjs`（不需要启动服务器，不访问网络）。

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
