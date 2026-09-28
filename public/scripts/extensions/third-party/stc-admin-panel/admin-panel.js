// @ts-nocheck
// STC Admin Panel - Full-featured admin UI
// Maps to /api/stc/* endpoints provided by src/stc-mod/

// ─────────────── State ───────────────
let csrfToken = null;
let currentInvitationCodes = [];
let currentAnnouncements = [];
let currentLoginAnnouncements = [];
let systemLoadInterval = null;
let systemLoadPaused = false;
let currentUserPage = 1;
let currentCodePage = 1;
let currentStoragePage = 1;
let currentInactivePage = 1;
const USERS_PER_PAGE = 20;
const CODES_PER_PAGE = 50;
const STORAGE_PER_PAGE = 30;
const INACTIVE_PER_PAGE = 20;
let userSearchTerm = '';
let codeSearchTerm = '';
let storageSearchTerm = '';
let _storageAnalysisCache = null; // { total, totalPages, data[], searchTerm, page }

// ─────────────── Helpers ───────────────
async function getCsrfToken() {
    try {
        const r = await fetch('/csrf-token');
        const d = await r.json();
        csrfToken = d.token;
    } catch {}
}

function getHeaders() {
    if (window.getRequestHeaders && typeof window.getRequestHeaders === 'function') {
        try { return window.getRequestHeaders(); } catch {}
    }
    const h = { 'Content-Type': 'application/json' };
    if (csrfToken) h['x-csrf-token'] = csrfToken;
    return h;
}

/** HTML-escape text for element content AND quoted attribute values (quotes included). */
function esc(s) {
    const d = document.createElement('div');
    d.textContent = String(s ?? '');
    return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function copyText(text) {
    navigator.clipboard.writeText(text).catch(() => {
        const t = document.createElement('textarea');
        t.value = text;
        document.body.appendChild(t);
        t.select();
        document.execCommand('copy');
        document.body.removeChild(t);
    });
}

function toast(msg, isError = false) {
    // Use simple custom toast with high z-index and !important styles
    // to ensure visibility on both PC and mobile
    if (!document.getElementById('stc-toast-style')) {
        const style = document.createElement('style');
        style.id = 'stc-toast-style';
        style.textContent = `
            @keyframes stcFadeIn {
                from { opacity: 0; transform: translateX(-50%) translateY(-10px); }
                to { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
            .stc-toast-message {
                position: fixed !important;
                top: 20px !important;
                left: 50% !important;
                transform: translateX(-50%) !important;
                z-index: 2147483648 !important;
                padding: 12px 24px !important;
                border-radius: 8px !important;
                font-size: 14px !important;
                font-family: inherit !important;
                box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important;
                animation: stcFadeIn 0.3s ease !important;
                pointer-events: auto !important;
                max-width: 90% !important;
                word-wrap: break-word !important;
                color: #fff !important;
            }
            #stc-admin-modal.stc-toast-active {
                padding-top: 80px !important;
                transition: padding-top 0.3s ease !important;
            }
        `;
        document.head.appendChild(style);
    }

    const el = document.createElement('div');
    el.className = 'stc-toast-message';
    el.textContent = msg;
    el.style.background = isError ? '#e74c3c' : '#27ae60';

    // Always append to body to ensure it's above everything
    document.body.appendChild(el);

    // Push down the admin modal to reveal the toast
    const adminModal = document.getElementById('stc-admin-modal');
    if (adminModal) {
        adminModal.classList.add('stc-toast-active');
    }

    setTimeout(() => {
        el.style.transition = 'opacity 0.3s';
        el.style.opacity = '0';
        setTimeout(() => {
            el.remove();
            // Restore admin modal position
            if (adminModal) {
                adminModal.classList.remove('stc-toast-active');
            }
        }, 300);
    }, 3000);
}

function setBtn(id, loading, origHtml) {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (loading) {
        btn.disabled = true;
        btn._orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 处理中...';
    } else {
        btn.disabled = false;
        btn.innerHTML = origHtml || btn._orig || '完成';
    }
}

function emptyState(icon, title, desc) {
    return `<div style="text-align:center;padding:40px;color:#888">
        <i class="fa-solid ${icon}" style="font-size:2em;margin-bottom:10px;display:block"></i>
        <h4 style="margin:0 0 5px">${esc(title)}</h4>
        <p style="margin:0;font-size:0.85em">${esc(desc)}</p></div>`;
}

function createPagination(current, total, btnClass = 'stc-page-btn') {
    if (total <= 1) return '';
    const pages = [];
    const range = (s, e) => { for (let i = s; i <= e; i++) pages.push(i); };
    if (total <= 7) { range(1, total); }
    else {
        pages.push(1);
        if (current > 3) pages.push('...');
        range(Math.max(2, current - 1), Math.min(total - 1, current + 1));
        if (current < total - 2) pages.push('...');
        pages.push(total);
    }
    return `<div style="display:flex;gap:6px;justify-content:center;align-items:center;margin:12px 0;flex-wrap:wrap">
        <button class="${btnClass} menu_button" data-page="${current - 1}" ${current <= 1 ? 'disabled' : ''} style="padding:4px 10px;white-space:nowrap">
            <i class="fa-solid fa-chevron-left"></i> 上一页</button>
        ${pages.map(p => p === '...' ? `<span style="opacity:.5;padding:0 4px">...</span>` :
            `<button class="${btnClass} menu_button" data-page="${p}" ${p === current ? 'disabled style="background:rgba(108,99,255,.4)"' : ''} style="padding:4px 10px;min-width:36px">${p}</button>`
        ).join('')}
        <button class="${btnClass} menu_button" data-page="${current + 1}" ${current >= total ? 'disabled' : ''} style="padding:4px 10px;white-space:nowrap">
            下一页 <i class="fa-solid fa-chevron-right"></i></button>
    </div>`;
}

// ─────────────── Panel HTML skeleton ───────────────
export function buildAdminPanelHTML() {
    return `
<div id="stc-admin-modal" style="position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:2147483647;display:flex;align-items:flex-start;justify-content:center;padding:20px;overflow-y:auto">
  <div style="position:relative;z-index:1;background:#16213e;border-radius:12px;width:100%;max-width:960px;min-height:500px;box-shadow:0 8px 32px rgba(0,0,0,.5);color:#eee;font-family:sans-serif">

    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 24px;border-bottom:1px solid #2a3a5e">
      <h2 style="margin:0;font-size:1.3em"><i class="fa-solid fa-screwdriver-wrench" style="color:#6c63ff;margin-right:8px"></i>STC 管理面板</h2>
      <button id="stc-admin-close" style="background:none;border:none;color:#888;font-size:1.4em;cursor:pointer;padding:4px 8px">✕</button>
    </div>

    <!-- Tabs -->
    <div id="stc-tabs" style="display:flex;gap:4px;padding:12px 24px 0;flex-wrap:wrap;border-bottom:1px solid #2a3a5e">
      ${[
        ['system', 'fa-chart-line', '系统监控'],
        ['invitation', 'fa-ticket', '邀请码'],
        ['announcements', 'fa-bullhorn', '公告管理'],
        ['email', 'fa-envelope', '邮件配置'],
        ['oauth', 'fa-key', 'OAuth 配置'],
        ['template', 'fa-copy', '默认模板'],
        ['storage', 'fa-database', '用户空间'],
        ['users', 'fa-users-gear', '用户管理'],
        ['qrole', 'fa-crown', 'QRole 会员'],
        ['tasks', 'fa-clock', '定时任务'],
      ].map(([id, icon, label]) =>
        `<button class="stc-tab-btn" data-tab="${id}" style="padding:8px 14px;border:none;border-radius:8px 8px 0 0;cursor:pointer;font-size:0.85em;background:rgba(255,255,255,.04);color:#aaa;transition:all .2s">
          <i class="fa-solid ${icon}" style="margin-right:5px"></i>${label}</button>`
      ).join('')}
    </div>

    <!-- Content -->
    <div id="stc-tab-content" style="padding:24px;min-height:400px">
      <div style="text-align:center;padding:60px;color:#666">点击上方标签加载内容</div>
    </div>

  </div>
</div>`;
}

// ─────────────── Tab routing ───────────────
export async function initAdminPanel() {
    await getCsrfToken();

    document.getElementById('stc-admin-close')?.addEventListener('click', () => {
        document.getElementById('stc-admin-modal')?.remove();
        clearInterval(systemLoadInterval);
        systemLoadInterval = null;
    });

    document.getElementById('stc-admin-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'stc-admin-modal') {
            document.getElementById('stc-admin-modal')?.remove();
            clearInterval(systemLoadInterval);
            systemLoadInterval = null;
        }
    });

    document.querySelectorAll('.stc-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.stc-tab-btn').forEach(b => {
                b.style.background = 'rgba(255,255,255,.04)';
                b.style.color = '#aaa';
                b.style.borderBottom = 'none';
            });
            btn.style.background = '#16213e';
            btn.style.color = '#fff';
            btn.style.borderBottom = '2px solid #6c63ff';
            clearInterval(systemLoadInterval);
            systemLoadInterval = null;
            switchTab(btn.dataset.tab);
        });
    });

    // Auto-open first tab
    document.querySelector('.stc-tab-btn')?.click();
}

async function switchTab(tab) {
    const content = document.getElementById('stc-tab-content');
    if (!content) return;
    content.innerHTML = `<div style="text-align:center;padding:60px;color:#888"><i class="fa-solid fa-spinner fa-spin fa-2x"></i><br><br>加载中...</div>`;

    switch (tab) {
        case 'system': await renderSystemTab(content); break;
        case 'invitation': await renderInvitationTab(content); break;
        case 'announcements': await renderAnnouncementsTab(content); break;
        case 'email': await renderEmailTab(content); break;
        case 'oauth': await renderOAuthTab(content); break;
        case 'template': await renderTemplateTab(content); break;
        case 'storage': await renderStorageTab(content); break;
        case 'users': await renderUsersTab(content); break;
        case 'qrole': await renderQroleTab(content); break;
        case 'tasks': await renderTasksTab(content); break;
    }
}

