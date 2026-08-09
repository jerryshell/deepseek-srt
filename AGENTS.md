# AGENTS.md — DeepSeek SRT 上传助手

## 项目约定（每次改动后必须执行）

1. **格式化**: 用 `oxfmt` 格式化代码
   ```bash
   oxfmt main.js
   ```
   位置: `C:/Users/jerry/.bun/bin/oxfmt`（已在 PATH）
   ⚠️ oxfmt 会改变格式，后续 edit 的 oldText 必须匹配格式化后的版本

2. **语法检查**:
   ```bash
   node --check main.js
   ```

3. 每次改动后按顺序执行: `node --check main.js && oxfmt main.js && node --check main.js`

## 项目结构

- `main.js` — Tampermonkey 用户脚本（唯一源码文件）
  - 匹配 chat.deepseek.com/* 和 www.youtube.com/*
  - @run-at document-start，grants: GM_getValue/GM_setValue/GM_registerMenuCommand/unsafeWindow
  - 版本号在文件头 `// @version x.y`，功能变更时递增
- `README.md` — 中文文档（无 em-dash/emoji）
- `*.har` — 网络抓包参考（gitignore 忽略，用于查 DeepSeek/YouTube 接口结构）

## 代码风格

- 注释用中文；分段用固定格式 `// === 主题 ===`
- 面板 DOM id: `ds-panel`/`ds-batch-btn`/`ds-status`/`ds-notice`/`ds-log`/`ds-taskbox`/`ds-tasklist`
- 存储键: `srtAutoFill`/`mdAutoFill`/`srtPrompt`/`newChatAfterSend`
- 调试日志统一走 `logMsg()`（进面板 ds-log + console），不要用裸 console.log 调试
- DeepSeek 页面禁止 `alert()`/`prompt()`（用面板通知/浮层）；YouTube 页可保留 alert

## 核心逻辑速览

- **srt 伪装**: File.prototype.name/type getter + FormData append/set 替换为 .txt File
- **批量处理**: 并发 2，发送前查闸 `countNewChatSessions() < 2`（侧边栏「新对话」标题会话数）；完成信号 = 侧边栏标题从「新对话」变为摘要（MutationObserver）
- **上传确认**: fetch_files SUCCESS（XHR 事件 / 脚本主动轮询兜底）或附件 chip 出现（MutationObserver，排除 ds-panel 防误匹配）
- **发送**: 圆形图标按钮（无 aria-label，按形状+位置找）→ 点击 + 1.5s 确认 → Enter 兜底（官方支持 Enter 发送）
- **批量预览激活时禁止自动填空**（`batchPreviewActive` 标志，File.name getter 会误触）

## 测试

- 无自动化测试；修改后让用户在 DeepSeek 页面 Ctrl+Shift+R 刷新验证
- 批量调试看面板日志区（可复制）
