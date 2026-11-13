/* eslint-disable no-console */
/**
 * Generation Guardian (生成守护) — SillyTavern 第三方扩展
 *
 * 解决的问题：回复生成到一半时，页面被刷新 / 被扩展的自动更新打断 / 手机端切到后台
 * 被系统杀掉重载，已经生成的内容直接消失，但 API 额度已经花掉了。
 *
 * 三件事：
 *   1. 生成中拦截刷新：beforeunload 钩子 + 拦截所有会 location.reload() 的扩展管理操作；
 *      页面隐藏 / 卸载时强制落盘（手机切后台、被系统杀掉前抢一次）。
 *   2. 流式断点保存：监听 STREAM_TOKEN_RECEIVED（SillyTavern 每次流式推送都会带
 *      当前累计的原始文本），把草稿持续写进 localStorage，页面被杀也不会丢。
 *   3. 刷新后恢复 + 续写：回到同一聊天时弹出恢复卡片，一键把草稿写回聊天。
 *      「接回」不发请求；「续写」由你手动触发一条普通指令（不用 continue）。
 *
 * 判定原则：草稿「是否已经完整进了聊天」一律保守 —— 不确定就留着，
 * 宁可多弹一张卡片，也不允许把还在存储里的草稿删掉。
 */

import { extension_settings, getContext } from '../../../extensions.js';

const MODULE_NAME = 'generation-guardian';
const TAG = '[GenerationGuardian]';
const STORE_KEY = 'genGuardian.snapshots.v1';

const MAX_SNAPSHOTS = 8;
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const FLUSH_INTERVAL_MS = 800;
const TAIL_HEAD_LEN = 60;
// 单条草稿上限，防 localStorage 配额被打满后连新草稿都写不进去
const MAX_DRAFT_CHARS = 1000000;
// 超过这么久没有任何新 token，就当这条回复卡住了，先把草稿落盘并提示
const STALL_WATCHDOG_MS = 45000;

// 默认的「续写指令」，就是在你那句话上补两条约束：
// 原句负责方向和位置（接着上一轮 / 不断章重来），
// 补的那句负责防复读、防文风漂移。两种场景各给一条，设置里可切换也可自己改。
const RESUME_PROMPT_TAIL = '不复述、不重复已经写过的内容，保持原有的视角、人称、语气和文风，直接从正文往下写。';
const RESUME_PRESETS = {
    main: `继续生成上一轮剧情，衔接上文末尾，不要从头开始。${RESUME_PROMPT_TAIL}`,
    extra: `继续生成上一个番外，衔接上文末尾，不要从头开始。${RESUME_PROMPT_TAIL}`,
};
const DEFAULT_RESUME_PROMPT = RESUME_PRESETS.main;

const DEFAULT_SETTINGS = {
    enabled: true,
    blockReload: true,
    resumePrompt: DEFAULT_RESUME_PROMPT,
};

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

function settings() {
    if (!extension_settings[MODULE_NAME] || typeof extension_settings[MODULE_NAME] !== 'object') {
        extension_settings[MODULE_NAME] = {};
    }
    const s = extension_settings[MODULE_NAME];
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[key] === undefined) s[key] = value;
    }
    return s;
}

function persistSettings() {
    try {
        getContext().saveSettingsDebounced?.();
    } catch (error) {
        console.warn(TAG, 'save settings failed', error);
    }
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

function el(id) {
    return document.getElementById(id);
}

function hash(text) {
    let h = 0x811c9dc5;
    const str = String(text ?? '');
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 0x01000193) >>> 0;
    }
    return h.toString(36);
}

