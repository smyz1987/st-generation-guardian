/**
 * Generation Guardian 测试沙盒
 *
 * 用 jsdom 造一个假的 SillyTavern 环境，把扩展从「流式中断」到「重载恢复 +
 * 手动续写」的整条链路真跑一遍。扩展源码会被复制到 sandbox 里，保证测试跑的是
 * 仓库里真实的那份 index.js（相对 import 路径与真实酒馆一致）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { extension_settings as extensionSettingsStub } from './sandbox/scripts/extensions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const sandboxExtension = path.join(__dirname, 'sandbox', 'scripts', 'extensions', 'third-party', 'gen', 'index.js');
const STORE_KEY = 'genGuardian.snapshots.v1';

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

let passed = 0;
const failures = [];

function ok(name, condition, detail = '') {
    if (condition) {
        passed += 1;
        console.log(`  ✓ ${name}`);
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
        console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

function eq(name, actual, expected) {
    ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ *
 * 假 localStorage（跨「重载」持久）
 * ------------------------------------------------------------------ */

function makeStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => void map.set(key, String(value)),
        removeItem: (key) => void map.delete(key),
        clear: () => map.clear(),
        key: (index) => Array.from(map.keys())[index] ?? null,
        get length() {
            return map.size;
        },
        __dump: () => Object.fromEntries(map),
    };
}

const storage = makeStorage();

/* ------------------------------------------------------------------ *
 * 事件总线（对应 ST 的 eventSource，on/emit 足够）
 * ------------------------------------------------------------------ */

const EVENT_TYPES = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    GENERATION_STARTED: 'generation_started',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended',
    STREAM_TOKEN_RECEIVED: 'stream_token_received',
};

function makeEventSource() {
    const handlers = new Map();
    return {
        on(name, handler) {
            if (!handlers.has(name)) {
                handlers.set(name, []);
            }
            handlers.get(name).push(handler);
        },
        removeListener(name, handler) {
            const list = handlers.get(name) || [];
            const index = list.indexOf(handler);
            if (index >= 0) {
                list.splice(index, 1);
            }
        },
        async emit(name, ...args) {
            for (const handler of [...(handlers.get(name) || [])]) {
                await handler(...args);
            }
        },
    };
}

/* ------------------------------------------------------------------ *
 * 假 SillyTavern 环境
 * ------------------------------------------------------------------ */

let consoleIssues = [];
const realWarn = console.warn.bind(console);
const realError = console.error.bind(console);

function captureConsole() {
    consoleIssues = [];
    console.warn = (...args) => {
        consoleIssues.push(['warn', args.map(String).join(' ')]);
        realWarn(...args);
    };
    console.error = (...args) => {
        consoleIssues.push(['error', args.map(String).join(' ')]);
        realError(...args);
    };
}

function restoreConsole() {
    console.warn = realWarn;
    console.error = realError;
    return consoleIssues;
}

function defineGlobal(name, value) {
    Object.defineProperty(globalThis, name, {
        value,
        configurable: true,
        writable: true,
        enumerable: false,
    });
}

/**
 * 造一个全新的酒馆窗口（相当于浏览器刷新）
 */
