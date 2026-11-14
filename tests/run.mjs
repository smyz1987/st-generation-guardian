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

/** 版本号从源码里读，升级时不用再改一遍测试 */
const SRC_VERSION = (fs.readFileSync(path.join(repoRoot, 'index.js'), 'utf8').match(/VERSION = '([^']+)'/) || [])[1];

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
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
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
        <div id="send_form">
            <div id="leftSendForm"><div id="extensionsMenuButton"></div></div>
            <textarea id="send_textarea"></textarea>
        </div>
        <div id="extensionsMenu">
            <div id="st_native_wand_container" class="extension_container"></div>
        </div>
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
    const b1 = document.getElementById('gg-wand-entry');
    ok('魔杖菜单里有那一条', Boolean(b1 && b1.closest('#extensionsMenu')));
    ok('聊天框上方不留任何浮层', !document.getElementById('gg-badge'));

    // 模拟 beforeunload：生成中应该被拦下
    const unload = new ctx.__window.Event('beforeunload', { cancelable: true });
    ctx.__window.dispatchEvent(unload);
    ok('生成中拦截刷新（beforeunload 被 preventDefault）', unload.defaultPrevented);

    for (const token of ['她抬起头', '她抬起头，', '她抬起头，看着你笑了。', '她抬起头，看着你笑了。\n*“等很久了吧。”*']) {
        await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, token);
    }
    eq('那一条顺便报累计字数', document.getElementById('gg-wand-state').textContent,
        `已保存 ${'她抬起头，看着你笑了。\n*“等很久了吧。”*'.length} 字`);

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
    ok('调试入口暴露了版本号', window.GenerationGuardian?.version === SRC_VERSION,
        `${window.GenerationGuardian?.version} vs ${SRC_VERSION}`);
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
    ok('那一条的字数小字清空了',
        document.getElementById('gg-wand-state')?.textContent === '',
        document.getElementById('gg-wand-state')?.textContent || '');

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
    // 酒馆续写默认会在原文和新正文之间插一个空格（continue_postfix 的默认值 SPACE），
    // 接回也得照它一样，否则会变成「前半段。后半段」把句子粘在一起
    eq('拼回原消息（保留酒馆续写插的那个空格）', chat[2]?.mes, '前半段。 后半段补上来了。');
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
    eq('面板里显示版本号', document.getElementById('gg-ver').textContent, SRC_VERSION);
    ok('指令框默认是剧情指令', document.getElementById('gg-set-prompt').value.startsWith('继续生成上一轮剧情'));

    eq('主题选择器有八套', document.querySelectorAll('#gg-themes .gg-theme').length, 8);
    ok('默认选中杏仁白', document.querySelector('#gg-themes .gg-theme[data-theme="almond"]').getAttribute('aria-pressed') === 'true');
    ok('body 上挂了默认主题 class', document.body.classList.contains('gg-theme-almond'));
    ok('八套主题名都在（杏仁白/暖奶油/雾蓝灰/桃奶茶/白茶灰/南瓜米/奶油绿/莲子白）',
        ['almond', 'cream', 'haze', 'peach', 'ash', 'pumpkin', 'butter', 'lotus'].every((key) => document.querySelector(`#gg-themes .gg-theme[data-theme="${key}"] .gg-theme-name`).textContent.length >= 2));

    document.querySelector('#gg-themes .gg-theme[data-theme="haze"]').click();
    ok('点雾蓝灰切过去', document.body.classList.contains('gg-theme-haze'));
    ok('切过去后旧主题 class 被摘掉', !document.body.classList.contains('gg-theme-almond'));
    ok('选中态跟着变', document.querySelector('#gg-themes .gg-theme[data-theme="haze"]').getAttribute('aria-pressed') === 'true');
    eq('主题写进设置', extensionSettingsStub['generation-guardian'].theme, 'haze');

    document.querySelector('#gg-themes .gg-theme[data-theme="lotus"]').click();
    ok('再切莲子白也生效', document.body.classList.contains('gg-theme-lotus'));
    eq('主题写进设置（第二次）', extensionSettingsStub['generation-guardian'].theme, 'lotus');

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
        // 这个场景测的就是「打开自动发送」这条路；默认是关的（见 [26]）
        autoSend: true,
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
    eq('生成中点「更新」照常放行（更新只提示刷新、不会真刷）', bubbled, 2);

    document.querySelector('.toggle_disable').click();
    await sleep(20);
    eq('生成中点「禁用」被拦下', bubbled, 2);

    document.querySelector('.btn_clean').click();
    await sleep(20);
    eq('生成中点「清理」被拦下', bubbled, 2);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_ENDED, chat.length);
    await sleep(30);
    document.querySelector('.toggle_disable').click();
    await sleep(20);
    eq('生成结束后恢复正常', bubbled, 3);

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
    // 要测「发送失败」这条路径，得先把自动发送打开（默认是关的）
    extensionSettingsStub['generation-guardian'] = { autoSend: true };

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

    delete extensionSettingsStub['generation-guardian'];
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
        <span class="toggle_disable">禁用</span>
    </div></div>`;
    document.body.appendChild(menu);

    let hits = 0;
    document.querySelector('.toggle_disable').addEventListener('click', () => {
        hits += 1;
    });

    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '半截内容');
    document.querySelector('.toggle_disable').click();
    eq('正在出字时，点「禁用」被拦下', hits, 0);
    eq('对外报告的是「真的在生成」', window.GenerationGuardian.isGenerating(), true);

    // 时间往前推 6 分钟：模拟 GENERATION_ENDED 丢了，这次生成其实早就死了
    const realNow = Date.now;
    const shift = 6 * 60 * 1000;
    Date.now = () => realNow() + shift;

    document.querySelector('.toggle_disable').click();
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

async function scenarioReloadShield() {
    console.log('\n[20] 扩展操作护栏：只拦真会刷新的四类，别的一概放行，且不包装任何全局函数');
    captureConsole();
    storage.clear();
    extensionSettingsStub['generation-guardian'] = {
        enabled: true,
        blockReload: true,
        blockExtensionOps: true,
        autoRestore: false,
    };
    // 热重载扩展在场（它自己会把重启延后到生成结束，我们不去插手）
    extensionSettingsStub['extension_hot_reload'] = { mode: 'force' };

    const chat = makeChat();
    const ctx = createWorld({ chat });

    const info = document.createElement('div');
    info.className = 'extensions_info';
    info.innerHTML = [
        '<div class="extension_block">',
        '<button type="button" class="toggle_enable">Enable</button>',
        '<button type="button" class="btn_update">Update</button>',
        '<button type="button" class="btn_delete">Delete</button>',
        '<button type="button" class="btn_branch">Branch</button>',
        '<button type="button" class="btn_move">Move</button>',
        '</div>',
    ].join('');
    document.body.appendChild(info);

    // 记录所有真正发出去的请求
    const sent = [];
    const DISCOVER_LIST = [
        { type: 'system', name: 'assets' },
        { type: 'global', name: 'third-party/st-generation-guardian' },
        { type: 'global', name: 'third-party/SillyTavern-Extension-Hot-Reload' },
        { type: 'global', name: 'third-party/claude-web' },
        { type: 'local', name: 'third-party/ST-BaiBai-Tools' },
        { type: 'local', name: 'third-party/SillyTavern-Self-Check' },
        { type: 'local', name: 'third-party/mobile' },
    ];
    const stubFetch = (input) => {
        const url = String(input?.url || input);
        sent.push(url);
        if (url.includes('/api/extensions/discover')) {
            return Promise.resolve({ ok: true, status: 200, json: async () => DISCOVER_LIST });
        }
        return Promise.resolve({ ok: true, status: 200 });
    };
    window.fetch = stubFetch;

    await bootExtension();
    await signalReady(ctx);
    // 兼容状态是异步拿扩展目录名单再渲染的，给它一点时间
    await new Promise((resolve) => setTimeout(resolve, 60));

    ok('没有包装 window.fetch（和 claude-web / kimi / story-oracle 的 fetch 钩子零冲突', window.fetch === stubFetch);

    const compatNames = Array.from(document.querySelectorAll('#gg-compat-list .gg-snap-title')).map((node) => node.textContent);
    ok('兼容状态里列出了检测到的 Hot-Reload', compatNames.some((name) => name.includes('Hot-Reload')), compatNames.join('|'));
    eq('兼容状态计数与条目数一致', document.getElementById('gg-compat-count').textContent, String(compatNames.length));

    const text = '她低头笑了，把杯子推回你手边。';
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, text);
    ok('现在是在生成中', window.GenerationGuardian.isGenerating());

    // 1) 更新按钮：酒馆源码里更新只 toast「刷新以生效」、不 reload → 不该拦
    const updateBtn = info.querySelector('.btn_update');
    const updateEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    updateBtn.dispatchEvent(updateEvent);
    ok('生成中点「更新」不被拦（否则她会觉得点了没反应）', !updateEvent.defaultPrevented);

    // 1.5) 扩展自己的「发现新版本」弹窗：点更新后它们 setTimeout 1 秒就刷新 → 生成中必须拦
    const autoPopup = document.createElement('div');
    autoPopup.className = 'popup';
    autoPopup.innerHTML = '<div>检测到插件有可用更新。要现在更新吗？</div>'
        + '<div>更新完成后，SillyTavern 会自动刷新页面。</div>'
        + '<button type="button" class="menu_button" id="gg-test-update">更新</button>'
        + '<button type="button" class="menu_button" id="gg-test-cancel">取消</button>';
    document.body.appendChild(autoPopup);
    const autoUpdateEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('gg-test-update').dispatchEvent(autoUpdateEvent);
    ok('生成中点扩展自动更新弹窗的「更新」被拦下', autoUpdateEvent.defaultPrevented);
    const autoCancelEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    document.getElementById('gg-test-cancel').dispatchEvent(autoCancelEvent);
    ok('同一个弹窗里点「取消」不拦，照样能关掉', !autoCancelEvent.defaultPrevented);
    const shiftUpdateEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true });
    document.getElementById('gg-test-update').dispatchEvent(shiftUpdateEvent);
    ok('按住 Shift 点「更新」放行（先落盘再让它刷）', !shiftUpdateEvent.defaultPrevented);
    autoPopup.remove();

    // 2) 换分支 / 移动：同样不 reload → 放行
    for (const selector of ['.btn_branch', '.btn_move']) {
        const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
        info.querySelector(selector).dispatchEvent(event);
        ok(`生成中点 ${selector} 不被拦`, !event.defaultPrevented);
    }

    // 3) 删除：delay(1000).then(location.reload()) → 必须拦
    const deleteBtn = info.querySelector('.btn_delete');
    const blocked = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    deleteBtn.dispatchEvent(blocked);
    ok('生成中点「删除扩展」被就地拦下', blocked.defaultPrevented);
    eq('拦下之前草稿还是落盘了', readSnapshots().length, 1);

    // 4) 启用：关扩展弹窗时会 reload → 必须拦
    const enableEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    info.querySelector('.toggle_enable').dispatchEvent(enableEvent);
    ok('生成中点「启用扩展」被拦下', enableEvent.defaultPrevented);

    // 5) Shift + 点击 → 强制放行
    const pass = new window.MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true });
    deleteBtn.dispatchEvent(pass);
    ok('Shift + 点击可以强制放行', !pass.defaultPrevented);

    // 6) 正常聊天请求永不受影响
    await window.fetch('/api/backends/chat-completions/generate', { method: 'POST', body: '{}' });
    const generateCalls = sent.filter((url) => url.includes('/api/backends/chat-completions/generate'));
    eq('正常生成请求照常放行', generateCalls.length, 1);

    // 7) 生成结束：字还在屏幕上、酒馆还没 saveChat —— 这段窗口刷新照样会整段丢，
    //    所以这里先把保护窗口压到 0，只验证「该放开的时候确实放开」，不误拦正常操作。
    globalThis.__ggPostGenGuardMs = 0;
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STOPPED, {});
    const afterStop = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    deleteBtn.dispatchEvent(afterStop);
    ok('生成结束、保护窗口过去之后就不再拦了', !afterStop.defaultPrevented);
    delete globalThis.__ggPostGenGuardMs;

    delete extensionSettingsStub['generation-guardian'];
    delete extensionSettingsStub['extension_hot_reload'];
    restoreConsole();
}

/* 21：其它扩展（claude-web / story-oracle / kimi）会在自己认定的时机直接 location.reload()，
   拦不住 —— 但任何导航前浏览器必定触发 beforeunload，我们要在这一刻把草稿刷到最新。 */
async function scenarioUnloadBeforeForeignReload() {
    console.log('\n[21] 别的扩展突然 location.reload() 时，beforeunload 那一刻草稿是最新的');
    captureConsole();
    storage.clear();
    extensionSettingsStub['generation-guardian'] = { enabled: true, blockReload: true, autoRestore: false };

    const chat = makeChat();
    const ctx = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    // 首批字，间隔还没到，正常不会立刻落盘
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '夜色很静。');
    eq('间隔没到之前还没落盘', readSnapshots().length, 0);

    // 别的扩展直接刷新（酒馆的 location.reload 也会走到这里）→ 先触发 beforeunload
    window.dispatchEvent(new window.Event('beforeunload'));
    const saved = readSnapshots();
    eq('beforeunload 立刻落了一次盘', saved.length, 1);
    ok('落盘内容就是最新那批字', saved[0].text.includes('夜色很静。'), saved[0].text);

    delete extensionSettingsStub['generation-guardian'];
    restoreConsole();
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

async function scenarioQuietFinish() {
    console.log('\n[22] 正常写完就安静：不弹卡片、不弹提示');
    captureConsole();
    storage.clear();
    window.__ggRecheckDelays = [40, 40, 40, 40];

    // ---- A. 正常收尾，但我们故意让 chat 里没有这条（模拟「酒馆写晚半拍」）
    extensionSettingsStub['generation-guardian'] = { enabled: true, autoRestore: true, quiet: true };
    const chat = makeChat();
    const ctx = createWorld({ chat, chatId: 'QuietChat' });
    const toasts = [];
    window.toastr = {
        info: (m) => toasts.push(['info', m]),
        success: (m) => toasts.push(['success', m]),
        warning: (m) => toasts.push(['warning', m]),
        error: (m) => toasts.push(['error', m]),
    };
    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '月光落在他肩上，他没有回头。');
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_ENDED, chat.length);
    await sleep(260);

    const snaps = readSnapshots();
    eq('正常结束的草稿留作备份', snaps.length, 1);
    ok('标了「正常结束」，不会被当成未完成', snaps[0].endedCleanly === true, JSON.stringify(snaps[0]?.endedCleanly));
    eq('安静模式下一条提示都不弹', toasts.length, 0);
    ok('卡片也不弹', !panelVisible());

    // ---- B. 同聊天再扫一次：备份草稿不许冒充「未完成的回复」
    chat.push({ name: '沈砚', is_user: false, mes: '月光落在他肩上，他没有回头。', send_date: 'x', swipes: [], swipe_id: 0 });
    await window.GenerationGuardian.scan();
    ok('刷新回来也不会弹「检测到未完成的回复」', !panelVisible());

    // ---- C. 对照组：真被打断（stopped）才该出声
    extensionSettingsStub['generation-guardian'] = { enabled: true, autoRestore: true, quiet: true };
    const chatB = makeChat();
    const ctxB = createWorld({ chat: chatB, chatId: 'LoudChat' });
    const toastsB = [];
    window.toastr = {
        info: (m) => toastsB.push(['info', m]),
        success: (m) => toastsB.push(['success', m]),
        warning: (m) => toastsB.push(['warning', m]),
        error: (m) => toastsB.push(['error', m]),
    };
    await bootExtension();
    await signalReady(ctxB);
    await ctxB.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctxB.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, '烛火晃了一下，他抬眼。');
    await ctxB.eventSource.emit(EVENT_TYPES.GENERATION_STOPPED, {});
    // 自动补回（autoRestore 开着）会在稍后把草稿写进聊天并把它清掉，
    // 所以「有没有标成正常结束」要在补回之前看
    const rightAfter = readSnapshots();
    ok('被打断的草稿不标「正常结束」', rightAfter.length === 1 && rightAfter[0].endedCleanly === false,
        JSON.stringify(rightAfter.map((s) => ({ k: s.chatKey, n: s.text.length, e: s.endedCleanly }))));
    await sleep(260);
    ok('真被打断的时候还是会吭一声', toastsB.length >= 1, JSON.stringify(toastsB));
    ok('补回成功之后草稿就不再重复占位', readSnapshots().length === 0,
        JSON.stringify(readSnapshots().map((s) => s.chatKey)));

    delete window.__ggRecheckDelays;
    delete extensionSettingsStub['generation-guardian'];
    restoreConsole();
}

async function scenarioHugeDraft() {
    console.log('\n[23] 一万五千字的一轮被打断，一字不差留住并接回');
    captureConsole();
    storage.clear();
    delete window.__ggRecheckDelays;
    extensionSettingsStub['generation-guardian'] = { enabled: true, autoRestore: false };

    const chunk = '他把袖子挽到小臂，火光顺着指节往上爬，谁也没有先开口，只听见窗外风把雪吹成一条线。';
    let full = '';
    while (full.length < 15000) {
        full += chunk;
    }
    const big = full.slice(0, 15000);

    const chat = makeChat();
    const ctx = createWorld({ chat, chatId: 'HugeChat' });
    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    // 按真实节奏分批吐字（每批都是「累计文本」，跟酒馆一致）
    for (let cut = 1500; cut <= big.length; cut += 1500) {
        await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, big.slice(0, cut));
    }
    ok('flush 间隔还没到，这时候存储是空的（正常节奏）', readSnapshots().length === 0);

    // 还没写完就被打断（别的扩展刷新 → beforeunload）
    window.dispatchEvent(new window.Event('beforeunload'));
    const saved = readSnapshots();
    eq('长草稿在存储里', saved.length, 1);
    eq('字数一个不少', saved[0].text.length, big.length);
    ok('内容逐字一致，没有中间省略', saved[0].text === big);
    ok('没被标成截断', saved[0].truncated === false, String(saved[0].truncated));

    // 模拟刷新回来（同一个聊天），点「接回」
    const ctx2 = createWorld({ chat, chatId: 'HugeChat' });
    const rendered = [];
    ctx2.eventSource.on('character_message_rendered', (id, type) => rendered.push([id, type]));
    const genCalls = [];
    window.fetch = (input) => {
        const url = String(input?.url || input);
        if (url.includes('chat-completions')) {
            genCalls.push(url);
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ([]) });
    };
    await bootExtension();
    await signalReady(ctx2);
    await sleep(800);
    ok('恢复卡片出现了', panelVisible());
    const before = chat.length;
    document.getElementById('gg-btn-recover').click();
    await sleep(250);

    eq('聊天里多了一条', chat.length, before + 1);
    const landed = chat[chat.length - 1];
    ok('接回的是 AI 侧', Boolean(landed) && landed.is_user === false);
    eq('接回来的字数一样多', String(landed.mes || '').length, big.length);
    ok('接回来的内容逐字一致', String(landed.mes || '') === big);
    eq('接回后不再留同一份草稿', readSnapshots().length, 0);

    // 渲染链路 + 额度
    eq('接回没有发任何生成请求（不额外扣额度）', genCalls.length, 0);
    ok('接回后补发了「这条渲染好了」事件（状态栏/变量类扩展靠它）',
        rendered.length === 1 && rendered[0][0] === before, JSON.stringify(rendered));
    ok('补发的事件带了来源标记，扩展能认出是自己人',
        String(rendered[0]?.[1] || '').includes('generation-guardian'), String(rendered[0]?.[1]));
    ok('消息对象带齐了 swipe 字段，右滑和重生成都正常',
        Array.isArray(landed.swipes) && landed.swipes[0] === big && typeof landed.swipe_id === 'number',
        JSON.stringify({ swipes: landed.swipes?.length, id: landed.swipe_id }));
    ok('正文存的是原始 markdown / HTML，没有被转义成纯文本',
        String(landed.mes) === big);
    ok('主题只往 body 挂自己那一个 theme class，不会多挂别的开关',
        document.body.classList.contains('gg-theme-almond')
        && !document.body.classList.contains('gg-light-surface'), document.body.className);

    delete extensionSettingsStub['generation-guardian'];
    restoreConsole();
}

async function scenarioSwipeLanded() {
    console.log('\n[24] 「换一条」其实已经写完 → 判为落地，刷新不再弹卡片');
    captureConsole();
    storage.clear();

    const draft = '另一种写法的整段开头，然后是中段，最后是收尾的那一句。';
    const chat = [
        { name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' },
        { name: '易湘琪', is_user: true, is_system: false, mes: '你抬头了吗', send_date: '2026-11-13T08:01:00.000Z' },
        {
            name: '沈砚', is_user: false, is_system: false, mes: '原来那一条。', send_date: '2026-11-13T08:02:00.000Z',
            swipe_id: 0, swipes: ['原来那一条。'], swipe_info: [{ send_date: '2026-11-13T08:02:00.000Z' }],
        },
    ];
    const ctx = createWorld({ chat });

    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'swipe', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, draft);
    pagehide(ctx);
    eq('换一条的草稿先落盘', readSnapshots().length, 1);

    // 酒馆把新 swipe 写进去了：消息数不变，mes 换成新文本，swipes 里多一条
    chat[2].mes = draft;
    chat[2].swipes.push(draft);
    chat[2].swipe_id = 1;

    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(900);

    eq('判为已写完，草稿被清掉', readSnapshots().length, 0);
    ok('不再弹「未完成的回复」', !panelVisible());

    delete extensionSettingsStub['generation-guardian'];
    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioEmptyPlaceholder() {
    console.log('\n[25] 刷新后那条空占位还在 → 接回填进它，不追加一条');
    captureConsole();
    storage.clear();

    const draft = '她抬头看过来，雪落在睫毛上，一句话都没说。';
    const chat = [
        { name: '沈砚', is_user: false, is_system: false, mes: '开场白。', send_date: '2026-11-13T08:00:00.000Z' },
        { name: '易湘琪', is_user: true, is_system: false, mes: '你抬头了吗', send_date: '2026-11-13T08:01:00.000Z' },
    ];
    const ctx = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx);

    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    // 酒馆流式一开始会先 push 一条空占位，再往里喂 token
    chat.push({ name: '沈砚', is_user: false, is_system: false, mes: '', send_date: '2026-11-13T08:02:00.000Z' });
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, draft);
    pagehide(ctx);
    eq('草稿已落盘', readSnapshots().length, 1);

    const ctx2 = createWorld({ chat });
    await bootExtension();
    await signalReady(ctx2);
    await sleep(900);

    ok('弹出恢复卡片', panelVisible());
    document.getElementById('gg-btn-recover').click();
    await sleep(80);

    eq('聊天条数没变（填进空占位，没有追加）', chat.length, 3);
    eq('空占位被填成草稿全文', chat[2]?.mes, draft);
    eq('没有走 addOneMessage 追加新消息', ctx2.__calls.addOneMessage, 0);
    eq('草稿被清掉', readSnapshots().length, 0);

    delete extensionSettingsStub['generation-guardian'];
    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

async function scenarioFillOnlyByDefault() {
    console.log('\n[26] 出厂默认：点「续写」只把指令放进输入框，一个请求都不发');
    captureConsole();
    storage.clear();
    // 用出厂默认跑 —— 不预设任何 extension_settings
    delete extensionSettingsStub['generation-guardian'];

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

    document.getElementById('gg-btn-recover-write').click();
    await sleep(90);

    eq('草稿写回聊天', chat.length, 3);
    eq('一个生成请求都没发（额度不动）', ctx2.__calls.generate.length, 0);
    const area = document.getElementById('send_textarea');
    ok('指令已经放进输入框', String(area.value).startsWith('继续生成上一轮剧情'), area.value);
    eq('光标停在指令末尾，接着往下打就行', area.selectionStart, area.value.length);

    delete extensionSettingsStub['generation-guardian'];
    const issues = restoreConsole();
    ok('没有异常日志', issues.filter(([level]) => level === 'error').length === 0, JSON.stringify(issues));
}

/* 27：生成刚写完、酒馆还没 saveChat 的这几秒，刷新照样整段丢。
   酒馆的流式是「开头落一条空消息 → 中途只改内存里的 chat[i].mes → 跑完 GENERATION_ENDED
   之后才 saveChat」，所以事件刚发出来那一刻磁盘上还是空的。这段窗口必须继续拦。 */
async function scenarioPostFinishGuard() {
    console.log('\n[27] 生成刚结束、还没写盘时，刷新和扩展操作照样拦');
    captureConsole();
    storage.clear();
    const chat = makeChat();
    const ctx = await createWorld({ chat });
    await bootExtension();
    await signalReady(ctx);
    extensionSettingsStub['generation-guardian'] = {
        autoRestore: false,
        blockReload: true,
        blockExtensionOps: true,
    };

    // (a) 真实 12 秒窗口：刚 STOPPED 就点刷新 → 拦
    const text = '他把伞往她那边偏了偏，雨顺着伞骨滑下去。';
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, text);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STOPPED, {});

    const unloadNow = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadNow);
    ok('刚写完还没落盘时，刷新被拦下', unloadNow.defaultPrevented);
    ok('拦的时候说的是「刚写完还没存进聊天」，不是「正在生成中」',
        String(window.GenerationGuardian?.unloadMessage?.(false) || '').includes('正在存进聊天'),
        String(window.GenerationGuardian?.unloadMessage?.(false) || ''));
    ok('生成中的说法仍然是「正在生成中」',
        String(window.GenerationGuardian?.unloadMessage?.(true) || '').includes('正在生成中'));

    // 这会儿点「禁用扩展」也会立刻刷新 → 同样要拦
    const info = document.createElement('div');
    info.className = 'extensions_info';
    info.innerHTML = '<div class="extension_block"><button class="toggle_disable" type="button">禁用</button></div>';
    document.body.appendChild(info);
    const disableEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    info.querySelector('.toggle_disable').dispatchEvent(disableEvent);
    ok('落盘保护窗口内点「禁用扩展」也被拦下', disableEvent.defaultPrevented);
    info.remove();

    // (b) 窗口到期就放开，不误拦正常操作
    globalThis.__ggPostGenGuardMs = 60;
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STARTED, 'normal', {}, false);
    await ctx.eventSource.emit(EVENT_TYPES.STREAM_TOKEN_RECEIVED, text);
    await ctx.eventSource.emit(EVENT_TYPES.GENERATION_STOPPED, {});
    const unloadDuring = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadDuring);
    ok('窗口内的第二次生成结束后，刷新仍然被拦', unloadDuring.defaultPrevented);
    await sleep(260);
    const unloadAfter = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloadAfter);
    ok('保护窗口到点自动解除，不会一直缠着不让刷新', !unloadAfter.defaultPrevented);
    delete globalThis.__ggPostGenGuardMs;

    delete extensionSettingsStub['generation-guardian'];
    restoreConsole();
    pagehide(ctx);
}

/* 28：入口只放魔杖菜单。她明确说过「聊天框上面挂图标没必要」，也不要单独做脚本，
   那就回到酒馆自己的魔法棒：跟别的扩展按钮排在一层，收起时不占版面。 */
async function scenarioWandEntry() {
    console.log('\n[28] 入口只在魔杖菜单里，跟别的扩展按钮排在一起');
    captureConsole();
    storage.clear();
    const ctx = createWorld({ chat: makeChat() });
    await bootExtension();
    await signalReady(ctx);

    const item = document.getElementById('gg-wand-entry');
    ok('启动后魔杖菜单里就有「生成守护」', Boolean(item && item.closest('#extensionsMenu')),
        item?.parentElement?.className || '(无父容器)');
    eq('它落在 extension_container 里（酒馆原生按钮也是这一层）',
        item?.parentElement?.className, 'extension_container');
    eq('名字就四个字', item?.querySelector('.gg-wand-name')?.textContent?.trim(), '生成守护');
    ok('带着跟别的扩展一样的图标位', Boolean(item?.querySelector('.extensionsMenuExtensionButton')));
    ok('点它不会报错', (() => {
        try {
            item.click();
            return true;
        } catch (error) {
            return false;
        }
    })());

    // 那个开关关掉 → 整条藏起来
    const toggle = document.getElementById('gg-set-badge');
    toggle.checked = false;
    toggle.dispatchEvent(new ctx.__window.Event('change'));
    await sleep(60);
    eq('关掉开关就不显示', item.style.display, 'none');

    toggle.checked = true;
    toggle.dispatchEvent(new ctx.__window.Event('change'));
    await sleep(60);
    ok('打开开关又回来', item.style.display !== 'none');

    // 魔杖菜单还没被酒馆建出来时，绝不往 body 上硬塞一个浮层
    document.getElementById('gg-wand-entry').remove();
    document.getElementById('extensionsMenu').remove();
    ok('菜单不在，页面上就没有这条', !document.getElementById('gg-wand-entry'));
    ok('恢复卡片仍然可用（只收入口，不动功能）', Boolean(document.getElementById('gg-panel')));

    delete extensionSettingsStub['generation-guardian'];
    restoreConsole();
}

/* 29：六块内容各折成一行。她的原话是「那么长一串东西拖着像什么样子」，
   所以默认只看得到六行标题 + 一行打开着的开关，其余要摊开才显。 */
async function scenarioPanelFolds() {
    console.log('\n[29] 六块内容折成六行，只有开关默认展开');
    captureConsole();
    storage.clear();
    const ctx = createWorld({ chat: makeChat() });
    await bootExtension();
    await signalReady(ctx);

    const folds = ['gg-theme-fold', 'gg-switch-fold', 'gg-prompt-fold', 'gg-storage-fold', 'gg-compat-fold', 'gg-snap-fold'];
    eq('六块都在', folds.filter((id) => document.getElementById(id)).length, 6);

    const heads = folds.map((id) => document.querySelector(`#${id} .gg-fold-head`));
    ok('每一块都有可点的标题行', heads.every(Boolean));
    const tags = heads.map((head) => head?.querySelector('.gg-fold-tag')?.textContent?.trim());
    eq('标题顺序：主题 / 开关 / 续写指令 / 存储 / 兼容状态 / 已保存草稿',
        tags.join('|'), '主题|开关|续写指令|存储|兼容状态|已保存草稿');

    const expanded = folds.map((id) => document.getElementById(id)?.getAttribute('aria-expanded'));
    eq('默认只有开关是打开的', expanded.join('|'), 'false|true|false|false|false|false');

    // 主题那一行的「小巧思」：收起时也看得出现在用哪套
    const label = document.getElementById('gg-fold-current')?.textContent?.trim();
    eq('收起行里写着当前主题名', label, '杏仁白');
    const dots = document.querySelectorAll('#gg-fold-dots .gg-fold-dot');
    eq('一排八颗点，就是八套配色', dots.length, 8);
    eq('当前那颗带 active 标记', document.querySelectorAll('#gg-fold-dots .gg-fold-dot[data-active="true"]').length, 1);
    ok('点上有各自的主题色', Boolean(dots[0]?.style.getPropertyValue('--d')));

    // 点标题行 → 摊开；再点 → 收回去
    const themeHead = document.querySelector('#gg-theme-fold .gg-fold-head');
    themeHead.click();
    eq('点一下就摊开', document.getElementById('gg-theme-fold').getAttribute('aria-expanded'), 'true');
    themeHead.click();
    eq('再点一下收回去', document.getElementById('gg-theme-fold').getAttribute('aria-expanded'), 'false');

    // 换一套主题 → 收起行里的名字和那颗环跟着走
    document.querySelector('#gg-themes [data-theme="lotus"]').click();
    await sleep(60);
    eq('换完主题，收起行的名字跟着换', document.getElementById('gg-fold-current')?.textContent?.trim(), '莲子白');
    eq('环也换到新的那一颗上', document.querySelector('#gg-fold-dots [data-active="true"]')?.style.getPropertyValue('--d').trim(), '#a9a1b0');

    // 兼容状态、草稿的计数挂在收起的标题上，不摊开也数得清
    ok('兼容状态带着计数', Boolean(document.querySelector('#gg-compat-head .gg-count')));
    ok('已保存草稿带着计数', Boolean(document.querySelector('#gg-snap-head .gg-count')));

    // 老结构不该再留在面板里
    eq('◆ 那种分隔符已经清干净了', document.querySelectorAll('#gg-settings .gg-diamond').length, 0);
    eq('.gg-sub 那种平铺小标题也清干净了', document.querySelectorAll('#gg-settings .gg-sub').length, 0);

    delete extensionSettingsStub['generation-guardian'];
    restoreConsole();
}