function fmtTime(ms) {
    const d = new Date(ms || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    const isToday = d.toDateString() === new Date().toDateString();
    return isToday
        ? `${p(d.getHours())}:${p(d.getMinutes())}`
        : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function typeLabel(type) {
    const map = {
        normal: '普通回复',
        continue: '继续生成',
        regenerate: '重新生成',
        swipe: '换一条',
        impersonate: '替我说话',
        quiet: '后台生成',
    };
    return map[type] || type || '生成';
}

function toast(message, level = 'info') {
    const t = window.toastr;
    try {
        if (t && typeof t[level] === 'function') {
            t[level](message, 'Generation Guardian', { timeOut: 7000, extendedTimeOut: 4000 });
        } else if (t && typeof t.info === 'function') {
            t.info(message, 'Generation Guardian');
        } else {
            console.log(TAG, message);
        }
    } catch {
        console.log(TAG, message);
    }
}

async function copyText(text) {
    try {
        if (navigator.clipboard && window.isSecureContext) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch {
        /* 非 https / 非 localhost 时 clipboard 不可用，走降级 */
    }
    try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '0';
        area.style.left = '0';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.focus();
        area.select();
        area.setSelectionRange(0, area.value.length);
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
    } catch (error) {
        console.warn(TAG, 'copy failed', error);
        return false;
    }
}

function putToTextarea(text) {
    const area = document.querySelector('#send_textarea');
    if (!area) {
        copyText(text);
        return false;
    }
    area.value = text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    try {
        area.focus();
    } catch {
        /* ignore */
    }
    return true;
}

/* ------------------------------------------------------------------ *
 * 聊天上下文辅助
 * ------------------------------------------------------------------ */

function currentChatKey() {
    const ctx = getContext();
    let key = ctx.chatId;
    if (!key) {
        const firstMes = ctx.chat?.[0]?.mes || '';
        key = `anon-${ctx.characterId ?? ctx.groupId ?? 'x'}-${hash(firstMes).slice(0, 8)}`;
    }
    return String(key);
}

/** 用于判断「聊天还停在我当初开始生成的那个位置」 */
function tailSignature(chatLen) {
    const chat = getContext().chat || [];
    if (chatLen <= 0 || !chat[chatLen - 1]) {
        return 'empty';
    }
    const message = chat[chatLen - 1];
    return hash(`${message.send_date ?? ''}|${message.is_user ? 'u' : 'c'}|${message.mes ?? ''}`);
}

/** 单条草稿超长时保留头尾，避免把 localStorage 配额写爆 */
function clipDraft(text) {
    const s = String(text ?? '');
    if (s.length <= MAX_DRAFT_CHARS) {
        return { text: s, truncated: false };
    }
    const head = s.slice(0, 4000);
    const tail = s.slice(-(MAX_DRAFT_CHARS - 4000));
    return { text: `${head}\n\n……（中间过长已省略）……\n\n${tail}`, truncated: true };
}

/** 从草稿里抽几个特征片段，用于判断「这段文字是不是已经出现在某条消息里」 */
function probeList(text) {
    const t = String(text || '').trim();
    if (!t) {
        return [];
    }
    // 短回复没有足够的采样空间，整段当探针
    if (t.length <= 20) {
        return [t];
    }
    const probes = [t.slice(0, 30), t.slice(-40)];
    if (t.length > 120) {
        const start = Math.floor(t.length * 0.55);
        probes.push(t.slice(start, start + 40));
    }
    return probes.map((probe) => probe.trim()).filter((probe) => probe.length >= 12);
}

function lastChatMessage() {
    const chat = getContext().chat || [];
    return chat.length ? chat[chat.length - 1] : null;
}

/**
 * 草稿是否「已经完整落进聊天」。
 *
 * 这是整个扩展里唯一会「删草稿」的判据，所以一律往保守的方向判：
 * 只要长度对不上、探针没命中，就当作没落地，把草稿留着让用户自己决定。
 * 旧版只看文本探针，会把「模型正文重复了某个片段」误判成已保存，
 * 从而删掉真草稿；也会把 impersonate（生成的是 user 消息）永远判成未保存。
 */
function chatDraftLanded(snapshot) {
    const chat = getContext().chat || [];
    const text = String(snapshot?.text || '').trim();
    if (!text || !chat.length) {
        return false;
    }
    const probes = probeList(text);
    if (!probes.length) {
        return false;
    }

    // 情形一：生成后多出一条新消息（普通回复 / 换一条 / 替我说话）
    if (chat.length > snapshot.chatLen) {
        const last = chat[chat.length - 1];
        const mes = String(last?.mes || '');
        if (!mes.trim()) {
            return false;
        }
        // 明显比草稿短 → 多半是被中断留下的半截，不算落地
        if (mes.trim().length < text.length * 0.9) {
            return false;
        }
        return probes.some((probe) => mes.includes(probe));
    }

    // 情形二：就地写回最后一条（继续生成追加 / 重新生成覆盖）
    if (chat.length === snapshot.chatLen) {
        const anchor = chat[snapshot.chatLen - 1];
        const mes = String(anchor?.mes || '');
        const base = typeof snapshot.baseMes === 'string' ? snapshot.baseMes : null;
        if (snapshot.type === 'continue' && base !== null) {
            if (mes.trim().length < (base.length + text.length) * 0.9) {
                return false;
            }
            return probes.some((probe) => mes.includes(probe));
        }
        if (snapshot.type === 'regenerate') {
            if (mes.trim().length < text.length * 0.9) {
                return false;
            }
            return probes.some((probe) => mes.includes(probe));
        }
    }

    return false;
}

/* ------------------------------------------------------------------ *
 * 草稿存储
 * ------------------------------------------------------------------ */

function readAll() {
    try {
        const raw = localStorage.getItem(STORE_KEY);
        if (!raw) {
            return [];
        }
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            return [];
        }
        const now = Date.now();
        return parsed.filter((item) => item
            && typeof item === 'object'
            && typeof item.id === 'string'
            && typeof item.text === 'string'
            && now - Number(item.updatedAt || 0) < MAX_AGE_MS);
    } catch (error) {
        console.warn(TAG, 'read snapshots failed', error);
        return [];
    }
}

let storageFailed = false;

function writeAll(list) {
    const trimmed = list
        .slice()
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
        .slice(0, MAX_SNAPSHOTS);
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(trimmed));
        storageFailed = false;
    } catch (error) {
        // 配额写满时逐条驱逐旧草稿重试，保证「当前这条」一定写得进去
        const evicted = trimmed.slice();
        let ok = false;
        while (evicted.length > 1) {
            evicted.pop();
            try {
                localStorage.setItem(STORE_KEY, JSON.stringify(evicted));
                ok = true;
                break;
            } catch {
                /* 继续驱逐 */
            }
        }
        if (!ok) {
            storageFailed = true;
            console.warn(TAG, 'write snapshots failed', error);
        } else {
            storageFailed = false;
            console.warn(TAG, 'localStorage full, older drafts evicted');
        }
    }
    refreshSnapList();
}

