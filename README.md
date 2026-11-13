# Generation Guardian · 生成守护

给 SillyTavern 用的第三方扩展：**回复生成到一半被打断（刷新、扩展自动更新、手机切后台被杀）时，不让你白花钱。**

- 生成中拦截刷新 / 关页面（`beforeunload` 确认框）
- 流式生成时把草稿持续写进浏览器本地存储，页面被杀也丢不了
- 刷新回来打开同一聊天，自动弹出恢复卡片，一键把草稿接回聊天并**接着往下写**
- 续写走 SillyTavern 自己的 `continue`（assistant 前缀），只付后半段的额度

---

## 先说清楚它做不到什么

**纯前端扩展没法让上游请求在页面刷新后继续跑。** SillyTavern 的生成是服务端代理转发的：浏览器一断开，服务端就把上游连接 abort 掉，这是 ST 自己的行为，改不了。

所以这个扩展的做法是「保命 + 接续」：

1. 已经流式吐出来的每一个字都存住了 —— 这部分额度不会重复支付；
2. 刷新后从断点继续生成 —— 只付剩下那部分的额度。

如果断点那一刻还没吐出任何字（比如关闭了流式输出），那就真的只剩「重新生成」一条路，扩展会把这条消息记下来提醒你，但钱没法救。

> 想要「浏览器关了还在后台继续生成」，需要写服务端插件（把生成任务搬到 ST 的 Node 进程里跑）。那是一条完全不同的实现路径，本仓库没有做。

---

## 安装

### 方式一：从 GitHub 直装（PC + 手机通用）

1. 把本仓库推到 GitHub（见下方「发布到 GitHub」）。
2. 打开 SillyTavern → 顶部「扩展 / Extensions」→ `Install Extension`。
3. 地址栏填 `https://github.com/<你的用户名>/st-generation-guardian`，点安装。
4. 刷新页面，在扩展列表里能看到 **Generation Guardian (生成守护)** 就是装好了。

因为扩展装在**服务端目录**里，所以只要是同一个 SillyTavern 实例，手机浏览器访问同一个地址也自动有。手机端不需要单独装。

### 方式二：手动放进目录

把整个仓库文件夹放到：

```
SillyTavern/public/scripts/extensions/third-party/gen-guardian/
```

目录名随意，只要里面有 `manifest.json`、`index.js`、`style.css`。放好后刷新页面。

### 方式三：手机 Termux 自建

如果酒馆是跑在 Termux 里的，就在 Termux 里 `cd` 到 `public/scripts/extensions/third-party`，然后：

```bash
git clone https://github.com/<你的用户名>/st-generation-guardian gen-guardian
```

手机浏览器刷新即可。

---

## 怎么用

生成的时候，左下角（手机端是顶部）会出现一个小徽标：

```
● 生成守护：已保存 1234 字
```

看到它说明草稿在实时落盘。

如果真的被刷新 / 被系统杀了：

1. 回到 ST，打开同一个聊天；
2. 右下角弹出「检测到未完成的回复」卡片，显示角色、时间、字数、末尾预览；
3. 默认 8 秒后自动续写（可以点「取消」）；
4. 也可以手动点：
   - **恢复并续写** —— 把草稿写回聊天，接着生成
   - **放入输入框** —— 只要草稿，自己改完再发
   - **复制** —— 拷走全文
   - **丢弃** —— 不要了

设置面板在「扩展」里，有一份草稿清单，可以逐个复制或删除。

---

## 设置项

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| 启用插件 | 开 | 总开关 |
| 生成中拦截刷新 / 关闭页面 | 开 | 生成中刷新会弹系统确认框；SillyTavern 内部某些操作（如启用/禁用扩展）会直接 `location.reload()`，这种情况拦不住，靠草稿恢复 |
| 刷新后自动续写 | 开 | 打开聊天时自动接上断点 |
| 自动续写倒计时 | 8 秒 | 留给你取消的缓冲时间 |

草稿存在 `localStorage`，最多保留 8 条 / 3 天，超过自动清理。

---

## 强烈建议顺手做的两件事

