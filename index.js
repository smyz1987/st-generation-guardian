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
const VERSION = '1.3.19';
const STORE_KEY = 'genGuardian.snapshots.v1';

const MAX_SNAPSHOTS = 8;
const FLUSH_INTERVAL_MS = 800;
// 生成中超过这么久没有任何新 token，就认为这次生成其实已经死了，
// 自动把「生成中」状态解开 —— 否则会一直拦着扩展操作、一直拦刷新，反而变成干扰。
const GENERATION_STALE_MS = 5 * 60 * 1000;
// 生成刚结束的那一小段「还在写盘」的时间，刷新照样要拦。
// 酒馆的流式是：开头 saveReply 先落一条空消息，中途只改内存里的 chat[i].mes 不落盘，
// 等流跑完 GENERATION_ENDED 之后才 saveChat。也就是说事件刚发出来那一刻，
// 字全在屏幕上、一个字都还没进磁盘 —— 这个窗口刷新必丢。留 12 秒肯定够 saveChat 走完。
const POST_GEN_GUARD_MS = 12 * 1000;

/* 八套主题。每套就是「一个极浅的中性底 + 一个中低饱和的彩色中间调」，
   色号逐字取自用户那份网页配色的八组：底在浅色一支，其余角色都从这两支派生。
   键名按底色叫，按钮上显示的就是底色名。 */
const THEMES = {
    almond: { label: '杏仁白', en: 'Almond', swatches: ['#f3e8dc', '#a37070'] },
    cream: { label: '暖奶油', en: 'Cream', swatches: ['#fdf4e3', '#7c8d99'] },
    haze: { label: '雾蓝灰', en: 'Blue Haze', swatches: ['#e1e6e9', '#a35e5e'] },
    peach: { label: '桃奶茶', en: 'Peach Tea', swatches: ['#f6e3d7', '#a3a88f'] },
    ash: { label: '白茶灰', en: 'White Tea', swatches: ['#efece6', '#9e6c55'] },
    pumpkin: { label: '南瓜米', en: 'Pumpkin', swatches: ['#f5e2c3', '#7da8b1'] },
    butter: { label: '奶油绿', en: 'Butter', swatches: ['#edf0e2', '#b48a78'] },
    lotus: { label: '莲子白', en: 'Lotus', swatches: ['#f5f2ee', '#a9a1b0'] },
};
const DEFAULT_THEME = 'almond';
const TAIL_HEAD_LEN = 60;
// 单条草稿上限，防 localStorage 配额被打满后连新草稿都写不进去
// （1 亿字符纯粹是「防呆」，正常一轮两万字都摸不到它）
const MAX_DRAFT_CHARS = 1000000;
// 所有草稿加起来的总字数预算。中文在 localStorage 里按 UTF-16 存，
// 120 万字 ≈ 2.4MB，留一半余量给酒馆自己的设置和聊天缓存，别去顶 5MB 配额。
// 超了就按「谁最旧谁先走」，但最新那条永远留下。
const MAX_TOTAL_CHARS = 1200000;
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
    // 面板配色主题
    theme: DEFAULT_THEME,
    // 被打断时直接把草稿补回聊天（写进聊天记录并保存），不用手动点「接回」
    autoRestore: true,
    // 生成中是否拦住「启用 / 禁用 / 删除 / 清理」这类会刷新页面的扩展操作
    blockExtensionOps: true,
    // 生成中是否显示「已保存 N 字」的浮动徽标
    showBadge: true,
    // 点「续写」后是否立刻替你发出去；关掉就只把指令填进输入框，自己改完按发送
    autoSend: false,
    // 最多保留几条草稿
    maxSnapshots: MAX_SNAPSHOTS,
    // 草稿保留几天
    keepDays: 3,
    // 多少秒没有新 token 就提示「像卡住了」；0 表示关闭
    stallSeconds: STALL_WATCHDOG_MS / 1000,
    // 安静模式：正常生成完就什么提示都别弹，只有真被打断才出声
    quiet: true,
    // 接回后补发一次 CHARACTER_MESSAGE_RENDERED，让状态栏 / 变量 / TTS / 翻译这类
    // 挂在「消息渲染完成」上的扩展认得这条刚接回来的消息
    notifyRenderers: true,
    // 新手引导是不是看过了；没看过就第一次打开面板时带一遍
    guideSeen: false,
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

function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(n)));
}

function maxSnapshots() {
    return clampNumber(settings().maxSnapshots, 1, 50, MAX_SNAPSHOTS);
}

function keepDays() {
    return clampNumber(settings().keepDays, 1, 30, 3);
}

function keepDaysMs() {
    return keepDays() * 24 * 60 * 60 * 1000;
}

/** 卡住判定时间（毫秒），0 表示关掉这个提示 */
function stallMs() {
    return clampNumber(settings().stallSeconds, 0, 600, STALL_WATCHDOG_MS / 1000) * 1000;
}

/* ------------------------------------------------------------------ *
 * 主题
 * ------------------------------------------------------------------ */

function themeKey() {
    const value = String(settings().theme || '');
    return Object.prototype.hasOwnProperty.call(THEMES, value) ? value : DEFAULT_THEME;
}