function upsertSnapshot(snapshot) {
    const clip = clipDraft(snapshot.text);
    const next = {
        ...snapshot,
        text: clip.text,
        truncated: clip.truncated || Boolean(snapshot.truncated),
        rawLength: String(snapshot.text || '').length,
    };
    const list = readAll();
    const index = list.findIndex((item) => item.id === next.id);
    if (index >= 0) {
        list[index] = next;
    } else {
        list.unshift(next);
    }
    writeAll(list);
    return next;
}

function removeSnapshot(id) {
    writeAll(readAll().filter((item) => item.id !== id));
}

/* ------------------------------------------------------------------ *
 * 生成生命周期
 * ------------------------------------------------------------------ */

let buffer = null;
let generating = false;
let flushTimer = null;
let lastFlushAt = 0;
let lastSavedText = '';
let stallTimer = null;

function updateBadge(text) {
    const badge = el('gg-badge');
    const label = el('gg-badge-text');
    if (!badge || !label) {
        return;
    }
    if (!settings().enabled || !generating) {
        badge.classList.add('gg-hidden');
        return;
    }
    badge.classList.remove('gg-hidden');
    label.textContent = text;
}

let pendingSnapshot = null;

function onGenerationStarted(type = 'normal', options = {}, dryRun = false) {
    if (!settings().enabled || dryRun) {
        return;
    }
    if (type === 'quiet') {
        return;
    }

    const ctx = getContext();
    const chat = ctx.chat || [];
    const chatLen = chat.length;
    const last = chat[chatLen - 1];

    // 同一次生成重复收到 GENERATION_STARTED 时不重置骨架，否则会清掉已攒下的草稿
    if (buffer && generating && buffer.chatLen === chatLen
        && buffer.type === String(type || 'normal') && buffer.text) {
        return;
    }

    buffer = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        chatKey: currentChatKey(),
        chatLen,
        tailHash: tailSignature(chatLen),
        tailHead: String(last?.mes || '').slice(0, TAIL_HEAD_LEN),
        tailIsUser: Boolean(last?.is_user),
        type: String(type || 'normal'),
        charName: String(ctx.name2 || '').slice(0, 80),
        baseMes: type === 'continue' && last && !last.is_user ? String(last.mes || '') : null,
        text: '',
        startedAt: Date.now(),
        updatedAt: Date.now(),
    };
    lastSavedText = '';
    generating = true;
    updateBadge('生成守护：已开始记录…');
    armUnloadGuard();
    armStallWatch();
}

/** 生成卡住（几十秒没有新 token 也没有结束事件）时，至少先把已有草稿钉死 */
function armStallWatch() {
    clearStallWatch();
    stallTimer = setTimeout(() => {
        stallTimer = null;
        if (!buffer || !generating) {
            return;
        }
        flushNow();
        const length = String(buffer.text || '').length;
        if (length) {
            toast(`这条回复好像卡住了，已保住 ${length} 字草稿`, 'warning');
        }
    }, STALL_WATCHDOG_MS);
}

function clearStallWatch() {
    if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
    }
}

/**
 * 收到流式 token。
 * STREAM_TOKEN_RECEIVED 传的是「当前累计的原始文本」，直接覆盖，不用自己拼接。
 * 万一没收到 GENERATION_STARTED（扩展加载晚、事件丢失），这里现场补一个草稿骨架，
 * 保证任何情况下都有东西可存。
 */
function onStreamToken(text) {
    if (!settings().enabled || typeof text !== 'string') {
        return;
    }
    if (!buffer) {
        buffer = adoptBuffer();
        generating = true;
        armUnloadGuard();
    }
    buffer.text = text;
    buffer.updatedAt = Date.now();
    if (storageFailed) {
        updateBadge(`生成守护：已保存 ${text.length} 字（本地存储不可用！）`);
    } else {
        updateBadge(`生成守护：已保存 ${text.length} 字 · 别刷新`);
    }
    armStallWatch();
    scheduleFlush();
}

/** 没拿到 GENERATION_STARTED 时，用当前聊天状态现场造草稿骨架 */
function adoptBuffer() {
    const ctx = getContext();
    const chat = ctx.chat || [];
    const chatLen = chat.length;
    const last = chat[chatLen - 1];
    console.warn(TAG, 'missed GENERATION_STARTED, adopting live chat state');
    return {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        chatKey: currentChatKey(),
        chatLen,
        tailHash: tailSignature(chatLen),
        tailHead: String(last?.mes || '').slice(0, TAIL_HEAD_LEN),
        tailIsUser: Boolean(last?.is_user),
        type: 'normal',
        charName: String(ctx.name2 || '').slice(0, 80),
        baseMes: null,
        text: '',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        adopted: true,
    };
}

function scheduleFlush() {
    if (flushTimer) {
        return;
    }
    const wait = Math.max(0, FLUSH_INTERVAL_MS - (Date.now() - lastFlushAt));
    flushTimer = setTimeout(() => {
        flushTimer = null;
        flushNow();
    }, wait);
}

function flushNow() {
    lastFlushAt = Date.now();
    if (!buffer) {
        return;
    }
    const text = String(buffer.text || '');
    // 用全文比较而不是长度比较：同样长度但内容变了也要落盘
    if (!text.length || text === lastSavedText) {
        return;
    }
    lastSavedText = text;
    buffer.updatedAt = Date.now();
    upsertSnapshot({ ...buffer });
}

