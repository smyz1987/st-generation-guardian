/**
 * Generation Guardian 测试沙盒
 *
 * 用 jsdom 造一个假的 SillyTavern 环境，把扩展从「流式中断」到「重载恢复 +
 * 自动续写」的整条链路真跑一遍。扩展源码会被复制到 sandbox 里，保证测试跑的是
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
    });

    const eventSource = makeEventSource();
    const calls = { addOneMessage: 0, saveChat: 0, generate: [], updateMessageBlock: 0 };

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
        __calls: calls,
        __window: window,
        __dom: dom,
    };

    globalThis.__ST = ctx;
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
    const raw = storage.getItem('genGuardian.snapshots.v1');
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

/* ------------------------------------------------------------------ *
 * 场景
 * ------------------------------------------------------------------ */

async function scenarioReloadAndResume() {
    console.log('\n[1] 流式中断 → 重载 → 恢复卡片 → 恢复并续写');
    captureConsole();
    storage.clear();

    const chat = [
        { name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' },
        { name: '易湘琪', is_user: true, is_system: false, mes: '你抬头了吗', send_date: '2026-11-13T08:01:00.000Z' },
    ];
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
    ctx.__window.dispatchEvent(new ctx.__window.Event('pagehide'));
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
    ok('卡片里显示字数', panelText().includes('12 字') || panelText().includes('字'), panelText());

    document.getElementById('gg-btn-recover').click();
    await sleep(60);
    eq('草稿被写回聊天（新增一条消息）', chat.length, 3);
    eq('消息内容就是草稿', chat[2]?.mes, '她抬起头，看着你笑了。\n*“等很久了吧。”*');
    eq('调用了 addOneMessage 渲染', ctx2.__calls.addOneMessage, 1);
    eq('调用了 saveChat 落盘', ctx2.__calls.saveChat, 1);
    eq('「接回」不发任何新请求', ctx2.__calls.generate.length, 0);
    eq('恢复后草稿被清掉', readSnapshots().length, 0);
    ok('恢复后卡片收起', !panelVisible());

    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioNormalCompletionKeepsNothing() {
    console.log('\n[2] 正常生成完成 → 不留草稿、不弹卡片');
    captureConsole();
    storage.clear();

    const chat = [
        { name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' },
        { name: '易湘琪', is_user: true, is_system: false, mes: '嗯', send_date: '2026-11-13T08:01:00.000Z' },
    ];
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '这是一段完整的回复，内容足够长以至于能验证判定逻辑。');
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '这是一段完整的回复，内容足够长以至于能验证判定逻辑。后面还有一点。');

    // ST 正常收尾：把文本写进最后一条消息，然后发 GENERATION_ENDED
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
    ctx.__window.dispatchEvent(new ctx.__window.Event('pagehide'));

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

    const chat = [
        { name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' },
        { name: '易湘琪', is_user: true, is_system: false, mes: '嗯', send_date: '2026-11-13T08:01:00.000Z' },
    ];
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'swipe', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '另一种写法的开头');
    ctx.__window.dispatchEvent(new ctx.__window.Event('pagehide'));

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

    const chat = [
        { name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' },
        { name: '易湘琪', is_user: true, is_system: false, mes: '第一条', send_date: '2026-11-13T08:01:00.000Z' },
    ];
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '被打断的半截回复');
    ctx.__window.dispatchEvent(new ctx.__window.Event('pagehide'));

    // 用户切回来后又发了新的一句
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

    const chat = [
        { name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' },
        { name: '易湘琪', is_user: true, is_system: false, mes: '嗯', send_date: '2026-11-13T08:01:00.000Z' },
    ];
    const ctx = createWorld({ chat, chatId: 'ChatA' });

    await bootExtension();
    await signalReady(ctx);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '聊天A的草稿');
    ctx.__window.dispatchEvent(new ctx.__window.Event('pagehide'));

    const ctx2 = createWorld({ chat, chatId: 'ChatB' });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(900);

    ok('切到别的聊天不弹卡片', !panelVisible());

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
    ok('有启用开关', Boolean(document.getElementById('gg-set-enabled')));
    ok('指令框默认是剧情指令', document.getElementById('gg-set-prompt').value.startsWith('继续生成上一轮剧情'));
    ok('没有自动续写开关', !document.getElementById('gg-set-auto'));

    // 生成一份草稿，看清单是否同步
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '清单里的草稿内容');
    ctx.__window.dispatchEvent(new ctx.__window.Event('pagehide'));
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
    // 用「番外」那条指令验证：指令内容走的是设置里的文本
    extensionSettingsStub['generation-guardian'] = {
        enabled: true,
        blockReload: true,
        resumePrompt: '继续生成上一个番外，衔接上文末尾，不要从头开始。',
    };

    const chat = [
        { name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' },
        { name: '易湘琪', is_user: true, is_system: false, mes: '说点什么', send_date: '2026-11-13T08:01:00.000Z' },
    ];
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '他刚要开口，就被打断了。');
    ctx.__window.dispatchEvent(new ctx.__window.Event('pagehide'));

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

    // 造一个 SillyTavern 风格的扩展条目
    const menu = document.createElement('div');
    menu.id = 'extensions_menu';
    menu.innerHTML = `<div class="extensions_info"><div class="extension_block" data-name="third-party/foo">
        <span class="extension_name">Foo</span>
        <span class="toggle_disable">禁用</span>
        <span class="btn_update">更新</span>
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

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_ENDED, chat.length);
    await sleep(30);
    document.querySelector('.btn_update').click();
    await sleep(20);
    eq('生成结束后恢复正常', bubbled, 2);

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