/** 把主题 class 挂到 body 上；只碰这几个 class，不动酒馆自己的任何东西 */
function applyTheme() {
    const body = document.body;
    if (!body || !body.classList) {
        return;
    }
    try {
        for (const key of Object.keys(THEMES)) {
            body.classList.toggle(`gg-theme-${key}`, key === themeKey());
        }
    } catch (error) {
        console.warn(TAG, 'apply theme failed', error);
    }
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
        // 光标停在指令末尾 —— 「续写」默认只填不发，她多半要在这后面接着补一句再发
        area.focus();
        const end = area.value.length;
        if (typeof area.setSelectionRange === 'function') {
            area.setSelectionRange(end, end);
        }
        area.scrollTop = area.scrollHeight;
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
        // 情形三：换一条 —— 消息总数不变，新文本进了那条消息的 swipes 数组，
        // 而 mes 也已经被换成新那条。不判这个的话「换一条」的草稿永远落地不了，
        // 每次刷新都会弹一张「检测到未完成的回复」，其实早写完了。
        if (snapshot.type === 'swipe') {
            const pool = [String(anchor?.mes || '')];
            if (Array.isArray(anchor?.swipes)) {
                for (const item of anchor.swipes) {
                    pool.push(String(item || ''));
                }
            }
            return pool.some((candidate) => candidate.trim().length >= text.length * 0.9
                && probes.some((probe) => candidate.includes(probe)));
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
            && now - Number(item.updatedAt || 0) < keepDaysMs());
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
        .slice(0, maxSnapshots());
    // 总字数预算：先按时间排，再从最旧的开始丢，最新那条（也就是正在写的那条）无条件保留。
    // 这样一轮一万两千字也稳：12000 字占 24KB，8 条全满也才 192KB。
    let total = 0;
    const budgeted = [];
    for (const snapshot of trimmed) {
        const length = String(snapshot.text || '').length;
        if (!budgeted.length || total + length <= MAX_TOTAL_CHARS) {
            budgeted.push(snapshot);
            total += length;
        }
    }
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify(budgeted));
        storageFailed = false;
    } catch (error) {
        // 配额写满时逐条驱逐旧草稿重试，保证「当前这条」一定写得进去
        const evicted = budgeted.slice();
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

/**
 * 「现在真的在生成吗」。
 * 不能只看 generating 这个 flag：万一 GENERATION_ENDED 事件丢了，flag 会永远为真，
 * 结果就是一直拦刷新、一直拦扩展按钮，正常操作全被挡住。
 * 所以再加一条：草稿必须还在动（GENERATION_STALE_MS 内有过 token）。
 */
function activelyGenerating() {
    if (!generating || !buffer) {
        return false;
    }
    if (Date.now() - Number(buffer.updatedAt || 0) < GENERATION_STALE_MS) {
        return true;
    }
    // 结束事件丢了 / 页面休眠回来：就地解开，别继续挡刷新和扩展操作。
    // releaseGeneration 里会先把 generating 置 false，所以不会递归回来。
    releaseGeneration();
    return false;
}

/** 生成状态卡死（结束事件丢了）时，把它解开，别让它继续挡路 */
function releaseGeneration() {
    // 释放之前先把还没落盘的那一段写掉：自愈解锁 / 事件丢失时也不丢字
    try {
        if (buffer?.text) {
            flushNow();
        }
    } catch (error) {
        console.warn(TAG, error);
    }
    generating = false;
    buffer = null;
    clearStallWatch();
    settlePostGenerationGuard();
    updateBadge('');
}

/**
 * 魔杖菜单里的那一条：平时写作「生成守护」，生成中借右侧那行小字报「已保存 N 字」。
 * 菜单收起时它只是一个不占地方的按钮，点开魔法棒才看得到 —— 正好是她要的样子。
 */
function updateBadge(text) {
    const item = el('gg-wand-entry');
    const state = el('gg-wand-state');
    if (!item || !state) {
        return;
    }
    item.style.display = settings().showBadge ? '' : 'none';
    state.textContent = text || '';
    item.classList.toggle('gg-wand-live', Boolean(text));
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
    updateBadge('记录中…');
    armUnloadGuard();
    armStallWatch();
}

/** 生成卡住（几十秒没有新 token 也没有结束事件）时，至少先把已有草稿钉死 */
function armStallWatch() {
    clearStallWatch();
    const ms = stallMs();
    if (!ms) {
        return;
    }
    stallTimer = setTimeout(() => {
        stallTimer = null;
        if (!buffer || !generating) {
            return;
        }
        flushNow();
        const length = String(buffer.text || '').length;
        // 太久没动静了：这不是「慢」，是这次生成已经死了（结束事件丢了）。
        // 把状态解开，否则会一直拦刷新和扩展按钮，反倒影响正常使用。
        if (Date.now() - Number(buffer.updatedAt || 0) > GENERATION_STALE_MS) {
            releaseGeneration();
            if (!settings().quiet) {
                toast(`这条生成已经没动静了，已解除「生成中」状态，草稿已保住 ${length} 字`, 'warning');
            }
            return;
        }
        // 只是「慢」、不是「死」：安静模式下完全不出声，写长段落时别打扰她
        if (length && !settings().quiet) {
            toast(`这条回复好像卡住了，已保住 ${length} 字草稿`, 'warning');
        }
        armStallWatch();
    }, ms);
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
        updateBadge(`已保存 ${text.length} 字（存储不可用）`);
    } else {
        updateBadge(`已保存 ${text.length} 字`);
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

/** 落盘间隔：草稿短的时候写盘很便宜，压到 300ms —— 别的扩展万一下一刻就把页面
    刷了，也能少丢一点；草稿变大后序列化成本上升，退回 800ms。 */
function flushInterval() {
    const length = String(buffer?.text || '').length;
    return length > 20000 ? FLUSH_INTERVAL_MS : Math.min(300, FLUSH_INTERVAL_MS);
}

function scheduleFlush() {
    if (flushTimer) {
        return;
    }
    const wait = Math.max(0, flushInterval() - (Date.now() - lastFlushAt));
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
    // 这里故意不 disarm：GENERATION_ENDED 是同步 emit 的，那一刻字全在屏幕上，
    // 但酒馆要等随后的 saveChat 才写盘。这段窗口刷新就是整段蒸发，绝不能放开。
    // 什么时候放开由 holdPostGenerationGuard / settlePostGenerationGuard 决定。
    clearStallWatch();
    updateBadge('');
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }

    const snapshot = buffer;
    buffer = null;
    if (!snapshot) {
        // 手动停止会先 STOPPED 再 ENDED，第二次进来时草稿已经被第一次处理过，
        // 保护窗口也已经设好了，这里什么都不动，别把它提前拆掉。
        return;
    }

    const text = String(snapshot.text || '');
    if (!text.trim()) {
        removeSnapshot(snapshot.id);
        settlePostGenerationGuard();
        return;
    }

    // 正常结束时内容已经完整写进聊天了，不需要留草稿。
    // 这里判定一律保守：拿不准就留着，交给后面的复核处理。
    if (chatDraftLanded(snapshot)) {
        removeSnapshot(snapshot.id);
        settlePostGenerationGuard();
        return;
    }

    // 还没落地：撑起落盘保护窗口，等复核确认写进聊天了再放开
    holdPostGenerationGuard();

    // 酒馆把这条消息塞进 ctx.chat 往往比 GENERATION_ENDED 晚半拍（真机实测过），
    // 所以这里不当场喊「没写进聊天」——只先记下来，隔几秒复核几次。
    // ended = 酒馆自己正常收尾，草稿只当备份，绝不出卡片、绝不弹提示。
    snapshot.endedCleanly = reason === 'ended';
    snapshot.updatedAt = Date.now();
    upsertSnapshot(snapshot);
    scheduleLandedRecheck(snapshot, reason);
}

/**
 * 生成结束后隔几秒复核「这条其实已经写进聊天了」。
 * 正常结束（endedCleanly）的草稿哪怕真没落地也只留在面板里当备份，不打扰她；
 * 只有「被打断 / 被停止」才 toast + 弹卡片。
 */
const LANDED_RECHECK_DELAYS = [1200, 1500, 2000, 3000];

function recheckDelays() {
    // 测试里可以把这几档压短，真机上永远是上面那组真实间隔
    const custom = globalThis.__ggRecheckDelays;
    return Array.isArray(custom) && custom.length ? custom : LANDED_RECHECK_DELAYS;
}

function scheduleLandedRecheck(snapshot, reason, attempt = 0) {
    const wait = recheckDelays()[attempt];
    if (!wait) {
        settleFinishedSnapshot(snapshot, reason);
        return;
    }
    setTimeout(() => {
        try {
            if (chatDraftLanded(snapshot)) {
                removeSnapshot(snapshot.id);
                // 确认已经写进聊天了，落盘保护可以撤了，别让她干等
                settlePostGenerationGuard();
                return;
            }
            scheduleLandedRecheck(snapshot, reason, attempt + 1);
        } catch (error) {
            console.warn(TAG, error);
        }
    }, wait);
}

function settleFinishedSnapshot(snapshot, reason) {
    if (!readAll().some((item) => item.id === snapshot.id)) {
        return;
    }
    const text = String(snapshot.text || '');
    if (!text.trim()) {
        removeSnapshot(snapshot.id);
        return;
    }
    // 正常收尾的：草稿留作备份（面板里能自己复制），一声不响
    if (snapshot.endedCleanly) {
        if (!settings().quiet) {
            toast(`回复已完整写进聊天，草稿留作备份（${text.length} 字）`, 'info');
        }
        return;
    }
    // 真被打断：这时候出声才不算打扰
    toast(`生成被中断，已保住 ${text.length} 字草稿（刷新后可以接着续写）`, 'warning');
    setTimeout(() => {
        if (!pendingSnapshot) {
            scanForRecoverySafe({ countdown: false });
        }
    }, 300);
}

/* ------------------------------------------------------------------ *
 * 刷新拦截
 * ------------------------------------------------------------------ */

let unloadGuardArmed = false;
// 生成刚结束、字还在屏幕上但酒馆还没 saveChat 的那段保护窗口
let postGenGuardUntil = 0;
let postGenGuardTimer = null;

/** 现在刷新会不会丢字：要么正在吐字，要么刚写完、还在往聊天里存 */
function reloadWouldLoseText() {
    return activelyGenerating() || Date.now() < postGenGuardUntil;
}

/** 两种痛点的说法分开：正在写 vs 写完了还没存进聊天 */
function unloadMessage(live) {
    return live
        ? '正在生成中，刷新会中断回复。草稿已保存，确定要刷新吗？'
        : '这段回复刚写完、正在存进聊天，现在刷新可能整段丢。确定要刷新吗？';
}

function unloadGuard(event) {
    const live = activelyGenerating();
    const writing = !live && Date.now() < postGenGuardUntil;
    if (!live && !writing) {
        return;
    }
    try {
        flushNow();
    } catch (error) {
        console.warn(TAG, error);
    }
    event.preventDefault();
    event.returnValue = unloadMessage(live);
    return event.returnValue;
}

/** 落盘保护窗口的长度：测试里可以把它压到 0，真机上永远是 POST_GEN_GUARD_MS */
function postGenGuardMs() {
    const custom = globalThis.__ggPostGenGuardMs;
    return Number.isFinite(custom) && custom >= 0 ? Number(custom) : POST_GEN_GUARD_MS;
}

/** 生成结束但字还没落盘：这段时间照拦，别让扩展的自动刷新把刚写完的字冲掉 */
function holdPostGenerationGuard() {
    if (!settings().blockReload) {
        return;
    }
    const hold = postGenGuardMs();
    postGenGuardUntil = Date.now() + hold;
    armUnloadGuard();
    if (postGenGuardTimer) {
        clearTimeout(postGenGuardTimer);
    }
    postGenGuardTimer = setTimeout(() => {
        postGenGuardTimer = null;
        settlePostGenerationGuard();
    }, hold);
}

/** 确认落盘了（或压根没内容）：立刻放开，不用干等 12 秒 */
function settlePostGenerationGuard() {
    postGenGuardUntil = 0;
    if (postGenGuardTimer) {
        clearTimeout(postGenGuardTimer);
        postGenGuardTimer = null;
    }
    disarmUnloadGuard();
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

/* 只有这四类真的会在生成中把页面刷掉：
   - 启用 / 禁用：改完置 requiresReload，关扩展弹窗那一刻 reload
   - 删除 / 清理：delay(1000).then(() => location.reload())
   其余（更新 / 换分支 / 移动）只改文件、不 reload，一概放行 ——
   这样她用热重载扩展点更新不会「点了没反应」。 */
const CLICK_BLOCK_SELECTOR = [
    '.extensions_info .extension_block .toggle_enable',
    '.extensions_info .extension_block .toggle_disable',
    '.extensions_info .extension_block .btn_delete',
    '.extensions_info .extension_block .btn_clean',
].join(', ');

function guardReloadProneClick(event) {
    if (!settings().enabled || !settings().blockReload || !settings().blockExtensionOps || !reloadWouldLoseText()) {
        return;
    }
    const target = event.target;
    const hit = typeof target?.closest === 'function' ? target.closest(CLICK_BLOCK_SELECTOR) : null;
    if (!hit) {
        return;
    }
    const isRemoval = hit.classList.contains('btn_delete') || hit.classList.contains('btn_clean');
    // 按住 Shift 点 = 这次放行（草稿先落盘再让它去刷）
    if (event.shiftKey) {
        try {
            flushNow();
        } catch (error) {
            console.warn(TAG, error);
        }
        toast('已放行这一次（草稿已保存，刷新回来会自动补回）', 'info');
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
        flushNow();
    } catch (error) {
        console.warn(TAG, error);
    }
    toast(isRemoval
        ? `这条${activelyGenerating() ? '正在写' : '刚写完还没存进聊天'}，删除 / 清理扩展会立刻刷新页面 —— 等一下再动（按住 Shift 点可以强制放行）`
        : `这条${activelyGenerating() ? '正在写' : '刚写完还没存进聊天'}，启用 / 禁用扩展会立刻刷新页面 —— 等一下再动（按住 Shift 点可以强制放行）`, 'warning');
}

/* 扩展自己的「更新」确认弹窗：点了以后它们自己会 setTimeout 刷新（实测本机
   ST-BaiBai-Tools / Mobile-Resize-Guard 是 1 秒，Self-Check 0.9 秒，Horae 0.8 秒，
   JS-Slash-Runner 3 秒，persona-weaver 1.5 秒，titania-theater 0.5 秒…）。
   这些全是别人家的 setTimeout，拿不到 timer id，没法在事后取消 ——
   唯一能在「还没刷」那一刻做点什么的办法，就是拦这次点击。

   判定收得很紧，只在生成中生效，且要同时满足：
     1) 按钮文字是「更新 / 立即更新 / 现在更新」这类；
     2) 它所在的容器里出现了「自动刷新页面」字样（扩展更新弹窗的典型提示）；
     3) 不是酒馆扩展管理面板里的 .btn_update（那个只 toast、不 reload，点它安全）。
   按住 Shift 点 = 放行（草稿先落盘，回来照样能补）。 */
const UPDATE_BUTTON_TEXTS = ['更新', '立即更新', '现在更新', '马上更新', '更新并重启', 'update', 'update now'];
const AUTO_RELOAD_HINT = /自动刷新|刷新页面|reload the page|will reload/i;

function guardExtensionUpdateClick(event) {
    if (!settings().enabled || !settings().blockReload || !reloadWouldLoseText()) {
        return;
    }
    const target = event.target;
    if (typeof target?.closest !== 'function') {
        return;
    }
    // 酒馆扩展管理面板里的「更新」：ST 只 toast 不 reload，放行
    if (target.closest('.extensions_info, #extensions_settings, #extensions_settings2')) {
        return;
    }
    const button = target.closest('button, a, .menu_button');
    if (!button) {
        return;
    }
    const label = String(button.textContent || '').trim().toLowerCase();
    if (!label || label.length > 12 || !UPDATE_BUTTON_TEXTS.includes(label)) {
        return;
    }
    const box = button.closest('.popup, #dialogue_popup, dialog, [class*="dialog"], [class*="modal"], [class*="popup"]');
    const hintText = box ? String(box.textContent || '') : '';
    if (!AUTO_RELOAD_HINT.test(hintText)) {
        return;
    }
    if (event.shiftKey) {
        try {
            flushNow();
        } catch (error) {
            console.warn(TAG, error);
        }
        toast('已放行这次更新（草稿已保存，刷新回来会自动补回）', 'info');
        return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
        flushNow();
    } catch (error) {
        console.warn(TAG, error);
    }
    toast(`这条${activelyGenerating() ? '正在写' : '刚写完还没存进聊天'}，更新完它不到一秒就会把页面刷掉 —— 等一下再更新（按住 Shift 点可以强制放行）`, 'warning');
}

/* ------------------------------------------------------------------ *
 * 为什么不去包装 fetch / 不去改别的全局函数
 *
 * 逐个对着酒馆源码查过（public/scripts/extensions.js）：
 *   - 更新扩展：onUpdateClick → updateExtension → 只 toast「Reload the page to
 *     apply updates」，**不 reload**，所以生成中点更新并不会打断回复 —— 不必拦。
 *   - 换分支 / 移动：只弹确认再调接口，也不 reload —— 不必拦。
 *   - 启用 / 禁用：改完状态置 requiresReload，**关闭扩展弹窗那一刻** reload。
 *   - 删除 / 清理：delay(1000).then(() => location.reload())，**必刷**。
 *
 * 所以只有「启用/禁用/删除/清理」四类真的会在生成中把页面刷掉，也就只拦这四类，
 * 别的一概放行。更新走的是热重载扩展（SillyTavern-Extension-Hot-Reload）时更安全 ——
 * 它自己就会在生成中把重启延后到 GENERATION_ENDED / GENERATION_STOPPED，我们不去插手。
 * 浏览器也不允许改写 location.reload（Location 的属性是 Unforgeable），
 * 所以「事后延后刷新」这条思路本来就不存在，别再包装任何全局函数。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 界面：状态徽标
 * ------------------------------------------------------------------ */

/* 卡片有两种形态：
   manual   —— 还没接回，给你「接回 / 续写 / 复制 / 丢弃」
   restored —— 已经自动补回聊天了，只留「续写 / 撤销补回」 */
let panelMode = 'manual';
let lastAutoRestore = null;

function setPanelButtons(mode) {
    const restored = mode === 'restored';
    for (const id of ['gg-btn-recover', 'gg-btn-prompt', 'gg-btn-textarea', 'gg-btn-discard']) {
        el(id)?.classList.toggle('gg-hidden', restored);
    }
    el('gg-btn-undo')?.classList.toggle('gg-hidden', !restored);
}

function showRestoredCard(snapshot) {
    ensureUI();
    panelMode = 'restored';
    setPanelButtons('restored');
    el('gg-recover-title').textContent = '已自动补回这一轮';
    el('gg-recover-meta').textContent = `${snapshot.charName || '当前角色'} · ${fmtTime(snapshot.startedAt)} · 已写进聊天并保存 · ${snapshot.text.length} 字${snapshot.truncated ? '（过长已截断）' : ''}`;

    const preview = el('gg-recover-preview');
    preview.textContent = snapshot.text.length > 1200
        ? `……（前面已生成的部分）\n${snapshot.text.slice(-1200)}`
        : snapshot.text;
    preview.scrollTop = preview.scrollHeight;

    setFoot('这条已经是一轮完整的回复，写在聊天里了，直接点酒馆的「继续生成」就能往下玩。「续写」会替你发一条主线指令（多一次请求）。');
    el('gg-btn-recover-write').classList.add('gg-primary');
    el('gg-panel').classList.remove('gg-hidden');
}

/**
 * 撤销自动补回：把那条从聊天里拿掉，草稿放回「已保存草稿」，回到手动模式。
 * 撤销需要的「第几条 / 原文」记在面板的 dataset 上，而不是只放在模块变量里 ——
 * 万一扩展被重复加载、或者两个标签页同时在跑，另一个实例点撤销也能拿到同一份记录。
 */
async function undoAutoRestore() {
    const panel = el('gg-panel');
    const raw = panel?.dataset?.undo || '';
    let record = null;
    try {
        record = raw ? JSON.parse(raw) : lastAutoRestore;
    } catch (error) {
        record = lastAutoRestore;
    }
    lastAutoRestore = null;
    if (panel?.dataset) {
        delete panel.dataset.undo;
    }
    hidePanel();
    if (!record) {
        return;
    }

    const ctx = getContext();
    const chat = ctx.chat || [];
    let index = record.index;
    if (!Number.isInteger(index) || index < 0 || index >= chat.length || String(chat[index]?.mes || '') !== record.text) {
        index = chat.findIndex((message) => String(message?.mes || '') === record.text);
    }

    if (index >= 0 && index < chat.length) {
        try {
            if (typeof ctx.deleteMessage === 'function') {
                ctx.deleteMessage(index);
            }
        } catch (error) {
            console.warn(TAG, 'delete restored message failed', error);
        }
        if (String(chat[index]?.mes || '') === record.text) {
            chat.splice(index, 1);
        }
        await saveChatQuiet(ctx);
        if (typeof ctx.scrollChatToBottom === 'function') {
            ctx.scrollChatToBottom();
        }
    }

    // 草稿还回去：内容直接用刚拿掉的那条正文重建，所以不依赖当初存下来的一大坨对象。
    // 打上 autoSuppressed：刷新后不会再自动补回这条，只弹手动卡片，避免「撤销完又自己长回来」。
    if (record.text) {
        upsertSnapshot({
            id: `undo-${Date.now().toString(36)}`,
            chatKey: record.chatKey || currentChatKey(),
            chatLen: Math.max(0, index),
            tailHash: tailSignature(Math.max(0, index)),
            tailHead: '',
            tailIsUser: false,
            type: 'normal',
            charName: String(ctx.name2 || '').slice(0, 80),
            baseMes: null,
            text: String(record.text),
            startedAt: Date.now(),
            updatedAt: Date.now(),
            autoSuppressed: true,
        });
    }
    toast('已撤销补回，草稿还在「已保存草稿」里', 'info');
}

/**
 * 魔杖菜单里的一条。
 * 她不要聊天框上面挂图标，也不要再单独做一份酒馆助手脚本 —— 入口就放回酒馆自己的
 * 魔法棒：跟别的扩展的按钮排在一起，收起时不占版面，点开就有。
 * 结构照酒馆原生模板：`#extensionsMenu > .extension_container > div`。
 */
function mountWandEntry() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu) {
        return false;
    }
    if (document.getElementById('gg-wand-entry')) {
        return true;
    }
    let box = document.getElementById('gg_wand_container');
    if (!box) {
        box = document.createElement('div');
        box.id = 'gg_wand_container';
        box.className = 'extension_container';
        menu.appendChild(box);
    }
    const item = document.createElement('div');
    item.id = 'gg-wand-entry';
    item.className = 'gg-wand-item';
    item.tabIndex = 0;
    item.title = '生成守护';

    const icon = document.createElement('div');
    icon.className = 'fa-fw fa-solid fa-shield-halved extensionsMenuExtensionButton';
    const name = document.createElement('span');
    name.className = 'gg-wand-name';
    name.textContent = '生成守护';
    const state = document.createElement('span');
    state.className = 'gg-wand-state';
    state.id = 'gg-wand-state';

    item.append(icon, name, state);
    item.addEventListener('click', () => {
        openSettingsDrawer();
    });
    item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            openSettingsDrawer();
        }
    });
    box.appendChild(item);
    return true;
}