/* 30：第一次用带一遍引导，之后只在点「?」的时候出现。
   她的原话是「你几句话放按钮不觉得很累赘吗，加个新手引导就行了」，
   所以面板上的名字要短、解释都在引导里。 */
async function scenarioGuide() {
    console.log('\n[30] 引导只自动弹一次，之后靠面板底部的「?」重看');
    captureConsole();
    storage.clear();
    const ctx = createWorld({ chat: makeChat() });
    await bootExtension();
    await signalReady(ctx);
    await sleep(1000);

    const guide = document.getElementById('gg-guide');
    ok('第一次进来会自己弹一遍', Boolean(guide) && !guide.classList.contains('gg-hidden'));
    eq('第一步是「它管什么」', document.getElementById('gg-guide-title')?.textContent?.trim(), '它管什么');
    eq('步数标着 1 / 7', document.getElementById('gg-guide-step')?.textContent?.trim(), '1 / 7');
    eq('底部七颗进度点', document.querySelectorAll('#gg-guide-dots .gg-guide-dot').length, 7);
    ok('第一步的上一步是灰的', Boolean(document.getElementById('gg-guide-prev')?.disabled));

    const next = document.getElementById('gg-guide-next');
    next.click();
    eq('点下一步走到第 2 步', document.getElementById('gg-guide-step')?.textContent?.trim(), '2 / 7');
    eq('第二步讲主题', document.getElementById('gg-guide-title')?.textContent?.trim(), '主题');

    for (let i = 0; i < 5; i += 1) {
        next.click();
    }
    eq('走到最后一步', document.getElementById('gg-guide-step')?.textContent?.trim(), '7 / 7');
    eq('最后一步的按钮变成「开始用」', next.textContent?.trim(), '开始用');
    next.click();
    ok('点「开始用」就收起', document.getElementById('gg-guide').classList.contains('gg-hidden'));
    eq('看过了这件事记进设置', extensionSettingsStub['generation-guardian']?.guideSeen, true);

    // 重开一次：不该再自己跳出来
    storage.clear();
    await bootExtension();
    await signalReady(ctx);
    await sleep(1000);
    ok('第二次进来不再自动弹', document.getElementById('gg-guide').classList.contains('gg-hidden'));

    // 面板底部那个「?」随时能翻出来
    document.getElementById('gg-help').click();
    ok('点「?」又出来了', !document.getElementById('gg-guide').classList.contains('gg-hidden'));
    eq('而且是从第一步重来', document.getElementById('gg-guide-step')?.textContent?.trim(), '1 / 7');

    // 点遮罩空白处关掉
    document.getElementById('gg-guide').click();
    ok('点遮罩也能关', document.getElementById('gg-guide').classList.contains('gg-hidden'));

    // 面板上的名字要短，解释都在引导里
    const labels = [...document.querySelectorAll('#gg-switch-fold .gg-check span')].map((node) => node.textContent.trim());
    eq('开关一共八个', labels.length, 8);
    ok('每个名字都不超过十个字、也不带括号解释',
        labels.every((text) => text.length <= 10 && !text.includes('（')), labels.join(' / '));
    eq('一行都没有残留的说明段', document.querySelectorAll('#gg-settings .gg-hint').length, 0);

    delete extensionSettingsStub['generation-guardian'];
    restoreConsole();
}

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
    await scenarioReloadShield();
    await scenarioUnloadBeforeForeignReload();
    await scenarioQuietFinish();
    await scenarioHugeDraft();
    await scenarioSwipeLanded();
    await scenarioEmptyPlaceholder();
    await scenarioFillOnlyByDefault();
    await scenarioPostFinishGuard();
    await scenarioWandEntry();
    await scenarioPanelFolds();
    await scenarioGuide();

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