1. **关掉流式输出的话，这扩展基本没用。** 打开 `Chat Completion → Streaming`（流式），否则没有中间内容可以保存。
2. **别让别的扩展自动更新打断你。** 第三方扩展的 `manifest.json` 里如果写了 `"auto_update": true`，SillyTavern 会定期检查并自动更新，更新流程可能触发页面重载。可以：
   - 把那些用不上的扩展的 `auto_update` 改成 `false`；
   - 或直接看 `config.yaml` 里的 `extensions.auto_update` 设置。

   本扩展自己的 manifest 是 `"auto_update": false`，它不会更新自己把你正在生成的回复刷掉。

---

## 技术实现（给想改的人）

| 环节 | 做法 |
| --- | --- |
| 开始记录 | `GENERATION_STARTED` 事件，记录 `chatId`、聊天长度、锚点消息指纹（hash + 前 60 字） |
| 保存内容 | `STREAM_TOKEN_RECEIVED` 事件给的是**当前累计的原始文本**，直接覆盖写入，节流 800ms 落盘 |
| 结束判断 | `GENERATION_STOPPED` / `GENERATION_ENDED`，如果内容已经进了聊天就丢草稿，没进就留下 |
| 恢复校验 | 聊天长度 + 锚点指纹双重校验，避免串到别的聊天或已经发过新消息的情况 |
| 写回聊天 | `chat.push()` + `addOneMessage()`，然后 `saveChat()` |
| 续写 | `generate('continue')`，ST 会用最后一条消息作为 prefill 追加 |
| 幂等 | 恢复过程中加锁 + 二次校验草稿是否还存在，双击按钮不会插两条 |
| 调试 | 控制台里 `GenerationGuardian.snapshots()` / `.clear()` / `.copy()` |

关键文件：

```
manifest.json   扩展清单（auto_update: false）
index.js        全部逻辑
style.css       样式，含手机端断点
tests/          本地测试沙盒
```

### 跑测试

`tests/run.mjs` 用 jsdom 造了一个假的酒馆窗口，把扩展源码复制进去后按真实相对路径 import，然后跑 8 个场景：

```bash
npm install
npm test
```

覆盖：流式中断→重载→恢复→续写、「继续生成」类型中断恢复回原消息、「换一条」只能进输入框、正常完成不留草稿、中断后聊天已变化不弹过期草稿、聊天 A 的草稿不会出现在聊天 B、设置面板与草稿清单、倒计时自动续写。

当前：**54 项断言全通过**。

---

## 发布到 GitHub

推之前先把 `manifest.json` 里两行改成你自己的（`homePage` 留空也行，填上会在扩展列表里显示「作者链接」）：

```json
"author": "你的 GitHub 用户名",
"homePage": "https://github.com/你的用户名/st-generation-guardian"
```

然后在本文件夹里执行（本地仓库已经初始化好了，已经有一次提交，所以只要加远端再推）：

```bash
git remote add origin https://github.com/<你的用户名>/st-generation-guardian.git
git push -u origin main
```

发版打 tag（SillyTavern 安装时可以直接指定分支或 tag）：

```bash
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

想更省事的做法：先在网页上建一个空仓库（public，不要勾选 README/gitignore），再按上面命令推。

如果没配过 git 身份，先在仓库里设一次（只影响这个仓库）：

```bash
git config user.name "你的名字"
git config user.email "你的邮箱"
```

---

## 已知限制

- 关闭流式输出时无法保存中间内容（没有中间内容）。
- 「换一条 / swipe」和「替我说话 / impersonate」这两类生成无法自动续写，只能把草稿放进输入框。
- 草稿是本机浏览器本地的：PC 上的草稿不会同步到手机，手机上的也不会同步到 PC（换设备 / 清缓存会丢）。
- 手机端部分浏览器（尤其 iOS Safari）对生成中的刷新确认框支持不佳，可能不弹窗直接刷新 —— 这种情况靠草稿恢复兜住。
- SillyTavern 内部直接调用 `location.reload()` 的操作（启用/禁用扩展等）拦不住，只能靠草稿恢复。
- 依赖 `STREAM_TOKEN_RECEIVED` 事件，低于 1.12 的旧版本可能没有。

## License

MIT