function onGenerationFinished(reason) {
    generating = false;
    disarmUnloadGuard();
    clearStallWatch();
    updateBadge('');
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    const snapshot = buffer;
    buffer = null;
    if (!snapshot) {
        return;
    }

    const text = String(snapshot.text || '');
    if (!text.trim()) {
        removeSnapshot(snapshot.id);
        return;
    }

    // 正常结束时内容已经完整写进聊天了，不需要留草稿。
    // 这里判定一律保守：拿不准就留着，交给 500ms 后的 scan 再复核一次。
    if (chatDraftLanded(snapshot)) {
        removeSnapshot(snapshot.id);
        return;
    }

    snapshot.updatedAt = Date.now();
    upsertSnapshot(snapshot);

    if (reason === 'stopped') {
        toast(`生成被中断，已保住 ${text.length} 字草稿（刷新后可以接着续写）`, 'warning');
    } else {
        toast(`生成结束时内容没写进聊天，已保住 ${text.length} 字草稿`, 'warning');
    }

    // 如果内容确实没进聊天（比如断连），当场就给出恢复入口，不用等刷新
    setTimeout(() => {
        if (!pendingSnapshot) {
            scanForRecoverySafe({ countdown: false });
        }
    }, 500);
}

/* ------------------------------------------------------------------ *
 * 刷新拦截
 * ------------------------------------------------------------------ */

let unloadGuardArmed = false;

function unloadGuard(event) {
    if (!generating) {
        return;
    }
    try {
        flushNow();
    } catch (error) {
        console.warn(TAG, error);
    }
    event.preventDefault();
    event.returnValue = '正在生成中，刷新会中断回复。草稿已保存，确定要刷新吗？';
    return event.returnValue;
}

function armUnloadGuard() {
    if (unloadGuardArmed || !settings().blockReload) {
        return;
    }
    window.addEventListener('beforeunload', unloadGuard);
    unloadGuardArmed = true;
}

function disarmUnloadGuard() {
    if (!unloadGuardArmed) {
        return;
    }
    window.removeEventListener('beforeunload', unloadGuard);
    unloadGuardArmed = false;
}

/* ------------------------------------------------------------------ *
 * 生成中拦住「会刷新页面」的扩展管理操作
 *
 * SillyTavern 的启用 / 禁用 / 更新 / 删除 / 换分支 都是直接 location.reload()，
 * beforeunload 拦不住它（浏览器内部 reload 不弹确认框），所以在源头掐：
 * 生成期间在这些按钮的捕获阶段就地拦下，等生成完再操作。
 * ------------------------------------------------------------------ */

const RELOAD_PRONE_SELECTOR = [
    '.extensions_info .extension_block .toggle_enable',
    '.extensions_info .extension_block .toggle_disable',
    '.extensions_info .extension_block .btn_update',
    '.extensions_info .extension_block .btn_delete',
    '.extensions_info .extension_block .btn_clean',
    '.extensions_info .extension_block .btn_move',
    '.extensions_info .extension_block .btn_branch',
].join(', ');

