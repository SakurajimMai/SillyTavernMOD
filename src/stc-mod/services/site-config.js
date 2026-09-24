/**
 * SillyTavernchat Module - Site appearance (config.yaml `site`)
 * Page background and site info of the STC public pages (welcome / login / register).
 * The values are read on every request, so edits to config.yaml apply on the next page load.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStcConfig } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const DEFAULT_FEATURE_ICON = 'fa-solid fa-star';
const MAX_FEATURES = 8;
const MAX_URL_LENGTH = 1024;
const MAX_FALLBACK_LENGTH = 300;
const TEXT_LIMITS = Object.freeze({
    name: 60,
    badge: 60,
    subtitle: 120,
    subtitle2: 120,
    featureTitle: 30,
    featureText: 80,
});

/**
 * Freeze an object and everything it contains.
 * @template T
 * @param {T} value
 * @returns {Readonly<T>}
 */
function deepFreeze(value) {
    if (value && typeof value === 'object') {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
}

/**
 * Default site settings: exactly what the pages showed before they became configurable.
 */
export const SITE_DEFAULTS = deepFreeze({
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
    features: [
        { icon: 'fa-solid fa-comments', title: 'AI 对话', text: '支持多种 LLM 模型' },
        { icon: 'fa-solid fa-masks-theater', title: '角色扮演', text: '丰富的角色卡系统' },
        { icon: 'fa-solid fa-palette', title: '个性化', text: '主题和界面定制' },
        { icon: 'fa-solid fa-puzzle-piece', title: '扩展', text: '强大的扩展生态' },
    ],
});

/**
 * @param {*} value
 * @returns {boolean} Whether the value is a plain (non-array) object
 */
function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Own property of a config object (inherited keys are ignored).
 * @param {*} obj
 * @param {string} key
 * @returns {*}
 */
function own(obj, key) {
    return isPlainObject(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/**
 * Normalize a display text: strip control characters, trim, cut to `maxLength` characters.
 * @param {*} value
 * @param {number} maxLength Maximum length in characters (code points)
 * @returns {string|null} Normalized text, or null if the value is not a string
 */
function cleanText(value, maxLength) {
    if (typeof value !== 'string') return null;
    const text = value.replace(/\p{Cc}/gu, '').trim();
    const chars = Array.from(text);
    return chars.length > maxLength ? chars.slice(0, maxLength).join('').trim() : text;
}

/**
 * Text field that may be empty ('' hides the element on the page).
 * @param {*} value
 * @param {number} maxLength
 * @param {string} fallback
 * @returns {string}
 */
function textOrDefault(value, maxLength, fallback) {
    const text = cleanText(value, maxLength);
    return text === null ? fallback : text;
}

/**
 * Text field that must not be empty.
 * @param {*} value
 * @param {number} maxLength
 * @param {string} fallback
 * @returns {string}
 */
function requiredTextOrDefault(value, maxLength, fallback) {
    const text = cleanText(value, maxLength);
    return text ? text : fallback;
}

/**
 * Validate a URL: a relative path or an absolute http(s) address.
 * javascript:, data:, vbscript:, file: and every other scheme are rejected.
 * @param {*} value
 * @returns {string|null} Trimmed URL ('' for an empty value), or null if invalid
 */
function cleanUrl(value) {
    if (typeof value !== 'string') return null;
    const url = value.trim();
    if (!url) return '';
    if (url.length > MAX_URL_LENGTH || /\p{Cc}/u.test(url)) return null;
    try {
        const { protocol } = new URL(url, 'http://localhost/');
        return protocol === 'http:' || protocol === 'https:' ? url : null;
    } catch {
        return null;
    }
}

/**
 * URL field; '' is kept when `allowEmpty`, otherwise it falls back to the default.
 * @param {*} value
 * @param {string} fallback
 * @param {boolean} allowEmpty
 * @returns {string}
 */
function urlOrDefault(value, fallback, allowEmpty) {
    const url = cleanUrl(value);
    if (url === null || (url === '' && !allowEmpty)) return fallback;
    return url;
}

/**
 * Validate the fallback background (a CSS color or gradient assigned to `style.background`).
 * Anything that could load a resource or break out of the declaration is rejected.
 * @param {*} value
 * @returns {string}
 */
function fallbackOrDefault(value) {
    const fallback = SITE_DEFAULTS.background.fallback;
    if (typeof value !== 'string') return fallback;
    const css = value.trim();
    if (!css || css.length > MAX_FALLBACK_LENGTH) return fallback;
    // <>;{}\ per spec; quotes and control characters too (colors and gradients never need them,
    // and without quotes no image-set()/src() string can load a resource)
    if (/[<>;{}\\"'\p{Cc}]/u.test(css) || /url\(|expression\(/i.test(css)) return fallback;
    return css;
}

/**
 * @param {*} value
 * @returns {number}
 */
function opacityOrDefault(value) {
    let number = NaN;
    if (typeof value === 'number') {
        number = value;
    } else if (typeof value === 'string' && value.trim() !== '') {
        number = Number(value.trim());
    }
    return Number.isFinite(number) && number >= 0 && number <= 1
        ? number
        : SITE_DEFAULTS.background.overlayOpacity;
}

/**
 * @param {*} value
 * @returns {string}
 */
function iconOrDefault(value) {
    if (typeof value !== 'string') return DEFAULT_FEATURE_ICON;
    const icon = value.trim();
    return /^[a-z0-9 -]{1,60}$/.test(icon) && icon.includes('fa-') ? icon : DEFAULT_FEATURE_ICON;
}

/**
 * @param {*} value
 * @returns {{ icon: string, title: string, text: string }[]}
 */
function featuresOrDefault(value) {
    if (!Array.isArray(value)) return structuredClone(SITE_DEFAULTS.features);
    const features = [];
    for (const item of value) {
        if (features.length >= MAX_FEATURES) break;
        if (!isPlainObject(item)) continue;
        const title = cleanText(own(item, 'title'), TEXT_LIMITS.featureTitle);
        if (!title) continue;
        features.push({
            icon: iconOrDefault(own(item, 'icon')),
            title,
            text: textOrDefault(own(item, 'text'), TEXT_LIMITS.featureText, ''),
        });
    }
    return features;
}

/**
 * Site settings from config.yaml `site`, normalized: every key is always present and every
 * invalid value is replaced by its default. Never throws.
 * @returns {{
 *   name: string, badge: string, subtitle: string, subtitle2: string, logoUrl: string,
 *   background: { pcVideoUrl: string, pcImageUrl: string, mobileImageUrl: string,
 *     fallback: string, overlayOpacity: number, sakura: boolean },
 *   features: { icon: string, title: string, text: string }[]
 * }}
 */
export function getSiteConfig() {
    try {
        const site = getStcConfig('site', {});
        const bg = own(site, 'background');
        const defaults = SITE_DEFAULTS;
        const sakura = own(bg, 'sakura');
        return {
            name: requiredTextOrDefault(own(site, 'name'), TEXT_LIMITS.name, defaults.name),
            badge: textOrDefault(own(site, 'badge'), TEXT_LIMITS.badge, defaults.badge),
            subtitle: textOrDefault(own(site, 'subtitle'), TEXT_LIMITS.subtitle, defaults.subtitle),
            subtitle2: textOrDefault(own(site, 'subtitle2'), TEXT_LIMITS.subtitle2, defaults.subtitle2),
            logoUrl: urlOrDefault(own(site, 'logoUrl'), defaults.logoUrl, false),
            background: {
                pcVideoUrl: urlOrDefault(own(bg, 'pcVideoUrl'), defaults.background.pcVideoUrl, true),
                pcImageUrl: urlOrDefault(own(bg, 'pcImageUrl'), defaults.background.pcImageUrl, true),
                mobileImageUrl: urlOrDefault(own(bg, 'mobileImageUrl'), defaults.background.mobileImageUrl, true),
                fallback: fallbackOrDefault(own(bg, 'fallback')),
                overlayOpacity: opacityOrDefault(own(bg, 'overlayOpacity')),
                sakura: typeof sakura === 'boolean' ? sakura : defaults.background.sakura,
            },
            features: featuresOrDefault(own(site, 'features')),
        };
    } catch (error) {
        console.error('[STC-MOD] Failed to read the site settings, using the defaults:', error);
        return structuredClone(SITE_DEFAULTS);
    }
}

/**
 * @param {string} text
 * @returns {string} Text safe for HTML element content and attribute values
 */
function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * JSON that is safe inside an inline <script> (no `</script>`, `<!--`, HTML entities or JS line
 * terminators can be formed).
 * @param {*} value
 * @returns {string}
 */
function jsonForScript(value) {
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,
        char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Page title per page kind */
const PAGE_TITLES = Object.freeze({
    welcome: name => name,
    login: name => `${name} - 登录`,
    register: name => `${name} - 注册账号`,
});

/**
 * Render an STC public page with the site settings: the first <title> gets the configured site
 * name and `<script>window.STC_SITE = {...};</script>` is inserted right before </head>.
 * @param {string} fileName File in src/stc-mod/public (e.g. 'login.html')
 * @param {'welcome'|'login'|'register'} pageKind
 * @returns {Promise<string>} HTML
 */
export async function renderSitePage(fileName, pageKind) {
    if (!Object.hasOwn(PAGE_TITLES, pageKind)) {
        throw new TypeError(`Unknown page kind: ${pageKind}`);
    }
    const html = await fs.promises.readFile(path.join(PUBLIC_DIR, path.basename(fileName)), 'utf8');
    const headEnd = html.search(/<\/head\s*>/i);
    if (headEnd === -1) {
        throw new Error(`${fileName} has no </head>`);
    }

    const site = getSiteConfig();
    const title = escapeHtml(PAGE_TITLES[pageKind](site.name));
    const script = `<script>window.STC_SITE = ${jsonForScript(site)};</script>\n`;
    // Replacer functions: `$&`, `$'`... in the site name must not be expanded
    const head = html.slice(0, headEnd).replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/i, () => `<title>${title}</title>`);
    return head + script + html.slice(headEnd);
}

/**
 * Send a rendered STC public page (no-cache, so config changes show on the next load).
 * Falls back to the static file when rendering fails.
 * @param {import('express').Response} res
 * @param {string} fileName File in src/stc-mod/public
 * @param {'welcome'|'login'|'register'} pageKind
 */
export async function sendSitePage(res, fileName, pageKind) {
    let html;
    try {
        html = await renderSitePage(fileName, pageKind);
    } catch (error) {
        console.error(`[STC-MOD] Failed to render ${fileName}, serving the static page:`, error);
        return res.sendFile(fileName, { root: PUBLIC_DIR });
    }
    res.set({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
    });
    return res.send(html);
}