/** 魔杖菜单是酒馆自己按需建的，没建出来就隔一会儿再挂一次 */
function syncWandEntry(retry = 0) {
    if (mountWandEntry()) {
        return;
    }
    if (retry < 10) {
        setTimeout(() => syncWandEntry(retry + 1), 400);
    }
}

/** 那一行点下去之后，魔杖菜单也该收起来 */
function closeWandMenu() {
    try {
        const menu = document.getElementById('extensionsMenu');
        if (menu && menu.style.display !== 'none') {
            document.getElementById('extensionsMenuButton')?.click();
        }
    } catch (error) {
        console.debug(TAG, error);
    }
}

/**
 * 跳到扩展页并把抽屉展开。她可能正停在聊天页，所以先替她把「扩展」那条抽屉打开
 * —— 用酒馆自己的 drawer 结构（.drawer > .drawer-toggle / .drawer-content.closedDrawer）。
 */
/**
 * 设置面板的弹窗宿主。
 * 她原话：「我要做的是面板弹窗啊。不是你现在这种」—— 点魔法棒那一条，面板就该自己浮上来，
 * 不该把她赶到「扩展」页去翻抽屉。所以整块 #gg-settings 平时挂在扩展页（酒馆惯例），
 * 打开弹窗时搬到浮层里，关掉再搬回去，DOM 和事件监听一个不重建。
 */
let sheetHome = null;

/**
 * 扩展页里那条常驻入口。
 * 面板被推进弹窗时，扩展页那一块会暂时空着 —— 她说不许把入口删掉，
 * 所以这里永远留一行「生成守护 · 打开面板」，面板搬回来时它自己让位。
 */
function mountExtEntry(host) {
    let entry = el('gg-ext-entry');
    if (!entry) {
        entry = document.createElement('div');
        entry.id = 'gg-ext-entry';
        entry.className = 'gg-ext-entry';
        entry.innerHTML = '<button type="button" class="gg-btn gg-mini" id="gg-ext-open">生成守护 · 打开面板</button>';
        host.appendChild(entry);
        el('gg-ext-open')?.addEventListener('click', () => openPanelModal());
    }
    return entry;
}

/** 面板在扩展页的时候把入口行藏起来，搬走了再露出来 */
function syncExtEntry() {
    const entry = el('gg-ext-entry');
    const root = el('gg-settings');
    if (!entry) {
        return;
    }
    const inModal = Boolean(root?.classList?.contains('gg-in-modal'));
    entry.style.display = inModal ? '' : 'none';
}

