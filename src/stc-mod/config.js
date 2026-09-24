/**
 * SillyTavernchat Module - Configuration
 * Reads custom config values from config.yaml under the 'stcMod' namespace.
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

let cachedConfig = null;
// Identity of the file the cache was read from (the atomic writer replaces the inode on every save)
let configStamp = '';
// Identity of the last unreadable file version (logged once, not on every read)
let failedStamp = '';

function getConfigPath() {
    return path.join(process.cwd(), 'config.yaml');
}

/**
 * Read config.yaml (cached until the file changes).
 * A missing file reads as {} and may be created. A file that exists but cannot be read or
 * parsed must not be overwritten (it would lose every setting); reads keep using the last
 * successfully parsed config so switches such as enableRegistration do not fail open.
 * @returns {{ config: object, writable: boolean }}
 */
function loadConfigState() {
    const configPath = getConfigPath();
    let stamp = '';
    try {
        const stat = fs.statSync(configPath);
        stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        if (cachedConfig && stamp === configStamp) return { config: cachedConfig, writable: true };
        const raw = fs.readFileSync(configPath, 'utf8');
        const parsed = yaml.parse(raw) ?? {};
        if (typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('top level is not a mapping');
        }
        cachedConfig = parsed;
        configStamp = stamp;
        failedStamp = '';
        return { config: cachedConfig, writable: true };
    } catch (e) {
        if (e?.code === 'ENOENT') return { config: {}, writable: true };
        if (stamp !== failedStamp || !stamp) {
            failedStamp = stamp;
            console.error('[STC-MOD] Failed to read config.yaml (using the last valid settings, saving is disabled until it is fixed):', e.message);
        }
        return { config: cachedConfig || {}, writable: false };
    }
}

function loadFullConfig() {
    return loadConfigState().config;
}

/**
 * Resolve the file that should actually be replaced, so a symlinked config.yaml
 * (Docker: config.yaml -> ./config/config.yaml) keeps its link.
 * @param {string} configPath
 * @returns {string}
 */
function resolveWriteTarget(configPath) {
    try {
        return fs.realpathSync(configPath);
    } catch (e) {
        if (e?.code !== 'ENOENT') throw e;
        try {
            // Dangling symlink: create its target instead of replacing the link
            return path.resolve(path.dirname(configPath), fs.readlinkSync(configPath));
        } catch {
            return configPath;
        }
    }
}

/**
 * Overwrite a file in place (fallback when an atomic rename is impossible).
 * Best effort: put the previous content back if the write fails halfway.
 * @param {string} target
 * @param {string} data
 */
function writeFileInPlace(target, data) {
    let original = null;
    try {
        original = fs.readFileSync(target);
    } catch {
        // Nothing to restore
    }
    try {
        fs.writeFileSync(target, data, 'utf8');
    } catch (e) {
        if (original !== null) {
            try {
                fs.writeFileSync(target, original);
            } catch {
                // Keep the original error
            }
        }
        throw e;
    }
}

/**
 * Atomically write the config object to config.yaml: write a temp file next to the
 * real target, fsync it, then rename it over the target. The original stays intact
 * if anything fails before the rename.
 * @param {object} config
 * @returns {boolean} true if the file was written
 */