function createWorld({ chat, chatId = 'ChatA', name2 = '沈砚' } = {}) {
    const dom = new JSDOM(`<!DOCTYPE html><html><body>
        <div id="chat"></div>
        <textarea id="send_textarea"></textarea>
        <div id="extensions_settings2"></div>
        <div id="continue_button"></div>
    </body></html>`, { url: 'http://localhost:8000/' });

    const { window } = dom;
    defineGlobal('window', window);
    defineGlobal('document', window.document);
    defineGlobal('navigator', window.navigator);
    defineGlobal('Event', window.Event);
    defineGlobal('HTMLElement', window.HTMLElement);
    defineGlobal('localStorage', storage);
    defineGlobal('toastr', {
        info: (m) => console.log(`    [toast:info] ${m}`),
        success: (m) => console.log(`    [toast:success] ${m}`),
        warning: (m) => console.log(`    [toast:warning] ${m}`),
        error: (m) => console.log(`    [toast:error] ${m}`),
    });

    const eventSource = makeEventSource();
    const calls = { addOneMessage: 0, saveChat: 0, generate: [], updateMessageBlock: 0, deleteMessage: 0 };

    const ctx = {
        chat,
        chatId,
        name2,
        characterId: 0,
        groupId: null,
        characters: [{ chat: chatId }],
        groups: [],
        eventSource,
        eventTypes: EVENT_TYPES,
        extensionSettings: {},
        saveSettingsDebounced: () => {},
        saveChat: async () => {
            calls.saveChat += 1;
        },
        scrollChatToBottom: () => {},
        generate: (type) => {
            calls.generate.push(type);
            return Promise.resolve();
        },
        addOneMessage: (message, options) => {
            calls.addOneMessage += 1;
            const node = window.document.createElement('div');
            node.className = 'mes';
            node.dataset.mesid = String(chat.indexOf(message));
            node.textContent = message.mes;
            window.document.getElementById('chat').appendChild(node);
            return node;
        },
        updateMessageBlock: (index, message) => {
            calls.updateMessageBlock += 1;
            const node = window.document.querySelector(`.mes[mesid="${index}"]`);
            if (node) {
                node.textContent = message.mes;
            }
        },
        deleteMessage: () => {
            calls.deleteMessage += 1;
        },
        __calls: calls,
        __window: window,
        __dom: dom,
    };

    globalThis.__ST = ctx;
    // 默认按「手动接回」模式跑，只有专门测自动补回的场景才打开 autoRestore
    if (!extensionSettingsStub['generation-guardian']) {
        extensionSettingsStub['generation-guardian'] = { autoRestore: false };
    }
    return ctx;
}

let importCounter = 0;