function ensureModal() {
    let modal = el('gg-modal');
    if (modal) {
        return modal;
    }
    modal = document.createElement('div');
    modal.id = 'gg-modal';
    modal.className = 'gg-modal gg-hidden';
    modal.innerHTML = `
        <div class="gg-modal-card" role="dialog" aria-modal="true" aria-labelledby="gg-modal-title">
            <div class="gg-modal-head">
                <span class="gg-modal-title" id="gg-modal-title">生成守护</span>
                <button type="button" class="gg-icon-btn" id="gg-modal-close" title="收起"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="gg-modal-body" id="gg-modal-body"></div>
        </div>`;
    document.body.appendChild(modal);

    el('gg-modal-close').addEventListener('click', () => closePanelModal());
    // 点遮罩空白处也关
    modal.addEventListener('click', (event) => {
        if (event.target === modal) {
            closePanelModal();
        }
    });
    return modal;
}

function openPanelModal(retry = 0) {
    closeWandMenu();
    const modal = ensureModal();
    let root = el('gg-settings');
    if (!root) {
        // 面板还没建过就当场建一个 —— 手机端最容易卡在这，
        // 表现就是「点魔杖里那一条什么都没发生」。
        mountSettings();
        root = el('gg-settings');
    }
    const body = el('gg-modal-body');
    if (!root || !body) {
        if (retry < 6) {
            setTimeout(() => openPanelModal(retry + 1), 200);
        }
        return;
    }
    if (root.parentElement !== body) {
        if (root.parentElement && !root.classList.contains('gg-in-modal')) {
            sheetHome = root.parentElement;
        }
        body.appendChild(root);
        root.classList.add('gg-in-modal');
    }
    syncExtEntry();
    modal.classList.remove('gg-hidden');

    // 第一次打开面板就顺手把引导走到，不让她自己去猜
    if (!settings().guideSeen) {
        openGuide();
    }
}

function closePanelModal() {
    const modal = el('gg-modal');
    if (!modal || modal.classList.contains('gg-hidden')) {
        return;
    }
    modal.classList.add('gg-hidden');
    const root = el('gg-settings');
    if (!root) {
        return;
    }
    root.classList.remove('gg-in-modal');
    // 面板是从扩展页搬来的就搬回去；本来就是建在弹窗里的就别动
    const home = sheetHome && document.contains(sheetHome) && !sheetHome.closest?.('#gg-modal')
        ? sheetHome
        : null;
    if (home && root.parentElement !== home) {
        home.appendChild(root);
    }
    syncExtEntry();
}

/** 老名字保留：/gg、脚本按钮、window.GenerationGuardian.openSettings 都还走这里 */
function openSettingsDrawer() {
    openPanelModal();
}

/**
 * 给 QR 助手脚本按钮留的一个入口。
 * 告诉她「面板在哪、怎么开」比弹一张可能已经过期的卡片更靠谱，
 * 所以这里只负责把她送到设置面板，不猜有没有草稿。
 */
function openPanel() {
    openSettingsDrawer();
    return true;
}

/* 魔杖菜单由酒馆在启动后建出来，建好了再把我们那条塞进去 */
function watchWandMenu() {
    syncWandEntry();
}

/**
 * 注册 /gg —— 她可以在自己的 QR 集合里加一条快捷写 /gg，
 * 那条快捷就折叠在快捷区里，聊天框上方什么都不用留。
 */
function registerSlashCommand() {
    if (globalThis.__ggSlashRegistered) {
        return;
    }
    try {
        const ctx = getContext();
        const parser = ctx?.SlashCommandParser;
        const SlashCommand = ctx?.SlashCommand;
        if (!parser?.addCommandObject || !SlashCommand?.fromProps) {
            return;
        }
        parser.addCommandObject(SlashCommand.fromProps({
            name: 'gg',
            callback: () => {
                openSettingsDrawer();
                return '';
            },
            helpString: '打开 Generation Guardian（生成守护）的设置面板。',
        }));
        globalThis.__ggSlashRegistered = true;
    } catch (error) {
        console.debug(TAG, error);
    }
}

