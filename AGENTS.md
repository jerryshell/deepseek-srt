# AGENTS.md

## 每次改动后

```bash
node --check main.js && oxfmt main.js && node --check main.js
```

oxfmt 会改格式，后续编辑 oldText 需匹配格式化后的版本。

## 约定

- 注释中文，分段 `// === 主题 ===`
- 调试日志用 `logMsg()`（进面板，可复制），不用裸 console.log
- DeepSeek 页禁用 alert()/prompt()，用面板通知/浮层
- 版本号在 `// @version`，功能变更时递增
- main.js 是唯一源码；*.har 是接口参考（gitignore）