function guardReloadProneClick(event) {
    if (!generating || !settings().enabled || !settings().blockReload) {
        return;
    }
    const target = event.target;
    const hit = typeof target?.closest === 'function' ? target.closest(RELOAD_PRONE_SELECTOR) : null;
    if (!hit) {
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    toast('正在生成中，这个操作会刷新页面把回复刷掉 —— 等这条回复写完再动扩展', 'warning');
}

/* ------------------------------------------------------------------ *
 * 界面：状态徽标
 * ------------------------------------------------------------------ */

function ensureUI() {
    if (el('gg-badge')) {
        return;
    }

    const badge = document.createElement('div');
    badge.id = 'gg-badge';
    badge.className = 'gg-hidden';
    badge.innerHTML = '<span class="gg-dot"></span><span id="gg-badge-text">生成守护</span>';
    document.body.appendChild(badge);

    const panel = document.createElement('div');
    panel.id = 'gg-panel';
    panel.className = 'gg-hidden';
    panel.innerHTML = `
        <div class="gg-card">
            <div class="gg-head">
                <span class="gg-title">检测到未完成的回复</span>
                <button type="button" class="gg-icon-btn" id="gg-btn-close" title="收起">✕</button>
            </div>
            <div class="gg-meta" id="gg-recover-meta"></div>
            <div class="gg-preview" id="gg-recover-preview"></div>
            <div class="gg-actions">
                <button type="button" class="gg-btn gg-primary" id="gg-btn-recover">接回</button>
                <button type="button" class="gg-btn" id="gg-btn-recover-write">续写</button>
                <button type="button" class="gg-btn" id="gg-btn-prompt">复制指令</button>
                <button type="button" class="gg-btn" id="gg-btn-textarea">放入输入框</button>
                <button type="button" class="gg-btn gg-danger" id="gg-btn-discard">丢弃</button>
            </div>
            <div class="gg-foot" id="gg-recover-foot"></div>
        </div>`;
    document.body.appendChild(panel);

    el('gg-btn-close').addEventListener('click', () => {
        hidePanel();
    });
    el('gg-btn-recover').addEventListener('click', () => {
        if (pendingSnapshot) {
            resumeSnapshot(pendingSnapshot, { thenPrompt: false });
        }
    });
    el('gg-btn-recover-write').addEventListener('click', () => {
        if (pendingSnapshot) {
            resumeSnapshot(pendingSnapshot, { thenPrompt: true });
        }
    });
    el('gg-btn-prompt').addEventListener('click', async () => {
        const prompt = resumePromptText();
        const ok = await copyText(prompt);
        toast(ok ? '续写指令已复制' : '复制失败，可到设置里手动复制', ok ? 'success' : 'warning');
    });
    el('gg-btn-textarea').addEventListener('click', () => {
        if (!pendingSnapshot) {
            return;
        }
        putToTextarea(pendingSnapshot.text);
        removeSnapshot(pendingSnapshot.id);
        pendingSnapshot = null;
        hidePanel();
        toast('草稿已放进输入框，可以自己改完再发', 'info');
    });
    el('gg-btn-discard').addEventListener('click', () => {
        if (pendingSnapshot) {
            removeSnapshot(pendingSnapshot.id);
            pendingSnapshot = null;
        }
        hidePanel();
        toast('草稿已丢弃', 'info');
    });
}

function showPanel(snapshot) {
    ensureUI();
    const panel = el('gg-panel');
    const meta = el('gg-recover-meta');
    const preview = el('gg-recover-preview');

    panel.classList.remove('gg-hidden');
    meta.textContent = `${snapshot.charName || '当前角色'} · ${fmtTime(snapshot.startedAt)} · ${typeLabel(snapshot.type)} · 已保住 ${snapshot.text.length} 字${snapshot.truncated ? '（过长已截断）' : ''}`;

    const head = '……（前面已生成的部分）\n';
    preview.textContent = snapshot.text.length > 1200
        ? head + snapshot.text.slice(-1200)
        : snapshot.text;
    preview.scrollTop = preview.scrollHeight;

    const resumeBtn = el('gg-btn-recover');
    const resumeWriteBtn = el('gg-btn-recover-write');
    const textareaBtn = el('gg-btn-textarea');
    const cannotResume = snapshot.type === 'swipe' || snapshot.type === 'impersonate';
    resumeBtn.classList.toggle('gg-hidden', cannotResume);
    resumeWriteBtn.classList.toggle('gg-hidden', cannotResume);
    textareaBtn.textContent = cannotResume ? '填入输入框（这类生成只能这样处理）' : '放入输入框';
    setFoot('「接回」只把草稿原样写回聊天，不再发请求；「续写」会替你发一条续写指令，多一次请求');
}

function hidePanel() {
    el('gg-panel')?.classList.add('gg-hidden');
}

function setFoot(html) {
    const foot = el('gg-recover-foot');
    if (foot) {
        foot.innerHTML = html;
    }
}

/* ------------------------------------------------------------------ *
 * 恢复（接回草稿，不再有任何自动续写倒计时）
 * ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ *
 * 恢复 + 续写
 * ------------------------------------------------------------------ */

function matchesAnchor(snapshot) {
    const chat = getContext().chat || [];
    if (!chat.length || snapshot.chatLen <= 0 || snapshot.chatLen > chat.length) {
        return false;
    }
    const anchor = chat[snapshot.chatLen - 1];
    if (!anchor) {
        return false;
    }
    const hashOk = snapshot.tailHash === tailSignature(snapshot.chatLen);
    const headOk = Boolean(snapshot.tailHead)
        && String(anchor.mes || '').startsWith(snapshot.tailHead)
        && Boolean(anchor.is_user) === Boolean(snapshot.tailIsUser);
    if (!hashOk && !headOk) {
        return false;
    }
    if (chat.length === snapshot.chatLen) {
        return true;
    }
    // 后面多出一条：空的半成品，或者被中断留下的半截正文，都允许用草稿覆盖它
    if (chat.length !== snapshot.chatLen + 1) {
        return false;
    }
    const extra = chat[snapshot.chatLen];
    if (!extra || extra.is_user) {
        return false;
    }
    const extraMes = String(extra.mes || '').trim();
    if (!extraMes) {
        return true;
    }
    // 草稿以这条半截消息开头 → 说明它就是被打断的那一条，接回时直接补全
    const draft = String(snapshot.text || '');
    return Boolean(draft) && draft.startsWith(extraMes) && draft.length > extraMes.length;
}

function scanForRecovery() {
    ensureUI();
    const key = currentChatKey();

    // 已经完整落进聊天的草稿顺手清掉，别让存储越堆越多
    for (const snapshot of readAll()) {
        if (snapshot.chatKey === key && chatDraftLanded(snapshot)) {
            removeSnapshot(snapshot.id);
        }
    }

    const candidates = readAll().filter((snapshot) => snapshot.chatKey === key
        && matchesAnchor(snapshot));

    if (!candidates.length) {
        pendingSnapshot = null;
        hidePanel();
        return;
    }

    candidates.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    pendingSnapshot = candidates[0];
    showPanel(pendingSnapshot);
}

function updateMessageInDom(ctx, index, message) {
    try {
        if (typeof ctx.updateMessageBlock === 'function') {
            ctx.updateMessageBlock(index, message, { rerenderMessage: true });
            return true;
        }
    } catch (error) {
        console.warn(TAG, 'updateMessageBlock failed', error);
    }
    return false;
}

async function saveChatQuiet(ctx) {
    try {
        await ctx.saveChat?.();
        return true;
    } catch (error) {
        console.warn(TAG, 'saveChat failed', error);
        return false;
    }
}

function resumePromptText() {
    const value = String(settings().resumePrompt ?? '').trim();
    return value || DEFAULT_RESUME_PROMPT;
}

/**
 * 替你发一条接续指令。
 * 走的完全是酒馆的标准路径：写进输入框 → 调 Generate('normal')，
 * Generate 会自己读输入框、清空、把这条消息塞进聊天再请求。
 * 发送失败时把指令重新填回输入框 —— 因为 Generate 已经把框清空了，
 * 不填回去就等于「指令丢了」。
 */
function sendResumePrompt() {
    const ctx = getContext();
    const prompt = resumePromptText();

    if (generating) {
        putToTextarea(prompt);
        toast('酒馆正在生成中，指令已放进输入框，等这次写完按发送', 'warning');
        return;
    }

    putToTextarea(prompt);
    if (typeof ctx.generate === 'function') {
        Promise.resolve(ctx.generate('normal')).catch((error) => {
            // 这条是降级路径，不是致命错误，用 warn 记录即可
            console.warn(TAG, 'auto prompt failed', error);
            putToTextarea(prompt);
            toast('自动发送失败，指令已放回输入框，按发送即可', 'warning');
        });
        return;
    }
    toast('没法自动发送，指令已放进输入框，按发送即可', 'warning');
}

let resuming = false;

async function resumeSnapshot(snapshot, { thenPrompt = false } = {}) {
    if (!snapshot) {
        return;
    }

    // 幂等保护：双击按钮 / 恢复过程中再次触发，都只执行一次
    if (resuming) {
        return;
    }
    if (!readAll().some((item) => item.id === snapshot.id)) {
        pendingSnapshot = null;
        hidePanel();
        return;
    }
    resuming = true;

    try {
        await doResume(snapshot, { thenPrompt });
    } finally {
        resuming = false;
    }
}

/**
 * 给接回的消息补齐酒馆渲染 / swipe 需要的字段。
 * 缺 swipe_id / swipes / swipe_info 时，这条消息虽然能显示，
 * 但右滑、重新生成这些按钮的行为会和普通消息不一致。
 */
function normalizeMessageFields(node, snapshot, ctx) {
    node.is_user = Boolean(node.is_user);
    node.is_system = Boolean(node.is_system);
    node.mes = String(node.mes || '');
    node.send_date = node.send_date || new Date().toISOString();
    if (!node.extra || typeof node.extra !== 'object') {
        node.extra = {};
    }
    if (!Array.isArray(node.swipes) || !node.swipes.length) {
        node.swipes = [node.mes];
    }
    if (typeof node.swipe_id !== 'number') {
        node.swipe_id = Math.max(0, node.swipes.length - 1);
    }
    if (!Array.isArray(node.swipe_info) || !node.swipe_info.length) {
        node.swipe_info = node.swipes.map((mes) => ({
            send_date: node.send_date,
            gen_started: snapshot.startedAt,
            gen_finished: Date.now(),
            extra: { ...node.extra },
        }));
    }
    // 群聊里补对头像，不然接回来的消息可能顶着空白头像
    if (!node.is_user && !node.force_avatar && ctx.groupId) {
        try {
            const member = Array.isArray(ctx.characters)
                ? ctx.characters.find((c) => c && c.name === node.name && c.avatar && c.avatar !== 'none')
                : null;
            if (member && typeof ctx.getThumbnailUrl === 'function') {
                node.force_avatar = ctx.getThumbnailUrl('avatar', member.avatar);
            }
        } catch (error) {
            console.warn(TAG, 'group avatar resolve failed', error);
        }
    }
    return node;
}

async function doResume(snapshot, { thenPrompt = false } = {}) {
    hidePanel();

    const ctx = getContext();
    const chat = ctx.chat || [];
    const text = String(snapshot.text || '');
    if (!text.trim()) {
        removeSnapshot(snapshot.id);
        pendingSnapshot = null;
        return;
    }

    // 换一条 / 替我说话 → 只能放回输入框
    if (snapshot.type === 'swipe' || snapshot.type === 'impersonate') {
        putToTextarea(text);
        removeSnapshot(snapshot.id);
        pendingSnapshot = null;
        toast('已把草稿放进输入框（这类生成没法自动续写）', 'info');
        return;
    }

    const anchorIndex = snapshot.chatLen - 1;
    const anchor = chat[anchorIndex];
    const anchorIsChar = Boolean(anchor) && !anchor.is_user;
    const appendToAnchor = snapshot.type === 'continue'
        || (snapshot.type === 'regenerate' && anchorIsChar);

    if (appendToAnchor && anchorIsChar) {
        // 原来是在续写同一条消息 → 把草稿接回那条消息
        const base = typeof snapshot.baseMes === 'string' ? snapshot.baseMes : '';
        anchor.mes = `${base}${text}`;
        normalizeMessageFields(anchor, snapshot, ctx);
        updateMessageInDom(ctx, anchorIndex, anchor);
        const saved = await saveChatQuiet(ctx);
        removeSnapshot(snapshot.id);
        pendingSnapshot = null;
        toast(saved
            ? (thenPrompt ? '已接回，正在发续写指令…' : '已接回断点位置')
            : '已接回，但保存聊天失败 —— 先别刷新页面', saved ? 'success' : 'warning');
        if (thenPrompt) {
            sendResumePrompt();
        }
        return;
    }

    // 聊天里留着一条被中断的半截消息，而草稿是它的完整版 → 直接补全那条，不新增
    const extraIndex = snapshot.chatLen;
    const extra = chat.length === snapshot.chatLen + 1 ? chat[extraIndex] : null;
    const extraMes = extra && !extra.is_user ? String(extra.mes || '').trim() : '';
    const canCompleteHalf = Boolean(extraMes) && text.startsWith(extraMes);

    if (canCompleteHalf && extra) {
        extra.mes = text;
        normalizeMessageFields(extra, snapshot, ctx);
        updateMessageInDom(ctx, extraIndex, extra);
        const saved = await saveChatQuiet(ctx);
        removeSnapshot(snapshot.id);
        pendingSnapshot = null;
        toast(saved
            ? '已把草稿补进那条被中断的消息'
            : '已补进聊天，但保存聊天失败 —— 先别刷新页面', saved ? 'success' : 'warning');
        if (thenPrompt) {
            sendResumePrompt();
        }
        return;
    }

    // 普通回复 → 把草稿作为一条新的角色消息塞回聊天
    const node = normalizeMessageFields({
        name: snapshot.charName || ctx.name2 || 'Character',
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes: text,
        extra: {
            gen_started: snapshot.startedAt,
            gen_finished: Date.now(),
            api: 'generation-guardian',
            model: 'recovered-draft',
        },
    }, snapshot, ctx);

    try {
        const keepLen = chat.length;
        chat.push(node);
        if (typeof ctx.addOneMessage !== 'function') {
            throw new Error('addOneMessage unavailable');
        }
        ctx.addOneMessage(node, { type: 'append' });
        const saved = await saveChatQuiet(ctx);
        if (typeof ctx.scrollChatToBottom === 'function') {
            ctx.scrollChatToBottom();
        }
        console.log(TAG, 'draft inserted', keepLen, '->', chat.length);
        if (!saved) {
            toast('草稿已放回聊天，但保存聊天失败 —— 先别刷新页面', 'warning');
        }
    } catch (error) {
        console.warn(TAG, 'insert draft failed', error);
        // 回滚刚 push 进 chat 的那条，避免「幽灵消息 + 输入框」两份
        const index = chat.indexOf(node);
        if (index !== -1) {
            try {
                ctx.deleteMessage?.(index);
            } catch {
                /* 忽略渲染层清理失败 */
            }
            const stillThere = chat.indexOf(node);
            if (stillThere !== -1) {
                chat.splice(stillThere, 1);
            }
        }
        putToTextarea(text);
        removeSnapshot(snapshot.id);
        pendingSnapshot = null;
        toast('写回聊天失败，草稿已放进输入框，请手动处理', 'warning');
        return;
    }

    removeSnapshot(snapshot.id);
    pendingSnapshot = null;
    toast(thenPrompt ? '已接回，正在发续写指令…' : '已接回聊天', 'success');
    if (thenPrompt) {
        sendResumePrompt();
    }
}

/* ------------------------------------------------------------------ *
 * 设置面板
 * ------------------------------------------------------------------ */

const SETTINGS_HTML = `
<div class="gg-settings">
    <div class="gg-set-title">Generation Guardian · 生成守护</div>
    <label class="gg-check"><input type="checkbox" id="gg-set-enabled"><span>启用插件</span></label>
    <label class="gg-check"><input type="checkbox" id="gg-set-block"><span>生成中拦截刷新 / 关闭页面</span></label>
    <div class="gg-set-label">续写指令（点「续写」时替你发这一条，可自己改）</div>
    <textarea id="gg-set-prompt" class="text_pole gg-prompt" rows="3"></textarea>
    <div class="gg-row">
        <button type="button" class="gg-btn gg-mini" id="gg-set-preset-main">用剧情指令</button>
        <button type="button" class="gg-btn gg-mini" id="gg-set-preset-extra">用番外指令</button>
    </div>
    <div class="gg-hint">草稿存在本机浏览器 localStorage 里，只在这个设备、这个浏览器可见。手机端切后台被系统杀掉重载，也能靠它捡回来。</div>
    <div class="gg-snap-head"><span>已保存草稿</span><span id="gg-snap-count">0</span></div>
    <div id="gg-snap-list" class="gg-snap-list"></div>
    <button type="button" id="gg-btn-clear" class="gg-btn gg-danger gg-full">清空全部草稿</button>
</div>`;

function mountSettings() {
    const host = el('extensions_settings2') || el('extensions_settings');
    if (!host || el('gg-settings')) {
        return;
    }
    const wrapper = document.createElement('div');
    wrapper.id = 'gg-settings';
    wrapper.innerHTML = SETTINGS_HTML;
    host.appendChild(wrapper);

    const s = settings();
    el('gg-set-enabled').checked = Boolean(s.enabled);
    el('gg-set-block').checked = Boolean(s.blockReload);
    el('gg-set-prompt').value = resumePromptText();

    el('gg-set-enabled').addEventListener('change', (event) => {
        s.enabled = Boolean(event.target.checked);
        if (!s.enabled) {
            generating = false;
            disarmUnloadGuard();
            updateBadge('');
            hidePanel();
        }
        persistSettings();
    });
    el('gg-set-block').addEventListener('change', (event) => {
        s.blockReload = Boolean(event.target.checked);
        if (!s.blockReload) {
            disarmUnloadGuard();
        } else if (generating) {
            armUnloadGuard();
        }
        persistSettings();
    });
    el('gg-set-prompt').addEventListener('change', (event) => {
        const value = String(event.target.value || '').trim();
        s.resumePrompt = value || DEFAULT_RESUME_PROMPT;
        event.target.value = s.resumePrompt;
        persistSettings();
    });
    const applyPreset = (text, label) => {
        s.resumePrompt = text;
        el('gg-set-prompt').value = text;
        persistSettings();
        toast(`续写指令已换成「${label}」`, 'info');
    };
    el('gg-set-preset-main').addEventListener('click', () => applyPreset(RESUME_PRESETS.main, '剧情'));
    el('gg-set-preset-extra').addEventListener('click', () => applyPreset(RESUME_PRESETS.extra, '番外'));
    el('gg-btn-clear').addEventListener('click', () => {
        writeAll([]);
        pendingSnapshot = null;
        hidePanel();
        toast('草稿已清空', 'info');
    });

    refreshSnapList();
}

function refreshSnapList() {
    const list = el('gg-snap-list');
    const count = el('gg-snap-count');
    if (!list || !count) {
        return;
    }
    const snapshots = readAll();
    count.textContent = String(snapshots.length);
    list.textContent = '';

    if (!snapshots.length) {
        const empty = document.createElement('div');
        empty.className = 'gg-snap-empty';
        empty.textContent = '暂无草稿';
        list.appendChild(empty);
        return;
    }

    for (const snapshot of snapshots) {
        const row = document.createElement('div');
        row.className = 'gg-snap-row';

        const info = document.createElement('div');
        info.className = 'gg-snap-info';
        const title = document.createElement('div');
        title.className = 'gg-snap-title';
        title.textContent = `${snapshot.charName || '未知角色'} · ${fmtTime(snapshot.startedAt)}`;
        const sub = document.createElement('div');
        sub.className = 'gg-snap-sub';
        sub.textContent = `${typeLabel(snapshot.type)} · ${snapshot.text.length} 字`;
        info.append(title, sub);

        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'gg-btn gg-mini';
        copyBtn.textContent = '复制';
        copyBtn.addEventListener('click', async () => {
            const ok = await copyText(snapshot.text);
            toast(ok ? '已复制' : '复制失败', ok ? 'success' : 'warning');
        });

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'gg-btn gg-mini gg-danger';
        delBtn.textContent = '删除';
        delBtn.addEventListener('click', () => {
            removeSnapshot(snapshot.id);
        });

        row.append(info, copyBtn, delBtn);
        list.appendChild(row);
    }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

let initialized = false;

function scanForRecoverySafe(options = {}) {
    try {
        scanForRecovery(options);
    } catch (error) {
        console.warn(TAG, 'scan failed', error);
    }
}

function initOnce() {
    if (initialized) {
        return;
    }
    initialized = true;

    const ctx = getContext();
    const events = ctx.eventTypes || ctx.event_types;

    try {
        ctx.eventSource.on(events.GENERATION_STARTED, onGenerationStarted);
        ctx.eventSource.on(events.STREAM_TOKEN_RECEIVED, onStreamToken);
        ctx.eventSource.on(events.GENERATION_STOPPED, () => onGenerationFinished('stopped'));
        ctx.eventSource.on(events.GENERATION_ENDED, () => onGenerationFinished('ended'));
        ctx.eventSource.on(events.CHAT_CHANGED, () => {
            setTimeout(scanForRecoverySafe, 120);
        });
    } catch (error) {
        console.warn(TAG, 'event wiring failed', error);
    }

    window.addEventListener('pagehide', () => {
        try {
            flushNow();
        } catch (error) {
            console.warn(TAG, error);
        }
    });
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            try {
                flushNow();
            } catch (error) {
                console.warn(TAG, error);
            }
        }
    });
    document.addEventListener('click', guardReloadProneClick, true);

    ensureUI();
    mountSettings();
    // 让刷新/重载后的恢复卡片晚一点出现，等聊天先渲染完
    setTimeout(scanForRecoverySafe, 600);

    window.GenerationGuardian = {
        version: '1.2.0',
        settings: settings,
        snapshots: readAll,
        /** 内存里正在写的这条草稿（localStorage 写不进去时的逃生口，复制即可救回） */
        liveDraft: () => (buffer ? String(buffer.text || '') : ''),
        isGenerating: () => generating,
        scan: scanForRecoverySafe,
        clear: () => writeAll([]),
        copy: copyText,
    };

    console.log(TAG, 'ready');
}

(function bootstrap() {
    try {
        const ctx = getContext();
        const events = ctx.eventTypes || ctx.event_types;
        if (ctx.eventSource && events?.APP_READY) {
            ctx.eventSource.on(events.APP_READY, () => initOnce());
        }
        // APP_READY 已经错过时的兜底
        setTimeout(() => initOnce(), 4000);
        if (document.readyState === 'complete') {
            setTimeout(() => initOnce(), 800);
        }
    } catch (error) {
        console.warn(TAG, 'bootstrap failed', error);
    }
})();