function ensureUI() {
    syncWandEntry();
    bindHelpButton();
    if (el('gg-panel')) {
        return;
    }

    const panel = document.createElement('div');
    panel.id = 'gg-panel';
    panel.className = 'gg-hidden';
    panel.innerHTML = `
        <div class="gg-card">
            <div class="gg-head">
                <span class="gg-title" id="gg-recover-title">检测到未完成的回复</span>
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
                <button type="button" class="gg-btn gg-danger gg-hidden" id="gg-btn-undo">撤销补回</button>
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
        if (panelMode === 'restored') {
            hidePanel();
            sendResumePrompt();
            return;
        }
        if (pendingSnapshot) {
            resumeSnapshot(pendingSnapshot, { thenPrompt: true });
        }
    });
    el('gg-btn-undo').addEventListener('click', () => {
        undoAutoRestore();
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

    ensureGuide();
}

/* ------------------------------------------------------------------ *
 * 新手引导
 *
 * 她的原话：「你的新手引导应该是面板出现后，依次分步照亮讲解处来引导。
 * 而不是面板都不出来讲说明书一样。」
 * 所以这里不是一张全屏说明书：遮罩只在当前这一块上挖个洞，旁边挂一个小气泡。
 * ------------------------------------------------------------------ */

const GUIDE_STEPS = [
    {
        target: '#gg-set-enabled',
        tag: '它到底在干什么',
        body: '流式回复写到一半被刷新、被别的扩展刷页、被手机杀掉后台，屏幕上已经吐出来的字会整段消失，API 额度照扣。这个扩展每 0.8 秒把正在写的那一段存进本机，回来帮你接回聊天，不用重发一遍。这一行是总开关，关掉就全都不管了。',
    },
    {
        target: '#gg-set-block',
        tag: '拦手动刷新',
        body: '「拦截刷新和关闭页面」：生成中按 F5、下拉刷新、关标签页，会先弹一次确认问你要不要真刷，手滑也有一次后悔的机会。生成刚结束的那 12 秒也算在保护期内 —— 那时候字还在内存里、没落盘。',
    },
    {
        target: '#gg-set-ops',
        tag: '拦别家扩展',
        body: '「拦住会刷新的扩展操作」：生成中禁用、删除、清理扩展会被拦下来。更新和换分支不拦，那是你自己点的。它认得的那几个：柏宝箱点更新后约 1 秒自己刷、Horae 0.8 秒、Self-Check 0.9 秒、酒馆助手 3 秒、titania-theater 0.5 秒、persona-weaver 1.5 秒。',
    },
    {
        target: '#gg-set-autorestore',
        tag: '接回：不花额度',
        body: '「被打断时自动接回」：刷新回来、打开同一个聊天，草稿会直接补成一正式的一轮并保存。它走的是酒馆自己的渲染，所以能右滑、能重新生成、能导出。这一步不发任何请求 —— 一个字都不重新生成，钱不会再花第二遍。',
    },
    {
        target: '#gg-set-quiet',
        tag: '平时别烦你',
        body: '「安静模式」：正常写完一声不吭，只有真被打断才出声。想让它每存一次草稿都报一声，把这个关掉就行。「通知状态栏类扩展」在它下面：接回之后广播一次「这条渲染好了」，给自动翻译、状态栏、TTS 用；不广播它们会以为这条还没写完。本扩展自己不额外发请求。',
    },
    {
        target: '#gg-set-autosend',
        tag: '续写：只填不发',
        body: '点「续写」的时候默认只把一段指令放进输入框，你可以先自己补两句再按发送，不会偷偷发请求。想让它续写后直接发，就打开这个开关。指令本身在下面「续写指令」那块，可以自己改，也给了主线、番外两条预设。',
    },
    {
        target: '#gg-compat-fold',
        tag: '兼容状态',
        body: '这一块列出你酒馆里会自己刷页的那几个扩展，标题右边的数字是命中几个。它们动手刷新之前，我们先把草稿钉进存储 —— 就算你没拦住，字也还在。',
    },
    {
        target: '#gg-snap-fold',
        tag: '已保存草稿',
        body: '被打断过的草稿都在这儿，按时间倒序。可以逐条「接回」写回聊天，也可以一键清空。正常写完的那一次不会留残留。',
    },
    {
        target: '#gg-theme-fold',
        tag: '主题',
        body: '八套配色。收起的时候右边那一条就是这八套的色谱：每一格上半是底色、下半是主色，当前那套放大并加一圈环 —— 不展开也知道现在是哪一套。点一下盖子掀开，下面是八张卡。',
    },
    {
        target: '#gg-help',
        tag: '重看',
        body: '就是这个小问号。以后想再看一遍这一整套，点它就从第一步重来。',
    },
];

let guideIndex = 0;

let helpBound = false;

/**
 * 面板底部那个「?」。
 * 面板会被搬进弹窗、扩展重载时也会复用旧节点 —— 直接绑在按钮上一次就可能漏，
 * 所以这里挂在 document 上做委托：只要点的是 #gg-help，不管它现在在谁家里都管用。
 */
function bindHelpButton() {
    if (helpBound) {
        return;
    }
    helpBound = true;
    document.addEventListener('click', (event) => {
        const btn = event.target?.closest?.('#gg-help');
        if (!btn) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        openGuide();
    }, true);
}

function ensureGuide() {
    if (el('gg-guide')) {
        return;
    }
    const wrap = document.createElement('div');
    wrap.id = 'gg-guide';
    wrap.className = 'gg-guide gg-hidden';
    wrap.innerHTML = `
        <div class="gg-guide-spot" id="gg-guide-spot" aria-hidden="true"></div>
        <div class="gg-guide-card" id="gg-guide-card" role="dialog" aria-modal="false" aria-labelledby="gg-guide-title">
            <div class="gg-guide-head">
                <span class="gg-guide-tag">新手引导</span>
                <span class="gg-guide-title" id="gg-guide-title"></span>
                <span class="gg-guide-step" id="gg-guide-step"></span>
                <button type="button" class="gg-icon-btn" id="gg-guide-close" title="跳过"><i class="fa-solid fa-xmark"></i></button>
            </div>
            <div class="gg-guide-body" id="gg-guide-body"></div>
            <div class="gg-guide-foot">
                <button type="button" class="gg-btn gg-mini" id="gg-guide-prev">上一步</button>
                <div class="gg-guide-dots" id="gg-guide-dots" aria-hidden="true"></div>
                <button type="button" class="gg-btn gg-mini gg-primary" id="gg-guide-next">下一步</button>
            </div>
        </div>`;
    document.body.appendChild(wrap);

    el('gg-guide-close').addEventListener('click', () => closeGuide());
    el('gg-guide-prev').addEventListener('click', () => {
        if (guideIndex > 0) {
            guideIndex -= 1;
            renderGuide();
        }
    });
    el('gg-guide-next').addEventListener('click', () => {
        if (guideIndex >= GUIDE_STEPS.length - 1) {
            closeGuide();
            return;
        }
        guideIndex += 1;
        renderGuide();
    });
    // 面板自己会滚，窗口也会转 —— 高亮框得跟着走
    const relite = () => {
        if (!el('gg-guide')?.classList.contains('gg-hidden')) {
            placeSpotlight(GUIDE_STEPS[guideIndex]?.target);
        }
    };
    el('gg-modal-body')?.addEventListener('scroll', relite, { passive: true });
    window.addEventListener('resize', relite);
    window.addEventListener('orientationchange', relite);
}

/**
 * 点亮一个控件之前先确认它真的露着：
 * 开关那几行在折叠块里，用户要是把它收起来了，就先替他掀开再照亮。
 */
function revealGuideTarget(target) {
    if (!target) {
        return false;
    }
    const rect = target.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
        return true;
    }
    const fold = target.closest?.('.gg-fold');
    const head = fold?.querySelector?.('.gg-fold-head');
    if (head && fold.getAttribute('aria-expanded') !== 'true') {
        head.click();
        return true;
    }
    return false;
}

/**
 * 把当前这一块照亮：高亮框贴着它，四周靠一层巨大的外阴影压暗。
 * 框和气泡都是 fixed 定位，所以面板滚动、窗口尺寸变化时要重新放一次。
 * 指引的是单个开关时，照亮它整个 label（只框一个小小的勾选框太小了）。
 */
function placeSpotlight(selector) {
    const spot = el('gg-guide-spot');
    const card = el('gg-guide-card');
    if (!spot || !card) {
        return;
    }
    let target = selector ? document.querySelector(selector) : null;
    if (target && target.matches?.('input, textarea')) {
        target = target.closest?.('label') || target;
    }
    if (!target) {
        spot.style.display = 'none';
        card.dataset.anchored = '0';
        return;
    }
    let rect = target.getBoundingClientRect();
    if (!rect || rect.width < 1 || rect.height < 1) {
        spot.style.display = 'none';
        card.dataset.anchored = '0';
        return;
    }
    // 目标在面板滚动区外面时先把它滚进来 —— 不然洞会挖到视口外，
    // 气泡也跟着跑到看不见的地方。第七步往后全是折叠块，必须这一步。
    const vh = window.innerHeight || 800;
    if (rect.top < 70 || rect.bottom > vh - 70) {
        try {
            target.scrollIntoView({ block: 'center', behavior: 'auto' });
        } catch {
            /* 老浏览器没有 options 参数，直接滚 */
            target.scrollIntoView();
        }
        rect = target.getBoundingClientRect();
    }

    const pad = 6;
    spot.style.display = '';
    spot.style.top = `${Math.round(rect.top - pad)}px`;
    spot.style.left = `${Math.round(rect.left - pad)}px`;
    spot.style.width = `${Math.round(rect.width + pad * 2)}px`;
    spot.style.height = `${Math.round(rect.height + pad * 2)}px`;

    // 气泡优先贴在下面，下面放不下就翻到上面
    const gap = 12;
    const cardH = card.offsetHeight || 150;
    let top = rect.bottom + gap;
    if (top + cardH > vh - 10) {
        top = Math.max(10, rect.top - cardH - gap);
    }
    card.dataset.anchored = '1';
    card.style.top = `${Math.round(top)}px`;
}

/**
 * 面板刚弹出来那一下它自己还在播入场动画、滚动位置也没定，
 * 量一次会差几十像素（实测偏了一行半）。所以连着量几遍，
 * 等它停稳 —— 洞会平滑地飘到正确那一行，不会先错再跳。
 */
function settleSpotlight(selector) {
    if (!selector) {
        placeSpotlight(null);
        return;
    }
    placeSpotlight(selector);
    [140, 320, 620, 980].forEach((delay) => {
        setTimeout(() => placeSpotlight(selector), delay);
    });
}

function renderGuide() {
    const step = GUIDE_STEPS[guideIndex] || GUIDE_STEPS[0];
    const title = el('gg-guide-title');
    if (title) {
        title.textContent = step.tag || '';
    }
    const counter = el('gg-guide-step');
    if (counter) {
        counter.textContent = `${guideIndex + 1} / ${GUIDE_STEPS.length}`;
    }
    const body = el('gg-guide-body');
    if (body) {
        body.textContent = '';
        for (const line of String(step.body || '').split('\n')) {
            const text = line.trim();
            if (!text) {
                continue;
            }
            const p = document.createElement('p');
            p.textContent = text;
            body.appendChild(p);
        }
    }
    const dots = el('gg-guide-dots');
    if (dots) {
        dots.textContent = '';
        for (let i = 0; i < GUIDE_STEPS.length; i += 1) {
            const dot = document.createElement('i');
            dot.className = 'gg-guide-dot';
            dot.dataset.active = String(i === guideIndex);
            dots.appendChild(dot);
        }
    }
    const prev = el('gg-guide-prev');
    if (prev) {
        prev.disabled = guideIndex === 0;
    }
    const next = el('gg-guide-next');
    if (next) {
        next.textContent = guideIndex >= GUIDE_STEPS.length - 1 ? '开始用' : '下一步';
    }
    // 这一块要是收着就先掀开（掀完要等一帧才量得到位置）；面板自己也在播
    // 入场动画 —— 所以交给 settleSpotlight 连量几遍，等它停稳。
    const lit = step.target ? document.querySelector(step.target) : null;
    if (lit) {
        revealGuideTarget(lit);
    }
    settleSpotlight(step.target);
}

function openGuide() {
    ensureGuide();
    guideIndex = 0;
    el('gg-guide')?.classList.remove('gg-hidden');
    renderGuide();
    // 刚显示出来时还没排版，等一帧再量位置
    if (typeof requestAnimationFrame === 'function') {
        settleSpotlight(GUIDE_STEPS[guideIndex]?.target);
    }
}

function closeGuide() {
    el('gg-guide')?.classList.add('gg-hidden');
    if (!settings().guideSeen) {
        settings().guideSeen = true;
        persistSettings();
    }
}

function showPanel(snapshot) {
    ensureUI();
    panelMode = 'manual';
    setPanelButtons('manual');
    el('gg-recover-title').textContent = '检测到未完成的回复';
    const panel = el('gg-panel');
    const meta = el('gg-recover-meta');
    const preview = el('gg-recover-preview');

    panel.classList.remove('gg-hidden');
    if (panel.dataset) {
        delete panel.dataset.undo;
    }
    meta.textContent = `${snapshot.charName || '当前角色'} · ${fmtTime(snapshot.startedAt)} · ${typeLabel(snapshot.type)} · 已保住 ${snapshot.text.length} 字${snapshot.truncated ? '（过长已截断）' : ''}`;

    const head = '……（前面已生成的部分）\n';
    preview.textContent = snapshot.text.length > 1200
        ? head + snapshot.text.slice(-1200)
        : snapshot.text;
    preview.scrollTop = preview.scrollHeight;

    const resumeBtn = el('gg-btn-recover');
    const resumeWriteBtn = el('gg-btn-recover-write');
    resumeWriteBtn.classList.remove('gg-primary');
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

async function scanForRecovery() {
    // 插件被关掉的时候什么都不做：不弹卡片、不自动补回，也不去动她的聊天记录。
    if (!settings().enabled) {
        pendingSnapshot = null;
        hidePanel();
        return;
    }
    // 扩展被重复加载 / 两个标签页同时在跑时，别让两次扫描互相踩（互相 hidePanel / 重复补回）
    const guard = globalThis.__ggScanRunning;
    if (guard && Date.now() - Number(guard) < 3000) {
        return;
    }
    globalThis.__ggScanRunning = Date.now();
    try {
        ensureUI();
        const key = currentChatKey();

    // 已经完整落进聊天的草稿顺手清掉，别让存储越堆越多
    for (const snapshot of readAll()) {
        if (snapshot.chatKey === key && chatDraftLanded(snapshot)) {
            removeSnapshot(snapshot.id);
        }
    }

    // 正常收尾留下的备份草稿不参与恢复：它对应的那条早就写进聊天了，
    // 再弹「检测到未完成的回复」只会让人莫名其妙。
    const candidates = readAll().filter((snapshot) => snapshot.chatKey === key
        && !snapshot.endedCleanly
        && matchesAnchor(snapshot));

    if (!candidates.length) {
        pendingSnapshot = null;
        hidePanel();
        return;
    }

    candidates.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    const top = candidates[0];

    // 被打断时默认直接把草稿补回聊天，写进聊天记录并保存 ——
    // 这样刷新回来就跟「这一轮确实生成过」一样，可以接着往下玩。
    // 「换一条」「替我说话」不自动处理：它们只能塞进输入框，会顶掉你正在打的字。
    const autoEligible = top.type !== 'swipe' && top.type !== 'impersonate' && !top.autoSuppressed;
    if (settings().enabled && settings().autoRestore && autoEligible && !activelyGenerating() && !resuming) {
        const result = await resumeSnapshot(top, { thenPrompt: false });
        if (result && result.mode === 'append') {
            // 新插一条进聊天 → 给「撤销补回」留个记录（也写到 dataset，跨实例可用）
            const record = { index: result.index, text: String(top.text || ''), chatKey: key };
            lastAutoRestore = record;
            if (el('gg-panel')) {
                el('gg-panel').dataset.undo = JSON.stringify(record);
            }
            showRestoredCard(top);
            toast(`已把被打断的 ${String(top.text || '').length} 字自动补回聊天`, 'success');
            return;
        }
        if (result && (result.mode === 'completeHalf' || result.mode === 'anchor')) {
            // 补进原有那条消息里，不再弹卡片（撤销会把那条整条删掉，风险太大）
            hidePanel();
            return;
        }
        if (result && result.mode === 'textarea') {
            // 已经放进输入框了，不再弹卡片
            return;
        }
    }

    pendingSnapshot = top;
    showPanel(pendingSnapshot);
    } finally {
        globalThis.__ggScanRunning = null;
    }
}

function updateMessageInDom(ctx, index, message) {
    try {
        if (typeof ctx.updateMessageBlock === 'function') {
            ctx.updateMessageBlock(index, message, { rerenderMessage: true });
            // updateMessageBlock 只重绘 .mes_text，不会重算 swipe 计数 / 按钮，
            // 接回来的那条如果不刷新一下，右下角会一直显示旧条数
            try {
                ctx.swipe?.refresh?.();
            } catch (error) {
                console.warn(TAG, 'swipe refresh failed', error);
            }
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

/** 「接回并续写」按下之后的提示 —— 只填不发的时候别再说「正在发」 */
function promptToastText() {
    return settings().autoSend
        ? '已接回，正在发续写指令…'
        : '已接回，续写指令已放进输入框，补完按发送';
}

/**
 * 把接续指令放进输入框；按设置决定「直接替你发出去」还是「只填不发等你按发送」。
 * 走的是酒馆的标准路径：写进输入框 → 调 Generate('normal')，
 * Generate 会自己读输入框、清空、把这条消息塞进聊天再请求。
 * 发送失败时把指令重新填回输入框 —— 因为 Generate 已经把框清空了，
 * 不填回去就等于「指令丢了」。
 */
function sendResumePrompt() {
    const ctx = getContext();
    const prompt = resumePromptText();

    if (activelyGenerating()) {
        putToTextarea(prompt);
        toast('酒馆正在生成中，指令已放进输入框，等这次写完按发送', 'warning');
        return;
    }

    putToTextarea(prompt);

    if (!settings().autoSend) {
        toast('指令已放进输入框，改完按发送', 'info');
        return;
    }

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
        return null;
    }

    // 幂等保护：双击按钮 / 恢复过程中再次触发，都只执行一次
    if (resuming) {
        return null;
    }
    if (!readAll().some((item) => item.id === snapshot.id)) {
        pendingSnapshot = null;
        hidePanel();
        return null;
    }
    resuming = true;

    try {
        return await doResume(snapshot, { thenPrompt });
    } finally {
        resuming = false;
    }
}

/**
 * 续写接回时该用的「原文前缀」。
 *
 * 酒馆续写把 `continue_mag` 加上 `oai_settings.continue_postfix`（默认是一个空格）
 * 再续 token，最后写进聊天的是「原文 + 空格 + 新正文」。我们存下来的 baseMes 是原文
 * （没有那个空格），所以直接 base + text 会把拼接处的空格吃掉，出现 "上一句下一句" 粘连。
 * 这里在消息已经被写过的情况下，从消息里找出新正文的起点，把它之前的部分整个当前缀。
 */
function continuePrefix(anchorMes, base, text) {
    const cur = String(anchorMes || '');
    const safeBase = String(base || '');
    const probe = String(text || '').slice(0, 16);
    if (probe && cur.length > safeBase.length && cur.startsWith(safeBase)) {
        const at = cur.indexOf(probe, safeBase.length);
        if (at > 0 && at <= safeBase.length + 8) {
            return cur.slice(0, at);
        }
    }
    // 消息里还是原文（刷新后加载的是上一次保存的版本，酒馆还没把新正文写进去）。
    // 酒馆续写默认会在原文和正文之间插一个空格（continue_postfix 的默认值 SPACE），
    // 这里照它补一个，免得中英混排或英文单词被粘在一起。
    if (safeBase && !/\s$/.test(safeBase) && !/^\s/.test(String(text || ''))) {
        return `${safeBase} `;
    }
    return safeBase;
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

/**
 * 接回之后补一次「这条角色消息渲染完了」事件。
 *
 * 酒馆的 addOneMessage() 只负责画 DOM（走的是和正常生成完全同一套
 * getMessageTextHTML → messageFormatting，所以 markdown / 自定义 HTML / 正则都照常），
 * 但它**不会** emit CHARACTER_MESSAGE_RENDERED —— 那个事件正常只在 Generate 流程里发。
 * 而状态栏、变量、思维链标签、TTS、自动翻译这类扩展都挂在这个事件上，
 * 所以不补这一下，接回来的那条会「正文有、状态栏没贴」。
 */
let eventTypesRef = null;
let eventSourceRef = null;

function notifyRenderers(ctx, messageId, type = 'generation-guardian') {
    if (!settings().notifyRenderers) {
        return;
    }
    try {
        const events = ctx?.eventTypes || ctx?.event_types || eventTypesRef || globalThis.event_types;
        const source = ctx?.eventSource || eventSourceRef || globalThis.eventSource;
        if (!events || !source || typeof source.emit !== 'function') {
            return;
        }
        const name = events.CHARACTER_MESSAGE_RENDERED;
        if (!name) {
            return;
        }
        Promise.resolve(source.emit(name, messageId, type)).catch((error) => {
            console.warn(TAG, 'notifyRenderers failed', error);
        });
    } catch (error) {
        console.warn(TAG, 'notifyRenderers failed', error);
    }
}

async function doResume(snapshot, { thenPrompt = false } = {}) {
    hidePanel();

    const ctx = getContext();
    const chat = ctx.chat || [];
    const text = String(snapshot.text || '');
    if (!text.trim()) {
        removeSnapshot(snapshot.id);
        pendingSnapshot = null;
        return { mode: 'none' };
    }

    // 换一条 / 替我说话 → 只能放回输入框
    if (snapshot.type === 'swipe' || snapshot.type === 'impersonate') {
        putToTextarea(text);
        removeSnapshot(snapshot.id);
        pendingSnapshot = null;
        toast('已把草稿放进输入框（这类生成没法自动续写）', 'info');
        return { mode: 'textarea' };
    }

    const anchorIndex = snapshot.chatLen - 1;
    const anchor = chat[anchorIndex];
    const anchorIsChar = Boolean(anchor) && !anchor.is_user;
    const appendToAnchor = snapshot.type === 'continue'
        || (snapshot.type === 'regenerate' && anchorIsChar);

    // 流式生成一开始，酒馆会先往 chat 里 push 一条占位消息再喂 token。
    // 如果刷新回来这条占位还空着（正文一个字都没落），直接把草稿填进去，
    // 千万别在后面再追加一条 —— 否则聊天里会多出一个空壳 + 一条正文。
    if (anchorIsChar && chat.length === snapshot.chatLen && !String(anchor.mes || '').trim()) {
        anchor.mes = text;
        normalizeMessageFields(anchor, snapshot, ctx);
        updateMessageInDom(ctx, anchorIndex, anchor);
        notifyRenderers(ctx, anchorIndex);
        const saved = await saveChatQuiet(ctx);
        removeSnapshot(snapshot.id);
        pendingSnapshot = null;
        toast(saved
            ? '已把草稿填回那条空消息'
            : '已填回聊天，但保存聊天失败 —— 先别刷新页面', saved ? 'success' : 'warning');
        if (thenPrompt) {
            sendResumePrompt();
        }
        return { mode: 'anchor', index: anchorIndex };
    }

    if (appendToAnchor && anchorIsChar) {
        // 原来是在续写同一条消息 → 把草稿接回那条消息
        const base = typeof snapshot.baseMes === 'string' ? snapshot.baseMes : '';
        // 酒馆续写会在原文和正文之间插一个 continue_postfix（默认是一个空格），
        // 这里用这条消息真实的前缀，别把那个空格吃掉
        anchor.mes = `${continuePrefix(anchor.mes, base, text)}${text}`;
        normalizeMessageFields(anchor, snapshot, ctx);
        updateMessageInDom(ctx, anchorIndex, anchor);
        notifyRenderers(ctx, anchorIndex);
        const saved = await saveChatQuiet(ctx);
        removeSnapshot(snapshot.id);
        pendingSnapshot = null;
        toast(saved
            ? (thenPrompt ? promptToastText() : '已接回断点位置')
            : '已接回，但保存聊天失败 —— 先别刷新页面', saved ? 'success' : 'warning');
        if (thenPrompt) {
            sendResumePrompt();
        }
        return { mode: 'anchor', index: anchorIndex };
    }

    // 聊天里留着一条被中断的半截消息，而草稿是它的完整版 → 直接补全那条，不新增
    const extraIndex = snapshot.chatLen;
    const extra = chat.length === snapshot.chatLen + 1 ? chat[extraIndex] : null;
    const extraMes = extra && !extra.is_user ? String(extra.mes || '').trim() : '';
    // 这条占位一个正文字都没落（酒馆流式一开始 push 的空壳，刷新回来还在）→
    // 直接把草稿填进它，别在后面再追加一条，否则会留下「空壳 + 正文」两份
    const fillEmptyPlaceholder = Boolean(extra) && !extra.is_user && !extraMes;
    const canCompleteHalf = Boolean(extraMes) && text.startsWith(extraMes);

    if ((canCompleteHalf || fillEmptyPlaceholder) && extra) {
        extra.mes = text;
        normalizeMessageFields(extra, snapshot, ctx);
        updateMessageInDom(ctx, extraIndex, extra);
        notifyRenderers(ctx, extraIndex);
        const saved = await saveChatQuiet(ctx);
        removeSnapshot(snapshot.id);
        pendingSnapshot = null;
        toast(saved
            ? (fillEmptyPlaceholder ? '已把草稿填回那条空消息' : '已把草稿补进那条被中断的消息')
            : '已补进聊天，但保存聊天失败 —— 先别刷新页面', saved ? 'success' : 'warning');
        if (thenPrompt) {
            sendResumePrompt();
        }
        return { mode: 'completeHalf', index: extraIndex };
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
        notifyRenderers(ctx, chat.length - 1);
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
        return { mode: 'textarea', failed: true };
    }

    removeSnapshot(snapshot.id);
    pendingSnapshot = null;
    toast(thenPrompt ? promptToastText() : '已接回聊天', 'success');
    if (thenPrompt) {
        sendResumePrompt();
    }
    return { mode: 'append', index: chat.length - 1 };
}

/* ------------------------------------------------------------------ *
 * 设置面板
 * ------------------------------------------------------------------ */

const SETTINGS_HTML = `
<div class="inline-drawer-toggle inline-drawer-header">
    <b>Generation Guardian · 生成守护</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-up up"></div>
</div>
<div class="inline-drawer-content">
    <div class="gg-sheet">
        <div class="gg-fold" id="gg-theme-fold" aria-expanded="false">
            <button type="button" class="gg-fold-head" id="gg-fold-head">
                <span class="gg-fold-tag">主题</span>
                <span class="gg-fold-current" id="gg-fold-current">杏仁白</span>
                <span class="gg-fold-dots" id="gg-fold-dots" aria-hidden="true"></span>
                <i class="gg-fold-chev fa-solid fa-chevron-down"></i>
            </button>
            <div class="gg-fold-body">
                <div class="gg-fold-inner">
                    <div class="gg-themes" id="gg-themes"></div>
                </div>
            </div>
        </div>

        <div class="gg-fold gg-fold-plain" id="gg-switch-fold" aria-expanded="true">
            <button type="button" class="gg-fold-head" id="gg-switch-head">
                <span class="gg-fold-tag">开关</span>
                <i class="gg-fold-chev fa-solid fa-chevron-down"></i>
            </button>
            <div class="gg-fold-body">
                <div class="gg-fold-inner">
                    <label class="gg-check"><input type="checkbox" id="gg-set-enabled"><span>启用插件</span></label>
                    <label class="gg-check"><input type="checkbox" id="gg-set-block"><span>拦截刷新和关闭页面</span></label>
                    <label class="gg-check"><input type="checkbox" id="gg-set-ops"><span>拦住会刷新的扩展操作</span></label>
                    <label class="gg-check"><input type="checkbox" id="gg-set-autorestore"><span>被打断时自动接回</span></label>
                    <label class="gg-check"><input type="checkbox" id="gg-set-quiet"><span>安静模式</span></label>
                    <label class="gg-check"><input type="checkbox" id="gg-set-notify"><span>通知状态栏类扩展</span></label>
                    <label class="gg-check"><input type="checkbox" id="gg-set-badge"><span>魔杖菜单留一条入口</span></label>
                    <label class="gg-check"><input type="checkbox" id="gg-set-autosend"><span>续写后直接发送</span></label>
                </div>
            </div>
        </div>

        <div class="gg-fold gg-fold-plain" id="gg-prompt-fold" aria-expanded="false">
            <button type="button" class="gg-fold-head" id="gg-prompt-head">
                <span class="gg-fold-tag">续写指令</span>
                <i class="gg-fold-chev fa-solid fa-chevron-down"></i>
            </button>
            <div class="gg-fold-body">
                <div class="gg-fold-inner">
                    <textarea id="gg-set-prompt" class="text_pole gg-prompt" rows="3"></textarea>
                    <div class="gg-row">
                        <button type="button" class="gg-btn gg-mini" id="gg-set-preset-main">用主线指令</button>
                        <button type="button" class="gg-btn gg-mini" id="gg-set-preset-extra">用番外指令</button>
                    </div>
                    
                </div>
            </div>
        </div>

        <div class="gg-fold gg-fold-plain" id="gg-storage-fold" aria-expanded="false">
            <button type="button" class="gg-fold-head" id="gg-storage-head">
                <span class="gg-fold-tag">存储</span>
                <i class="gg-fold-chev fa-solid fa-chevron-down"></i>
            </button>
            <div class="gg-fold-body">
                <div class="gg-fold-inner">
                    <label class="gg-check gg-inline"><span>最多保留</span><input type="number" class="text_pole gg-num" id="gg-set-max" min="1" max="50" step="1"><span>条草稿</span></label>
                    <label class="gg-check gg-inline"><span>保留</span><input type="number" class="text_pole gg-num" id="gg-set-days" min="1" max="30" step="1"><span>天</span></label>
                    <label class="gg-check gg-inline"><span>卡住</span><input type="number" class="text_pole gg-num" id="gg-set-stall" min="0" max="600" step="5"><span>秒没字就提示</span></label>
                </div>
            </div>
        </div>

        <div class="gg-fold gg-fold-plain" id="gg-compat-fold" aria-expanded="false">
            <button type="button" class="gg-fold-head" id="gg-compat-head">
                <span class="gg-fold-tag">兼容状态</span>
                <span class="gg-count" id="gg-compat-count">0</span>
                <i class="gg-fold-chev fa-solid fa-chevron-down"></i>
            </button>
            <div class="gg-fold-body">
                <div class="gg-fold-inner">
                    <div id="gg-compat-list" class="gg-snap-list"></div>
                    
                </div>
            </div>
        </div>

        <div class="gg-fold gg-fold-plain" id="gg-snap-fold" aria-expanded="false">
            <button type="button" class="gg-fold-head" id="gg-snap-head">
                <span class="gg-fold-tag">已保存草稿</span>
                <span class="gg-count" id="gg-snap-count">0</span>
                <i class="gg-fold-chev fa-solid fa-chevron-down"></i>
            </button>
            <div class="gg-fold-body">
                <div class="gg-fold-inner">
                    <div id="gg-snap-list" class="gg-snap-list"></div>
                    <button type="button" id="gg-btn-clear" class="gg-btn gg-danger gg-full">清空全部草稿</button>
                    
                </div>
            </div>
        </div>

        <div class="gg-ver">
            <span>v<span id="gg-ver">1.3.19</span> · smyz1987 · MIT</span>
            <button type="button" class="gg-help" id="gg-help" title="再看一遍引导" aria-label="再看一遍引导"><i class="fa-solid fa-question"></i></button>
        </div>
    </div>
</div>`;

/* ------------------------------------------------------------------ *
 * 兼容状态：把「逐个读源码」得出的结论摆进面板
 *
 * 只列「会主动刷新页面」的那几个，其余（TopInfoBar / Timelines / Silence）
 * 查过是纯 UI，不刷新也不包装全局，没必要占地方。
 * ------------------------------------------------------------------ */

/* 按「装了哪个目录」来判定，不看 extension_settings 的 key ——
 * 那些 key 是历史残留，扩展删了也留着，拿它判在场会误报（本机实测 80 多个 key，
 * 真正装着的是 third-party 7 个 + data/default-user/extensions 里的一批）。 */
const KNOWN_INTERRUPT_SOURCES = [
    {
        name: 'Hot-Reload 热重载',
        dirs: ['SillyTavern-Extension-Hot-Reload'],
        note: '生成中它自己把重启延后到写完，不用管',
        autoReload: false,
    },
    {
        name: '柏宝箱 ST-BaiBai-Tools',
        dirs: ['ST-BaiBai-Tools'],
        note: '发现插件更新后点「更新」，约 1 秒自动刷新 —— 生成中会被我们拦下',
        autoReload: true,
    },
    {
        name: 'Mobile-Resize-Guard',
        dirs: ['SillyTavern-Mobile-Resize-Guard'],
        note: '和柏宝箱同一套代码，更新后约 1 秒自动刷新',
        autoReload: true,
    },
    {
        name: 'Self-Check 自检',
        dirs: ['SillyTavern-Self-Check'],
        note: '自检完约 0.9 秒自动刷新，刷新前草稿已经落盘',
        autoReload: true,
    },
    {
        name: 'Horae',
        dirs: ['SillyTavern-Horae'],
        note: '两处 0.8 秒自动刷新，还会临时包一层 fetch（我们不碰 fetch，不打架）',
        autoReload: true,
    },
    {
        name: 'JS-Slash-Runner 酒馆助手',
        dirs: ['JS-Slash-Runner'],
        note: '更新后 3 秒自动刷新；会重定义 window.parent/top，我们不碰这些',
        autoReload: true,
    },
    {
        name: 'persona-weaver 人设编织',
        dirs: ['st-persona-weaver'],
        note: '1.5 秒自动刷新',
        autoReload: true,
    },
    {
        name: 'titania-theater',
        dirs: ['titania-theater'],
        note: '0.5 秒自动刷新',
        autoReload: true,
    },
    {
        name: 'st-theater',
        dirs: ['st-theater'],
        note: '剧场更新后会刷新页面',
        autoReload: true,
    },
    {
        name: 'chajian 插件',
        dirs: ['chajian'],
        note: '0.5 秒自动刷新',
        autoReload: true,
    },
    {
        name: 'QR',
        dirs: ['QR'],
        note: '2 秒自动刷新',
        autoReload: true,
    },
    {
        name: 'TypingIndicator 主题',
        dirs: ['SillyTavern-TypingIndicatorThemes'],
        note: '切换主题时会刷新',
        autoReload: true,
    },
    {
        name: 'claude-web',
        dirs: ['claude-web'],
        note: '改布局 / 样式或点重载才刷新，拦不住 —— 靠落盘兜住',
        autoReload: true,
    },
    {
        name: 'story-oracle 故事神谕',
        dirs: ['story-oracle'],
        note: '「一键更新」成功后 5 秒刷新（提示可取消），5 秒够草稿写盘',
        autoReload: true,
    },
    {
        name: 'kimi 思维链注入',
        dirs: ['st-kimi-reasoning-injector'],
        note: '流式中会主动停止来截断，走「被中断」路径保住草稿',
        autoReload: false,
    },
];

/* 已装扩展目录名缓存：ST 的 /api/extensions/discover 是实时读目录的，比任何 key 都准 */
let installedDirCache = null;

async function installedDirs() {
    if (installedDirCache) {
        return installedDirCache;
    }
    let names = [];
    // 有的宿主环境把 fetch 只挂在 window 上（测试用的 jsdom 就是这样），
    // 所以两个位置都认，一个都拿不到就当成「读不到名单」，功能降级而不是报错。
    const fetcher = (typeof window !== 'undefined' && typeof window.fetch === 'function')
        ? window.fetch.bind(window)
        : (typeof fetch === 'function' ? fetch : null);
    if (fetcher) {
        try {
            const response = await fetcher('/api/extensions/discover');
            if (response && response.ok) {
                const list = await response.json();
                names = (Array.isArray(list) ? list : [])
                    .map((item) => String(item?.name || '').replace(/^third-party\//, ''))
                    .filter(Boolean);
            }
        } catch (error) {
            // 拿不到名单就当没装，绝不因此报错、也不影响其余功能
            names = [];
        }
    }
    installedDirCache = names;
    return names;
}

async function renderCompatSection() {
    const host = el('gg-compat-list');
    const counter = el('gg-compat-count');
    if (!host) {
        return;
    }
    let installed = [];
    try {
        installed = await installedDirs();
    } catch (error) {
        installed = [];
    }
    const lower = installed.map((name) => name.toLowerCase());
    const detected = KNOWN_INTERRUPT_SOURCES.filter((source) => source.dirs
        .some((dir) => lower.includes(dir.toLowerCase())));
    // 会自己刷新的排前面，别让真正要防的被纯 UI 的挤掉
    detected.sort((a, b) => Number(Boolean(b.autoReload)) - Number(Boolean(a.autoReload)));
    if (counter) {
        counter.textContent = String(detected.length);
    }
    host.textContent = '';
    const rows = detected.length
        ? detected
        : [{ name: '没检测到会自动刷新的扩展', note: '当前装的扩展里没有会自己 reload 的，放心玩' }];
    for (const row of rows) {
        const item = document.createElement('div');
        item.className = 'gg-snap-row';
        const info = document.createElement('div');
        info.className = 'gg-snap-info';
        const title = document.createElement('div');
        title.className = 'gg-snap-title';
        title.textContent = row.name;
        const sub = document.createElement('div');
        sub.className = 'gg-snap-sub';
        sub.textContent = row.note;
        info.append(title, sub);
        item.appendChild(info);
        host.appendChild(item);
    }
}

function mountSettings(retry = 0) {
    if (el('gg-settings')) {
        bindHelpButton();
        return;
    }
    // 面板不能等着扩展容器才出现：手机端那个容器可能根本没渲染出来，
    // 结果就是魔杖里点一下「什么都没发生」。所以先自建弹窗，面板总有个家。
    ensureModal();
    const host = el('extensions_settings2') || el('extensions_settings');
    const container = host || el('gg-modal-body');
    if (!container) {
        if (retry < 12) {
            setTimeout(() => mountSettings(retry + 1), 300);
        }
        return;
    }
    const wrapper = document.createElement('div');
    wrapper.id = 'gg-settings';
    wrapper.className = host ? 'inline-drawer' : 'gg-standalone';
    wrapper.innerHTML = SETTINGS_HTML;
    container.appendChild(wrapper);
    if (host) {
        mountExtEntry(host);
    }

    const s = settings();
    el('gg-set-enabled').checked = Boolean(s.enabled);
    el('gg-set-block').checked = Boolean(s.blockReload);
    el('gg-set-ops').checked = Boolean(s.blockExtensionOps);
    el('gg-set-badge').checked = Boolean(s.showBadge);
    el('gg-set-quiet').checked = s.quiet !== false;
    el('gg-set-notify').checked = s.notifyRenderers !== false;
    el('gg-set-autosend').checked = Boolean(s.autoSend);
    el('gg-set-autorestore').checked = Boolean(s.autoRestore);
    el('gg-set-prompt').value = resumePromptText();
    el('gg-set-max').value = String(maxSnapshots());
    el('gg-set-days').value = String(keepDays());
    el('gg-set-stall').value = String(Math.round(stallMs() / 1000));
    el('gg-ver').textContent = VERSION;
    bindHelpButton();
    renderCompatSection();
    syncExtEntry();

    /* 收起那一行里的小巧思：八颗点就是八套配色本身，横着排成一条调色盘。
       底色太接近，光靠主色分不出八套（她原话「好几个颜色还一样」），
       所以每颗点做成「底色打底 + 主色内芯」的双色小圆 —— 两个色一起报身份。
       当前那套长出一圈同色环并放大一点。 */
    const renderThemeFold = () => {
        const current = themeKey();
        const theme = THEMES[current];
        const label = el('gg-fold-current');
        if (label) {
            label.textContent = theme?.label || '';
        }
        const dots = el('gg-fold-dots');
        if (!dots) {
            return;
        }
        dots.textContent = '';
        for (const [key, item] of Object.entries(THEMES)) {
            const dot = document.createElement('span');
            dot.className = 'gg-fold-dot';
            dot.style.setProperty('--b', item.swatches[0]);
            dot.style.setProperty('--d', item.swatches[1]);
            dot.dataset.active = String(key === current);
            dot.title = `${item.label} ${item.en}`;
            dots.appendChild(dot);
        }
    };

    const renderThemes = () => {
        const host = el('gg-themes');
        if (!host) {
            return;
        }
        host.textContent = '';
        const current = themeKey();
        let index = 0;
        for (const [key, theme] of Object.entries(THEMES)) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'gg-theme';
            btn.dataset.theme = key;
            btn.style.setProperty('--gg-i', String(index));
            index += 1;
            btn.setAttribute('aria-pressed', String(key === current));
            btn.title = `${theme.label} / ${theme.en}`;

            const dots = document.createElement('span');
            dots.className = 'gg-theme-dots';
            for (const color of theme.swatches) {
                const dot = document.createElement('i');
                dot.style.background = color;
                dots.appendChild(dot);
            }
            const name = document.createElement('span');
            name.className = 'gg-theme-name';
            name.textContent = theme.label;

            btn.appendChild(dots);
            btn.appendChild(name);
            btn.addEventListener('click', () => {
                s.theme = key;
                persistSettings();
                applyTheme();
                renderThemes();
                renderThemeFold();
            });
            host.appendChild(btn);
        }
    };
    renderThemes();
    renderThemeFold();

    // 六块内容全部折成一行，只有「开关」默认展开 —— 最常用的那几项不用多点一下
    for (const [rootId, headId] of [
        ['gg-theme-fold', 'gg-fold-head'],
        ['gg-switch-fold', 'gg-switch-head'],
        ['gg-prompt-fold', 'gg-prompt-head'],
        ['gg-storage-fold', 'gg-storage-head'],
        ['gg-compat-fold', 'gg-compat-head'],
        ['gg-snap-fold', 'gg-snap-head'],
    ]) {
        const root = el(rootId);
        const head = el(headId);
        head?.addEventListener('click', () => {
            const open = root?.getAttribute('aria-expanded') === 'true';
            root?.setAttribute('aria-expanded', String(!open));
        });
    }

    el('gg-set-enabled').addEventListener('change', (event) => {
        s.enabled = Boolean(event.target.checked);
        if (!s.enabled) {
            generating = false;
            buffer = null;
            clearStallWatch();
            settlePostGenerationGuard();
            updateBadge('');
            hidePanel();
        }
        persistSettings();
    });
    el('gg-set-block').addEventListener('change', (event) => {
        s.blockReload = Boolean(event.target.checked);
        if (!s.blockReload) {
            settlePostGenerationGuard();
        } else if (generating || Date.now() < postGenGuardUntil) {
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
    el('gg-set-autosend').addEventListener('change', (event) => {
        s.autoSend = Boolean(event.target.checked);
        persistSettings();
    });
    el('gg-set-autorestore').addEventListener('change', (event) => {
        s.autoRestore = Boolean(event.target.checked);
        persistSettings();
    });
    el('gg-set-ops').addEventListener('change', (event) => {
        s.blockExtensionOps = Boolean(event.target.checked);
        persistSettings();
    });
    el('gg-set-quiet').addEventListener('change', (event) => {
        s.quiet = Boolean(event.target.checked);
        persistSettings();
    });
    el('gg-set-notify').addEventListener('change', (event) => {
        s.notifyRenderers = Boolean(event.target.checked);
        persistSettings();
    });
    el('gg-set-badge').addEventListener('change', (event) => {
        s.showBadge = Boolean(event.target.checked);
        updateBadge(generating ? `已保存 ${String(buffer?.text || '').length} 字` : '');
        persistSettings();
    });
    const bindNumber = (id, key, min, max, fallback, after) => {
        const input = el(id);
        input.addEventListener('change', (event) => {
            const value = clampNumber(event.target.value, min, max, fallback);
            s[key] = value;
            event.target.value = String(value);
            persistSettings();
            after?.(value);
        });
    };
    bindNumber('gg-set-max', 'maxSnapshots', 1, 50, MAX_SNAPSHOTS, () => {
        writeAll(readAll());
        refreshSnapList();
    });
    bindNumber('gg-set-days', 'keepDays', 1, 30, 3, () => {
        writeAll(readAll());
        refreshSnapList();
    });
    bindNumber('gg-set-stall', 'stallSeconds', 0, 600, STALL_WATCHDOG_MS / 1000, () => {
        if (generating) {
            armStallWatch();
        }
    });
    const applyPreset = (text, label) => {
        s.resumePrompt = text;
        el('gg-set-prompt').value = text;
        persistSettings();
        toast(`续写指令已换成「${label}」`, 'info');
    };
    el('gg-set-preset-main').addEventListener('click', () => applyPreset(RESUME_PRESETS.main, '主线'));
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
        sub.textContent = snapshot.endedCleanly
            ? `备份 · 这一轮已正常写完 · ${snapshot.text.length} 字`
            : `${typeLabel(snapshot.type)} · ${snapshot.text.length} 字`;
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
        const result = scanForRecovery(options);
        if (result && typeof result.catch === 'function') {
            result.catch((error) => console.warn(TAG, 'scan failed', error));
        }
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
    eventTypesRef = events;
    eventSourceRef = ctx.eventSource;

    try {
        // 每个 handler 都套一层 try/catch：我这里抛异常会顺着酒馆的事件链往上炸，
        // 影响别的扩展甚至影响聊天本身。绝不能让它发生。
        const bind = (name, handler) => ctx.eventSource.on(name, (...args) => {
            try {
                handler(...args);
            } catch (error) {
                console.warn(TAG, 'handler failed', name, error);
            }
        });
        bind(events.GENERATION_STARTED, onGenerationStarted);
        bind(events.STREAM_TOKEN_RECEIVED, onStreamToken);
        bind(events.GENERATION_STOPPED, () => onGenerationFinished('stopped'));
        bind(events.GENERATION_ENDED, () => onGenerationFinished('ended'));
        bind(events.CHAT_CHANGED, () => {
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
    document.addEventListener('click', guardExtensionUpdateClick, true);

    ensureUI();
    watchWandMenu();
    registerSlashCommand();
    applyTheme();
    mountSettings();
    // 让刷新/重载后的恢复卡片晚一点出现，等聊天先渲染完
    setTimeout(scanForRecoverySafe, 600);

    // 第一次用的话，带一遍引导；看过了就再也不主动弹
    setTimeout(() => {
        try {
            if (!settings().guideSeen) {
                openGuide();
            }
        } catch (error) {
            console.warn(TAG, 'guide failed', error);
        }
    }, 900);

    window.GenerationGuardian = {
        version: VERSION,
        settings: settings,
        snapshots: readAll,
        /** 内存里正在写的这条草稿（localStorage 写不进去时的逃生口，复制即可救回） */
        liveDraft: () => (buffer ? String(buffer.text || '') : ''),
        isGenerating: () => activelyGenerating(),
        unloadMessage: unloadMessage,
        openPanel: openPanel,
        openSettings: openSettingsDrawer,
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