function writeConfigFile(config) {
    let tmpPath = null;
    try {
        const data = yaml.stringify(config);
        const target = resolveWriteTarget(getConfigPath());
        let targetStat = null;
        try {
            targetStat = fs.statSync(target);
        } catch {
            // New file
        }

        const tmpCandidate = `${target}.${process.pid}.${Date.now()}.tmp`;
        let fd;
        try {
            fd = fs.openSync(tmpCandidate, 'wx', targetStat ? targetStat.mode & 0o777 : 0o666);
        } catch (e) {
            // Directory not writable while the file itself may be: keep the old in-place behavior
            if (!['EACCES', 'EPERM', 'EROFS'].includes(e?.code)) throw e;
            writeFileInPlace(target, data);
            return true;
        }
        tmpPath = tmpCandidate;
        try {
            if (targetStat) {
                // Keep the original owner and permissions (the file holds OAuth / SMTP secrets)
                try {
                    fs.fchownSync(fd, targetStat.uid, targetStat.gid);
                } catch {
                    // Not permitted for non-root users; ownership stays with the current user
                }
                try {
                    fs.fchmodSync(fd, targetStat.mode & 0o777);
                } catch {
                    // Not supported on this platform
                }
            }
            fs.writeFileSync(fd, data, 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }

        try {
            fs.renameSync(tmpPath, target);
            tmpPath = null;
        } catch (e) {
            // e.g. config.yaml is a single-file bind mount (EBUSY) or on another device (EXDEV)
            if (!['EBUSY', 'EXDEV', 'EPERM', 'EACCES'].includes(e?.code)) throw e;
            fs.rmSync(tmpPath, { force: true });
            tmpPath = null;
            writeFileInPlace(target, data);
        }
        return true;
    } catch (e) {
        console.error('[STC-MOD] Failed to write config.yaml:', e.message);
        if (tmpPath) {
            try {
                fs.rmSync(tmpPath, { force: true });
            } catch {
                // Ignore cleanup errors
            }
        }
        return false;
    }
}

/**
 * Get a STC-MOD specific config value.
 * Looks under config.yaml keys directly (e.g. 'enableInvitationCodes', 'oauth.github.enabled', etc.)
 * @param {string} key Dot-separated key path
 * @param {*} defaultValue Default value if key not found
 * @returns {*}
 */
export function getStcConfig(key, defaultValue = undefined) {
    const config = loadFullConfig();
    const parts = key.split('.');
    let current = config;
    for (const part of parts) {
        if (current == null || typeof current !== 'object') return defaultValue;
        current = current[part];
    }
    return current !== undefined ? current : defaultValue;
}

const FORBIDDEN_KEY_PARTS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Assign a dot-separated key path inside a config object.
 * @param {object} config
 * @param {string} key
 * @param {*} value
 */
function assignPath(config, key, value) {
    const parts = String(key).split('.');
    if (parts.some(part => !part || FORBIDDEN_KEY_PARTS.has(part))) {
        throw new Error(`Invalid config key: ${key}`);
    }
    let current = config;
    for (let i = 0; i < parts.length - 1; i++) {
        if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
            current[parts[i]] = {};
        }
        current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
}

/**
 * Set several config values and save config.yaml once.
 * @param {Record<string, *>} entries Map of dot-separated key path -> value
 * @returns {boolean} true if the file was written
 */
export function setStcConfigs(entries) {
    const { config: current, writable } = loadConfigState();
    if (!writable) {
        console.error('[STC-MOD] config.yaml could not be read or parsed; refusing to overwrite it. Fix the file and save again.');
        return false;
    }

    // Work on a copy: the cache only changes once the file was written
    const config = structuredClone(current);
    for (const [key, value] of Object.entries(entries)) {
        assignPath(config, key, value);
    }

    if (!writeConfigFile(config)) return false;
    cachedConfig = config;
    return true;
}

/**
 * Set a config value and save to config.yaml
 * @param {string} key Dot-separated key path
 * @param {*} value Value to set
 * @returns {boolean} true if the file was written
 */
export function setStcConfig(key, value) {
    return setStcConfigs({ [key]: value });
}

/**
 * Ensure default STC config values exist in config.yaml
 */
export function ensureDefaultConfig() {
    const defaults = {
        enableInvitationCodes: false,
        // 开放注册：false 时隐藏注册入口并拒绝所有注册；仅 QRole 会员登录仍可自动开户
        enableRegistration: true,
        purchaseLink: '',
        oauth: {
            github: { enabled: false, clientId: '', clientSecret: '', callbackUrl: '' },
            discord: { enabled: false, clientId: '', clientSecret: '', callbackUrl: '' },
            linuxdo: {
                enabled: false, clientId: '', clientSecret: '', callbackUrl: '',
                authUrl: 'https://connect.linux.do/oauth2/authorize',
                tokenUrl: 'https://connect.linux.do/oauth2/token',
                userInfoUrl: 'https://connect.linux.do/api/user',
            },
            qrole: {
                enabled: false, clientId: '', clientSecret: '', callbackUrl: '',
                authUrl: 'https://www.qqy.one/api/oauth/authorize',
                tokenUrl: 'https://www.qqy.one/api/oauth/token',
                userInfoUrl: 'https://www.qqy.one/api/oauth/userinfo',
                scope: 'openid profile email',
                // client_secret_post | client_secret_basic
                tokenAuthMethod: 'client_secret_post',
                usePkce: true,
                // 仅允许下列 QRole 会员等级登录（membershipTierId）；关闭则任何 QRole 用户都可登录
                requireMembership: true,
                allowedTiers: ['vip', 'svip'],
                // userinfo 中会员等级 / 到期时间所在字段（按顺序取第一个存在的，支持 a.b 路径）
                tierClaims: ['membershipTierId', 'membership_tier', 'membership.tierId', 'membership.tier', 'tier'],
                expiryClaims: ['membershipExpiresAt', 'membership_expires_at', 'membership.expiresAt'],
                // 会员状态复核间隔（小时）：超过后需重新通过 QRole 登录以确认会员仍有效；0 = 仅按已知到期时间/等级判断
                reverifyHours: 24,
            },
        },
        email: {
            enabled: false,
            smtp: { host: '', port: 587, secure: false, user: '', password: '' },
            from: '',
            fromName: 'SillyTavern',
            siteUrl: '',
        },
        userStorage: {
            enabled: false,
            defaultLimitMiB: 500,
            dailyCheckInMiB: 0,
        },
        privacy: {
            secretsVault: {
                requireForApiKeys: true,
                unlockTtlMinutes: 1440,
            },
        },
        deployment: {
            // 反向代理信任设置（手动配置，无自动探测）。
            // false = 不信任任何反代（默认，本地 HTTP 直连用）；
            // 1 = 单层反代（nginx/OpenResty/Caddy）；
            // 2 = 双层（例如 Cloudflare + 自建反代）；
            // 'cloudflare' = 仅信任 Cloudflare IP 段并使用 CF-Connecting-IP 取真实访客 IP；
            // true = 信任全部跳数（不推荐）。
            trustProxy: false,
        },
        // 登录 / 注册 / 欢迎页的站点信息与背景（校验规则见 services/site-config.js，修改后刷新页面即生效）
        site: {
            name: 'SillyTavern',
            badge: 'Silly Tavern',
            subtitle: 'AI 角色扮演与对话平台',
            subtitle2: 'Creative · Immersive · Extensible',
            logoUrl: 'img/logo.png',
            background: {
                pcVideoUrl: 'https://t.alcy.cc/acg',
                pcImageUrl: '',
                mobileImageUrl: 'https://t.alcy.cc/moemp',
                fallback: 'linear-gradient(125deg,#06040f 0%,#180d3a 40%,#0d1b3e 70%,#06040f 100%)',
                overlayOpacity: 0.52,
                sakura: true,
            },
            // 欢迎页功能卡片（仅在缺少该键时写入；[] = 不显示）
            features: [
                { icon: 'fa-solid fa-comments', title: 'AI 对话', text: '支持多种 LLM 模型' },
                { icon: 'fa-solid fa-masks-theater', title: '角色扮演', text: '丰富的角色卡系统' },
                { icon: 'fa-solid fa-palette', title: '个性化', text: '主题和界面定制' },
                { icon: 'fa-solid fa-puzzle-piece', title: '扩展', text: '强大的扩展生态' },
            ],
        },
    };

    const { config: current, writable } = loadConfigState();
    if (!writable) {
        console.error('[STC-MOD] config.yaml could not be read or parsed; default STC config values were not added. Fix the file and restart.');
        return;
    }
    const config = structuredClone(current);
    let changed = false;

    function mergeDefaults(target, source, prefix = '') {
        for (const [key, val] of Object.entries(source)) {
            const isSection = val && typeof val === 'object' && !Array.isArray(val);
            // An empty YAML section (e.g. "qrole:") parses as null; treat it as missing
            if (target[key] === undefined || (target[key] === null && isSection)) {
                target[key] = structuredClone(val);
                changed = true;
            } else if (isSection && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
                mergeDefaults(target[key], val, `${prefix}${key}.`);
            }
        }
    }

    mergeDefaults(config, defaults);

    if (changed) {
        if (writeConfigFile(config)) {
            cachedConfig = config;
            console.log('[STC-MOD] Default configuration values added to config.yaml');
        } else {
            console.error('[STC-MOD] Failed to save default config');
        }
    }
}

export function getDataRoot() {
    return globalThis.DATA_ROOT || path.join(process.cwd(), 'data');
}

export function getStcDataDir() {
    const dir = path.join(getDataRoot(), 'stc-mod');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}