// ═══════════════════════════════════════════════════
// TAB: 系统监控
// ═══════════════════════════════════════════════════
async function renderSystemTab(container) {
    container.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;margin-bottom:20px" id="stc-sys-cards">
        ${['cpu','memory','users','uptime'].map(k => `<div id="stc-sys-${k}" style="background:rgba(255,255,255,.05);border-radius:10px;padding:18px;text-align:center">
            <div style="color:#888;font-size:.8em;margin-bottom:6px">${{cpu:'CPU 使用率',memory:'内存使用',users:'活跃用户',uptime:'运行时间'}[k]}</div>
            <div id="stc-sv-${k}" style="font-size:2em;font-weight:700;color:#6c63ff">—</div>
            <div id="stc-ss-${k}" style="color:#888;font-size:.75em;margin-top:4px"></div>
            <div id="stc-pb-${k}" style="background:#333;border-radius:3px;height:6px;margin-top:8px"><div id="stc-pp-${k}" style="height:100%;border-radius:3px;width:0;background:linear-gradient(90deg,#667eea,#764ba2);transition:width .5s"></div></div>
        </div>`).join('')}
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;gap:10px;flex-wrap:wrap">
        <h3 style="margin:0;flex-shrink:0">用户统计</h3>
        <div style="display:flex;gap:8px;align-items:center">
          <input id="stc-user-search" type="text" placeholder="搜索用户..." style="padding:6px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.85em;width:160px">
          <button id="stc-sys-refresh" class="menu_button" style="padding:6px 14px;font-size:.85em;white-space:nowrap;flex-shrink:0;color:#fff"><i class="fa-solid fa-rotate-right"></i> 刷新</button>
        </div>
      </div>
      <div id="stc-user-list"><div style="text-align:center;padding:30px;color:#888">加载中...</div></div>`;

    document.getElementById('stc-sys-refresh')?.addEventListener('click', loadSystemData);
    document.getElementById('stc-user-search')?.addEventListener('input', (e) => {
        userSearchTerm = e.target.value.trim();
        currentUserPage = 1;
        renderUserList();
    });

    await loadSystemData();
    clearInterval(systemLoadInterval);
    systemLoadInterval = setInterval(() => { if (!systemLoadPaused) loadSystemData(); }, 60000);
}

let systemData = null;
async function loadSystemData() {
    try {
        const r = await fetch('/api/stc/system-load/current', { headers: getHeaders() });
        if (!r.ok) throw new Error('Failed');
        systemData = await r.json();
        updateSystemCards();

        // Also fetch expiration list for user stats
        const ur = await fetch('/api/stc/users/expiration-list', { headers: getHeaders() });
        if (ur.ok) {
            const users = await ur.json();
            systemData._users = users;
            renderUserList();
        }
    } catch (e) {
        document.getElementById('stc-user-list').innerHTML = `<div style="color:#e74c3c;text-align:center;padding:20px">加载失败: ${esc(e.message)}</div>`;
    }
}

function updateSystemCards() {
    if (!systemData) return;
    const cpu = systemData.cpu || 0;
    const mem = systemData.memory?.percent || 0;
    const uptimeSec = systemData.uptime || 0;
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);

    setCard('cpu', `${cpu}%`, '', cpu);
    setCard('memory', `${mem}%`, `${systemData.memory?.used || 0}/${systemData.memory?.total || 0} MiB`, mem);
    setCard('users', '—', ``, 0, false);
    setCard('uptime', `${days}天 ${hours}时 ${mins}分`, '', 0, false);
}

function setCard(key, val, sub, pct, showBar = true) {
    const v = document.getElementById(`stc-sv-${key}`);
    const s = document.getElementById(`stc-ss-${key}`);
    const p = document.getElementById(`stc-pp-${key}`);
    const b = document.getElementById(`stc-pb-${key}`);
    if (v) v.textContent = val;
    if (s) s.textContent = sub;
    if (b) b.style.display = showBar ? '' : 'none';
    if (p && showBar) {
        p.style.width = `${Math.min(pct, 100)}%`;
        p.style.background = pct > 80 ? 'linear-gradient(90deg,#e74c3c,#c0392b)' : pct > 60 ? 'linear-gradient(90deg,#f39c12,#e67e22)' : 'linear-gradient(90deg,#667eea,#764ba2)';
    }
}

function renderUserList() {
    const users = systemData?._users || [];
    const container = document.getElementById('stc-user-list');
    if (!container) return;

    const filtered = userSearchTerm ? users.filter(u =>
        u.handle?.toLowerCase().includes(userSearchTerm.toLowerCase())
    ) : users;

    // Update users card
    const v = document.getElementById('stc-sv-users');
    if (v) v.textContent = `${filtered.length} 人`;

    if (!filtered.length) {
        container.innerHTML = emptyState('fa-users', '暂无用户', '没有用户数据');
        return;
    }

    const total = Math.ceil(filtered.length / USERS_PER_PAGE);
    if (currentUserPage > total) currentUserPage = total;
    const start = (currentUserPage - 1) * USERS_PER_PAGE;
    const page = filtered.slice(start, start + USERS_PER_PAGE);

    // Helper function to format relative time
    const formatRelativeTime = (timestamp) => {
        if (!timestamp) return '从未';
        const now = Date.now();
        const diff = now - timestamp;
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);

        if (days > 0) return `${days}天前`;
        if (hours > 0) return `${hours}小时前`;
        if (mins > 0) return `${mins}分钟前`;
        return '刚刚';
    };

    container.innerHTML = `
        <div style="color:#888;font-size:.8em;margin-bottom:8px">显示 ${start + 1}-${Math.min(start + USERS_PER_PAGE, filtered.length)} / ${filtered.length} 用户 · 按最后活跃时间排序</div>
        ${createPagination(currentUserPage, total)}
        ${page.map(u => {
            const lastActivity = u.lastActiveAt || u.lastLoginAt || u.createdAt || 0;
            const activityText = formatRelativeTime(lastActivity);
            const activityColor = (() => {
                const days = (Date.now() - lastActivity) / 86400000;
                if (days < 1) return '#27ae60';
                if (days < 7) return '#f39c12';
                if (days < 30) return '#e67e22';
                return '#e74c3c';
            })();

            return `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-radius:8px;background:rgba(255,255,255,.04);margin-bottom:8px">
            <div style="flex:1">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                    <span style="font-weight:600">${esc(u.handle)}</span>
                    ${u.expired ? '<span style="color:#e74c3c;font-size:.75em;padding:2px 6px;background:rgba(231,76,60,.2);border-radius:4px">已过期</span>' : '<span style="color:#27ae60;font-size:.75em;padding:2px 6px;background:rgba(39,174,96,.2);border-radius:4px">正常</span>'}
                </div>
                <div style="font-size:.75em;color:#888;line-height:1.6">
                    <div style="display:flex;flex-wrap:wrap;gap:8px">
                        <span style="color:${activityColor}"><i class="fa-solid fa-clock"></i> 最后活跃: ${activityText}</span>
                        ${u.lastChatTime ? `<span style="color:#8ab4f8"><i class="fa-solid fa-message"></i> 最后对话: ${formatRelativeTime(u.lastChatTime)}</span>` : ''}
                        ${u.expiresAt ? `<span><i class="fa-solid fa-calendar"></i> 到期: ${new Date(u.expiresAt).toLocaleDateString('zh-CN')}</span>` : ''}
                    </div>
                    ${u.email ? `<div style="margin-top:2px"><i class="fa-solid fa-envelope"></i> ${esc(u.email)}</div>` : ''}
                </div>
            </div>
        </div>`;
        }).join('')}
        ${createPagination(currentUserPage, total)}`;

    container.querySelectorAll('.stc-page-btn').forEach(b => {
        b.addEventListener('click', () => {
            currentUserPage = parseInt(b.dataset.page);
            renderUserList();
        });
    });
}

// ═══════════════════════════════════════════════════
// TAB: 邀请码管理
// ═══════════════════════════════════════════════════
async function renderInvitationTab(container) {
    container.innerHTML = `
      <!-- Registration settings -->
      <div id="stc-reg-card" style="background:rgba(255,255,255,.04);border-radius:10px;padding:16px;margin-bottom:16px">
        <h4 style="margin:0 0 12px">注册设置</h4>
        <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
          <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:.95em">
            <input id="stc-reg-enabled" type="checkbox" disabled> 开放注册</label>
          <span id="stc-reg-status" style="font-size:.8em;color:#888">加载中...</span>
          <button id="stc-reg-save" class="menu_button" disabled style="margin-left:auto;padding:7px 18px;background:#27ae60;font-size:.85em;white-space:nowrap;color:#fff"><i class="fa-solid fa-save"></i> 保存</button>
        </div>
        <div style="font-size:.8em;color:#888;margin-top:10px;line-height:1.6">关闭后：隐藏注册按钮、拒绝注册；已有账号可正常登录；QRole 会员首次登录仍会自动开户</div>
        <div id="stc-reg-invite-state" style="font-size:.8em;color:#888;margin-top:4px"></div>
      </div>

      <!-- Purchase link -->
      <div style="background:rgba(255,193,7,.08);border:1px solid rgba(255,193,7,.3);border-radius:8px;padding:14px;margin-bottom:16px">
        <div style="font-size:.85em;margin-bottom:6px;color:#ffc107"><i class="fa-solid fa-circle-info"></i> 邀请码功能需在 config.yaml 中设置 <code>enableInvitationCodes: true</code></div>
        <div style="display:flex;gap:8px;align-items:center">
          <span style="white-space:nowrap;font-size:.85em">续费购买链接：</span>
          <input id="stc-purchase-link" type="text" placeholder="https://your-shop.com/buy-code" style="flex:1;padding:7px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.85em">
          <button id="stc-save-purchase-link" class="menu_button" style="padding:7px 14px;white-space:nowrap;font-size:.85em;color:#fff"><i class="fa-solid fa-save"></i> 保存购买链接</button>
        </div>
      </div>

      <!-- Create -->
      <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:16px;margin-bottom:16px">
        <h4 style="margin:0 0 14px">创建邀请码</h4>
        <!-- Row: labels above, controls below, all same height -->
        <div style="display:flex;flex-direction:column;gap:6px">
          <div style="display:flex;gap:8px">
            <span style="font-size:.8em;color:#888;width:140px">有效期类型</span>
            <span style="font-size:.8em;color:#888;width:96px">创建数量</span>
          </div>
          <div style="display:flex;gap:8px;align-items:stretch">
            <select id="stc-inv-duration"
              style="width:140px;height:36px;padding:0 10px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.9em;box-sizing:border-box">
              <option value="permanent">永久</option>
              <option value="1day">1 天</option>
              <option value="1week">1 周</option>
              <option value="1month" selected>1 个月</option>
              <option value="1quarter">3 个月</option>
              <option value="6months">6 个月</option>
              <option value="1year">1 年</option>
            </select>
            <input id="stc-inv-count" type="number" value="1" min="1" max="100"
              style="width:96px;height:36px;padding:0 10px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.9em;box-sizing:border-box">
            <button id="stc-create-single-inv" class="menu_button"
              style="flex:1;height:36px;padding:0 16px;font-size:.88em;white-space:nowrap;display:flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;color:#fff">
              <i class="fa-solid fa-plus"></i> 单个创建</button>
            <button id="stc-create-batch-inv" class="menu_button"
              style="flex:1;height:36px;padding:0 16px;font-size:.88em;white-space:nowrap;display:flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;color:#fff">
              <i class="fa-solid fa-layer-group"></i> 批量创建</button>
          </div>
        </div>
      </div>

      <!-- Filters & list -->
      <div style="display:flex;gap:8px;margin-bottom:12px;align-items:stretch">
        <input id="stc-code-search" type="text" placeholder="搜索邀请码..."
          style="flex:1;min-width:100px;height:36px;padding:0 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.85em;box-sizing:border-box">
        <select id="stc-code-type-filter"
          style="height:36px;padding:0 10px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.85em;white-space:nowrap;box-sizing:border-box">
          <option value="all">类型: 全部</option>
          <option value="permanent">永久</option>
          <option value="1day">1 天</option>
          <option value="1week">1 周</option>
          <option value="1month">1 个月</option>
          <option value="1quarter">3 个月</option>
          <option value="6months">6 个月</option>
          <option value="1year">1 年</option>
        </select>
        <select id="stc-code-status-filter"
          style="height:36px;padding:0 10px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.85em;white-space:nowrap;box-sizing:border-box">
          <option value="all">状态: 全部</option>
          <option value="unused">未使用</option>
          <option value="used">已使用</option>
        </select>
        <button id="stc-inv-refresh" class="menu_button"
          style="height:36px;padding:0 16px;font-size:.85em;white-space:nowrap;display:flex;align-items:center;gap:6px;box-sizing:border-box;color:#fff">
          <i class="fa-solid fa-rotate-right"></i> 刷新</button>
        <button id="stc-inv-download-all" class="menu_button"
          style="height:36px;padding:0 16px;font-size:.85em;white-space:nowrap;display:flex;align-items:center;gap:6px;box-sizing:border-box;color:#fff">
          <i class="fa-solid fa-download"></i> 下载全部</button>
      </div>
      <div id="stc-inv-list">加载中...</div>`;

    // Registration switch (controls stay disabled until the current value is known,
    // so a failed load can never silently close registration)
    const regEnabled = document.getElementById('stc-reg-enabled');
    const regSave = document.getElementById('stc-reg-save');
    const regStatus = document.getElementById('stc-reg-status');
    const showRegState = (enabled) => {
        if (!regStatus) return;
        regStatus.textContent = enabled ? '当前：已开放注册' : '当前：已关闭注册';
        regStatus.style.color = enabled ? '#27ae60' : '#e74c3c';
    };
    fetch('/api/stc/registration-config/config', { headers: getHeaders() })
        .then(async r => {
            if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
            return r.json();
        })
        .then(d => {
            if (regEnabled) {
                regEnabled.checked = d.enableRegistration !== false;
                regEnabled.disabled = false;
            }
            if (regSave) regSave.disabled = false;
            showRegState(d.enableRegistration !== false);
            const inviteState = document.getElementById('stc-reg-invite-state');
            if (inviteState) {
                inviteState.textContent = d.enableInvitationCodes
                    ? '邀请码：已启用（新用户注册需要邀请码）'
                    : '邀请码：未启用';
            }
        })
        .catch(e => {
            if (regStatus) {
                regStatus.textContent = '加载失败: ' + e.message;
                regStatus.style.color = '#e74c3c';
            }
        });

    regSave?.addEventListener('click', async () => {
        const enableRegistration = !!regEnabled?.checked;
        setBtn('stc-reg-save', true);
        try {
            const r = await fetch('/api/stc/registration-config/config', { method: 'POST', headers: getHeaders(), body: JSON.stringify({ enableRegistration }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
            const saved = d.enableRegistration !== undefined ? !!d.enableRegistration : enableRegistration;
            if (regEnabled) regEnabled.checked = saved;
            showRegState(saved);
            toast(saved ? '已开放注册，立即生效' : '已关闭注册，立即生效');
        } catch (e) { toast('保存失败: ' + e.message, true); }
        setBtn('stc-reg-save', false, '<i class="fa-solid fa-save"></i> 保存');
    });

    // Load purchase link
    fetch('/api/stc/invitation-codes/purchase-link', { headers: getHeaders() })
        .then(r => r.json()).then(d => {
            const inp = document.getElementById('stc-purchase-link');
            if (inp) inp.value = d.purchaseLink || '';
        }).catch(() => {});

    document.getElementById('stc-save-purchase-link')?.addEventListener('click', async () => {
        const link = document.getElementById('stc-purchase-link')?.value?.trim();
        try {
            const r = await fetch('/api/stc/invitation-codes/purchase-link', { method: 'POST', headers: getHeaders(), body: JSON.stringify({ purchaseLink: link }) });
            if (r.ok) toast('购买链接已保存'); else throw new Error();
        } catch { toast('保存失败', true); }
    });

    document.getElementById('stc-create-single-inv')?.addEventListener('click', () => createInvitationCodes(1));
    document.getElementById('stc-create-batch-inv')?.addEventListener('click', () => {
        const n = parseInt(document.getElementById('stc-inv-count')?.value) || 1;
        createInvitationCodes(n);
    });
    document.getElementById('stc-inv-refresh')?.addEventListener('click', loadInvitationCodes);
    document.getElementById('stc-inv-download-all')?.addEventListener('click', downloadInvitationCodes);
    document.getElementById('stc-code-search')?.addEventListener('input', (e) => { codeSearchTerm = e.target.value; currentCodePage = 1; renderInvitationCodes(); });
    document.getElementById('stc-code-type-filter')?.addEventListener('change', () => { currentCodePage = 1; renderInvitationCodes(); });
    document.getElementById('stc-code-status-filter')?.addEventListener('change', () => { currentCodePage = 1; renderInvitationCodes(); });

    await loadInvitationCodes();
}

async function loadInvitationCodes() {
    const listEl = document.getElementById('stc-inv-list');
    if (!listEl) {
        console.error('[STC] stc-inv-list element not found');
        return;
    }
    listEl.innerHTML = `<div style="text-align:center;padding:20px;color:#888"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>`;
    try {
        const r = await fetch('/api/stc/invitation-codes/list', { headers: getHeaders() });
        if (!r.ok) throw new Error(await r.text());
        currentInvitationCodes = await r.json();
        console.log('[STC] Loaded invitation codes:', currentInvitationCodes.length);
        renderInvitationCodes();
    } catch (e) {
        console.error('[STC] Failed to load invitation codes:', e);
        listEl.innerHTML = `<div style="color:#e74c3c;text-align:center;padding:20px">加载失败: ${esc(e.message)}</div>`;
    }
}

const DURATION_LABELS = { '1day': '1天', '1week': '1周', '1month': '1月', '1quarter': '3月', '6months': '6月', '1year': '1年', 'permanent': '永久' };

function renderInvitationCodes() {
    const container = document.getElementById('stc-inv-list');
    if (!container) return;

    let codes = currentInvitationCodes;
    const typeFilter = document.getElementById('stc-code-type-filter')?.value || 'all';
    const statusFilter = document.getElementById('stc-code-status-filter')?.value || 'all';

    if (typeFilter !== 'all') codes = codes.filter(c => c.durationType === typeFilter);
    if (statusFilter === 'used') codes = codes.filter(c => c.used);
    if (statusFilter === 'unused') codes = codes.filter(c => !c.used);
    if (codeSearchTerm) codes = codes.filter(c => c.code?.toLowerCase().includes(codeSearchTerm.toLowerCase()) || c.usedBy?.toLowerCase().includes(codeSearchTerm.toLowerCase()));

    if (!codes.length) { container.innerHTML = emptyState('fa-ticket', '暂无邀请码', '点击上方按钮创建新的邀请码'); return; }

    const total = Math.ceil(codes.length / CODES_PER_PAGE);
    if (currentCodePage > total) currentCodePage = total;
    const start = (currentCodePage - 1) * CODES_PER_PAGE;
    const page = codes.slice(start, start + CODES_PER_PAGE);

    container.innerHTML = `
        <div style="color:#888;font-size:.8em;margin-bottom:8px">显示 ${start + 1}-${Math.min(start + CODES_PER_PAGE, codes.length)} / ${codes.length} 个邀请码</div>
        ${createPagination(currentCodePage, total)}
        <table style="width:100%;border-collapse:collapse;font-size:.85em">
          <thead><tr style="color:#888;border-bottom:1px solid #2a3a5e">
            <th style="padding:8px 6px;text-align:left">邀请码</th>
            <th style="padding:8px 6px;text-align:left">有效期</th>
            <th style="padding:8px 6px;text-align:left">状态</th>
            <th style="padding:8px 6px;text-align:left">使用者</th>
            <th style="padding:8px 6px;text-align:left">创建时间</th>
            <th style="padding:8px 6px;text-align:center">操作</th>
          </tr></thead>
          <tbody>
            ${page.map(c => `
            <tr style="border-bottom:1px solid rgba(255,255,255,.04);${c.used ? 'opacity:.6' : ''}">
              <td style="padding:8px 6px;font-family:monospace;font-weight:600">${esc(c.code)}</td>
              <td style="padding:8px 6px">${DURATION_LABELS[c.durationType] || c.durationType}</td>
              <td style="padding:8px 6px"><span style="color:${c.used ? '#e74c3c' : '#27ae60'}">${c.used ? '已使用' : '未使用'}</span></td>
              <td style="padding:8px 6px">${c.usedBy ? esc(c.usedBy) : '—'}</td>
              <td style="padding:8px 6px">${new Date(c.createdAt).toLocaleDateString('zh-CN')}</td>
              <td style="padding:8px 6px;text-align:center;white-space:nowrap">
                <button class="menu_button" onclick="navigator.clipboard.writeText('${c.code}').then(()=>stcToast('已复制'))" style="padding:3px 8px;font-size:.8em;margin-right:4px;color:#fff" title="复制"><i class="fa-solid fa-copy"></i></button>
                <button class="stc-del-code menu_button" data-code="${esc(c.code)}" style="padding:3px 8px;font-size:.8em;background:#c0392b;color:#fff" title="删除"><i class="fa-solid fa-trash"></i></button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${createPagination(currentCodePage, total)}`;

    container.querySelectorAll('.stc-page-btn').forEach(b => b.addEventListener('click', () => { currentCodePage = parseInt(b.dataset.page); renderInvitationCodes(); }));
    container.querySelectorAll('.stc-del-code').forEach(b => b.addEventListener('click', () => deleteInvitationCode(b.dataset.code)));
}

async function createInvitationCodes(count) {
    const durationType = document.getElementById('stc-inv-duration')?.value || 'permanent';
    try {
        const r = await fetch('/api/stc/invitation-codes/create', { method: 'POST', headers: getHeaders(), body: JSON.stringify({ durationType, count }) });
        if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
        const d = await r.json();
        toast(`✓ 成功创建 ${d.codes?.length || count} 个邀请码`);
        await loadInvitationCodes();
    } catch (e) { toast('创建失败: ' + e.message, true); }
}

async function deleteInvitationCode(code) {
    if (!confirm(`确定删除邀请码 ${code}？`)) return;
    try {
        const r = await fetch('/api/stc/invitation-codes/delete', { method: 'POST', headers: getHeaders(), body: JSON.stringify({ code }) });
        if (!r.ok) throw new Error();
        toast('邀请码已删除');
        await loadInvitationCodes();
    } catch { toast('删除失败', true); }
}

function downloadInvitationCodes() {
    const unused = currentInvitationCodes.filter(c => !c.used);
    const text = unused.map(c => `${c.code}\t${DURATION_LABELS[c.durationType] || c.durationType}`).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `invitation-codes-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
}

// ═══════════════════════════════════════════════════
// TAB: 公告管理
// ═══════════════════════════════════════════════════
async function renderAnnouncementsTab(container) {
    container.innerHTML = `
      <!-- Type switch -->
      <div style="display:flex;gap:8px;margin-bottom:16px;justify-content:center">
        <button id="stc-ann-tab-main" class="menu_button" data-anntype="main" style="padding:7px 24px;background:#6c63ff;white-space:nowrap;flex:0 1 auto;color:#fff">
          <i class="fa-solid fa-home"></i> 主站公告</button>
        <button id="stc-ann-tab-login" class="menu_button" data-anntype="login" style="padding:7px 24px;white-space:nowrap;flex:0 1 auto;color:#fff">
          <i class="fa-solid fa-right-to-bracket"></i> 登录页面公告</button>
      </div>

      <!-- Create form -->
      <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:16px;margin-bottom:16px" id="stc-ann-create-form">
        <h4 style="margin:0 0 12px" id="stc-ann-form-title">创建新公告</h4>
        <input id="stc-ann-title" type="text" placeholder="标题：" style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;margin-bottom:8px">
        <textarea id="stc-ann-content" placeholder="内容：" style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;min-height:80px;resize:vertical;margin-bottom:8px"></textarea>
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <div id="stc-ann-type-wrap" style="display:none">
            <label style="font-size:.85em;color:#aaa">类型：</label>
            <select id="stc-ann-type" style="padding:6px 10px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee">
              <option value="info">信息</option>
              <option value="warning">警告</option>
              <option value="success">成功</option>
              <option value="error">错误</option>
            </select>
          </div>
          <label style="display:flex;align-items:center;gap:6px;font-size:.85em;cursor:pointer">
            <input id="stc-ann-enabled" type="checkbox" checked> 立即启用
          </label>
          <button id="stc-ann-submit" class="menu_button" style="padding:8px 24px;background:#27ae60;margin-left:auto;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;color:#fff">
            <i class="fa-solid fa-plus"></i> 创建</button>
        </div>
      </div>

      <!-- List -->
      <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
        <button id="stc-ann-refresh" class="menu_button" style="padding:6px 18px;font-size:.85em;white-space:nowrap;color:#fff"><i class="fa-solid fa-rotate-right"></i> 刷新</button>
      </div>
      <div id="stc-ann-list">加载中...</div>`;

    let annType = 'main';
    const switchAnnType = (type) => {
        annType = type;
        ['main', 'login'].forEach(t => {
            const btn = document.getElementById(`stc-ann-tab-${t}`);
            if (btn) btn.style.background = t === type ? '#6c63ff' : 'rgba(255,255,255,.06)';
        });
        const typeWrap = document.getElementById('stc-ann-type-wrap');
        if (typeWrap) typeWrap.style.display = type === 'login' ? '' : 'none';
        loadAnnouncementsOf(type);
    };

    document.getElementById('stc-ann-tab-main')?.addEventListener('click', () => switchAnnType('main'));
    document.getElementById('stc-ann-tab-login')?.addEventListener('click', () => switchAnnType('login'));
    document.getElementById('stc-ann-refresh')?.addEventListener('click', () => loadAnnouncementsOf(annType));
    document.getElementById('stc-ann-submit')?.addEventListener('click', () => createAnnouncement(annType));

    switchAnnType('main');
}

async function loadAnnouncementsOf(type) {
    const container = document.getElementById('stc-ann-list');
    if (!container) return;
    container.innerHTML = `<div style="text-align:center;padding:20px;color:#888"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>`;
    try {
        const r = await fetch(`/api/stc/announcements/list?type=${type}`, { headers: getHeaders() });
        if (!r.ok) throw new Error(await r.text());
        const anns = await r.json();
        if (type === 'main') currentAnnouncements = anns;
        else currentLoginAnnouncements = anns;
        renderAnnouncementList(type, anns);
    } catch (e) {
        container.innerHTML = `<div style="color:#e74c3c;text-align:center;padding:20px">加载失败: ${esc(e.message)}</div>`;
    }
}

const ANN_TYPE_COLORS = { info: '#4a90e2', warning: '#f39c12', success: '#27ae60', error: '#e74c3c' };

function renderAnnouncementList(type, anns) {
    const container = document.getElementById('stc-ann-list');
    if (!container) return;
    if (!anns.length) { container.innerHTML = emptyState('fa-bullhorn', '暂无公告', '点击上方创建新公告'); return; }
    container.innerHTML = anns.map(a => `
        <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:14px;margin-bottom:10px;border-left:3px solid ${ANN_TYPE_COLORS[a.type] || '#4a90e2'}">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px">
            <div style="flex:1">
              <div style="font-weight:600;margin-bottom:4px">${esc(a.title)}</div>
              <div style="font-size:.85em;color:#aaa;white-space:pre-wrap">${esc(a.content)}</div>
              <div style="font-size:.75em;color:#666;margin-top:6px">
                ${a.type ? `<span style="color:${ANN_TYPE_COLORS[a.type]}">■ ${a.type}</span> · ` : ''}
                ${new Date(a.createdAt).toLocaleString('zh-CN')}
                ${a.createdBy ? ` · by ${esc(a.createdBy)}` : ''}
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
              <span style="font-size:.75em;padding:3px 8px;border-radius:10px;background:${a.enabled ? 'rgba(39,174,96,.2)' : 'rgba(150,150,150,.2)'};color:${a.enabled ? '#27ae60' : '#888'}">
                ${a.enabled ? '已启用' : '已禁用'}</span>
              <div style="display:flex;gap:6px">
                <button class="stc-ann-toggle menu_button" data-id="${a.id}" data-type="${type}" style="padding:5px 14px;font-size:.82em;white-space:nowrap">
                  <i class="fa-solid fa-${a.enabled ? 'pause' : 'play'}"></i> ${a.enabled ? '禁用' : '启用'}</button>
                <button class="stc-ann-delete menu_button" data-id="${a.id}" data-title="${esc(a.title)}" data-type="${type}" style="padding:4px 10px;font-size:.8em;background:#c0392b">
                  <i class="fa-solid fa-trash"></i></button>
              </div>
            </div>
          </div>
        </div>`).join('');

    container.querySelectorAll('.stc-ann-toggle').forEach(b => b.addEventListener('click', () => toggleAnnouncement(b.dataset.id, b.dataset.type)));
    container.querySelectorAll('.stc-ann-delete').forEach(b => b.addEventListener('click', () => deleteAnnouncement(b.dataset.id, b.dataset.title, b.dataset.type)));
}

async function createAnnouncement(type) {
    const title = document.getElementById('stc-ann-title')?.value?.trim();
    const content = document.getElementById('stc-ann-content')?.value?.trim();
    const annType = document.getElementById('stc-ann-type')?.value || 'info';
    const enabled = document.getElementById('stc-ann-enabled')?.checked;
    if (!title || !content) { toast('请填写标题和内容', true); return; }
    try {
        const r = await fetch(`/api/stc/announcements/create?type=${type}`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ title, content, type: annType, enabled }) });
        if (!r.ok) { const d = await r.json(); throw new Error(d.error); }
        document.getElementById('stc-ann-title').value = '';
        document.getElementById('stc-ann-content').value = '';
        toast('公告创建成功');
        await loadAnnouncementsOf(type);
    } catch (e) { toast('创建失败: ' + e.message, true); }
}

async function toggleAnnouncement(id, type) {
    try {
        const list = type === 'login' ? currentLoginAnnouncements : currentAnnouncements;
        const ann = list.find(a => a.id === id);
        const r = await fetch(`/api/stc/announcements/update?type=${type}`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ id, enabled: !ann?.enabled }) });
        if (!r.ok) throw new Error();
        await loadAnnouncementsOf(type);
    } catch { toast('操作失败', true); }
}

async function deleteAnnouncement(id, title, type) {
    if (!confirm(`确定删除公告 "${title}"？`)) return;
    try {
        const r = await fetch(`/api/stc/announcements/delete?type=${type}`, { method: 'POST', headers: getHeaders(), body: JSON.stringify({ id }) });
        if (!r.ok) throw new Error();
        toast('公告已删除');
        await loadAnnouncementsOf(type);
    } catch { toast('删除失败', true); }
}

// ═══════════════════════════════════════════════════
// TAB: 邮件配置
// ═══════════════════════════════════════════════════
async function renderEmailTab(container) {
    container.innerHTML = `
      <h3 style="margin:0 0 16px;text-align:center">邮件服务配置</h3>
      <div style="max-width:560px;margin:0 auto">
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer;font-size:.95em">
          <input id="stc-email-enabled" type="checkbox"> 启用邮件服务</label>

        <div class="stc-form-row"><label>SMTP 服务器:</label>
          <input id="stc-email-host" type="text" placeholder="smtp.exmail.qq.com"></div>
        <div class="stc-form-row"><label>SMTP 端口:</label>
          <input id="stc-email-port" type="number" placeholder="465" value="465" style="width:120px"></div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:.9em">
          <input id="stc-email-secure" type="checkbox"> 使用 SSL/TLS（通常端口465需要启用）</label>
        <div class="stc-form-row"><label>SMTP 用户名:</label>
          <input id="stc-email-user" type="text" placeholder="user@example.com"></div>
        <div class="stc-form-row"><label>SMTP 密码:</label>
          <input id="stc-email-password" type="password" placeholder="••••••••••••"></div>
        <div class="stc-form-row"><label>发件人邮箱:</label>
          <input id="stc-email-from" type="email" placeholder="noreply@example.com"></div>
        <div class="stc-form-row"><label>发件人名称:</label>
          <input id="stc-email-fromname" type="text" placeholder="SillyTavern"></div>

        <div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap">
          <button id="stc-email-save" class="menu_button" style="padding:8px 24px;background:#27ae60;white-space:nowrap;flex-shrink:0;color:#fff"><i class="fa-solid fa-save"></i> 保存</button>
          <div style="display:flex;gap:6px;flex:1;align-items:center">
            <input id="stc-email-test-addr" type="email" placeholder="发送测试邮件到..." style="flex:1;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.85em">
            <button id="stc-email-test" class="menu_button" style="padding:8px 16px;white-space:nowrap;color:#fff"><i class="fa-solid fa-paper-plane"></i> 发送测试邮件</button>
          </div>
        </div>

        <div style="margin-top:16px;background:rgba(255,255,255,.04);border-radius:8px;padding:14px;font-size:.8em;color:#888;line-height:1.8">
          <strong style="color:#aaa">配置说明:</strong><br>
          Gmail: smtp.gmail.com:587，需在 Google 账号开启"应用专用密码"<br>
          QQ邮箱: smtp.qq.com:587 或 465（启用SSL），需获取授权码<br>
          腾讯企业邮箱: smtp.exmail.qq.com:465（必须启用SSL），使用邮箱密码<br>
          163邮箱: smtp.163.com:465（启用SSL）或 smtp.163.com:25，需要授权码<br>
          Outlook: smtp-mail.outlook.com:587<br>
          <span style="color:#ffc107">⚠ 端口465必须勾选"使用 SSL/TLS"选项</span>
        </div>
      </div>
      <style>
        .stc-form-row { display:flex;align-items:center;gap:10px;margin-bottom:12px }
        .stc-form-row label { width:120px;font-size:.85em;color:#aaa;flex-shrink:0 }
        .stc-form-row input { flex:1;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.9em }
      </style>`;

    // Load existing config
    try {
        const r = await fetch('/api/stc/email-config/config', { headers: getHeaders() });
        if (r.ok) {
            const c = await r.json();
            document.getElementById('stc-email-enabled').checked = !!c.enabled;
            document.getElementById('stc-email-host').value = c.host || '';
            document.getElementById('stc-email-port').value = c.port || 465;
            document.getElementById('stc-email-secure').checked = !!c.secure;
            document.getElementById('stc-email-user').value = c.user || '';
            document.getElementById('stc-email-password').value = c.password || '';
            document.getElementById('stc-email-from').value = c.from || '';
            document.getElementById('stc-email-fromname').value = c.fromName || 'SillyTavern';
        }
    } catch {}

    document.getElementById('stc-email-save')?.addEventListener('click', async () => {
        const data = {
            enabled: document.getElementById('stc-email-enabled')?.checked,
            host: document.getElementById('stc-email-host')?.value?.trim(),
            port: parseInt(document.getElementById('stc-email-port')?.value) || 465,
            secure: document.getElementById('stc-email-secure')?.checked,
            user: document.getElementById('stc-email-user')?.value?.trim(),
            password: document.getElementById('stc-email-password')?.value,
            from: document.getElementById('stc-email-from')?.value?.trim(),
            fromName: document.getElementById('stc-email-fromname')?.value?.trim(),
        };
        try {
            const r = await fetch('/api/stc/email-config/config', { method: 'POST', headers: getHeaders(), body: JSON.stringify(data) });
            if (!r.ok) throw new Error((await r.json())?.error);
            toast('邮件配置已保存（需重启服务生效）');
        } catch (e) { toast('保存失败: ' + e.message, true); }
    });

    document.getElementById('stc-email-test')?.addEventListener('click', async () => {
        const email = document.getElementById('stc-email-test-addr')?.value?.trim();
        if (!email) { toast('请输入测试邮箱地址', true); return; }
        setBtn('stc-email-test', true);
        try {
            const r = await fetch('/api/stc/email-config/test', { method: 'POST', headers: getHeaders(), body: JSON.stringify({ email }) });
            const d = await r.json();
            if (d.success) toast('测试邮件发送成功！');
            else throw new Error(d.error);
        } catch (e) { toast('发送失败: ' + e.message, true); }
        setBtn('stc-email-test', false, '<i class="fa-solid fa-paper-plane"></i> 发送测试邮件');
    });
}

// ═══════════════════════════════════════════════════
// TAB: OAuth 配置
// ═══════════════════════════════════════════════════
// Endpoint defaults (mirror src/stc-mod/config.js); blank fields fall back to these on the server
const OAUTH_ENDPOINT_DEFAULTS = {
    linuxdo: {
        authUrl: 'https://connect.linux.do/oauth2/authorize',
        tokenUrl: 'https://connect.linux.do/oauth2/token',
        userInfoUrl: 'https://connect.linux.do/api/user',
    },
    qrole: {
        authUrl: 'https://www.qqy.one/api/oauth/authorize',
        tokenUrl: 'https://www.qqy.one/api/oauth/token',
        userInfoUrl: 'https://www.qqy.one/api/oauth/userinfo',
    },
};

const QROLE_DEFAULTS = {
    scope: 'openid profile email membership',
    tokenAuthMethod: 'client_secret_post',
    allowedTiers: ['vip', 'svip'],
    tierClaims: ['membershipTierId', 'membership_tier', 'membership.tierId', 'membership.tier', 'tier'],
    expiryClaims: ['membershipExpiresAt', 'membership_expires_at', 'membership.expiresAt'],
    reverifyHours: 24,
    // Membership expiry lifecycle (mirror the code defaults of the server)
    backgroundReverify: true,
    renewUrl: 'https://www.qqy.one/membership',
    expiryReminderDays: 7,
    expiredDataExport: true,
    expiredCleanup: { enabled: false, afterDays: 90 },
};
const QROLE_REVERIFY_MAX_HOURS = 8760;
const QROLE_REMINDER_MAX_DAYS = 60;
const QROLE_CLEANUP_MIN_DAYS = 30;
const QROLE_CLEANUP_MAX_DAYS = 3650;

/** Whether a string is an absolute http(s) URL. */
function isHttpUrl(value) {
    try {
        const url = new URL(String(value ?? '').trim());
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

/** Config list (array or comma-separated string) → text for an input. */
function listToText(value, fallback = []) {
    if (Array.isArray(value)) return value.join(',');
    if (typeof value === 'string') return value;
    return fallback.join(',');
}

/** Comma-separated input text → array of trimmed non-empty strings. */
function textToList(text) {
    return String(text ?? '').split(',').map(s => s.trim()).filter(Boolean);
}

async function renderOAuthTab(container) {
    let oauthConfig = {};
    let loadFailed = false;
    try {
        const r = await fetch('/api/stc/oauth-config/config', { headers: getHeaders() });
        if (r.ok) oauthConfig = await r.json();
        else loadFailed = true;
    } catch { loadFailed = true; }

    // Get current domain for callback URL example
    const currentDomain = window.location.origin;

    const renderProvider = (id, label, icon, color, extra = '') => {
        const callbackExample = esc(`${currentDomain}/api/stc/oauth/${id}/callback`);
        return `
      <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:16px;margin-bottom:16px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
          <i class="${icon}" style="color:${color};font-size:1.3em"></i>
          <strong>${label}</strong>
          <label style="display:flex;align-items:center;gap:6px;margin-left:auto;cursor:pointer;font-size:.85em">
            <input class="stc-oauth-enabled" type="checkbox" data-provider="${id}"> 启用
          </label>
        </div>
        <div class="stc-form-row"><label>Client ID:</label>
          <input class="stc-oauth-clientid" data-provider="${id}" type="text"></div>
        <div class="stc-form-row"><label>Client Secret:</label>
          <input class="stc-oauth-secret" data-provider="${id}" type="password" autocomplete="new-password"></div>
        <div class="stc-form-row"><label>Callback URL:</label>
          <input class="stc-oauth-callback" data-provider="${id}" type="text" placeholder="留空则自动生成"></div>
        ${extra}
        <div style="background:rgba(255,255,255,.02);border-left:3px solid #4a90e2;padding:10px 12px;margin:10px 0;border-radius:4px;font-size:.78em;color:#aaa">
          <div style="color:#4a90e2;font-weight:600;margin-bottom:4px"><i class="fa-solid fa-circle-info"></i> 回调地址配置说明</div>
          <div style="line-height:1.6">
            在 ${label} 开发者平台创建应用时，需要填写回调地址（Redirect URI / Callback URL）：<br>
            <code class="stc-callback-url" style="background:rgba(0,0,0,.3);padding:4px 8px;border-radius:3px;color:#8ab4f8;font-size:.9em;display:block;margin:6px 0;word-break:break-all;overflow-wrap:break-word">${callbackExample}</code>
            <button class="stc-copy-callback menu_button" data-url="${callbackExample}" style="padding:6px 12px;font-size:.85em;margin-top:4px;white-space:nowrap;display:inline-flex;align-items:center;gap:6px;color:#fff">
              <i class="fa-solid fa-copy"></i> <span>复制回调地址</span>
            </button>
          </div>
        </div>
        <div style="text-align:center;margin-top:10px">
          <button class="stc-oauth-save menu_button" data-provider="${id}" style="padding:7px 24px;background:#27ae60;font-size:.85em;white-space:nowrap;width:auto;display:inline-flex;align-items:center;gap:6px;color:#fff">
            <i class="fa-solid fa-save"></i> 保存 ${label}
          </button>
        </div>
      </div>`;
    };

    const endpointRows = (id) => `
        <div class="stc-form-row"><label>Auth URL:</label>
          <input class="stc-oauth-authurl" data-provider="${id}" type="text" placeholder="${OAUTH_ENDPOINT_DEFAULTS[id].authUrl}"></div>
        <div class="stc-form-row"><label>Token URL:</label>
          <input class="stc-oauth-tokenurl" data-provider="${id}" type="text" placeholder="${OAUTH_ENDPOINT_DEFAULTS[id].tokenUrl}"></div>
        <div class="stc-form-row"><label>UserInfo URL:</label>
          <input class="stc-oauth-userinfourl" data-provider="${id}" type="text" placeholder="${OAUTH_ENDPOINT_DEFAULTS[id].userInfoUrl}"></div>`;

    const qroleExtra = `
        <div class="stc-form-row"><label>Scope:</label>
          <input class="stc-oauth-scope" data-provider="qrole" type="text" placeholder="${QROLE_DEFAULTS.scope}"></div>
        <div class="stc-oauth-hint">空格分隔；留空使用默认值。开启「仅允许会员登录」时必须包含 membership（QRole 据此返回会员等级与到期时间），否则所有人都会被拒绝登录。</div>
        ${endpointRows('qrole')}
        <div class="stc-form-row"><label>Token 认证方式:</label>
          <select class="stc-oauth-tokenauth" data-provider="qrole">
            <option value="client_secret_post">client_secret_post（表单参数）</option>
            <option value="client_secret_basic">client_secret_basic（HTTP Basic）</option>
          </select></div>
        <label class="stc-oauth-check">
          <input class="stc-oauth-pkce" data-provider="qrole" type="checkbox"> 启用 PKCE（S256）</label>
        <label class="stc-oauth-check">
          <input class="stc-oauth-requiremember" data-provider="qrole" type="checkbox"> 仅允许会员登录（关闭后任何 QRole 用户均可登录）</label>
        <div class="stc-form-row"><label>允许的会员等级:</label>
          <input class="stc-oauth-tiers" data-provider="qrole" type="text" placeholder="${QROLE_DEFAULTS.allowedTiers.join(',')}"></div>
        <div class="stc-oauth-hint">逗号分隔，不区分大小写（例如 vip,svip）；未列出的等级（包括 free）将被拒绝登录。</div>
        <div class="stc-form-row"><label>会员状态复核间隔（小时）:</label>
          <input class="stc-oauth-reverify" data-provider="qrole" type="number" min="0" max="${QROLE_REVERIFY_MAX_HOURS}" step="1" placeholder="${QROLE_DEFAULTS.reverifyHours}"></div>
        <div class="stc-oauth-hint">超过该时长需重新使用 QRole 登录以确认会员状态；0 = 仅按已知到期时间和等级判断</div>
        <div class="stc-oauth-subtitle"><i class="fa-solid fa-hourglass-half"></i> 会员到期处理</div>
        <label class="stc-oauth-check">
          <input class="stc-oauth-bgreverify" data-provider="qrole" type="checkbox"> 后台自动复核会员（保存 QRole 刷新令牌）</label>
        <div class="stc-oauth-hint">登录时加密保存 QRole 刷新令牌（30 天有效），会员到期或需复核时由服务器自动向 QRole 确认，续费用户无需重新登录。关闭后，已保存的令牌在用户下次登录时删除。</div>
        <div class="stc-form-row"><label>续费链接:</label>
          <input class="stc-oauth-renewurl" data-provider="qrole" type="text" placeholder="${QROLE_DEFAULTS.renewUrl}"></div>
        <div class="stc-oauth-hint">到期提醒与数据导出页中「去续费」按钮打开的地址，仅支持 http(s)；留空使用默认地址。</div>
        <div class="stc-form-row"><label>到期提醒提前天数:</label>
          <input class="stc-oauth-reminderdays" data-provider="qrole" type="number" min="0" max="${QROLE_REMINDER_MAX_DAYS}" step="1" placeholder="${QROLE_DEFAULTS.expiryReminderDays}"></div>
        <div class="stc-oauth-hint">会员到期前 N 天在页面顶部提醒用户续费（0-${QROLE_REMINDER_MAX_DAYS}）；0 = 不提醒。</div>
        <label class="stc-oauth-check">
          <input class="stc-oauth-expiredexport" data-provider="qrole" type="checkbox"> 会员过期后允许导出数据</label>
        <div class="stc-oauth-hint">已有账号会员过期（或不是会员）时，QRole 登录后进入仅可续费 / 下载数据（ZIP）的页面；下载需官方 backups.allowFullDataBackup 开启。过期账号列表与自动清理见「QRole 会员」标签页。</div>
        <details class="stc-oauth-advanced">
          <summary>高级：会员字段映射</summary>
          <div class="stc-form-row"><label>等级字段:</label>
            <input class="stc-oauth-tierclaims" data-provider="qrole" type="text" placeholder="${QROLE_DEFAULTS.tierClaims.join(',')}"></div>
          <div class="stc-form-row"><label>到期字段:</label>
            <input class="stc-oauth-expiryclaims" data-provider="qrole" type="text" placeholder="${QROLE_DEFAULTS.expiryClaims.join(',')}"></div>
          <div class="stc-oauth-hint">userinfo 中的字段名，逗号分隔，按顺序取第一个存在的值，支持 a.b 路径；留空则使用默认字段。</div>
        </details>
        <div class="stc-oauth-hint" style="color:#e91e63">
          <i class="fa-solid fa-circle-info"></i> QRole 会员首次登录会自动创建账号（无需邀请码，关闭注册时同样生效）；QRole 的角色不会授予管理员权限。
        </div>`;

    container.innerHTML = `
      <h3 style="margin:0 0 16px">OAuth 第三方登录配置</h3>
      <div style="font-size:.8em;color:#888;margin:-8px 0 14px">Client Secret 仅可写入：留空表示保持原值不变。</div>
      ${renderProvider('github', 'GitHub OAuth', 'fa-brands fa-github', '#6e5494')}
      ${renderProvider('discord', 'Discord OAuth', 'fa-brands fa-discord', '#5865F2')}
      ${renderProvider('linuxdo', 'Linux.do OAuth', 'fa-solid fa-globe', '#f59e0b', endpointRows('linuxdo'))}
      ${renderProvider('qrole', 'QRole OAuth', 'fa-solid fa-crown', '#e91e63', qroleExtra)}
      <style>
        .stc-form-row { display:flex;align-items:center;gap:10px;margin-bottom:10px }
        .stc-form-row label { width:120px;font-size:.85em;color:#aaa;flex-shrink:0 }
        .stc-form-row input, .stc-form-row select { flex:1;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.9em }
        .stc-oauth-check { display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;font-size:.85em;color:#ccc }
        .stc-oauth-hint { font-size:.78em;color:#888;margin:-4px 0 10px;line-height:1.5 }
        .stc-oauth-advanced { margin-bottom:10px;font-size:.9em }
        .stc-oauth-subtitle { font-size:.85em;font-weight:600;color:#ffc440;margin:16px 0 10px;padding-top:12px;border-top:1px dashed rgba(255,255,255,.08);display:flex;align-items:center;gap:6px }
        .stc-oauth-advanced summary { cursor:pointer;color:#aaa;font-size:.85em;margin-bottom:10px }

        /* Mobile responsive styles */
        @media (max-width: 600px) {
          .stc-form-row { flex-direction:column;align-items:stretch;gap:6px }
          .stc-form-row label { width:100%;font-size:.8em }
          .stc-form-row input, .stc-form-row select { width:100%;font-size:.85em }
          .stc-callback-url { font-size:.8em !important;padding:6px !important }
          .stc-copy-callback { width:100%;justify-content:center;font-size:.8em !important }
        }
      </style>`;

    if (loadFailed) {
        // Saving blank fields over an unknown config would wipe it; block until reloaded
        container.querySelectorAll('.stc-oauth-save').forEach(btn => { btn.disabled = true; });
        toast('加载 OAuth 配置失败，请刷新后重试', true);
    }

    const field = (cls, provider) => container.querySelector(`.${cls}[data-provider="${provider}"]`);
    const setValue = (cls, provider, value) => {
        const el = field(cls, provider);
        if (el) el.value = value ?? '';
    };
    const setChecked = (cls, provider, value) => {
        const el = field(cls, provider);
        if (el) el.checked = !!value;
    };
    const setSecretPlaceholder = (provider, hasSecret) => {
        const el = field('stc-oauth-secret', provider);
        if (el) el.placeholder = hasSecret ? '已设置，留空保持不变' : '未设置';
    };

    // Populate inputs from config (never interpolated into markup)
    for (const provider of ['github', 'discord', 'linuxdo', 'qrole']) {
        const cfg = oauthConfig[provider] || {};
        setChecked('stc-oauth-enabled', provider, cfg.enabled);
        setValue('stc-oauth-clientid', provider, cfg.clientId);
        setValue('stc-oauth-callback', provider, cfg.callbackUrl);
        setSecretPlaceholder(provider, !!cfg.hasClientSecret);
        if (OAUTH_ENDPOINT_DEFAULTS[provider]) {
            setValue('stc-oauth-authurl', provider, cfg.authUrl);
            setValue('stc-oauth-tokenurl', provider, cfg.tokenUrl);
            setValue('stc-oauth-userinfourl', provider, cfg.userInfoUrl);
        }
    }
    const qroleCfg = oauthConfig.qrole || {};
    setValue('stc-oauth-scope', 'qrole', qroleCfg.scope ?? QROLE_DEFAULTS.scope);
    setValue('stc-oauth-tokenauth', 'qrole', qroleCfg.tokenAuthMethod === 'client_secret_basic' ? 'client_secret_basic' : QROLE_DEFAULTS.tokenAuthMethod);
    setChecked('stc-oauth-pkce', 'qrole', qroleCfg.usePkce !== false);
    setChecked('stc-oauth-requiremember', 'qrole', qroleCfg.requireMembership !== false);
    setValue('stc-oauth-tiers', 'qrole', listToText(qroleCfg.allowedTiers, QROLE_DEFAULTS.allowedTiers));
    setValue('stc-oauth-tierclaims', 'qrole', listToText(qroleCfg.tierClaims, QROLE_DEFAULTS.tierClaims));
    setValue('stc-oauth-expiryclaims', 'qrole', listToText(qroleCfg.expiryClaims, QROLE_DEFAULTS.expiryClaims));
    setValue('stc-oauth-reverify', 'qrole', Number.isInteger(qroleCfg.reverifyHours) ? qroleCfg.reverifyHours : QROLE_DEFAULTS.reverifyHours);
    setChecked('stc-oauth-bgreverify', 'qrole', qroleCfg.backgroundReverify !== false);
    setValue('stc-oauth-renewurl', 'qrole', typeof qroleCfg.renewUrl === 'string' && qroleCfg.renewUrl ? qroleCfg.renewUrl : QROLE_DEFAULTS.renewUrl);
    // Like the lists: the renew URL is only sent when edited. The server reports the effective URL,
    // so saving it untouched would turn a blank / missing renewUrl into a pinned default.
    let loadedRenewUrl = field('stc-oauth-renewurl', 'qrole')?.value?.trim() ?? '';
    setValue('stc-oauth-reminderdays', 'qrole', Number.isInteger(qroleCfg.expiryReminderDays) ? qroleCfg.expiryReminderDays : QROLE_DEFAULTS.expiryReminderDays);
    setChecked('stc-oauth-expiredexport', 'qrole', qroleCfg.expiredDataExport !== false);

    // List fields are only sent when edited: an untouched list may be unset in config.yaml
    // (built-in defaults apply), and saving it would pin today's defaults into the file.
    const QROLE_LIST_INPUTS = { allowedTiers: 'stc-oauth-tiers', tierClaims: 'stc-oauth-tierclaims', expiryClaims: 'stc-oauth-expiryclaims' };
    const loadedQroleLists = {};
    for (const [key, cls] of Object.entries(QROLE_LIST_INPUTS)) {
        loadedQroleLists[key] = field(cls, 'qrole')?.value?.trim() ?? '';
    }

    container.querySelectorAll('.stc-oauth-save').forEach(btn => {
        btn.addEventListener('click', async () => {
            const provider = btn.dataset.provider;
            const row = (cls) => field(cls, provider)?.value?.trim();
            const data = {
                provider,
                enabled: !!field('stc-oauth-enabled', provider)?.checked,
                clientId: row('stc-oauth-clientid'),
                callbackUrl: row('stc-oauth-callback'),
            };
            // Blank secret = keep the stored one (the server never returns it)
            const secret = row('stc-oauth-secret');
            if (secret) data.clientSecret = secret;
            if (OAUTH_ENDPOINT_DEFAULTS[provider]) {
                data.authUrl = row('stc-oauth-authurl');
                data.tokenUrl = row('stc-oauth-tokenurl');
                data.userInfoUrl = row('stc-oauth-userinfourl');
            }
            if (provider === 'qrole') {
                data.scope = row('stc-oauth-scope');
                data.tokenAuthMethod = row('stc-oauth-tokenauth') || QROLE_DEFAULTS.tokenAuthMethod;
                data.usePkce = !!field('stc-oauth-pkce', provider)?.checked;
                data.requireMembership = !!field('stc-oauth-requiremember', provider)?.checked;
                const allowedTiers = textToList(row('stc-oauth-tiers')).map(t => t.toLowerCase());
                if (data.requireMembership && !allowedTiers.length) {
                    toast('开启会员限制时，请至少填写一个允许的会员等级', true);
                    return;
                }
                for (const [key, cls] of Object.entries(QROLE_LIST_INPUTS)) {
                    if ((row(cls) ?? '') === loadedQroleLists[key]) continue;
                    data[key] = key === 'allowedTiers' ? allowedTiers : textToList(row(cls));
                }
                // Blank = default; unparsable input (value '' with badInput) is rejected below
                const reverifyText = row('stc-oauth-reverify');
                const reverifyHours = reverifyText
                    ? Number(reverifyText)
                    : (field('stc-oauth-reverify', provider)?.validity?.badInput ? NaN : QROLE_DEFAULTS.reverifyHours);
                if (!Number.isInteger(reverifyHours) || reverifyHours < 0 || reverifyHours > QROLE_REVERIFY_MAX_HOURS) {
                    toast(`会员状态复核间隔需为 0-${QROLE_REVERIFY_MAX_HOURS} 之间的整数（小时）`, true);
                    return;
                }
                data.reverifyHours = reverifyHours;

                // Membership expiry lifecycle (expiredCleanup is saved from the 「QRole 会员」 tab)
                data.backgroundReverify = !!field('stc-oauth-bgreverify', provider)?.checked;
                data.expiredDataExport = !!field('stc-oauth-expiredexport', provider)?.checked;
                const renewUrl = row('stc-oauth-renewurl') ?? '';
                if (renewUrl !== loadedRenewUrl) {
                    // Blank = the default QRole membership page
                    if (renewUrl && !isHttpUrl(renewUrl)) {
                        toast('续费链接必须是 http(s) 地址', true);
                        return;
                    }
                    data.renewUrl = renewUrl;
                }
                const reminderText = row('stc-oauth-reminderdays');
                const reminderDays = reminderText
                    ? Number(reminderText)
                    : (field('stc-oauth-reminderdays', provider)?.validity?.badInput ? NaN : QROLE_DEFAULTS.expiryReminderDays);
                if (!Number.isInteger(reminderDays) || reminderDays < 0 || reminderDays > QROLE_REMINDER_MAX_DAYS) {
                    toast(`到期提醒提前天数需为 0-${QROLE_REMINDER_MAX_DAYS} 之间的整数`, true);
                    return;
                }
                data.expiryReminderDays = reminderDays;
            }
            btn.disabled = true;
            try {
                const r = await fetch('/api/stc/oauth-config/config', { method: 'POST', headers: getHeaders(), body: JSON.stringify(data) });
                if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || `HTTP ${r.status}`);
                if (data.clientSecret) {
                    setValue('stc-oauth-secret', provider, '');
                    setSecretPlaceholder(provider, true);
                }
                if (provider === 'qrole') {
                    for (const [key, cls] of Object.entries(QROLE_LIST_INPUTS)) {
                        if (data[key]) loadedQroleLists[key] = row(cls) ?? '';
                    }
                    if (data.renewUrl !== undefined) loadedRenewUrl = data.renewUrl;
                }
                toast('已保存，立即生效');
            } catch (e) { toast('保存失败: ' + e.message, true); }
            btn.disabled = false;
        });
    });

    // Copy callback URL buttons
    container.querySelectorAll('.stc-copy-callback').forEach(btn => {
        btn.addEventListener('click', () => {
            const url = btn.dataset.url;
            copyText(url);
            toast('回调地址已复制到剪贴板');
        });
    });
}

// ═══════════════════════════════════════════════════
// TAB: 默认配置模板
// ═══════════════════════════════════════════════════
async function renderTemplateTab(container) {
    container.innerHTML = `
      <h3 style="margin:0 0 16px">默认用户配置模板</h3>
      <div id="stc-tpl-status" style="background:rgba(255,255,255,.04);border-radius:8px;padding:14px;margin-bottom:16px">加载中...</div>

      <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:16px;margin-bottom:16px">
        <h4 style="margin:0 0 12px">从现有用户生成模板</h4>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div style="flex:1;min-width:200px">
            <div style="font-size:.8em;color:#888;margin-bottom:4px">来源用户:</div>
            <select id="stc-tpl-user" style="width:100%;padding:8px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee">
              <option value="">加载中...</option></select>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:12px;font-size:.85em">
          ${[
            ['settings','settings.json','核心','default'],
            ['secrets','secrets.json','核心','default'],
            ['characters','默认角色卡','内容','default'],
            ['worlds','世界书 / Lorebook','内容'],
            ['themes','主题','内容','default'],
            ['presets','预设文件','预设','default'],
            ['regex','正则表达式','预设','default'],
          ].map(([k, label, group, checked]) => `
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;padding:6px;border-radius:4px;background:rgba(255,255,255,.03)">
              <input type="checkbox" id="stc-tpl-${k}" ${checked ? 'checked' : ''}> ${label}
              <span style="font-size:.75em;color:#666">(${group})</span>
            </label>`).join('')}
        </div>
        <div style="text-align:center;margin-top:14px">
          <button id="stc-tpl-save" class="menu_button" style="padding:9px 28px;background:#27ae60;white-space:nowrap;width:auto;display:inline-flex;align-items:center;gap:6px;color:#fff">
            <i class="fa-solid fa-save"></i> 保存为默认配置
          </button>
        </div>
        <div style="font-size:.75em;color:#888;margin-top:8px;text-align:center">默认模板保存在 data/stc-mod/default-template，新用户注册时会自动应用。</div>
      </div>

      <div style="text-align:center">
        <button id="stc-tpl-delete" class="menu_button" style="padding:8px 24px;background:#c0392b;font-size:.85em;white-space:nowrap;width:auto;display:inline-flex;align-items:center;gap:6px;color:#fff">
          <i class="fa-solid fa-trash"></i> 清空模板
        </button>
      </div>`;

    // Load template status
    try {
        const r = await fetch('/api/stc/default-config/template', { headers: getHeaders() });
        const d = await r.json();
        const statusDiv = document.getElementById('stc-tpl-status');
        if (d && d.sourceHandle) {
            statusDiv.innerHTML = `<div style="color:#27ae60"><i class="fa-solid fa-check-circle"></i> 状态: 已配置</div>
                <div style="font-size:.85em;color:#aaa;margin-top:6px">来源用户: ${esc(d.sourceHandle)} · 更新时间: ${new Date(d.createdAt).toLocaleString('zh-CN')}</div>
                <div style="font-size:.85em;color:#aaa">包含内容: ${(d.copiedItems || []).join(', ') || '—'}</div>`;
        } else {
            statusDiv.innerHTML = `<div style="color:#888"><i class="fa-solid fa-circle-xmark"></i> 状态: 未配置 — 新用户将使用 SillyTavern 默认空白配置</div>`;
        }
    } catch {}

    // Load user list
    try {
        const r = await fetch('/api/stc/users/expiration-list', { headers: getHeaders() });
        const users = await r.json();
        const sel = document.getElementById('stc-tpl-user');
        if (sel) sel.innerHTML = users.map(u => `<option value="${esc(u.handle)}">${esc(u.handle)}</option>`).join('');
    } catch {}

    document.getElementById('stc-tpl-save')?.addEventListener('click', async () => {
        const sourceHandle = document.getElementById('stc-tpl-user')?.value;
        if (!sourceHandle) { toast('请选择来源用户', true); return; }
        const getCheck = id => !!document.getElementById(`stc-tpl-${id}`)?.checked;
        const options = {
            includeSettings: getCheck('settings'),
            includeSecrets: getCheck('secrets'),
            includePresets: getCheck('presets'),
            includeRegex: getCheck('regex'),
            includeCharacters: getCheck('characters'),
            includeWorlds: getCheck('worlds'),
            includeThemes: getCheck('themes'),
        };
        try {
            const r = await fetch('/api/stc/default-config/template', { method: 'POST', headers: getHeaders(), body: JSON.stringify({ sourceHandle, options }) });
            if (!r.ok) throw new Error((await r.json())?.error);
            toast('默认模板已保存');
            await renderTemplateTab(container);
        } catch (e) { toast('保存失败: ' + e.message, true); }
    });

    document.getElementById('stc-tpl-delete')?.addEventListener('click', async () => {
        if (!confirm('确定清空默认模板？')) return;
        try {
            await fetch('/api/stc/default-config/template/delete', { method: 'POST', headers: getHeaders() });
            toast('模板已清空');
            await renderTemplateTab(container);
        } catch { toast('操作失败', true); }
    });
}

// ═══════════════════════════════════════════════════
// TAB: 用户空间
// ═══════════════════════════════════════════════════
async function renderStorageTab(container) {
    container.innerHTML = `
      <h3 style="margin:0 0 16px">用户空间限制</h3>
      <div style="max-width:520px;background:rgba(255,255,255,.04);border-radius:10px;padding:16px;margin-bottom:16px">
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer">
          <input id="stc-stor-enabled" type="checkbox"> 启用用户存储空间限制</label>
        <div class="stc-form-row">
          <label>默认空间上限 (MiB):</label>
          <input id="stc-stor-default" type="number" min="50" value="500" style="width:120px">
        </div>
        <div class="stc-form-row">
          <label>每日签到奖励 (MiB):</label>
          <input id="stc-stor-checkin" type="number" min="0" value="0" style="width:120px">
        </div>
        <div style="font-size:.8em;color:#888;margin-bottom:12px">设置为 0 可关闭签到奖励</div>
        <div style="display:flex;gap:10px;justify-content:center">
          <button id="stc-stor-reload" class="menu_button" style="padding:8px 20px;font-size:.85em;white-space:nowrap;color:#fff"><i class="fa-solid fa-rotate-right"></i> 加载配置</button>
          <button id="stc-stor-save" class="menu_button" style="padding:8px 20px;background:#27ae60;font-size:.85em;white-space:nowrap;color:#fff"><i class="fa-solid fa-save"></i> 保存</button>
        </div>
        <div style="font-size:.75em;color:#888;margin-top:8px">保存后建议重启服务以确保配置生效。</div>
      </div>

      <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:16px;margin-bottom:16px">
        <h4 style="margin:0 0 12px">空间扩容激活码</h4>
        <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">
          <div>
            <div style="font-size:.8em;color:#888;margin-bottom:4px">生成数量:</div>
            <input id="stc-stor-code-count" type="number" min="1" max="100" value="1" style="padding:7px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;width:80px">
          </div>
          <div>
            <div style="font-size:.8em;color:#888;margin-bottom:4px">扩容大小 (MiB):</div>
            <input id="stc-stor-code-size" type="number" min="1" value="100" style="padding:7px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;width:100px">
          </div>
          <button id="stc-stor-gen-codes" class="menu_button" style="padding:8px 20px;font-size:.85em;white-space:nowrap;align-self:flex-end;color:#fff"><i class="fa-solid fa-plus"></i> 生成激活码</button>
        </div>
        <div id="stc-stor-codes-result" style="margin-top:10px;font-family:monospace;font-size:.85em;color:#aaa;white-space:pre-wrap;background:rgba(0,0,0,.2);border-radius:6px;padding:10px;display:none"></div>
      </div>
      <style>
        .stc-form-row { display:flex;align-items:center;gap:10px;margin-bottom:12px }
        .stc-form-row label { width:160px;font-size:.85em;color:#aaa;flex-shrink:0 }
        .stc-form-row input { padding:8px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee }
      </style>`;

    // Load config
    const loadConfig = async () => {
        try {
            const r = await fetch('/api/stc/user-storage/config', { headers: getHeaders() });
            if (r.ok) {
                const c = await r.json();
                document.getElementById('stc-stor-enabled').checked = !!c.enabled;
                document.getElementById('stc-stor-default').value = c.defaultLimitMiB || 500;
                document.getElementById('stc-stor-checkin').value = c.dailyCheckInMiB || 0;
            }
        } catch {}
    };
    await loadConfig();

    document.getElementById('stc-stor-reload')?.addEventListener('click', loadConfig);
    document.getElementById('stc-stor-save')?.addEventListener('click', async () => {
        const data = {
            enabled: document.getElementById('stc-stor-enabled')?.checked,
            defaultLimitMiB: parseInt(document.getElementById('stc-stor-default')?.value) || 500,
            dailyCheckInMiB: parseInt(document.getElementById('stc-stor-checkin')?.value) || 0,
        };
        try {
            const r = await fetch('/api/stc/user-storage/config', { method: 'POST', headers: getHeaders(), body: JSON.stringify(data) });
            if (!r.ok) throw new Error((await r.json())?.error);
            toast('存储配置已保存');
        } catch (e) { toast('保存失败: ' + e.message, true); }
    });

    document.getElementById('stc-stor-gen-codes')?.addEventListener('click', async () => {
        const count = parseInt(document.getElementById('stc-stor-code-count')?.value) || 1;
        const amountMiB = parseInt(document.getElementById('stc-stor-code-size')?.value) || 100;
        try {
            const r = await fetch('/api/stc/user-storage/generate-codes', { method: 'POST', headers: getHeaders(), body: JSON.stringify({ count, amountMiB }) });
            if (!r.ok) throw new Error((await r.json())?.error);
            const d = await r.json();
            const resultDiv = document.getElementById('stc-stor-codes-result');
            resultDiv.style.display = '';
            resultDiv.textContent = d.codes.map(c => `${c.code}\t+${c.amountMiB} MiB`).join('\n');
            toast(`生成了 ${d.codes.length} 个激活码`);
        } catch (e) { toast('生成失败: ' + e.message, true); }
    });
}

// ═══════════════════════════════════════════════════
// TAB: 用户管理（存储分析 + 删除不活跃用户）
// ═══════════════════════════════════════════════════
// TAB: 用户管理（存储分析 + 删除不活跃用户）
// ═══════════════════════════════════════════════════
async function renderUsersTab(container) {
    container.innerHTML = `
      <!-- Section: Storage Analysis -->
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0">用户存储占用分析</h3>
        <button id="stc-ua-refresh" class="menu_button"
          style="height:36px;padding:0 18px;font-size:.85em;white-space:nowrap;display:flex;align-items:center;gap:6px;box-sizing:border-box;color:#fff">
          <i class="fa-solid fa-rotate-right"></i> 刷新分析</button>
      </div>
      <div id="stc-ua-list" style="margin-bottom:28px">
        <div style="text-align:center;padding:24px;color:#888"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>
      </div>

      <!-- Section: Delete Inactive Users -->
      <div style="border-top:1px solid #2a3a5e;padding-top:20px">
        <h3 style="margin:0 0 14px"><i class="fa-solid fa-user-slash" style="color:#e74c3c;margin-right:6px"></i>清理长期未登录用户</h3>

        <div style="background:rgba(231,76,60,.08);border:1px solid rgba(231,76,60,.3);border-radius:8px;padding:12px;margin-bottom:16px;font-size:.85em;color:#e88">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <strong>此操作不可逆！</strong>将彻底删除不活跃用户的 SillyTavern 账号及其全部数据（聊天记录、角色卡、世界书、备份等），以释放存储空间。
          强烈建议先使用"预览"确认名单后再执行删除。
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:10px">
          <div>
            <div style="font-size:.8em;color:#888;margin-bottom:4px">超过多少天未登录视为不活跃:</div>
            <div style="display:flex;align-items:center;gap:6px">
              <input id="stc-inactive-days" type="number" value="30" min="1" max="3650"
                style="padding:7px 10px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;width:80px">
              <span style="font-size:.85em;color:#888">天</span>
            </div>
          </div>
          <div>
            <div style="font-size:.8em;color:#888;margin-bottom:4px">且使用空间低于（MB，0 = 不限制）:</div>
            <div style="display:flex;align-items:center;gap:6px">
              <input id="stc-inactive-min-storage" type="number" value="50" min="0" max="99999"
                style="padding:7px 10px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;width:90px">
              <span style="font-size:.85em;color:#888">MB</span>
            </div>
          </div>
        </div>
        <div style="font-size:.8em;color:#aaa;margin-bottom:12px;padding:8px 10px;background:rgba(255,255,255,.04);border-radius:6px;border-left:2px solid #4a90e2">
          <i class="fa-solid fa-circle-info" style="margin-right:4px"></i>
          同时满足以上两个条件才会被列为候选：未登录天数超过阈值 <strong>且</strong> 存储占用低于阈值。
          存储量较大的用户（可能有重要数据）将被自动排除。
        </div>
        <div style="margin-bottom:14px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:.85em">
            <input id="stc-inactive-send-email" type="checkbox"> 删除前发送邮件通知用户（需配置邮件服务）
          </label>
        </div>

        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">
          <button id="stc-inactive-preview" class="menu_button" style="padding:9px 18px;font-size:.85em;white-space:nowrap;flex:1 1 auto;min-width:120px;max-width:200px;color:#fff">
            <i class="fa-solid fa-magnifying-glass"></i> 预览候选名单</button>
          <button id="stc-inactive-warn" class="menu_button" style="padding:9px 18px;font-size:.85em;white-space:nowrap;flex:1 1 auto;min-width:160px;max-width:240px;color:#fff">
            <i class="fa-solid fa-envelope-open-text"></i> 仅发送提醒邮件</button>
          <button id="stc-inactive-delete" class="menu_button" style="padding:9px 18px;font-size:.85em;background:#c0392b;white-space:nowrap;flex:1 1 auto;min-width:100px;max-width:160px;color:#fff">
            <i class="fa-solid fa-trash-can"></i> 确认删除</button>
        </div>

        <div id="stc-inactive-preview-result" style="margin-top:14px;display:none"></div>
      </div>`;

    document.getElementById('stc-ua-refresh')?.addEventListener('click', () => {
        currentStoragePage = 1;
        storageSearchTerm = '';
        _selectedHandles.clear();
        loadStorageAnalysis(1);
    });
    document.getElementById('stc-inactive-preview')?.addEventListener('click', () => {
        currentInactivePage = 1;
        _inactiveCandidates = [];
        previewInactiveUsers();
    });
    document.getElementById('stc-inactive-warn')?.addEventListener('click', warnInactiveUsers);
    document.getElementById('stc-inactive-delete')?.addEventListener('click', deleteInactiveUsers);

    currentStoragePage = 1;
    await loadStorageAnalysis(1);
}

// Store user metadata for activity time display
let _userMetaMap = {};

async function resetUser(handle) {
    if (!confirm(`确定要重置用户 "${handle}" 的所有数据吗？\n\n此操作将删除该用户的：\n- 所有聊天记录\n- 所有角色卡\n- 所有世界书\n- 所有备份文件\n- 所有设置\n\n用户账号将保留，但数据将被清空。`)) {
        return;
    }

    try {
        const r = await fetch('/api/stc/users/reset-user', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ handle })
        });

        if (!r.ok) {
            const error = await r.json();
            throw new Error(error.error || '重置失败');
        }

        toast(`用户 "${handle}" 已重置`);
        await loadStorageAnalysis(currentStoragePage);
    } catch (e) {
        toast('重置失败: ' + e.message, true);
    }
}

async function deleteSingleUser(handle) {
    if (!confirm(`确定要删除用户 "${handle}" 吗？\n\n此操作将：\n- 删除用户账号\n- 删除所有用户数据\n- 此操作不可恢复！`)) {
        return;
    }

    const confirmText = prompt(`请输入用户名 "${handle}" 以确认删除：`);
    if (confirmText !== handle) {
        toast('用户名不匹配，操作已取消', true);
        return;
    }

    try {
        const r = await fetch('/api/stc/users/delete-single', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ handle })
        });

        if (!r.ok) {
            const error = await r.json();
            throw new Error(error.error || '删除失败');
        }

        toast(`用户 "${handle}" 已删除`);
        _selectedHandles.delete(handle);
        await loadStorageAnalysis(currentStoragePage);
    } catch (e) {
        toast('删除失败: ' + e.message, true);
    }
}

// Cache for all storage data when sorting by activity
let _allStorageData = null;

// Selected handles for batch operations
let _selectedHandles = new Set();

async function deleteBatchUsers() {
    const handles = [..._selectedHandles];
    if (!handles.length) return;

    if (!confirm(`⚠ 危险操作！确定要删除选中的 ${handles.length} 个用户吗？\n\n用户：${handles.slice(0, 5).join(', ')}${handles.length > 5 ? ` 等 ${handles.length} 人` : ''}\n\n此操作将永久删除这些用户的账号及全部数据，不可恢复！`)) return;

    const btn = document.getElementById('stc-batch-delete-btn');
    if (btn) { btn.disabled = true; btn._orig = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 删除中...'; }

    try {
        const r = await fetch('/api/stc/users/delete-batch', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ handles }),
        });
        if (!r.ok) throw new Error((await r.json())?.error);
        const d = await r.json();
        _selectedHandles.clear();
        let msg = `已删除 ${d.deleted.length} 个用户`;
        if (d.failed?.length) msg += `，${d.failed.length} 个失败`;
        toast(msg, d.failed?.length > 0);
        await loadStorageAnalysis(currentStoragePage);
    } catch (e) {
        toast('批量删除失败: ' + e.message, true);
        if (btn) { btn.disabled = false; btn.innerHTML = btn._orig; }
    }
}

async function loadStorageAnalysis(page, sortBy = 'name') {
    if (page !== undefined) currentStoragePage = page;
    const container = document.getElementById('stc-ua-list');
    if (!container) return;
    container.innerHTML = `<div style="text-align:center;padding:24px;color:#888"><i class="fa-solid fa-spinner fa-spin"></i> 分析中，请稍候（第 ${currentStoragePage} 页）...</div>`;
    try {
        // Load user metadata for activity times
        const metaRes = await fetch('/api/stc/users/expiration-list', { headers: getHeaders() });
        if (metaRes.ok) {
            const users = await metaRes.json();
            _userMetaMap = {};
            users.forEach(u => {
                _userMetaMap[u.handle] = {
                    lastActiveAt: u.lastActiveAt,
                    lastChatTime: u.lastChatTime,
                    lastLoginAt: u.lastLoginAt,
                    createdAt: u.createdAt
                };
            });
        }

        // For activity sorting, we need all data to sort globally
        if (sortBy === 'activity') {
            // Load all data without pagination
            const params = new URLSearchParams({ page: 1, limit: 9999 });
            if (storageSearchTerm) params.set('search', storageSearchTerm);
            params.set('sortBy', 'name'); // Get data sorted by name first
            const r = await fetch(`/api/stc/scheduled-tasks/storage-analysis?${params}`, { headers: getHeaders() });
            if (!r.ok) throw new Error(await r.text());
            const result = await r.json();
            _allStorageData = result.data || result;
            renderStorageAnalysis({ data: _allStorageData, total: _allStorageData.length }, sortBy);
        } else {
            // Normal backend pagination for name/storage sorting
            const params = new URLSearchParams({
                page:  currentStoragePage,
                limit: STORAGE_PER_PAGE,
            });
            if (storageSearchTerm) params.set('search', storageSearchTerm);
            if (sortBy) params.set('sortBy', sortBy);
            const r = await fetch(`/api/stc/scheduled-tasks/storage-analysis?${params}`, { headers: getHeaders() });
            if (!r.ok) throw new Error(await r.text());
            const result = await r.json();
            _storageAnalysisCache = result;
            _allStorageData = null; // Clear cache when not sorting by activity
            renderStorageAnalysis(result, sortBy);
        }
    } catch (e) {
        container.innerHTML = `<div style="color:#e74c3c;text-align:center;padding:20px">加载失败: ${esc(e.message)}</div>`;
    }
}

function renderStorageAnalysis(result, sortBy = 'name') {
    const container = document.getElementById('stc-ua-list');
    if (!container) return;

    // Support both old array format and new paginated object format
    let allData = Array.isArray(result) ? result : (result.data || []);
    let total = Array.isArray(result) ? allData.length : (result.total || allData.length);

    if (!allData.length) {
        container.innerHTML = emptyState('fa-users', '暂无数据', '没有找到用户数据');
        return;
    }

    // Client-side sorting for activity (backend doesn't support it)
    if (sortBy === 'activity') {
        allData = [...allData].sort((a, b) => {
            const aM = _userMetaMap[a.handle] || {};
            const bM = _userMetaMap[b.handle] || {};
            const aTime = aM.lastActiveAt || aM.lastLoginAt || aM.createdAt || 0;
            const bTime = bM.lastActiveAt || bM.lastLoginAt || bM.createdAt || 0;
            return bTime - aTime; // Most recent first
        });

        // Client-side pagination for activity sorting
        total = allData.length;
        const totalPages = Math.ceil(total / STORAGE_PER_PAGE);
        if (currentStoragePage > totalPages) currentStoragePage = totalPages || 1;
        const start = (currentStoragePage - 1) * STORAGE_PER_PAGE;
        const data = allData.slice(start, start + STORAGE_PER_PAGE);

        const pageMiB = data.reduce((s, u) => s + u.totalMiB, 0).toFixed(2);
        renderStorageTable(data, total, totalPages, currentStoragePage, pageMiB, sortBy);
    } else {
        // Backend pagination
        const data = allData;
        const totalPages = Array.isArray(result) ? 1 : (result.totalPages || 1);
        const curPage = Array.isArray(result) ? 1 : (result.page || 1);
        const pageMiB = data.reduce((s, u) => s + u.totalMiB, 0).toFixed(2);
        renderStorageTable(data, total, totalPages, curPage, pageMiB, sortBy);
    }
}

function renderStorageTable(data, total, totalPages, curPage, pageMiB, sortBy) {
    const container = document.getElementById('stc-ua-list');
    if (!container) return;

    // Helper function to format relative time
    const formatRelativeTime = (timestamp) => {
        if (!timestamp) return '从未';
        const now = Date.now();
        const diff = now - timestamp;
        const days = Math.floor(diff / 86400000);
        const hours = Math.floor((diff % 86400000) / 3600000);
        const mins = Math.floor((diff % 3600000) / 60000);

        if (days > 0) return `${days}天前`;
        if (hours > 0) return `${hours}小时前`;
        if (mins > 0) return `${mins}分钟前`;
        return '刚刚';
    };

    const rows = data.map(u => {
        const c = u.categories || {};
        const backupMiB = c.backups || 0;

        // Get activity time from metadata
        const meta = _userMetaMap[u.handle] || {};
        const lastActivity = meta.lastActiveAt || meta.lastLoginAt || meta.createdAt || 0;
        const activityText = formatRelativeTime(lastActivity);
        const activityColor = (() => {
            const days = (Date.now() - lastActivity) / 86400000;
            if (days < 1) return '#27ae60';
            if (days < 7) return '#f39c12';
            if (days < 30) return '#e67e22';
            return '#e74c3c';
        })();

        const isChecked = _selectedHandles.has(u.handle);

        return `<tr style="border-bottom:1px solid rgba(255,255,255,.04);transition:background .1s"
                    onmouseover="this.style.background='rgba(255,255,255,.04)'"
                    onmouseout="this.style.background='${isChecked ? 'rgba(108,99,255,.15)' : ''}'">
            <td style="padding:8px 10px;text-align:center;width:36px">
                <input type="checkbox" class="stc-user-checkbox" data-handle="${esc(u.handle)}"
                    ${isChecked ? 'checked' : ''}
                    style="width:15px;height:15px;cursor:pointer;accent-color:#6c63ff">
            </td>
            <td style="padding:8px 10px;font-weight:600">${esc(u.handle)}</td>
            <td style="padding:8px 10px;text-align:right;color:#eee;font-weight:600">${u.totalMiB} MiB</td>
            <td style="padding:8px 10px;text-align:right;color:#aaa">${c.chats || 0}</td>
            <td style="padding:8px 10px;text-align:right;color:#aaa">${c.characters || 0}</td>
            <td style="padding:8px 10px;text-align:right;color:${backupMiB > 10 ? '#f39c12' : '#aaa'}"
                title="${backupMiB > 10 ? '备份文件较多，建议清理' : ''}">${backupMiB}${backupMiB > 10 ? ' ⚠' : ''}</td>
            <td style="padding:8px 10px;text-align:right;color:#aaa">${c.worlds || 0}</td>
            <td style="padding:8px 10px;text-align:right;color:#aaa">${c.other || 0}</td>
            <td style="padding:8px 10px;text-align:center;color:${activityColor};font-size:.85em">${activityText}</td>
            <td style="padding:8px 10px;text-align:center;white-space:nowrap">
                <button class="stc-user-reset menu_button" data-handle="${esc(u.handle)}"
                    style="padding:3px 8px;font-size:.75em;margin-right:4px;color:#fff" title="重置">
                    <i class="fa-solid fa-rotate-left"></i></button>
                <button class="stc-user-delete menu_button" data-handle="${esc(u.handle)}"
                    style="padding:3px 8px;font-size:.75em;background:#c0392b;color:#fff" title="删除">
                    <i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>`;
    }).join('');

    const pager = createPagination(curPage, totalPages, 'stc-storage-page-btn');

    const startIdx = (curPage - 1) * STORAGE_PER_PAGE + 1;
    const endIdx   = Math.min(curPage * STORAGE_PER_PAGE, total);

    const sortLabel = sortBy === 'storage' ? '按占用排序' : sortBy === 'activity' ? '按活跃时间' : '按用户名';
    const sortIcon = sortBy === 'storage' ? 'fa-arrow-down-wide-short' : sortBy === 'activity' ? 'fa-clock' : 'fa-arrow-down-a-z';

    const allHandles = data.map(u => u.handle);
    const allChecked = allHandles.length > 0 && allHandles.every(h => _selectedHandles.has(h));
    const someChecked = allHandles.some(h => _selectedHandles.has(h));
    const selectedCount = _selectedHandles.size;

    container.innerHTML = `
        <!-- Search bar -->
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
            <input id="stc-storage-search" type="text" placeholder="搜索用户名..."
                value="${esc(storageSearchTerm)}"
                style="flex:1;min-width:160px;padding:6px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;font-size:.85em">
            <button id="stc-storage-search-btn" class="menu_button" style="padding:6px 16px;font-size:.85em;white-space:nowrap;color:#fff">
                <i class="fa-solid fa-magnifying-glass"></i> 搜索</button>
            ${storageSearchTerm ? `<button id="stc-storage-clear-btn" class="menu_button" style="padding:6px 14px;font-size:.85em;white-space:nowrap;color:#fff">
                <i class="fa-solid fa-xmark"></i> 清除</button>` : ''}
            <button id="stc-storage-sort-btn" class="menu_button" data-sort="${sortBy}"
                style="padding:6px 14px;font-size:.85em;white-space:nowrap;background:${sortBy !== 'name' ? '#4a90e2' : ''};color:#fff">
                <i class="fa-solid ${sortIcon}"></i> ${sortLabel}</button>
        </div>
        <!-- Batch action bar -->
        <div id="stc-batch-bar" style="display:${selectedCount > 0 ? 'flex' : 'none'};align-items:center;gap:10px;padding:8px 12px;background:rgba(108,99,255,.15);border:1px solid rgba(108,99,255,.4);border-radius:8px;margin-bottom:10px;flex-wrap:wrap">
            <span style="font-size:.85em;color:#ccc"><i class="fa-solid fa-check-square" style="color:#6c63ff;margin-right:4px"></i>已选 <strong style="color:#fff" id="stc-selected-count">${selectedCount}</strong> 个用户</span>
            <button id="stc-batch-delete-btn" class="menu_button" style="padding:5px 14px;font-size:.82em;background:#c0392b;color:#fff;white-space:nowrap">
                <i class="fa-solid fa-trash-can"></i> 批量删除</button>
            <button id="stc-batch-clear-btn" class="menu_button" style="padding:5px 14px;font-size:.82em;color:#fff;white-space:nowrap">
                <i class="fa-solid fa-xmark"></i> 取消选择</button>
        </div>
        <!-- Summary -->
        <div style="color:#888;font-size:.82em;margin-bottom:8px;display:flex;gap:12px;flex-wrap:wrap">
            <span>共 <strong style="color:#eee">${total}</strong> 个用户
                ${storageSearchTerm ? `（搜索"${esc(storageSearchTerm)}"）` : ''}
            </span>
            <span>显示 <strong style="color:#eee">${startIdx}–${endIdx}</strong></span>
            <span>本页占用 <strong style="color:#eee">${pageMiB} MiB</strong></span>
        </div>
        ${pager}
        <div style="overflow-x:auto;margin-top:8px">
        <table style="width:100%;border-collapse:collapse;font-size:.82em;min-width:760px">
          <thead>
            <tr style="color:#888;border-bottom:1px solid #2a3a5e">
              <th style="padding:8px 10px;text-align:center;width:36px">
                <input type="checkbox" id="stc-select-all" title="全选/取消全选"
                    ${allChecked ? 'checked' : ''}
                    style="width:15px;height:15px;cursor:pointer;accent-color:#6c63ff"></th>
              <th style="padding:8px 10px;text-align:left">用户</th>
              <th style="padding:8px 10px;text-align:right">总占用</th>
              <th style="padding:8px 10px;text-align:right">聊天记录</th>
              <th style="padding:8px 10px;text-align:right">角色卡</th>
              <th style="padding:8px 10px;text-align:right">备份文件</th>
              <th style="padding:8px 10px;text-align:right">世界书</th>
              <th style="padding:8px 10px;text-align:right">其他</th>
              <th style="padding:8px 10px;text-align:center">最后活跃</th>
              <th style="padding:8px 10px;text-align:center">操作</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table></div>
        ${pager}`;

    // Search handlers
    const searchInput = container.querySelector('#stc-storage-search');
    const doSearch = () => {
        storageSearchTerm = searchInput?.value?.trim() || '';
        currentStoragePage = 1;
        loadStorageAnalysis(1, sortBy);
    };
    container.querySelector('#stc-storage-search-btn')?.addEventListener('click', doSearch);
    container.querySelector('#stc-storage-clear-btn')?.addEventListener('click', () => {
        storageSearchTerm = '';
        currentStoragePage = 1;
        loadStorageAnalysis(1, sortBy);
    });
    searchInput?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

    // Sort button handler
    container.querySelector('#stc-storage-sort-btn')?.addEventListener('click', () => {
        // Cycle through: name -> storage -> activity -> name
        let newSort = 'name';
        if (sortBy === 'name') newSort = 'storage';
        else if (sortBy === 'storage') newSort = 'activity';
        else newSort = 'name';
        currentStoragePage = 1;
        loadStorageAnalysis(1, newSort);
    });

    // Pagination handlers
    container.querySelectorAll('.stc-storage-page-btn').forEach(b => {
        b.addEventListener('click', () => loadStorageAnalysis(parseInt(b.dataset.page), sortBy));
    });

    // Action button handlers
    container.querySelectorAll('.stc-user-reset').forEach(btn => {
        btn.addEventListener('click', () => resetUser(btn.dataset.handle));
    });
    container.querySelectorAll('.stc-user-delete').forEach(btn => {
        btn.addEventListener('click', () => deleteSingleUser(btn.dataset.handle));
    });

    // Checkbox handlers
    const updateBatchBar = () => {
        const bar = container.querySelector('#stc-batch-bar');
        const countEl = container.querySelector('#stc-selected-count');
        if (bar) bar.style.display = _selectedHandles.size > 0 ? 'flex' : 'none';
        if (countEl) countEl.textContent = _selectedHandles.size;
        // Update select-all checkbox state
        const selectAll = container.querySelector('#stc-select-all');
        if (selectAll) {
            const pageHandles = data.map(u => u.handle);
            selectAll.checked = pageHandles.length > 0 && pageHandles.every(h => _selectedHandles.has(h));
            selectAll.indeterminate = !selectAll.checked && pageHandles.some(h => _selectedHandles.has(h));
        }
        // Update row highlight
        container.querySelectorAll('.stc-user-checkbox').forEach(cb => {
            const row = cb.closest('tr');
            if (row) row.style.background = cb.checked ? 'rgba(108,99,255,.15)' : '';
        });
    };

    container.querySelector('#stc-select-all')?.addEventListener('change', (e) => {
        const pageHandles = data.map(u => u.handle);
        if (e.target.checked) {
            pageHandles.forEach(h => _selectedHandles.add(h));
        } else {
            pageHandles.forEach(h => _selectedHandles.delete(h));
        }
        container.querySelectorAll('.stc-user-checkbox').forEach(cb => {
            cb.checked = e.target.checked;
        });
        updateBatchBar();
    });

    container.querySelectorAll('.stc-user-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            if (e.target.checked) {
                _selectedHandles.add(cb.dataset.handle);
            } else {
                _selectedHandles.delete(cb.dataset.handle);
            }
            updateBatchBar();
        });
    });

    container.querySelector('#stc-batch-delete-btn')?.addEventListener('click', deleteBatchUsers);
    container.querySelector('#stc-batch-clear-btn')?.addEventListener('click', () => {
        _selectedHandles.clear();
        updateBatchBar();
        container.querySelectorAll('.stc-user-checkbox').forEach(cb => { cb.checked = false; });
        const selectAll = container.querySelector('#stc-select-all');
        if (selectAll) { selectAll.checked = false; selectAll.indeterminate = false; }
    });

    // Initial highlight for already-selected rows
    updateBatchBar();
}

async function previewInactiveUsers() {
    const days = parseInt(document.getElementById('stc-inactive-days')?.value) || 30;
    const minStorage = parseFloat(document.getElementById('stc-inactive-min-storage')?.value) || 0;
    const resultDiv = document.getElementById('stc-inactive-preview-result');
    if (!resultDiv) return;
    resultDiv.style.display = '';
    resultDiv.innerHTML = `<div style="text-align:center;padding:16px;color:#888"><i class="fa-solid fa-spinner fa-spin"></i> 扫描中...</div>`;
    try {
        const r = await fetch('/api/stc/users/delete-inactive', {
            method: 'POST', headers: getHeaders(),
            body: JSON.stringify({ maxInactiveDays: days, minStorageMB: minStorage, dryRun: true }),
        });
        if (!r.ok) throw new Error((await r.json())?.error);
        const d = await r.json();
        renderInactivePreview(d.candidates || []);
    } catch (e) { resultDiv.innerHTML = `<div style="color:#e74c3c;padding:12px">预览失败: ${esc(e.message)}</div>`; }
}

// Cached full candidate list for client-side inactive user pagination
let _inactiveCandidates = [];

function renderInactivePreview(candidates, page) {
    if (candidates !== undefined) _inactiveCandidates = candidates;
    if (page !== undefined) currentInactivePage = page;

    const resultDiv = document.getElementById('stc-inactive-preview-result');
    if (!resultDiv) return;
    if (!_inactiveCandidates.length) {
        resultDiv.innerHTML = `<div style="color:#27ae60;padding:12px"><i class="fa-solid fa-check-circle"></i> 未找到符合条件的不活跃用户</div>`;
        return;
    }

    const all        = _inactiveCandidates;
    const totalPages = Math.ceil(all.length / INACTIVE_PER_PAGE);
    if (currentInactivePage > totalPages) currentInactivePage = totalPages;
    const start  = (currentInactivePage - 1) * INACTIVE_PER_PAGE;
    const pageItems = all.slice(start, start + INACTIVE_PER_PAGE);
    const pager  = createPagination(currentInactivePage, totalPages, 'stc-inactive-page-btn');

    resultDiv.innerHTML = `
        <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:14px">
          <div style="font-weight:600;margin-bottom:10px;color:#f39c12;display:flex;align-items:center;gap:8px">
            <i class="fa-solid fa-user-clock"></i>
            <span>找到 ${all.length} 个不活跃用户
              （显示 ${start + 1}–${Math.min(start + INACTIVE_PER_PAGE, all.length)}）</span>
          </div>
          ${pager}
          <div style="overflow-x:auto">
          <table style="width:100%;border-collapse:collapse;font-size:.82em;min-width:480px">
            <thead><tr style="color:#888;border-bottom:1px solid #333">
              <th style="padding:6px 8px;text-align:left">用户名</th>
              <th style="padding:6px 8px;text-align:left">最后登录</th>
              <th style="padding:6px 8px;text-align:right">未登录天数</th>
              <th style="padding:6px 8px;text-align:right">存储占用</th>
              <th style="padding:6px 8px;text-align:left">邮箱</th>
            </tr></thead>
            <tbody>
              ${pageItems.map(c => `
              <tr style="border-bottom:1px solid rgba(255,255,255,.04);transition:background .1s"
                  onmouseover="this.style.background='rgba(255,255,255,.04)'"
                  onmouseout="this.style.background=''">
                <td style="padding:6px 8px;font-weight:600">${esc(c.handle)}</td>
                <td style="padding:6px 8px;color:#888">${c.lastLoginAt ? new Date(c.lastLoginAt).toLocaleDateString('zh-CN') : '从未登录'}</td>
                <td style="padding:6px 8px;text-align:right;color:#f39c12">${c.daysInactive} 天</td>
                <td style="padding:6px 8px;text-align:right;color:#888">${c.usedMiB != null ? c.usedMiB + ' MiB' : '-'}</td>
                <td style="padding:6px 8px;color:#888">${c.email ? esc(c.email) : '<span style="color:#555">无邮箱</span>'}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>
          ${pager}
          <div style="font-size:.8em;color:#888;margin-top:8px">
            * 其中 ${all.filter(c => c.email).length} 人有邮箱可接收通知，
            ${all.filter(c => !c.email).length} 人无邮箱记录</div>
        </div>`;

    resultDiv.querySelectorAll('.stc-inactive-page-btn').forEach(b => {
        b.addEventListener('click', () => renderInactivePreview(undefined, parseInt(b.dataset.page)));
    });
}

async function warnInactiveUsers() {
    const days = parseInt(document.getElementById('stc-inactive-days')?.value) || 30;
    const minStorage = parseFloat(document.getElementById('stc-inactive-min-storage')?.value) || 0;
    const btn = document.getElementById('stc-inactive-warn');
    if (btn) { btn.disabled = true; btn._orig = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 发送中...'; }
    try {
        const r = await fetch('/api/stc/users/warn-inactive', {
            method: 'POST', headers: getHeaders(),
            body: JSON.stringify({ maxInactiveDays: days, minStorageMB: minStorage }),
        });
        if (!r.ok) throw new Error((await r.json())?.error);
        const d = await r.json();
        toast(`提醒邮件发送完成：成功 ${d.sent} 封，跳过(无邮箱) ${d.skipped} 人${d.errors.length ? '，部分失败' : ''}`);
        if (d.errors.length) console.warn('[STC] warn-inactive errors:', d.errors);
    } catch (e) { toast('发送失败: ' + e.message, true); }
    finally {
        if (btn) { btn.disabled = false; btn.innerHTML = btn._orig; }
    }
}

async function deleteInactiveUsers() {
    const days = parseInt(document.getElementById('stc-inactive-days')?.value) || 30;
    const minStorage = parseFloat(document.getElementById('stc-inactive-min-storage')?.value) || 0;
    const sendEmail = !!document.getElementById('stc-inactive-send-email')?.checked;
    const storageDesc = minStorage > 0 ? `且存储占用 < ${minStorage} MB` : '';
    if (!confirm(`⚠ 危险操作！确定要彻底删除超过 ${days} 天未登录${storageDesc}的用户吗？\n\n这将永久清除这些用户的 SillyTavern 账号及其所有数据（聊天记录、角色卡、世界书、备份等），操作不可恢复！${sendEmail ? '\n\n（将同时发送删除通知邮件）' : ''}`)) return;
    const btn = document.getElementById('stc-inactive-delete');
    if (btn) { btn.disabled = true; btn._orig = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 处理中...'; }
    try {
        const r = await fetch('/api/stc/users/delete-inactive', {
            method: 'POST', headers: getHeaders(),
            body: JSON.stringify({ maxInactiveDays: days, minStorageMB: minStorage, dryRun: false, sendEmailNotice: sendEmail }),
        });
        if (!r.ok) throw new Error((await r.json())?.error);
        const d = await r.json();
        let msg = `已彻底删除 ${d.deleted} 个不活跃用户（账号及全部数据已清除）`;
        if (sendEmail && d.emailResults) {
            msg += `\n邮件通知：发送 ${d.emailResults.sent} 封，跳过 ${d.emailResults.skipped} 人`;
        }
        if (d.purgeErrors?.length) {
            msg += `\n警告：${d.purgeErrors.length} 个用户清理时遇到错误`;
        }
        toast(msg);
        const resultDiv = document.getElementById('stc-inactive-preview-result');
        if (resultDiv) {
            const errHtml = d.purgeErrors?.length
                ? `<div style="color:#f39c12;margin-top:8px;font-size:.85em">清理异常：${d.purgeErrors.map(e => `${esc(e.handle)}: ${esc(e.error)}`).join('；')}</div>`
                : '';
            resultDiv.innerHTML = `<div style="color:#27ae60;padding:12px"><i class="fa-solid fa-check-circle"></i> ${esc(msg)}</div>${errHtml}`;
        }
        currentStoragePage = 1;
        storageSearchTerm = '';
        await loadStorageAnalysis(1);
    } catch (e) { toast('删除失败: ' + e.message, true); }
    finally {
        if (btn) { btn.disabled = false; btn.innerHTML = btn._orig; }
    }
}

// ═══════════════════════════════════════════════════
// TAB: QRole 会员（过期账号管理 + 自动清理）
// ═══════════════════════════════════════════════════
const QROLE_ACCOUNTS_PER_PAGE = 30;
const QROLE_EXPIRING_DAYS = 7;
const DAY_MS = 86400000;
const QROLE_STATE_LABELS = {
    active: ['有效', '#27ae60'],
    expired: ['已过期', '#e74c3c'],
    not_member: ['非会员', '#e67e22'],
};
const QROLE_FILTERS = [
    ['all', '全部'],
    ['expired', '已过期'],
    ['expiring', `${QROLE_EXPIRING_DAYS} 天内到期`],
    ['active', '有效'],
];
const QROLE_VERIFY_MESSAGES = {
    no_token: '该账号没有可用的刷新令牌，无法后台复核（需用户重新使用 QRole 登录）',
    transient: '暂时无法连接 QRole，请稍后重试',
    definitive: 'QRole 拒绝了该账号的刷新令牌（已过期、被撤销或账号异常），令牌已删除',
};
// Why a cleanup run kept an account (skipped[].reason of the run result)
const QROLE_CLEANUP_SKIP_LABELS = {
    gone: '账号已不存在',
    renewed: '已续费',
    not_due: '未到清理时间',
    verify_transient: '暂时无法连接 QRole，顺延到下次',
    verify_deferred: '本次复核次数已达上限，顺延到下次',
    verify_unavailable: '无法复核（令牌密钥不可用或已关闭后台复核），未删除',
    verify_client_rejected: 'QRole 拒绝了本站的客户端凭据，未删除（请检查 OAuth 配置）',
    cleanup_disabled: '清理已被关闭，未删除',
};
// Verify reasons with a more specific message than QROLE_VERIFY_MESSAGES[result]
const QROLE_VERIFY_REASON_MESSAGES = {
    invalid_client: 'QRole 拒绝了本站的客户端凭据（invalid_client），请检查「OAuth 配置」中 QRole 的 Client ID、Client Secret 与令牌认证方式；已保存的刷新令牌不受影响',
};
// Background cleanup run: poll GET .../cleanup/status until the run has finished
const QROLE_CLEANUP_POLL_MS = 3000;
const QROLE_CLEANUP_POLL_MAX_MS = 30 * 60 * 1000;

let _qroleAccounts = [];
let _qroleCleanup = {};
let _qroleClockOffset = 0;
let _qroleFilter = 'all';
let _qroleSearch = '';
let _qrolePage = 1;
const _qroleSelected = new Set();

/** Server-adjusted current time (the account list carries the server's `now`). */
function qroleNow() {
    return Date.now() + _qroleClockOffset;
}

/** ms number, seconds number or ISO string → ms (null when missing/invalid). */
function toMs(value) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        return value < 1e12 ? value * 1000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

/** Local `YYYY-MM-DD`. */
function fmtDate(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Local `YYYY-MM-DD HH:mm`. */
function fmtDateTime(ms) {
    const d = new Date(ms);
    return `${fmtDate(ms)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Byte count → human readable size ('未知' when unknown). */
function fmtBytes(bytes) {
    const n = Number(bytes);
    if (bytes === null || bytes === undefined || !Number.isFinite(n) || n < 0) return '未知';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function fmtRelativePast(ms) {
    if (!ms) return '从未';
    const diff = qroleNow() - ms;
    if (diff < 60000) return '刚刚';
    const days = Math.floor(diff / DAY_MS);
    if (days > 0) return `${days}天前`;
    const hours = Math.floor(diff / 3600000);
    if (hours > 0) return `${hours}小时前`;
    return `${Math.floor(diff / 60000)}分钟前`;
}

function qroleStateLabel(state) {
    return Object.hasOwn(QROLE_STATE_LABELS, state) ? QROLE_STATE_LABELS[state][0] : '未知';
}

function isQroleExpiringSoon(account) {
    if (account.state !== 'active') return false;
    const expiresAt = toMs(account.expiresAt);
    const now = qroleNow();
    return expiresAt !== null && expiresAt > now && expiresAt - now <= QROLE_EXPIRING_DAYS * DAY_MS;
}

function qroleMatchesFilter(account, filter) {
    switch (filter) {
        case 'expired': return account.state !== 'active';
        case 'expiring': return isQroleExpiringSoon(account);
        case 'active': return account.state === 'active';
        default: return true;
    }
}

/** Non-active accounts first (longest expired first), then active ones by expiry (soonest first). */
function compareQroleAccounts(a, b) {
    const aActive = a.state === 'active';
    const bActive = b.state === 'active';
    if (aActive !== bActive) return aActive ? 1 : -1;
    const key = aActive ? 'expiresAt' : 'expiredSince';
    const aTime = toMs(a[key]) ?? Infinity;
    const bTime = toMs(b[key]) ?? Infinity;
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;
    return String(a.handle).localeCompare(String(b.handle));
}

/** Result code of a verification (`'ok'`, `{ result: 'ok' }`...). */
function qroleResultCode(value) {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
        for (const key of ['result', 'outcome', 'code']) {
            if (typeof value[key] === 'string') return value[key];
        }
    }
    return '';
}

/** `handle（detail）` list of result items, at most 10 (escaped HTML). */
function describeQroleResultItems(items, detail) {
    const texts = items
        .filter(item => item && typeof item.handle === 'string')
        .map(item => {
            const extra = detail(item);
            return esc(item.handle) + (extra ? `（${esc(extra)}）` : '');
        });
    return texts.slice(0, 10).join('、') + (texts.length > 10 ? ` 等 ${texts.length} 个` : '');
}

/**
 * One-line summary of a cleanup run result (escaped HTML): the result of POST .../cleanup/run
 * and `cleanup.lastResult` of the account list share the shape
 * `{ candidates, deletedCount, skippedCount, failedCount, remaining, deleted[], skipped[], failed[], error? }`.
 */
function describeQroleCleanupResult(result) {
    if (!result || typeof result !== 'object') return '无';
    const deleted = Array.isArray(result.deleted) ? result.deleted : [];
    const skipped = Array.isArray(result.skipped) ? result.skipped : [];
    const failed = Array.isArray(result.failed) ? result.failed : [];
    const count = (value, list) => (Number.isFinite(value) ? value : list.length);
    const parts = [];
    if (Number.isFinite(result.candidates)) parts.push(`到期账号 ${result.candidates} 个`);
    parts.push(`删除 ${count(result.deletedCount, deleted)} 个`);
    parts.push(`跳过 ${count(result.skippedCount, skipped)} 个`);
    const failedCount = count(result.failedCount, failed);
    if (failedCount) parts.push(`<span style="color:#e74c3c">失败 ${failedCount} 个</span>`);
    if (Number.isFinite(result.remaining) && result.remaining > 0) parts.push(`${result.remaining} 个顺延到下次运行`);
    if (result.stopped === 'disabled') parts.push('<span style="color:#f39c12">运行中清理被关闭，任务已提前结束</span>');
    if (typeof result.error === 'string' && result.error) parts.push(`<span style="color:#e74c3c">错误：${esc(result.error)}</span>`);
    if (deleted.length) parts.push(`已删除：${describeQroleResultItems(deleted, () => '')}`);
    if (skipped.length) {
        parts.push(`已跳过：${describeQroleResultItems(skipped, item => (Object.hasOwn(QROLE_CLEANUP_SKIP_LABELS, item.reason) ? QROLE_CLEANUP_SKIP_LABELS[item.reason] : String(item.reason ?? '')))}`);
    }
    if (failed.length) {
        parts.push(`<span style="color:#e74c3c">失败：${describeQroleResultItems(failed, item => String(item.error ?? ''))}</span>`);
    }
    return parts.join('，');
}

async function renderQroleTab(container) {
    const input = 'padding:7px 10px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee';
    container.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;flex-wrap:wrap;gap:8px">
        <h3 style="margin:0"><i class="fa-solid fa-crown" style="color:#ffc440;margin-right:6px"></i>QRole 会员账号</h3>
        <button id="stc-qa-refresh" class="menu_button" style="height:36px;padding:0 18px;font-size:.85em;white-space:nowrap;display:flex;align-items:center;gap:6px;color:#fff">
          <i class="fa-solid fa-rotate-right"></i> 刷新</button>
      </div>
      <div id="stc-qa-notice"></div>
      <div style="font-size:.8em;color:#aaa;margin-bottom:12px;padding:8px 10px;background:rgba(255,255,255,.04);border-radius:6px;border-left:2px solid #ffc440;line-height:1.6">
        <i class="fa-solid fa-circle-info" style="margin-right:4px"></i>
        仅列出通过 QRole 登录创建的账号（不含管理员）。「已过期」包含会员已到期和当前不是会员的账号；有刷新令牌的账号可「立即复核」向 QRole 确认最新会员状态。
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap">
        ${QROLE_FILTERS.map(([id, label]) => `
        <button class="stc-qa-filter menu_button" data-filter="${id}" style="padding:6px 12px;font-size:.82em;white-space:nowrap;color:#fff">
          ${label} <span class="stc-qa-count" data-filter="${id}" style="opacity:.7"></span></button>`).join('')}
        <input id="stc-qa-search" type="text" placeholder="搜索用户名..." style="flex:1;min-width:140px;${input};font-size:.85em">
      </div>
      <div id="stc-qa-batch-bar" style="display:none;align-items:center;gap:10px;padding:8px 12px;background:rgba(108,99,255,.15);border:1px solid rgba(108,99,255,.4);border-radius:8px;margin-bottom:10px;flex-wrap:wrap">
        <span style="font-size:.85em;color:#ccc"><i class="fa-solid fa-check-square" style="color:#6c63ff;margin-right:4px"></i>已选 <strong id="stc-qa-selected-count" style="color:#fff">0</strong> 个账号，合计 <strong id="stc-qa-selected-size" style="color:#fff"></strong></span>
        <button id="stc-qa-batch-delete" class="menu_button" style="padding:5px 14px;font-size:.82em;background:#c0392b;color:#fff;white-space:nowrap">
          <i class="fa-solid fa-trash-can"></i> 批量删除所选</button>
        <button id="stc-qa-batch-clear" class="menu_button" style="padding:5px 14px;font-size:.82em;color:#fff;white-space:nowrap">
          <i class="fa-solid fa-xmark"></i> 取消选择</button>
      </div>
      <div id="stc-qa-list" style="margin-bottom:28px">
        <div style="text-align:center;padding:24px;color:#888"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>
      </div>

      <!-- Automatic cleanup -->
      <div style="border-top:1px solid #2a3a5e;padding-top:20px">
        <h3 style="margin:0 0 14px"><i class="fa-solid fa-broom" style="color:#e74c3c;margin-right:6px"></i>自动清理过期 QRole 账号</h3>
        <div style="background:rgba(231,76,60,.08);border:1px solid rgba(231,76,60,.3);border-radius:8px;padding:12px;margin-bottom:14px;font-size:.85em;color:#e88;line-height:1.6">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <strong>删除不可恢复！</strong>开启后，服务器每天检查一次，彻底删除超过保留期限的过期 / 非会员 QRole 账号及其全部数据（每次最多 20 个）。
          有刷新令牌的账号会在删除前先向 QRole 复核，已续费的账号不会被删除。
        </div>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:.9em">
          <input id="stc-qa-cleanup-enabled" type="checkbox"> 启用自动清理</label>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap">
          <span style="font-size:.85em;color:#aaa">过期后保留天数:</span>
          <input id="stc-qa-cleanup-days" type="number" min="${QROLE_CLEANUP_MIN_DAYS}" max="${QROLE_CLEANUP_MAX_DAYS}" step="1"
            placeholder="${QROLE_DEFAULTS.expiredCleanup.afterDays}" style="${input};width:100px">
          <span style="font-size:.85em;color:#888">天（${QROLE_CLEANUP_MIN_DAYS}-${QROLE_CLEANUP_MAX_DAYS}）</span>
        </div>
        <div style="font-size:.78em;color:#888;margin-bottom:14px;line-height:1.6">
          计划清理时间 = 会员到期（或被判定为非会员）时间、最后活跃时间、最后登录时间三者中最晚者 + 保留天数。
          仅在 QRole 配置开启「仅允许会员登录」时运行。
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;margin-bottom:12px">
          <button id="stc-qa-cleanup-save" class="menu_button" style="padding:9px 18px;font-size:.85em;background:#27ae60;white-space:nowrap;color:#fff">
            <i class="fa-solid fa-save"></i> 保存清理设置</button>
          <button id="stc-qa-cleanup-preview" class="menu_button" style="padding:9px 18px;font-size:.85em;white-space:nowrap;color:#fff">
            <i class="fa-solid fa-magnifying-glass"></i> 预览将被清理的账号</button>
          <button id="stc-qa-cleanup-run" class="menu_button" style="padding:9px 18px;font-size:.85em;background:#c0392b;white-space:nowrap;color:#fff">
            <i class="fa-solid fa-trash-can"></i> 立即执行清理</button>
        </div>
        <div id="stc-qa-cleanup-last" style="font-size:.82em;color:#888;margin-bottom:10px"></div>
        <div id="stc-qa-cleanup-result" style="display:none"></div>
      </div>`;

    container.querySelector('#stc-qa-refresh')?.addEventListener('click', () => loadQroleAccounts());
    container.querySelectorAll('.stc-qa-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            _qroleFilter = btn.dataset.filter;
            _qrolePage = 1;
            renderQroleAccounts();
        });
    });
    const search = container.querySelector('#stc-qa-search');
    if (search) {
        search.value = _qroleSearch;
        search.addEventListener('input', () => {
            _qroleSearch = search.value.trim();
            _qrolePage = 1;
            renderQroleAccounts();
        });
    }
    container.querySelector('#stc-qa-batch-delete')?.addEventListener('click', deleteSelectedQroleAccounts);
    container.querySelector('#stc-qa-batch-clear')?.addEventListener('click', () => {
        _qroleSelected.clear();
        renderQroleAccounts();
    });
    container.querySelector('#stc-qa-cleanup-save')?.addEventListener('click', saveQroleCleanupSettings);
    container.querySelector('#stc-qa-cleanup-preview')?.addEventListener('click', previewQroleCleanup);
    container.querySelector('#stc-qa-cleanup-run')?.addEventListener('click', runQroleCleanup);

    await loadQroleAccounts({ syncCleanupForm: true });
}

/**
 * GET /api/stc/qrole-accounts (+ the QRole config for notices).
 * @param {{ syncCleanupForm?: boolean }} [options] Also fill the cleanup settings inputs
 */
async function loadQroleAccounts({ syncCleanupForm = false } = {}) {
    const list = document.getElementById('stc-qa-list');
    if (!list) return;
    list.innerHTML = '<div style="text-align:center;padding:24px;color:#888"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>';

    const configPromise = fetch('/api/stc/oauth-config/config', { headers: getHeaders() })
        .then(r => (r.ok ? r.json() : null))
        .catch(() => null);
    try {
        const r = await fetch('/api/stc/qrole-accounts', { headers: getHeaders(), cache: 'no-store' });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);

        _qroleAccounts = Array.isArray(d.accounts) ? d.accounts.filter(a => a && typeof a.handle === 'string') : [];
        _qroleCleanup = d.cleanup && typeof d.cleanup === 'object' ? d.cleanup : {};
        const serverNow = toMs(d.now);
        _qroleClockOffset = serverNow !== null ? serverNow - Date.now() : 0;
        // Drop selections of accounts that no longer exist
        const handles = new Set(_qroleAccounts.map(a => a.handle));
        for (const handle of [..._qroleSelected]) {
            if (!handles.has(handle)) _qroleSelected.delete(handle);
        }
        if (syncCleanupForm) syncQroleCleanupForm();
        renderQroleCleanupLastRun();
        renderQroleAccounts();
    } catch (e) {
        list.innerHTML = `<div style="color:#e74c3c;text-align:center;padding:20px">加载失败: ${esc(e.message)}</div>`;
    }

    const config = await configPromise;
    const notice = document.getElementById('stc-qa-notice');
    if (notice && config?.qrole) {
        const warnings = [];
        if (config.qrole.enabled !== true) warnings.push('QRole 登录当前未启用。');
        if (config.qrole.requireMembership === false) warnings.push('「仅允许会员登录」已关闭：会员状态不再限制登录，自动清理不会运行。');
        notice.innerHTML = warnings.length
            ? `<div style="background:rgba(243,156,18,.08);border:1px solid rgba(243,156,18,.3);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:.82em;color:#f5d76e">
                <i class="fa-solid fa-triangle-exclamation"></i> ${warnings.map(esc).join(' ')}</div>`
            : '';
    }
}

function syncQroleCleanupForm() {
    const enabled = document.getElementById('stc-qa-cleanup-enabled');
    const days = document.getElementById('stc-qa-cleanup-days');
    if (enabled) enabled.checked = _qroleCleanup.enabled === true;
    if (days) {
        days.value = Number.isInteger(_qroleCleanup.afterDays)
            ? _qroleCleanup.afterDays
            : QROLE_DEFAULTS.expiredCleanup.afterDays;
    }
}

function renderQroleCleanupLastRun() {
    const el = document.getElementById('stc-qa-cleanup-last');
    if (!el) return;
    const lastRunAt = toMs(_qroleCleanup.lastRunAt);
    const status = _qroleCleanup.enabled === true
        ? '<span style="color:#27ae60">已启用</span>'
        : '<span style="color:#888">未启用</span>';
    el.innerHTML = `<i class="fa-solid fa-info-circle"></i> 自动清理：${status} · 上次运行：<span style="color:#aaa">${lastRunAt !== null ? fmtDateTime(lastRunAt) : '从未运行'}</span>`
        + (lastRunAt !== null && _qroleCleanup.lastResult !== undefined && _qroleCleanup.lastResult !== null
            ? ` · 结果：<span style="color:#aaa">${describeQroleCleanupResult(_qroleCleanup.lastResult)}</span>`
            : '')
        + (_qroleCleanup.running === true ? ' · <span style="color:#f39c12"><i class="fa-solid fa-spinner fa-spin"></i> 清理正在运行</span>' : '');
}

function renderQroleAccounts() {
    const list = document.getElementById('stc-qa-list');
    if (!list) return;

    // Filter buttons: counts + active state
    document.querySelectorAll('.stc-qa-count').forEach(el => {
        el.textContent = `(${_qroleAccounts.filter(a => qroleMatchesFilter(a, el.dataset.filter)).length})`;
    });
    document.querySelectorAll('.stc-qa-filter').forEach(btn => {
        btn.style.background = btn.dataset.filter === _qroleFilter ? '#6c63ff' : '';
    });

    const term = _qroleSearch.toLowerCase();
    const filtered = _qroleAccounts
        .filter(a => qroleMatchesFilter(a, _qroleFilter))
        .filter(a => !term || a.handle.toLowerCase().includes(term) || String(a.name ?? '').toLowerCase().includes(term))
        .sort(compareQroleAccounts);

    updateQroleBatchBar();

    if (!filtered.length) {
        list.innerHTML = emptyState('fa-crown', _qroleAccounts.length ? '没有符合条件的账号' : '暂无 QRole 账号', _qroleAccounts.length ? '请更换筛选条件' : '还没有通过 QRole 登录的用户');
        return;
    }

    const totalPages = Math.ceil(filtered.length / QROLE_ACCOUNTS_PER_PAGE);
    if (_qrolePage > totalPages) _qrolePage = totalPages;
    const start = (_qrolePage - 1) * QROLE_ACCOUNTS_PER_PAGE;
    const page = filtered.slice(start, start + QROLE_ACCOUNTS_PER_PAGE);
    const pager = createPagination(_qrolePage, totalPages, 'stc-qa-page-btn');
    const now = qroleNow();
    const cell = 'padding:8px 10px';

    const rows = page.map(a => {
        const handle = esc(a.handle);
        const name = typeof a.name === 'string' && a.name && a.name !== a.handle
            ? `<div style="font-size:.85em;color:#888;font-weight:400">${esc(a.name)}</div>` : '';
        const tierTitle = [
            typeof a.tierName === 'string' ? a.tierName.trim() : '',
            a.tierAllowed === false ? '该等级不在允许登录的等级列表中' : '',
        ].filter(Boolean).join(' · ');
        const tier = typeof a.tier === 'string' && a.tier.trim()
            ? `<span style="color:${a.tierAllowed === false ? '#888' : '#ffc440'}" title="${esc(tierTitle)}">${esc(a.tier.trim().toUpperCase())}</span>`
            : '<span style="color:#666">—</span>';
        const [stateText, stateColor] = Object.hasOwn(QROLE_STATE_LABELS, a.state) ? QROLE_STATE_LABELS[a.state] : ['未知', '#888'];
        const badge = (text, color) => `<span style="color:${color};font-size:.85em;padding:2px 6px;background:${color}33;border-radius:4px;white-space:nowrap">${text}</span>`;
        const badges = badge(stateText, stateColor)
            + (isQroleExpiringSoon(a) ? ` ${badge('即将到期', '#f39c12')}` : '')
            + (a.enabled === false ? ` ${badge('已停用', '#888')}` : '');

        const expiresAt = toMs(a.expiresAt);
        const expiry = expiresAt !== null
            ? `<span title="${fmtDateTime(expiresAt)}">${fmtDate(expiresAt)}</span>`
            : `<span style="color:#666">${a.state === 'active' ? '无期限' : '—'}</span>`;

        const expiredSince = toMs(a.expiredSince);
        const expiredDays = a.state !== 'active' && expiredSince !== null
            ? `<span style="color:#e74c3c">${Math.max(0, Math.floor((now - expiredSince) / DAY_MS))} 天</span>`
            : '<span style="color:#666">—</span>';

        const lastActive = toMs(a.lastActiveAt) ?? toMs(a.lastLoginAt);
        const activity = lastActive !== null
            ? `<span title="${fmtDateTime(lastActive)}">${fmtRelativePast(lastActive)}</span>`
            : '<span style="color:#666">从未</span>';

        const tokenExpiresAt = toMs(a.refreshTokenExpiresAt);
        let token;
        if (a.hasRefreshToken !== true) {
            token = '<span style="color:#888">无令牌</span>';
        } else if (tokenExpiresAt !== null && tokenExpiresAt <= now) {
            token = `<span style="color:#e67e22" title="令牌已于 ${fmtDateTime(tokenExpiresAt)} 过期">令牌已过期</span>`;
        } else {
            token = `<span style="color:#27ae60"><i class="fa-solid fa-key"></i> 有令牌</span>${tokenExpiresAt !== null
                ? `<div style="font-size:.85em;color:#888">至 ${fmtDate(tokenExpiresAt)}</div>` : ''}`;
        }

        const cleanupAt = toMs(a.cleanupAt);
        const cleanup = cleanupAt === null
            ? '<span style="color:#666">—</span>'
            : cleanupAt <= now
                ? `<span style="color:#e74c3c" title="${fmtDateTime(cleanupAt)}">已到期（下次运行）</span>`
                : `<span style="color:#f39c12" title="${fmtDateTime(cleanupAt)}">${fmtDate(cleanupAt)}</span>`;

        const checked = _qroleSelected.has(a.handle);
        const canVerify = a.hasRefreshToken === true && (tokenExpiresAt === null || tokenExpiresAt > now);
        return `<tr style="border-bottom:1px solid rgba(255,255,255,.04);background:${checked ? 'rgba(108,99,255,.15)' : ''}">
            <td style="${cell};text-align:center;width:36px">
              <input type="checkbox" class="stc-qa-check" data-handle="${handle}" ${checked ? 'checked' : ''} style="width:15px;height:15px;cursor:pointer;accent-color:#6c63ff"></td>
            <td style="${cell};font-weight:600">${handle}${name}</td>
            <td style="${cell}">${tier}</td>
            <td style="${cell}">${badges}</td>
            <td style="${cell};white-space:nowrap">${expiry}</td>
            <td style="${cell};text-align:right;white-space:nowrap">${expiredDays}</td>
            <td style="${cell};text-align:center;white-space:nowrap">${activity}</td>
            <td style="${cell};text-align:right;white-space:nowrap">${esc(fmtBytes(a.storageBytes))}</td>
            <td style="${cell};white-space:nowrap">${token}</td>
            <td style="${cell};white-space:nowrap">${cleanup}</td>
            <td style="${cell};text-align:center;white-space:nowrap">
              <button class="stc-qa-verify menu_button" data-handle="${handle}" ${canVerify ? '' : 'disabled'}
                style="padding:3px 8px;font-size:.75em;margin-right:4px;color:#fff"
                title="${canVerify ? '立即复核：使用刷新令牌向 QRole 确认会员状态' : '没有可用的刷新令牌，无法后台复核'}">
                <i class="fa-solid fa-user-check"></i> 立即复核</button>
              <button class="stc-qa-delete menu_button" data-handle="${handle}"
                style="padding:3px 8px;font-size:.75em;background:#c0392b;color:#fff" title="删除账号及全部数据">
                <i class="fa-solid fa-trash"></i> 删除</button>
            </td>
          </tr>`;
    }).join('');

    const pageHandles = page.map(a => a.handle);
    const allChecked = pageHandles.length > 0 && pageHandles.every(h => _qroleSelected.has(h));
    const th = 'padding:8px 10px;white-space:nowrap';
    list.innerHTML = `
        <div style="color:#888;font-size:.82em;margin-bottom:8px">
          共 <strong style="color:#eee">${filtered.length}</strong> 个账号 · 显示 ${start + 1}–${Math.min(start + QROLE_ACCOUNTS_PER_PAGE, filtered.length)}
        </div>
        ${pager}
        <div style="overflow-x:auto;margin-top:8px">
        <table style="width:100%;border-collapse:collapse;font-size:.82em;min-width:980px">
          <thead><tr style="color:#888;border-bottom:1px solid #2a3a5e">
            <th style="${th};text-align:center;width:36px">
              <input type="checkbox" id="stc-qa-select-all" title="全选/取消全选本页" ${allChecked ? 'checked' : ''} style="width:15px;height:15px;cursor:pointer;accent-color:#6c63ff"></th>
            <th style="${th};text-align:left">用户名</th>
            <th style="${th};text-align:left">等级</th>
            <th style="${th};text-align:left">状态</th>
            <th style="${th};text-align:left">到期时间</th>
            <th style="${th};text-align:right">已过期天数</th>
            <th style="${th};text-align:center">最后活跃</th>
            <th style="${th};text-align:right">占用空间</th>
            <th style="${th};text-align:left">自动复核</th>
            <th style="${th};text-align:left">计划清理</th>
            <th style="${th};text-align:center">操作</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
        ${pager}`;

    list.querySelectorAll('.stc-qa-page-btn').forEach(b => {
        b.addEventListener('click', () => {
            _qrolePage = parseInt(b.dataset.page);
            renderQroleAccounts();
        });
    });
    list.querySelectorAll('.stc-qa-verify').forEach(btn => {
        btn.addEventListener('click', () => verifyQroleAccount(btn.dataset.handle, btn));
    });
    list.querySelectorAll('.stc-qa-delete').forEach(btn => {
        btn.addEventListener('click', () => deleteQroleAccount(btn.dataset.handle));
    });
    const selectAll = list.querySelector('#stc-qa-select-all');
    if (selectAll) selectAll.indeterminate = !allChecked && pageHandles.some(h => _qroleSelected.has(h));
    selectAll?.addEventListener('change', () => {
        pageHandles.forEach(h => (selectAll.checked ? _qroleSelected.add(h) : _qroleSelected.delete(h)));
        list.querySelectorAll('.stc-qa-check').forEach(cb => {
            cb.checked = selectAll.checked;
            const row = cb.closest('tr');
            if (row) row.style.background = cb.checked ? 'rgba(108,99,255,.15)' : '';
        });
        updateQroleBatchBar();
    });
    list.querySelectorAll('.stc-qa-check').forEach(cb => {
        cb.addEventListener('change', () => {
            if (cb.checked) _qroleSelected.add(cb.dataset.handle);
            else _qroleSelected.delete(cb.dataset.handle);
            const row = cb.closest('tr');
            if (row) row.style.background = cb.checked ? 'rgba(108,99,255,.15)' : '';
            if (selectAll) {
                selectAll.checked = pageHandles.every(h => _qroleSelected.has(h));
                selectAll.indeterminate = !selectAll.checked && pageHandles.some(h => _qroleSelected.has(h));
            }
            updateQroleBatchBar();
        });
    });
}

/**
 * Total storage of accounts (unknown sizes are counted separately).
 * @param {object[]} accounts Account entries (or preview candidates)
 * @returns {{ bytes: number, unknown: number }}
 */
function sumQroleStorage(accounts) {
    let bytes = 0;
    let unknown = 0;
    for (const account of accounts) {
        const value = account?.storageBytes;
        const n = Number(value);
        if (value !== null && value !== undefined && Number.isFinite(n) && n >= 0) bytes += n;
        else unknown++;
    }
    return { bytes, unknown };
}

/** Account entries of the selected handles. */
function selectedQroleAccounts() {
    return [..._qroleSelected].map(handle => _qroleAccounts.find(a => a.handle === handle) ?? { handle });
}

function updateQroleBatchBar() {
    const bar = document.getElementById('stc-qa-batch-bar');
    if (!bar) return;
    bar.style.display = _qroleSelected.size > 0 ? 'flex' : 'none';
    const { bytes, unknown } = sumQroleStorage(selectedQroleAccounts());
    const count = document.getElementById('stc-qa-selected-count');
    const size = document.getElementById('stc-qa-selected-size');
    if (count) count.textContent = String(_qroleSelected.size);
    if (size) size.textContent = fmtBytes(bytes) + (unknown ? `（${unknown} 个未知）` : '');
}

async function verifyQroleAccount(handle, btn) {
    if (!handle) return;
    if (btn) {
        btn.disabled = true;
        btn._orig = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 复核中';
    }
    try {
        const r = await fetch('/api/stc/qrole-accounts/verify', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ handle }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);

        // Updated entry: { account } / { entry } / the entry itself
        const account = [d.account, d.entry, d.state ? d : null].find(a => a && typeof a === 'object' && a.handle === handle);
        const code = qroleResultCode(d.result !== undefined ? d.result : d);
        if (code === 'ok') {
            const expiresAt = toMs(account?.expiresAt);
            toast(`复核完成：${account ? qroleStateLabel(account.state) : '会员状态已更新'}${expiresAt !== null ? `，到期时间 ${fmtDateTime(expiresAt)}` : ''}`);
        } else if (typeof d.reason === 'string' && Object.hasOwn(QROLE_VERIFY_REASON_MESSAGES, d.reason)) {
            toast(QROLE_VERIFY_REASON_MESSAGES[d.reason], true);
        } else {
            toast(Object.hasOwn(QROLE_VERIFY_MESSAGES, code) ? QROLE_VERIFY_MESSAGES[code] : `复核结果：${code || '未知'}`, true);
        }
        if (account) {
            _qroleAccounts = _qroleAccounts.map(a => (a.handle === handle ? account : a));
            renderQroleAccounts();
        } else {
            await loadQroleAccounts();
        }
    } catch (e) {
        toast('复核失败: ' + e.message, true);
        if (btn?.isConnected) {
            btn.disabled = false;
            btn.innerHTML = btn._orig;
        }
    }
}

async function deleteQroleAccount(handle) {
    const account = _qroleAccounts.find(a => a.handle === handle);
    if (!account) return;
    const expiredSince = toMs(account.expiredSince);
    const stateText = qroleStateLabel(account.state)
        + (account.state !== 'active' && expiredSince !== null ? `（${Math.max(0, Math.floor((qroleNow() - expiredSince) / DAY_MS))} 天）` : '');
    if (!confirm(`确定要删除 QRole 账号 "${handle}" 吗？\n\n状态：${stateText}\n占用空间：${fmtBytes(account.storageBytes)}\n\n此操作将删除用户账号及全部数据（聊天记录、角色卡、世界书、备份等），不可恢复！`)) return;
    const confirmText = prompt(`请输入用户名 "${handle}" 以确认删除：`);
    if (confirmText !== handle) {
        if (confirmText !== null) toast('用户名不匹配，操作已取消', true);
        return;
    }

    try {
        const r = await fetch('/api/stc/users/delete-single', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ handle }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || '删除失败');
        toast(`用户 "${handle}" 已删除`);
        _qroleSelected.delete(handle);
        await loadQroleAccounts();
    } catch (e) {
        toast('删除失败: ' + e.message, true);
    }
}

async function deleteSelectedQroleAccounts() {
    const handles = [..._qroleSelected];
    if (!handles.length) return;
    const { bytes, unknown } = sumQroleStorage(selectedQroleAccounts());
    const names = handles.slice(0, 5).join(', ') + (handles.length > 5 ? ` 等 ${handles.length} 人` : '');
    if (!confirm(`⚠ 危险操作！确定要删除选中的 ${handles.length} 个 QRole 账号吗？\n\n用户：${names}\n合计占用空间：${fmtBytes(bytes)}${unknown ? `（另有 ${unknown} 个未知）` : ''}\n\n此操作将永久删除这些账号及全部数据，不可恢复！`)) return;

    const btn = document.getElementById('stc-qa-batch-delete');
    if (btn) { btn.disabled = true; btn._orig = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 删除中...'; }
    try {
        const r = await fetch('/api/stc/users/delete-batch', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ handles }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
        const deleted = Array.isArray(d.deleted) ? d.deleted : [];
        const failed = Array.isArray(d.failed) ? d.failed : [];
        deleted.forEach(h => _qroleSelected.delete(h));
        let msg = `已删除 ${deleted.length} 个账号`;
        if (failed.length) msg += `，${failed.length} 个失败：${failed.slice(0, 3).map(f => `${f.handle}（${f.error}）`).join('；')}`;
        toast(msg, failed.length > 0);
        await loadQroleAccounts();
    } catch (e) {
        toast('批量删除失败: ' + e.message, true);
    } finally {
        if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = btn._orig; }
    }
}

async function saveQroleCleanupSettings() {
    const enabled = !!document.getElementById('stc-qa-cleanup-enabled')?.checked;
    const daysInput = document.getElementById('stc-qa-cleanup-days');
    const daysText = daysInput?.value?.trim() ?? '';
    const afterDays = daysText
        ? Number(daysText)
        : (daysInput?.validity?.badInput ? NaN : QROLE_DEFAULTS.expiredCleanup.afterDays);
    if (!Number.isInteger(afterDays) || afterDays < QROLE_CLEANUP_MIN_DAYS || afterDays > QROLE_CLEANUP_MAX_DAYS) {
        toast(`过期后保留天数需为 ${QROLE_CLEANUP_MIN_DAYS}-${QROLE_CLEANUP_MAX_DAYS} 之间的整数`, true);
        return;
    }
    if (enabled && _qroleCleanup.enabled !== true
        && !confirm(`确定开启自动清理吗？\n\n开启后，服务器每天自动彻底删除会员过期（或非会员）超过 ${afterDays} 天且此期间未活跃的 QRole 账号及其全部数据，不可恢复。\n建议先点击「预览将被清理的账号」确认名单。`)) {
        return;
    }

    const btn = document.getElementById('stc-qa-cleanup-save');
    if (btn) btn.disabled = true;
    try {
        const r = await fetch('/api/stc/oauth-config/config', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ provider: 'qrole', expiredCleanup: { enabled, afterDays } }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
        toast('清理设置已保存');
        await loadQroleAccounts({ syncCleanupForm: true });
    } catch (e) {
        toast('保存失败: ' + e.message, true);
    } finally {
        if (btn?.isConnected) btn.disabled = false;
    }
}

async function previewQroleCleanup() {
    const resultDiv = document.getElementById('stc-qa-cleanup-result');
    if (!resultDiv) return;
    resultDiv.style.display = '';
    resultDiv.innerHTML = '<div style="text-align:center;padding:16px;color:#888"><i class="fa-solid fa-spinner fa-spin"></i> 扫描中...</div>';
    try {
        const r = await fetch('/api/stc/qrole-accounts/cleanup/preview', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({}),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d?.error || `HTTP ${r.status}`);
        const candidates = (Array.isArray(d) ? d : (Array.isArray(d.candidates) ? d.candidates : []))
            .filter(c => c && typeof c.handle === 'string');
        const disabledNote = _qroleCleanup.enabled !== true
            ? '<div style="font-size:.8em;color:#f39c12;margin-bottom:8px"><i class="fa-solid fa-circle-info"></i> 自动清理当前未启用，以下为按当前设置计算的结果。</div>'
            : '';
        if (!candidates.length) {
            resultDiv.innerHTML = `${disabledNote}<div style="color:#27ae60;padding:12px"><i class="fa-solid fa-check-circle"></i> 当前没有达到清理时间的账号</div>`;
            return;
        }
        const { bytes, unknown } = sumQroleStorage(candidates);
        const now = qroleNow();
        const td = 'padding:6px 8px';
        resultDiv.innerHTML = `
          <div style="background:rgba(255,255,255,.04);border-radius:8px;padding:14px">
            ${disabledNote}
            <div style="font-weight:600;margin-bottom:10px;color:#f39c12;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
              <i class="fa-solid fa-user-clock"></i>
              <span>下次运行将处理 ${candidates.length} 个账号（每次最多删除 20 个），合计占用 ${esc(fmtBytes(bytes))}${unknown ? `（${unknown} 个未知）` : ''}</span>
            </div>
            <div style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:.82em;min-width:620px">
              <thead><tr style="color:#888;border-bottom:1px solid #333">
                <th style="${td};text-align:left">用户名</th>
                <th style="${td};text-align:left">状态</th>
                <th style="${td};text-align:left">到期时间</th>
                <th style="${td};text-align:right">占用空间</th>
                <th style="${td};text-align:left">计划清理</th>
                <th style="${td};text-align:left">删除前复核</th>
              </tr></thead>
              <tbody>
                ${candidates.map(c => {
                    const expiresAt = toMs(c.expiresAt);
                    const cleanupAt = toMs(c.cleanupAt);
                    return `<tr style="border-bottom:1px solid rgba(255,255,255,.04)">
                      <td style="${td};font-weight:600">${esc(c.handle)}</td>
                      <td style="${td}">${esc(qroleStateLabel(c.state))}</td>
                      <td style="${td};color:#888">${expiresAt !== null ? fmtDate(expiresAt) : '—'}</td>
                      <td style="${td};text-align:right;color:#888">${esc(fmtBytes(c.storageBytes))}</td>
                      <td style="${td};color:${cleanupAt !== null && cleanupAt <= now ? '#e74c3c' : '#888'}">${cleanupAt !== null ? fmtDate(cleanupAt) : '—'}</td>
                      <td style="${td}">${c.wouldVerify ? '<span style="color:#27ae60">是（先向 QRole 复核）</span>' : '<span style="color:#888">否（无可用令牌）</span>'}</td>
                    </tr>`;
                }).join('')}
              </tbody>
            </table></div>
          </div>`;
    } catch (e) {
        resultDiv.innerHTML = `<div style="color:#e74c3c;padding:12px">预览失败: ${esc(e.message)}</div>`;
    }
}

async function runQroleCleanup() {
    // The server only runs the job while automatic cleanup is enabled (same rules as the scheduler)
    if (_qroleCleanup.enabled !== true) {
        toast('请先勾选「启用自动清理」并保存清理设置', true);
        return;
    }
    if (!confirm('⚠ 确定立即执行一次过期 QRole 账号清理吗？\n\n将彻底删除已达到清理时间的账号及其全部数据（每次最多 20 个）；有刷新令牌的账号会先向 QRole 复核，已续费的不会被删除。\n此操作不可恢复！建议先预览名单。')) return;

    const btn = document.getElementById('stc-qa-cleanup-run');
    const resultDiv = document.getElementById('stc-qa-cleanup-result');
    if (btn) { btn.disabled = true; btn._orig = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 清理中...'; }
    if (resultDiv) {
        resultDiv.style.display = '';
        resultDiv.innerHTML = '<div style="text-align:center;padding:16px;color:#888"><i class="fa-solid fa-spinner fa-spin"></i> 清理中，请稍候...</div>';
    }
    try {
        // Runs in the background on the server: a long run (QRole checks, large data folders)
        // must not depend on this request staying open behind a reverse proxy
        const r = await fetch('/api/stc/qrole-accounts/cleanup/run', {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({ background: true }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
            if (r.status >= 500 && !d?.error) {
                throw new Error(`HTTP ${r.status}（任务可能仍在服务器上运行，请稍后点击「刷新」查看上次运行结果）`);
            }
            throw new Error(d?.error || `HTTP ${r.status}`);
        }
        const result = r.status === 202 ? await waitForQroleCleanup(toMs(d.startedAt)) : d;
        if (!result) {
            if (resultDiv) resultDiv.innerHTML = '<div style="color:#f39c12;padding:12px"><i class="fa-solid fa-hourglass-half"></i> 清理仍在服务器上运行，请稍后点击「刷新」查看结果</div>';
            return;
        }
        const summary = describeQroleCleanupResult(result);
        if (resultDiv) resultDiv.innerHTML = `<div style="color:#27ae60;padding:12px"><i class="fa-solid fa-check-circle"></i> 清理完成：${summary}</div>`;
        toast('清理任务已执行');
        _qroleSelected.clear();
        await loadQroleAccounts();
    } catch (e) {
        toast('清理失败: ' + e.message, true);
        if (resultDiv) resultDiv.innerHTML = `<div style="color:#e74c3c;padding:12px">清理失败: ${esc(e.message)}</div>`;
    } finally {
        if (btn?.isConnected) { btn.disabled = false; btn.innerHTML = btn._orig; }
    }
}

/**
 * Poll the cleanup status until the background run that started at `startedAt` finished.
 * @param {number|null} startedAt Server time the run started
 * @returns {Promise<object|null>} The run result, or null when it is still running (gave up
 *   waiting, or the QRole tab was closed)
 */
async function waitForQroleCleanup(startedAt) {
    const deadline = Date.now() + QROLE_CLEANUP_POLL_MAX_MS;
    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, QROLE_CLEANUP_POLL_MS));
        if (!document.getElementById('stc-qa-cleanup-result')) return null;
        try {
            const r = await fetch('/api/stc/qrole-accounts/cleanup/status', { headers: getHeaders(), cache: 'no-store' });
            if (!r.ok) continue; // e.g. a proxy hiccup: keep waiting
            const cleanup = await r.json();
            if (!cleanup || typeof cleanup !== 'object' || cleanup.running === true) continue;
            const lastRunAt = toMs(cleanup.lastRunAt);
            if (startedAt === null || (lastRunAt !== null && lastRunAt >= startedAt)) return cleanup.lastResult || {};
        } catch {
            // Network error: keep waiting
        }
    }
    return null;
}

// ═══════════════════════════════════════════════════
// TAB: 定时任务（备份清理 + 定时配置）
// ═══════════════════════════════════════════════════
async function renderTasksTab(container) {
    container.innerHTML = `
      <!-- Manual Cleanup -->
      <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:16px;margin-bottom:20px">
        <h3 style="margin:0 0 12px"><i class="fa-solid fa-broom" style="color:#4a90e2;margin-right:6px"></i>立即清理备份文件</h3>
        <p style="margin:0 0 14px;font-size:.88em;color:#aaa">
          SillyTavern 会在每次保存时自动创建备份文件，长期积累会占用大量空间。
          清理操作不可恢复，建议先查看存储分析再决定是否清理。</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end">
          <div>
            <div style="font-size:.8em;color:#888;margin-bottom:4px">指定用户（留空=清理所有用户）:</div>
            <div style="display:flex;gap:6px;align-items:center">
              <select id="stc-task-user" style="padding:7px 12px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;min-width:160px">
                <option value="">所有用户</option>
              </select>
              <button id="stc-task-reload-users" class="menu_button" style="padding:7px 10px;font-size:.8em;color:#fff" title="刷新用户列表">
                <i class="fa-solid fa-rotate-right"></i></button>
            </div>
          </div>
          <button id="stc-task-clean-now" class="menu_button" style="padding:8px 20px;background:#e67e22;font-size:.88em;white-space:nowrap;color:#fff">
            <i class="fa-solid fa-broom"></i> 立即清理</button>
        </div>
        <div id="stc-task-clean-result" style="margin-top:12px;display:none"></div>
      </div>

      <!-- Scheduled Task Config -->
      <div style="background:rgba(255,255,255,.04);border-radius:10px;padding:16px">
        <h3 style="margin:0 0 12px"><i class="fa-solid fa-clock" style="color:#9b59b6;margin-right:6px"></i>自动定时清理配置</h3>
        <p style="margin:0 0 14px;font-size:.88em;color:#aaa">
          启用后，服务器将在后台按指定间隔自动清理所有用户的备份文件。</p>
        <div id="stc-task-config-form">
          <div style="text-align:center;padding:20px;color:#888"><i class="fa-solid fa-spinner fa-spin"></i> 加载中...</div>
        </div>
      </div>`;

    await loadTaskUsers();
    await loadTaskConfig();

    document.getElementById('stc-task-reload-users')?.addEventListener('click', loadTaskUsers);
    document.getElementById('stc-task-clean-now')?.addEventListener('click', runCleanupNow);
}

async function loadTaskUsers() {
    const sel = document.getElementById('stc-task-user');
    if (!sel) return;
    try {
        const r = await fetch('/api/stc/users/expiration-list', { headers: getHeaders() });
        const users = await r.json();
        sel.innerHTML = '<option value="">所有用户</option>' + users.map(u => `<option value="${esc(u.handle)}">${esc(u.handle)}</option>`).join('');
    } catch {}
}

async function loadTaskConfig() {
    const form = document.getElementById('stc-task-config-form');
    if (!form) return;
    try {
        const r = await fetch('/api/stc/scheduled-tasks/config', { headers: getHeaders() });
        if (!r.ok) throw new Error(await r.text());
        const cfg = await r.json();
        const cb = cfg.cleanBackups || {};
        const lastRun = cb.lastRun ? new Date(cb.lastRun).toLocaleString('zh-CN') : '从未运行';

        form.innerHTML = `
          <label style="display:flex;align-items:center;gap:8px;margin-bottom:14px;cursor:pointer">
            <input id="stc-sched-enabled" type="checkbox" ${cb.enabled ? 'checked' : ''}> 启用自动清理备份</label>
          <div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">
            <label style="font-size:.85em;color:#aaa">清理间隔（小时）:</label>
            <input id="stc-sched-interval" type="number" min="1" max="720" value="${cb.intervalHours || 24}"
              style="padding:7px 10px;border-radius:6px;border:1px solid #333;background:#0f3460;color:#eee;width:80px">
            <span style="font-size:.8em;color:#888">常用: 24=每天, 168=每周, 720=每月</span>
          </div>
          <div style="font-size:.82em;color:#666;margin-bottom:14px">
            <i class="fa-solid fa-info-circle"></i>
            上次运行: <span style="color:#aaa">${lastRun}</span>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <button id="stc-sched-save" class="menu_button" style="padding:8px 20px;background:#27ae60;font-size:.88em;white-space:nowrap;color:#fff">
              <i class="fa-solid fa-save"></i> 保存配置</button>
            <span style="font-size:.8em;color:#888">保存后立即生效，无需重启服务</span>
          </div>`;

        document.getElementById('stc-sched-save')?.addEventListener('click', saveTaskConfig);
    } catch (e) {
        form.innerHTML = `<div style="color:#e74c3c;padding:12px">加载失败: ${esc(e.message)}</div>`;
    }
}

async function saveTaskConfig() {
    const data = {
        cleanBackups: {
            enabled: !!document.getElementById('stc-sched-enabled')?.checked,
            intervalHours: parseInt(document.getElementById('stc-sched-interval')?.value) || 24,
        },
    };
    try {
        const r = await fetch('/api/stc/scheduled-tasks/config', { method: 'POST', headers: getHeaders(), body: JSON.stringify(data) });
        if (!r.ok) throw new Error((await r.json())?.error);
        toast('定时任务配置已保存');
        await loadTaskConfig();
    } catch (e) { toast('保存失败: ' + e.message, true); }
}

async function runCleanupNow() {
    const handle = document.getElementById('stc-task-user')?.value || null;
    const resultDiv = document.getElementById('stc-task-clean-result');
    const btn = document.getElementById('stc-task-clean-now');
    if (btn) { btn.disabled = true; btn._orig = btn.innerHTML; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 清理中...'; }
    if (resultDiv) { resultDiv.style.display = ''; resultDiv.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 清理中，请稍候...'; }
    try {
        const r = await fetch('/api/stc/scheduled-tasks/clean-backups', {
            method: 'POST', headers: getHeaders(),
            body: JSON.stringify(handle ? { handle } : {}),
        });
        if (!r.ok) throw new Error((await r.json())?.error);
        const d = await r.json();
        const msg = `清理完成：删除了 ${d.cleaned} 个备份文件，释放 ${d.freedMiB} MiB 空间`;
        toast(msg);
        if (resultDiv) resultDiv.innerHTML = `<div style="color:#27ae60;padding:4px"><i class="fa-solid fa-check-circle"></i> ${esc(msg)}</div>`;
    } catch (e) {
        toast('清理失败: ' + e.message, true);
        if (resultDiv) resultDiv.innerHTML = `<div style="color:#e74c3c;padding:4px">清理失败: ${esc(e.message)}</div>`;
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = btn._orig; }
    }
}

// ─── Global helper exposed for inline onclick ───
window.stcToast = function(msg) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 18px;border-radius:6px;z-index:999999;font-size:13px;pointer-events:none';
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1800);
};