async function bootExtension() {
    // 每次都用不同的 query 让 Node 重新执行模块，模拟页面重载后内存状态清空
    importCounter += 1;
    return import(`file://${sandboxExtension.replace(/\\/g, '/')}?boot=${importCounter}`);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalReady(ctx) {
    return ctx.eventSource.emit(EVENT_TYPES.APP_READY);
}

function readSnapshots() {
    const raw = storage.getItem(STORE_KEY);
    return raw ? JSON.parse(raw) : [];
}

function panelVisible() {
    const panel = document.getElementById('gg-panel');
    return Boolean(panel) && !panel.classList.contains('gg-hidden');
}

function panelText() {
    const meta = document.getElementById('gg-recover-meta');
    const preview = document.getElementById('gg-recover-preview');
    return `${meta?.textContent || ''}\n${preview?.textContent || ''}`;
}

function makeChat() {
    return [
        { name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' },
        { name: '易湘琪', is_user: true, is_system: false, mes: '你抬头了吗', send_date: '2026-11-13T08:01:00.000Z' },
    ];
}

function pagehide(ctx) {
    ctx.__window.dispatchEvent(new ctx.__window.Event('pagehide'));
}

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

async function scenarioReloadAndResume() {
    console.log('\n[1] 流式中断 → 重载 → 恢复卡片 → 恢复');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    const mod = await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    const b1 = document.getElementById('gg-badge');
    ok('生成开始后出现状态徽标', b1 && !b1.classList.contains('gg-hidden'));

    // 模拟 beforeunload：生成中应该被拦下
    const unload = new ctx.__window.Event('beforeunload', { cancelable: true });
    ctx.__window.dispatchEvent(unload);
    ok('生成中拦截刷新（beforeunload 被 preventDefault）', unload.defaultPrevented);

    for (const token of ['她抬起头', '她抬起头，', '她抬起头，看着你笑了。', '她抬起头，看着你笑了。\n*“等很久了吧。”*']) {
        await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, token);
    }
    eq('徽标显示累计字数', document.getElementById('gg-badge-text').textContent, `生成守护：已保存 ${'她抬起头，看着你笑了。\n*“等很久了吧。”*'.length} 字 · 别刷新`);

    // 页面被杀（pagehide 时同步落盘）
    pagehide(ctx);
    const dumped = readSnapshots();
    eq('草稿已落盘 1 条', dumped.length, 1);
    eq('草稿内容完整', dumped[0]?.text, '她抬起头，看着你笑了。\n*“等很久了吧。”*');
    eq('记录了生成类型', dumped[0]?.type, 'normal');
    eq('记录了锚点长度', dumped[0]?.chatLen, 2);

    // ---------- 模拟刷新：全新窗口 + 全新模块实例，但 localStorage 还在 ----------
    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(900);
    ok('重载后自动弹出恢复卡片', panelVisible(), panelText());
    ok('卡片里显示字数', panelText().includes('字'), panelText());

    document.getElementById('gg-btn-recover').click();
    await sleep(60);
    eq('草稿被写回聊天（新增一条消息）', chat.length, 3);
    eq('消息内容就是草稿', chat[2]?.mes, '她抬起头，看着你笑了。\n*“等很久了吧。”*');
    eq('调用了 addOneMessage 渲染', ctx2.__calls.addOneMessage, 1);
    eq('调用了 saveChat 落盘', ctx2.__calls.saveChat, 1);
    eq('「接回」不发任何新请求', ctx2.__calls.generate.length, 0);
    eq('恢复后草稿被清掉', readSnapshots().length, 0);
    ok('恢复后卡片收起', !panelVisible());
    eq('补上了 swipe_id', chat[2]?.swipe_id, 0);
    ok('补上了 swipes', Array.isArray(chat[2]?.swipes) && chat[2].swipes.length === 1, JSON.stringify(chat[2]?.swipes));
    ok('补上了 swipe_info', Array.isArray(chat[2]?.swipe_info) && chat[2].swipe_info.length === 1);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
    ok('调试入口暴露了 1.3.1 版本号', window.GenerationGuardian?.version === '1.3.1');
}

async function scenarioNormalCompletionKeepsNothing() {
    console.log('\n[2] 正常生成完成 → 不留草稿、不弹卡片');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '这是一段完整的回复，内容足够长以至于能验证判定逻辑。');
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '这是一段完整的回复，内容足够长以至于能验证判定逻辑。后面还有一点。');

    chat.push({
        name: '沈砚',
        is_user: false,
        is_system: false,
        mes: '这是一段完整的回复，内容足够长以至于能验证判定逻辑。后面还有一点。',
        send_date: '2026-11-13T08:02:00.000Z',
    });
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_ENDED, chat.length);
    await sleep(50);

    eq('正常完成后不残留草稿', readSnapshots().length, 0);
    ok('正常完成后不弹恢复卡片', !panelVisible());
    ok('徽标收起', document.getElementById('gg-badge').classList.contains('gg-hidden'));

    const unloadAfter = new ctx.__window.Event('beforeunload', { cancelable: true });
    ctx.__window.dispatchEvent(unloadAfter);
    ok('生成结束后不再拦截刷新', !unloadAfter.defaultPrevented);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioContinueType() {
    console.log('\n[3] 「继续生成」中断 → 恢复到原消息而不是新增一条');
    captureConsole();
    storage.clear();

    const chat = [
        { name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' },
        { name: '易湘琪', is_user: true, is_system: false, mes: '继续', send_date: '2026-11-13T08:01:00.000Z' },
        { name: '沈砚', is_user: false, is_system: false, mes: '前半段。', send_date: '2026-11-13T08:02:00.000Z' },
    ];
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'continue', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '后半段补上来了。');
    pagehide(ctx);

    const dumped = readSnapshots();
    eq('continue 草稿已落盘', dumped.length, 1);
    eq('记录了 baseMes', dumped[0]?.baseMes, '前半段。');

    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(900);

    document.getElementById('gg-btn-recover').click();
    await sleep(60);
    eq('没有新增消息', chat.length, 3);
    eq('拼回原消息', chat[2]?.mes, '前半段。后半段补上来了。');
    eq('「接回」不再发任何请求', ctx2.__calls.generate.length, 0);
    eq('调用了 updateMessageBlock 重渲染', ctx2.__calls.updateMessageBlock, 1);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioSwipeGoesToTextarea() {
    console.log('\n[4] 「换一条」中断 → 只能放回输入框');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'swipe', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '另一种写法的开头');
    pagehide(ctx);

    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(900);

    ok('弹出恢复卡片', panelVisible());
    ok('隐藏了「续写」按钮', document.getElementById('gg-btn-recover-write').classList.contains('gg-hidden'));
    ok('隐藏了「接回」按钮', document.getElementById('gg-btn-recover').classList.contains('gg-hidden'));

    document.getElementById('gg-btn-textarea').click();
    await sleep(40);
    eq('内容进了输入框', document.getElementById('send_textarea').value, '另一种写法的开头');
    eq('没有触发生成', ctx2.__calls.generate.length, 0);
    eq('草稿被清掉', readSnapshots().length, 0);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioChatMovedOn() {
    console.log('\n[5] 中断后又发了新消息 → 不再弹过期草稿');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '被打断的半截回复');
    pagehide(ctx);

    chat.push({ name: '易湘琪', is_user: true, is_system: false, mes: '第二条', send_date: '2026-11-13T08:05:00.000Z' });

    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(900);

    ok('不弹过期的恢复卡片', !panelVisible(), panelText());
    eq('草稿仍然保留在本地（不主动删用户数据）', readSnapshots().length, 1);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioOtherChatIgnored() {
    console.log('\n[6] 草稿属于别的聊天 → 不出卡片');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat, chatId: 'ChatA' });

    await bootExtension();
    await signalReady(ctx);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '聊天A的草稿');
    pagehide(ctx);

    const ctx2 = createWorld({ chat, chatId: 'ChatB' });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(900);

    ok('切到别的聊天不弹卡片', !panelVisible());
    eq('别的聊天的草稿不会被删', readSnapshots().length, 1);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioSettingsPanel() {
    console.log('\n[7] 设置面板渲染与草稿清单');
    captureConsole();
    storage.clear();

    const chat = [{ name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' }];
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);
    await sleep(50);

    const host = document.getElementById('extensions_settings2');
    ok('设置面板挂到了扩展设置区', Boolean(host.querySelector('#gg-settings')));
    ok('是酒馆标准的可折叠抽屉条目', Boolean(host.querySelector('#gg-settings .inline-drawer-toggle')) && Boolean(host.querySelector('#gg-settings .inline-drawer-content')));
    ok('抽屉标题就是扩展名', host.querySelector('#gg-settings .inline-drawer-header b').textContent.includes('Generation Guardian'));
    ok('有启用开关', Boolean(document.getElementById('gg-set-enabled')));
    ok('有「拦截刷新」开关', Boolean(document.getElementById('gg-set-block')));
    ok('有「拦住会刷新的扩展操作」开关', Boolean(document.getElementById('gg-set-ops')));
    ok('有「显示徽标」开关', Boolean(document.getElementById('gg-set-badge')));
    ok('有「被打断自动补回聊天」开关', Boolean(document.getElementById('gg-set-autorestore')));
    ok('主线指令按钮文案改对了', document.getElementById('gg-set-preset-main').textContent === '用主线指令');
    ok('有「续写直接发送」开关', Boolean(document.getElementById('gg-set-autosend')));
    ok('有保留条数设置', Boolean(document.getElementById('gg-set-max')));
    ok('有保留天数设置', Boolean(document.getElementById('gg-set-days')));
    ok('有卡住提示秒数设置', Boolean(document.getElementById('gg-set-stall')));
    eq('面板里显示版本号', document.getElementById('gg-ver').textContent, '1.3.1');
    ok('指令框默认是剧情指令', document.getElementById('gg-set-prompt').value.startsWith('继续生成上一轮剧情'));

    eq('主题选择器有四套', document.querySelectorAll('#gg-themes .gg-theme').length, 4);
    ok('默认选中特里亚农', document.querySelector('#gg-themes .gg-theme[data-theme="trianon"]').getAttribute('aria-pressed') === 'true');
    ok('body 上挂了默认主题 class', document.body.classList.contains('gg-theme-trianon'));
    ok('四套主题名都在（特里亚农/雪暮/霓虹街/霜岸）',
        ['trianon', 'dusk', 'neon', 'frost'].every((key) => document.querySelector(`#gg-themes .gg-theme[data-theme="${key}"] .gg-theme-name`).textContent.length >= 2));

    document.querySelector('#gg-themes .gg-theme[data-theme="neon"]').click();
    ok('点霓虹街切过去', document.body.classList.contains('gg-theme-neon'));
    ok('切过去后旧主题 class 被摘掉', !document.body.classList.contains('gg-theme-trianon'));
    ok('选中态跟着变', document.querySelector('#gg-themes .gg-theme[data-theme="neon"]').getAttribute('aria-pressed') === 'true');
    eq('主题写进设置', extensionSettingsStub['generation-guardian'].theme, 'neon');

    document.querySelector('#gg-themes .gg-theme[data-theme="frost"]').click();
    ok('再切霜岸也生效', document.body.classList.contains('gg-theme-frost'));
    eq('主题写进设置（第二次）', extensionSettingsStub['generation-guardian'].theme, 'frost');

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '清单里的草稿内容');
    pagehide(ctx);
    eq('清单计数更新', document.getElementById('gg-snap-count').textContent, '1');
    ok('清单里有条目', document.getElementById('gg-snap-list').children.length >= 1);

    document.getElementById('gg-btn-clear').click();
    eq('清空后计数为 0', document.getElementById('gg-snap-count').textContent, '0');
    eq('清空后本地也没有了', readSnapshots().length, 0);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioResumePrompt() {
    console.log('\n[8] 点「续写」→ 替你发一条续写指令');
    captureConsole();
    storage.clear();
    extensionSettingsStub['generation-guardian'] = {
        enabled: true,
        blockReload: true,
        autoRestore: false,
        resumePrompt: '继续生成上一个番外，衔接上文末尾，不要从头开始。',
    };

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '他刚要开口，就被打断了。');
    pagehide(ctx);

    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(700);

    ok('卡片弹出', panelVisible());
    ok('卡片里没有倒计时', !(document.getElementById('gg-recover-foot').textContent || '').includes('秒后'));
    eq('续写按钮就叫「续写」', document.getElementById('gg-btn-recover-write').textContent, '续写');
    eq('接回按钮就叫「接回」', document.getElementById('gg-btn-recover').textContent, '接回');

    document.getElementById('gg-btn-recover-write').click();
    await sleep(80);
    eq('草稿写回聊天', chat.length, 3);
    eq('只发了一次普通请求（不是 continue）', ctx2.__calls.generate.join(','), 'normal');
    eq('输入框里就是那条指令', document.getElementById('send_textarea').value, '继续生成上一个番外，衔接上文末尾，不要从头开始。');
    eq('草稿已清掉', readSnapshots().length, 0);

    document.getElementById('gg-btn-recover-write').click();
    await sleep(40);
    eq('重复点击不会再发请求', ctx2.__calls.generate.length, 1);

    delete extensionSettingsStub['generation-guardian'];

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioGuardReloadClicks() {
    console.log('\n[9] 生成中拦住会刷新页面的扩展管理操作');
    captureConsole();
    storage.clear();

    const chat = [{ name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' }];
    const ctx = createWorld({ chat });

    const menu = document.createElement('div');
    menu.id = 'extensions_menu';
    menu.innerHTML = `<div class="extensions_info"><div class="extension_block" data-name="third-party/foo">
        <span class="extension_name">Foo</span>
        <span class="toggle_disable">禁用</span>
        <span class="btn_update">更新</span>
        <span class="btn_clean">清理</span>
    </div></div>`;
    document.body.appendChild(menu);

    let bubbled = 0;
    document.addEventListener('click', () => {
        bubbled += 1;
    });

    await bootExtension();
    await signalReady(ctx);

    document.querySelector('.toggle_disable').click();
    await sleep(20);
    eq('不在生成时，点击照常交给酒馆处理', bubbled, 1);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    document.querySelector('.btn_update').click();
    await sleep(20);
    eq('生成中点「更新」被就地拦下', bubbled, 1);

    document.querySelector('.toggle_disable').click();
    await sleep(20);
    eq('生成中点「禁用」也被拦下', bubbled, 1);

    document.querySelector('.btn_clean').click();
    await sleep(20);
    eq('生成中点「清理」也被拦下', bubbled, 1);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_ENDED, chat.length);
    await sleep(30);
    document.querySelector('.btn_update').click();
    await sleep(20);
    eq('生成结束后恢复正常', bubbled, 2);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioHalfCutMessage() {
    console.log('\n[10] 酒馆留下半截消息 → 「接回」补全那条，不新增');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    const full = '她抬起头，看着你笑了。\n*“等很久了吧。”*';
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, full);
    // ST 被打断时把半截正文留在了聊天里
    chat.push({
        name: '沈砚',
        is_user: false,
        is_system: false,
        mes: '她抬起头，看着你笑了。',
        send_date: '2026-11-13T08:02:00.000Z',
    });
    pagehide(ctx);

    const dumped = readSnapshots();
    eq('完整草稿仍然保留（没被半截消息顶掉）', dumped.length, 1);
    eq('存的是完整版', dumped[0]?.text, full);

    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(900);

    ok('识别出「这是被打断的那一条」并弹卡片', panelVisible(), panelText());
    ok('卡片没被当成过期草稿删掉', readSnapshots().length === 1);

    document.getElementById('gg-btn-recover').click();
    await sleep(60);
    eq('没有新增消息', chat.length, 3);
    eq('那条半截被补成完整版', chat[2]?.mes, full);
    eq('重渲染了那条消息', ctx2.__calls.updateMessageBlock, 1);
    eq('草稿被清掉', readSnapshots().length, 0);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioImpersonateCompletion() {
    console.log('\n[11] 「替我说话」正常完成 → 不留草稿（旧版会误留）');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'impersonate', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '我想说的话。');
    chat.push({ name: '易湘琪', is_user: true, is_system: false, mes: '我想说的话。', send_date: '2026-11-13T08:03:00.000Z' });
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_ENDED, chat.length);
    await sleep(60);

    eq('替我说话正常完成不留草稿', readSnapshots().length, 0);
    ok('也不弹卡片', !panelVisible());
    eq('消息在聊天里', chat.length, 3);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level])=> level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioMissedGenerationStarted() {
    console.log('\n[12] 没收到 GENERATION_STARTED 也照样存');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    // 只来 token，不来 started（扩展加载晚 / 事件丢失）
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '没有开始事件也要把这段存下来。');
    pagehide(ctx);

    const dumped = readSnapshots();
    eq('仍然落盘了 1 条', dumped.length, 1);
    eq('内容完整', dumped[0]?.text, '没有开始事件也要把这段存下来。');
    eq('标了 adopted', dumped[0]?.adopted, true);
    eq('锚点按 token 到达时的长度记录', dumped[0]?.chatLen, 2);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioDuplicateStarted() {
    console.log('\n[13] 同一次生成重复收到开始事件 → 不清空已攒的草稿');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '第一段已经生成好了。');
    await sleep(900);
    eq('第一次落盘成功', readSnapshots().length, 1);

    // 重复的开始事件
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    pagehide(ctx);
    const dumped = readSnapshots();
    eq('没有多出一条草稿', dumped.length, 1);
    eq('已有内容没被清空', dumped[0]?.text, '第一段已经生成好了。');

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioStorageQuota() {
    console.log('\n[14] localStorage 写满 → 驱逐旧草稿，保住当前这条');
    captureConsole();
    storage.clear();

    const chat = [{ name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' }];
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    const old = [
        { id: 'old-1', chatKey: 'OtherChat', text: '旧草稿一', type: 'normal', chatLen: 1, startedAt: Date.now() - 300000, updatedAt: Date.now() - 300000 },
        { id: 'old-2', chatKey: 'OtherChat', text: '旧草稿二', type: 'normal', chatLen: 1, startedAt: Date.now() - 200000, updatedAt: Date.now() - 200000 },
    ];
    storage.setItem(STORE_KEY, JSON.stringify(old));

    const realSet = storage.setItem;
    let quotaHit = false;
    storage.setItem = (key, value) => {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) && parsed.length >= 3) {
            quotaHit = true;
            throw new Error('QuotaExceededError');
        }
        realSet(key, value);
    };

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '当前这条新的草稿内容');
    pagehide(ctx);

    storage.setItem = realSet;
    const after = readSnapshots();
    ok('确实触发了配额失败', quotaHit);
    ok('驱逐旧草稿后新草稿仍然写了进去', after.some((item) => item.text === '当前这条新的草稿内容'), JSON.stringify(after.map((i) => i.id)));

    const issues = restoreConsole();
    ok('没有抛出未捕获异常', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioPromptSendFailure() {
    console.log('\n[15] 「续写」发送失败 → 指令回填输入框，不会凭空消失');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '刚要开口就被打断了。');
    pagehide(ctx);

    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(700);
    ok('卡片弹出', panelVisible());

    // 模拟 Generate 已经清空输入框，然后请求失败
    ctx2.generate = (type) => {
        ctx2.__calls.generate.push(type);
        document.getElementById('send_textarea').value = '';
        return Promise.reject(new Error('boom'));
    };

    document.getElementById('gg-btn-recover-write').click();
    await sleep(120);

    eq('草稿写回聊天', chat.length, 3);
    eq('先发了一次 normal', ctx2.__calls.generate.join(','), 'normal');
    ok('输入框里还有那条指令（没丢）', document.getElementById('send_textarea').value.startsWith('继续生成上一轮剧情'));

    const issues = restoreConsole();
    ok('没有发给用户看的 error 日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioSaveChatFailure() {
    console.log('\n[16] 保存聊天失败 → 消息不丢、不发空请求');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '这条要写回聊天。');
    pagehide(ctx);

    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(700);

    ctx2.saveChat = async () => {
        throw new Error('disk full');
    };

    document.getElementById('gg-btn-recover').click();
    await sleep(80);

    eq('消息照样在聊天里', chat.length, 3);
    eq('内容正确', chat[2]?.mes, '这条要写回聊天。');
    eq('没发新请求', ctx2.__calls.generate.length, 0);

    const issues = restoreConsole();
    ok('保存失败没有炸出异常', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioPromptFillOnly() {
    console.log('\n[17] 关掉「直接发送」→ 点「续写」只把指令填进输入框，等你按发送');
    captureConsole();
    storage.clear();
    extensionSettingsStub['generation-guardian'] = {
        enabled: true,
        blockReload: true,
        autoRestore: false,
        resumePrompt: '继续生成上一轮剧情，衔接上文末尾，不要从头开始。',
        autoSend: false,
    };

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '他刚要开口，就被打断了。');
    pagehide(ctx);

    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(700);
    ok('卡片弹出', panelVisible());
    eq('设置里默认勾着「直接发送」以外的状态被读到', document.getElementById('gg-set-autosend').checked, false);

    document.getElementById('gg-btn-recover-write').click();
    await sleep(80);

    eq('草稿照样接回聊天', chat.length, 3);
    eq('没有替你发请求', ctx2.__calls.generate.length, 0);
    eq('指令在输入框里等你改', document.getElementById('send_textarea').value, '继续生成上一轮剧情，衔接上文末尾，不要从头开始。');

    delete extensionSettingsStub['generation-guardian'];

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioStaleGenerationRelease() {
    console.log('\n[18] 生成状态卡死 5 分钟后自动解锁（不再挡路）');
    captureConsole();
    storage.clear();

    const chat = makeChat();
    const ctx = createWorld({ chat });

    const menu = document.createElement('div');
    menu.id = 'extensions_menu';
    menu.innerHTML = `<div class="extensions_info"><div class="extension_block" data-name="third-party/bar">
        <span class="btn_update">更新</span>
    </div></div>`;
    document.body.appendChild(menu);

    let hits = 0;
    document.querySelector('.btn_update').addEventListener('click', () => {
        hits += 1;
    });

    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '半截内容');
    document.querySelector('.btn_update').click();
    eq('正在出字时，点「更新」被拦下', hits, 0);
    eq('对外报告的是「真的在生成」', window.GenerationGuardian.isGenerating(), true);

    // 时间往前推 6 分钟：模拟 GENERATION_ENDED 丢了，这次生成其实早就死了
    const realNow = Date.now;
    const shift = 6 * 60 * 1000;
    Date.now = () => realNow() + shift;

    document.querySelector('.btn_update').click();
    eq('超过 5 分钟没动静后不再拦，可以正常动扩展', hits, 1);
    eq('对外报告的「生成中」也已经解除', window.GenerationGuardian.isGenerating(), false);

    Date.now = realNow;
    pagehide(ctx);
    eq('草稿本身还牢牢留着', readSnapshots().length, 1);

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioAutoRestore() {
    console.log('\n[19] 被打断 → 自动补回聊天（不用点「接回」）');
    captureConsole();
    storage.clear();
    extensionSettingsStub['generation-guardian'] = {
        enabled: true,
        blockReload: true,
        autoRestore: true,
        resumePrompt: '继续生成上一轮剧情，衔接上文末尾，不要从头开始。',
    };

    const chat = makeChat();
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    const full = '她抬起头，看着你笑了。\n*“等很久了吧。”*';
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, full);
    pagehide(ctx);
    eq('草稿先落盘', readSnapshots().length, 1);

    // 页面被杀 / 刷新回来
    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(900);

    eq('自动补回：草稿直接变成聊天里的一轮', chat.length, 3);
    eq('补回的内容就是完整草稿', chat[2]?.mes, full);
    ok('补回后确实存了聊天', ctx2.__calls.saveChat >= 1);
    eq('草稿从待恢复列表里清掉', readSnapshots().length, 0);
    ok('卡片切成「已自动补回」', document.getElementById('gg-recover-title').textContent.includes('已自动补回'), document.getElementById('gg-recover-title').textContent);
    ok('给了「撤销补回」按钮', !document.getElementById('gg-btn-undo').classList.contains('gg-hidden'));
    eq('没有替你发任何请求', ctx2.__calls.generate.length, 0);

    document.getElementById('gg-btn-undo').click();
    await sleep(140);
    eq('撤销后那条从聊天里拿掉', chat.length, 2);
    eq('撤销后草稿回来了', readSnapshots().length, 1);
    eq('撤销过的草稿打了标记，之后不会再自动补回', readSnapshots()[0]?.autoSuppressed, true);

    delete extensionSettingsStub['generation-guardian'];
    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

async function main() {
    fs.mkdirSync(path.dirname(sandboxExtension), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'index.js'), sandboxExtension);

    await scenarioReloadAndResume();
    await scenarioNormalCompletionKeepsNothing();
    await scenarioContinueType();
    await scenarioSwipeGoesToTextarea();
    await scenarioChatMovedOn();
    await scenarioOtherChatIgnored();
    await scenarioSettingsPanel();
    await scenarioResumePrompt();
    await scenarioGuardReloadClicks();
    await scenarioHalfCutMessage();
    await scenarioImpersonateCompletion();
    await scenarioMissedGenerationStarted();
    await scenarioDuplicateStarted();
    await scenarioStorageQuota();
    await scenarioPromptSendFailure();
    await scenarioSaveChatFailure();
    await scenarioPromptFillOnly();
    await scenarioStaleGenerationRelease();
    await scenarioAutoRestore();

    console.log(`\n==== 结果：${passed} 通过 / ${failures.length} 失败 ====`);
    if (failures.length) {
        for (const failure of failures) {
            console.log(`  失败：${failure}`);
        }
    }
    process.exit(failures.length ? 1 : 0);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
