// ==UserScript==
// @name         DeepSeek SRT 上传助手 + YouTube 字幕下载
// @namespace    http://tampermonkey.net/
// @version      3.11
// @description  允许在 DeepSeek 直接上传 .srt 字幕文件（自动伪装为 .txt）。可选拖入 .srt / .md 时自动填入提示词。批量处理 MD 文件（并发 2 自动排队）。YouTube 页面添加「下载字幕」按钮。
// @author       Jerry
// @match        https://chat.deepseek.com/*
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=deepseek.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // === 配置 ===
  const DEFAULT_PROMPT =
    "通俗易懂总结，不用术语/破折号，用连贯/简单/简洁语言表达，就像两个普通人在对话";
  const DEFAULT_DELAY = 3; // 批量发送间隔基准（秒），实际 基准~基准+2s 随机，防风控
  const STORAGE = {
    ENABLED: "srtAutoFill",
    MD: "mdAutoFill",
    PROMPT: "srtPrompt",
    NEWCHAT: "newChatAfterSend",
    DELAY: "sendDelay",
  };
  let autoFillEnabled = GM_getValue(STORAGE.ENABLED, true);
  let mdAutoFillEnabled = GM_getValue(STORAGE.MD, false);
  let promptText = GM_getValue(STORAGE.PROMPT, DEFAULT_PROMPT);
  let newChatAfterSend = GM_getValue(STORAGE.NEWCHAT, false);
  let sendDelaySec = GM_getValue(STORAGE.DELAY, DEFAULT_DELAY);

  // === 页面控制面板（仅 DeepSeek 页面）===
  function buildPanel() {
    if (location.hostname !== "chat.deepseek.com" || document.getElementById("ds-panel")) return;
    const panel = document.createElement("div");
    panel.id = "ds-panel";
    panel.style.cssText =
      "position:fixed;right:12px;top:64px;z-index:2147483000;font-size:12px;color:#fff;" +
      "user-select:none;border-radius:14px;border:1px solid rgba(255,255,255,.08);" +
      "display:flex;align-items:center;justify-content:center;";
    // hover/运行态样式（内联样式写不了 :hover，注入一次样式表）
    const dsStyle = document.createElement("style");
    dsStyle.textContent =
      '#ds-panel[data-open="0"]{cursor:pointer;}' +
      '#ds-panel[data-open="0"]:hover{filter:brightness(1.15);}' +
      "#ds-panel .ds-row:hover{background:rgba(255,255,255,.05);}" +
      '#ds-panel[data-open="0"] #ds-title{font-weight:700;}' +
      '#ds-panel[data-open="1"] #ds-title{font-weight:600;}' +
      '#ds-panel[data-open="1"] #ds-title span:last-child{color:#71717a;font-size:15px;line-height:1;}' +
      "#ds-batch-btn:hover{filter:brightness(1.12);}";
    document.head.appendChild(dsStyle);

    // 标题栏：默认折叠为渐变小按钮，点击展开/收起
    const title = document.createElement("div");
    title.id = "ds-title";
    title.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;padding:0;";
    const body = document.createElement("div");
    body.id = "ds-body";
    panel.appendChild(title);
    panel.appendChild(body);
    const apply = (open) => {
      panel.dataset.open = open ? "1" : "0";
      panel.style.display = open ? "block" : "flex";
      panel.style.width = open ? "280px" : "48px";
      panel.style.height = open ? "auto" : "48px";
      panel.style.padding = open ? "10px 0" : "0";
      panel.style.background = open ? "rgba(17,17,22,.95)" : "#4d6bfe";
      panel.style.boxShadow = open ? "0 4px 16px rgba(0,0,0,.35)" : "0 2px 8px rgba(0,0,0,.3)";
      title.style.padding = open ? "0 12px 8px" : "0";
      title.style.borderBottom = open ? "1px solid rgba(255,255,255,.1)" : "none";
      title.style.marginBottom = open ? "4px" : "0";
      title.innerHTML = open ? "<span>SRT 助手</span><span>−</span>" : "SRT";
      body.style.display = open ? "" : "none";
    };
    apply(false); // 默认折叠
    panel.expand = () => apply(true); // 供错误通知自动展开
    panel.addEventListener("click", () => {
      if (body.style.display === "none") apply(true);
    });
    title.addEventListener("click", (e) => {
      if (body.style.display !== "none") {
        e.stopPropagation();
        apply(false);
      }
    });

    const rowStyle =
      "display:flex;align-items:center;justify-content:space-between;" +
      "padding:6px 8px;margin:1px 8px;border-radius:8px;cursor:pointer;";
    const labelStyle = "color:#e4e4e7;";

    function toggleRow(label, key, get, set) {
      const row = document.createElement("div");
      row.className = "ds-row";
      row.style.cssText = rowStyle;
      const span = document.createElement("span");
      span.textContent = label;
      span.style.cssText = labelStyle;
      // 滑动开关
      const state = document.createElement("span");
      state.style.cssText =
        "width:26px;height:14px;border-radius:7px;background:#3f3f46;position:relative;" +
        "flex-shrink:0;";
      const knob = document.createElement("span");
      knob.style.cssText =
        "position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;" +
        "background:#a1a1aa;";
      state.appendChild(knob);
      const paint = () => {
        state.style.background = get() ? "#4d6bfe" : "#3f3f46";
        knob.style.left = get() ? "14px" : "2px";
        knob.style.background = get() ? "#fff" : "#a1a1aa";
      };
      paint();
      row.appendChild(span);
      row.appendChild(state);
      row.addEventListener("click", () => {
        set(!get());
        GM_setValue(key, get());
        paint();
      });
      return row;
    }

    // 行内编辑行：label + ✎，点击换成输入框（回车/失焦保存）。
    // getText 是显示文案；getEdit（可选）是输入框里的可编辑值（如 label 显示「3~5s 随机」、输入框显示「3」）
    function inlineEditRow(prefix, getText, onSave, getEdit) {
      const row = document.createElement("div");
      row.className = "ds-row";
      row.style.cssText = rowStyle;
      const label = document.createElement("span");
      label.style.cssText =
        labelStyle +
        "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
      const paint = () => (label.textContent = prefix + getText());
      paint();
      const ic = document.createElement("span");
      ic.textContent = "✎";
      ic.style.cssText = "color:#71717a;margin-left:6px;flex-shrink:0;";
      row.appendChild(label);
      row.appendChild(ic);
      row.addEventListener("click", () => {
        const input = document.createElement("input");
        input.type = "text";
        input.value = getEdit ? getEdit() : getText();
        input.style.cssText =
          "flex:1;min-width:0;background:#111;color:#fff;border:1px solid #4d6bfe;" +
          "border-radius:6px;padding:3px 6px;font-size:11px;outline:none;";
        label.replaceWith(input);
        input.focus();
        input.select();
        const save = () => {
          const v = input.value.trim();
          if (v) onSave(v);
          input.replaceWith(label);
          paint();
        };
        input.addEventListener("blur", save);
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            save();
          }
          if (e.key === "Escape") input.replaceWith(label);
        });
      });
      return row;
    }

    // 提示词行
    const promptRow = inlineEditRow(
      "提示词: ",
      () => promptText,
      (v) => {
        promptText = v;
        GM_setValue(STORAGE.PROMPT, promptText);
      },
    );
    // 发送间隔行（基准秒，实际基准~基准+2s 随机；批量防风控）。输入框直接输基准数字
    const delayRow = inlineEditRow(
      "发送间隔: ",
      () => sendDelaySec + "~" + (sendDelaySec + 2) + "s 随机",
      (v) => {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 0) {
          sendDelaySec = n;
          GM_setValue(STORAGE.DELAY, n);
        }
      },
      () => String(sendDelaySec),
    );

    const batchBtn = document.createElement("button");
    batchBtn.id = "ds-batch-btn";
    batchBtn.textContent = "批量上传 MD/SRT";
    batchBtn.style.cssText =
      "width:calc(100% - 24px);margin:6px 12px 2px;padding:8px 0;border:none;border-radius:8px;" +
      "background:#4d6bfe;color:#fff;font-size:12px;font-weight:600;cursor:pointer;";
    batchBtn.addEventListener("click", () => {
      if (batch.running) {
        stopBatch();
        return;
      }
      if (batch.tasks.length && batch.pendingFiles?.length) {
        logMsg("开始处理 " + batch.tasks.length + " 个文件");
        runBatch(batch.pendingFiles);
      } else {
        logMsg("打开批量文件选择器");
        pickBatchFiles();
      }
    });

    // 任务列表区（选文件后展示，可逐项看状态）
    const taskBox = document.createElement("div");
    taskBox.id = "ds-taskbox";
    taskBox.style.cssText = "display:none;margin:4px 12px 0;";
    const taskHead = document.createElement("div");
    taskHead.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;" +
      "padding:2px 0 4px;font-weight:600;";
    const taskTitle = document.createElement("span");
    taskTitle.textContent = "任务";
    const clearLink = document.createElement("span");
    clearLink.textContent = "清空";
    clearLink.style.cssText = "cursor:pointer;color:#a1a1aa;font-weight:400;font-size:11px;";
    clearLink.addEventListener("click", clearTasks);
    taskHead.appendChild(taskTitle);
    taskHead.appendChild(clearLink);
    const taskList = document.createElement("div");
    taskList.id = "ds-tasklist";
    taskList.style.cssText =
      "max-height:150px;overflow-y:auto;font-size:11px;line-height:1.5;" +
      "border-top:1px solid rgba(255,255,255,.08);";
    taskBox.appendChild(taskHead);
    taskBox.appendChild(taskList);

    body.appendChild(taskBox);
    body.appendChild(
      toggleRow(
        "自动填空 (SRT)",
        STORAGE.ENABLED,
        () => autoFillEnabled,
        (v) => (autoFillEnabled = v),
      ),
    );
    body.appendChild(
      toggleRow(
        "自动填空 (MD)",
        STORAGE.MD,
        () => mdAutoFillEnabled,
        (v) => (mdAutoFillEnabled = v),
      ),
    );
    body.appendChild(
      toggleRow(
        "发送后新对话",
        STORAGE.NEWCHAT,
        () => newChatAfterSend,
        (v) => (newChatAfterSend = v),
      ),
    );
    body.appendChild(promptRow);
    body.appendChild(delayRow);
    body.appendChild(batchBtn);
    setBatchBtnState();

    const statusRow = document.createElement("div");
    statusRow.id = "ds-status";
    statusRow.style.cssText =
      "margin:8px 12px 0;padding-top:8px;border-top:1px solid rgba(255,255,255,.12);" +
      "color:#a1a1aa;font-size:11px;line-height:1.5;";
    statusRow.textContent = getStatusText();
    body.appendChild(statusRow);

    // 进度条（运行中显示）
    const progress = document.createElement("div");
    progress.id = "ds-progress";
    progress.style.cssText =
      "margin:4px 12px 0;height:3px;border-radius:2px;background:#27272a;overflow:hidden;display:none;";
    const bar = document.createElement("div");
    bar.style.cssText = "height:100%;width:0;background:#4d6bfe;";
    progress.appendChild(bar);
    body.appendChild(progress);

    const notice = document.createElement("div");
    notice.id = "ds-notice";
    notice.style.cssText =
      "margin:6px 12px 0;color:#a1a1aa;font-size:11px;line-height:1.4;min-height:1.2em;word-break:break-all;";
    body.appendChild(notice);

    // 日志区：默认收起，点击标题展开；运行中自动展开
    const logHead = document.createElement("div");
    logHead.style.cssText =
      "display:flex;align-items:center;justify-content:space-between;margin:6px 12px 0;" +
      "cursor:pointer;font-size:11px;color:#a1a1aa;";
    const logTitle = document.createElement("span");
    logTitle.textContent = "运行日志 ▸";
    const copyBtn = document.createElement("button");
    copyBtn.textContent = "复制日志";
    copyBtn.style.cssText =
      "padding:2px 8px;background:#3f3f46;color:#e4e4e7;border:none;border-radius:6px;" +
      "cursor:pointer;font-size:10px;";
    copyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const text = batch.logs.join("\n") || "（无日志）";
      navigator.clipboard.writeText(text).then(() => {
        const prev = copyBtn.textContent;
        copyBtn.textContent = "已复制！";
        setTimeout(() => (copyBtn.textContent = prev), 1200);
      });
    });
    logHead.appendChild(logTitle);
    logHead.appendChild(copyBtn);
    const logBox = document.createElement("div");
    logBox.id = "ds-log";
    logBox.style.cssText =
      "display:none;margin:4px 12px 10px;max-height:130px;overflow-y:auto;font-family:monospace;" +
      "font-size:10px;color:#71717a;line-height:1.5;user-select:text;word-break:break-all;";
    body.appendChild(logHead);
    body.appendChild(logBox);
    const toggleLog = (show) => {
      logBox.style.display = show ? "block" : "none";
      logTitle.textContent = show ? "运行日志 ▾" : "运行日志 ▸";
    };
    logHead.addEventListener("click", () => toggleLog(logBox.style.display === "none"));

    document.body.appendChild(panel);
    return statusRow;
  }

  function panelNotice(text, isError) {
    const panel = document.getElementById("ds-panel");
    if (!panel) buildPanel();
    if (isError) panel.expand?.(); // 错误时自动展开面板
    const notice = document.getElementById("ds-notice");
    if (!notice) return;
    notice.textContent = text;
    notice.style.color = isError ? "#f87171" : "#a1a1aa";
    notice.dataset.ts = String(Date.now());
    setTimeout(() => {
      if (Date.now() - Number(notice.dataset.ts || 0) >= 3000) notice.textContent = "";
    }, 3200);
  }
  function getStatusText() {
    if (batch.running) {
      return (
        "处理中 " +
        (batch.done + batch.failed) +
        "/" +
        batch.total +
        "（进行中 " +
        countNewChatSessions() +
        "）"
      );
    }
    if (batch.total > 0)
      return (
        "上次：成功 " +
        batch.done +
        "，失败 " +
        batch.failed +
        (batch.lastError ? "｜" + batch.lastError : "")
      );
    return ""; // 无任务时不显示状态
  }

  // 面板状态刷新：并入 logMsg（batch 每次变化的必经点）

  // === 核心：把 .srt 伪装成 .txt（拦截 File.name/type + FormData 替换）===
  const origNameDesc = Object.getOwnPropertyDescriptor(File.prototype, "name");
  const origTypeDesc = Object.getOwnPropertyDescriptor(File.prototype, "type");

  // .srt 触发自动填空并改名；.md 在开关开启时只填空
  if (origNameDesc) {
    Object.defineProperty(File.prototype, "name", {
      get() {
        const name = origNameDesc.get.call(this);
        if (/\.srt$/i.test(name)) {
          if (autoFillEnabled) scheduleAutoFill();
          return name.replace(/\.srt$/i, ".txt");
        }
        if (/\.md$/i.test(name) && mdAutoFillEnabled) scheduleAutoFill();
        return name;
      },
      configurable: true,
    });
  }

  // .srt 的 MIME 伪装为 text/plain，绕过前端格式校验
  if (origTypeDesc) {
    Object.defineProperty(File.prototype, "type", {
      get() {
        const name = origNameDesc.get.call(this);
        return /\.srt$/i.test(name) ? "text/plain" : origTypeDesc.get.call(this);
      },
      configurable: true,
    });
  }

  // 关键：FormData 序列化不走 JS getter（Blink 读内部槽位），
  // 所以必须在入 FormData 时把 .srt 换成新的 .txt File 对象，服务器才收到 .txt 名。
  function wrapSrt(value) {
    if (value instanceof File) {
      try {
        const name = origNameDesc.get.call(value);
        if (/\.srt$/i.test(name)) {
          logMsg("SRT 伪装: " + name + " → " + name.replace(/\.srt$/i, ".txt"));
          return new File([value], name.replace(/\.srt$/i, ".txt"), {
            type: "text/plain",
            lastModified: value.lastModified,
          });
        }
      } catch (e) {
        logMsg("SRT 伪装异常: " + e.message);
      }
    }
    return value;
  }
  const fdProto = FormData.prototype;
  const origAppend = fdProto.append;
  fdProto.append = function (name, value, filename) {
    return origAppend.call(this, name, wrapSrt(value), filename);
  };
  const origSet = fdProto.set;
  fdProto.set = function (name, value, filename) {
    return origSet.call(this, name, wrapSrt(value), filename);
  };

  // === 自动填空与发送后新对话 ===
  // React 受控组件必须用原生 setter 赋值并派发 input 事件，才能触发其 onChange
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;

  function findInput() {
    const sel = [
      'textarea[placeholder*="消息"]',
      'textarea[placeholder*="Message"]',
      "#chat-input",
      '[role="textbox"]',
      "textarea",
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  // 查找“开启新对话”按钮：DeepSeek 中它是一个 div+span，不是 button
  function findNewChatButton() {
    const all = document.querySelectorAll("div[tabindex], button");
    for (const el of all) {
      const t = (el.textContent || "").trim();
      const aria = el.getAttribute("aria-label") || "";
      if (
        t === "开启新对话" ||
        t === "New chat" ||
        aria.includes("开启新对话") ||
        aria.includes("New chat")
      ) {
        return el;
      }
    }
    return null;
  }

  // 模拟官方快捷键开新对话（macOS 是 ⌘J，其他是 Ctrl+J）
  function shortcutNewChat() {
    const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
    document.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "j",
        bubbles: true,
        ...(isMac ? { metaKey: true } : { ctrlKey: true }),
      }),
    );
  }

  let pendingFill = false;
  let watchingSend = false;
  // 批量预览激活时禁止自动填空（showBatchPreview 读取 f.name 会误触 File getter）
  let batchPreviewActive = false;

  // 发送后开新对话：监听 URL。DeepSeek 发消息后进会话页 /a/chat/s/...，开新对话回 /。
  // 注意：若在已有会话里发消息（URL 不变）则检测不到。
  function watchSendThenNewChat() {
    if (!newChatAfterSend || watchingSend) return;
    watchingSend = true;
    logMsg("发送后新对话: 开始监听 URL");
    let lastUrl = location.href;
    const timer = setInterval(() => {
      const url = location.href;
      if (url === lastUrl) return;
      lastUrl = url;
      if (!/\/a\/chat\/s\//.test(url)) return; // 只认进入会话页
      clearInterval(timer);
      watchingSend = false;
      // 防抖：等路由稳定、DOM 重建完成再触发
      setTimeout(() => {
        const btn = findNewChatButton();
        if (btn) {
          logMsg("发送后新对话: 点击开启新对话按钮");
          btn.click();
        } else {
          logMsg("发送后新对话: 未找到按钮，用快捷键 Ctrl+J");
          shortcutNewChat();
        }
      }, 300);
    }, 300);
  }

  // 自动填空：等输入框渲染出来；已有内容则不覆盖。批量期间（预览/运行）禁用，processFile 自己填空
  function scheduleAutoFill() {
    if (batchPreviewActive || batch.running) return;
    if (pendingFill) return;
    logMsg("自动填空排队");
    pendingFill = true;

    let attempts = 0;
    const maxAttempts = 15;
    function retry() {
      // 批量预览/运行激活后取消排队中的填空（processFile 自己会填空）
      if (batchPreviewActive || batch.running) {
        pendingFill = false;
        return;
      }
      attempts++;
      const input = findInput();
      if (input) {
        if (input.value.trim()) {
          pendingFill = false;
          return;
        }
        nativeSetter.call(input, promptText);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.focus();
        logMsg("已自动填提示词");
        pendingFill = false;
        watchSendThenNewChat();
      } else if (attempts < maxAttempts) {
        setTimeout(retry, 300);
      } else {
        pendingFill = false;
        logMsg("自动填空失败: " + maxAttempts + " 次未找到输入框");
      }
    }
    setTimeout(retry, 500);
  }

  // === 批量处理（并发 2，侧边栏实时计数）===
  // 发送前查闸：侧边栏「新对话」会话数 < 2 才放行下一个文件。
  // 完成信号：生成完成后 DeepSeek 自动把会话标题改为内容摘要，计数减少。
  const MAX_CONCURRENT = 2;
  const batch = {
    running: false,
    queue: [],
    stop: false,
    fileReady: false,
    fileReadyDom: false,
    uploadId: "",
    currentFileName: "",
    sent: false,
    lastError: "",
    errors: [],
    tasks: [],
    pendingFiles: null,
    logs: [],
    total: 0,
    done: 0,
    failed: 0,
  };

  function waitFor(pred, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function poll() {
        if (pred()) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(poll, 500);
      })();
    });
  }

  // 面板日志：进面板（ds-log）实时显示可复制；同时刷新状态栏与进度条（batch 变化必经点）
  function logMsg(line) {
    const d = new Date();
    const ts =
      String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
    batch.logs.push("[" + ts + "] " + line);
    if (batch.logs.length > 1000) batch.logs.shift();
    const box = document.getElementById("ds-log");
    if (box) {
      // 运行中自动展开日志区
      box.style.display = "block";
      const head = box.previousElementSibling;
      if (head?.firstChild) head.firstChild.textContent = "运行日志 ▾";
      const row = document.createElement("div");
      row.textContent = "[" + ts + "] " + line;
      box.appendChild(row);
      box.scrollTop = box.scrollHeight;
    }
    // 状态栏 + 进度条同步（面板可能尚未构建，getElementById 为空则跳过）
    const panel = document.getElementById("ds-panel");
    if (panel) {
      const status = panel.querySelector("#ds-status");
      if (status) status.textContent = getStatusText();
      // 折叠时小按钮显示运行红点
      if (panel.dataset.open === "0") {
        const t = panel.querySelector("#ds-title");
        if (t) t.innerHTML = batch.running ? 'SRT <span style="color:#f87171">●</span>' : "SRT";
      }
      const progress = panel.querySelector("#ds-progress");
      const bar = progress?.firstChild;
      if (progress && bar) {
        if (batch.running && batch.total > 0) {
          progress.style.display = "block";
          bar.style.width = ((batch.done + batch.failed) / batch.total) * 100 + "%";
        } else {
          progress.style.display = "none";
        }
      }
    }
  }

  // DeepSeek XHR 信号：fetch_files 确认上传成功，upload_file 记录日志
  function handleDeepSeekSignals(url, xhr) {
    if (!batch.running) return;
    try {
      const short = url.replace("https://chat.deepseek.com", "");
      if (url.includes("fetch_files")) {
        const d = JSON.parse(xhr.responseText);
        const files = d?.data?.biz_data?.files || d?.data?.files || [];
        const summary = files.map((f) => (f.file_name || f.name) + ":" + (f.status || "?"));
        logMsg(
          "fetch_files(" +
            xhr.status +
            "): " +
            (summary.join(", ") || "(空)") +
            " | 期望: " +
            batch.currentFileName,
        );
        // 完整响应体（截断）——繁忙/拒绝时 biz_error 等信息在这里面
        logMsg(
          "fetch_files 响应: " +
            String(xhr.responseText || "")
              .replace(/\s+/g, " ")
              .slice(0, 300),
        );
        const norm = (s) =>
          String(s || "")
            .replace(/\s+/g, " ")
            .trim();
        const f = files.find((f) => norm(f.file_name || f.name) === norm(batch.currentFileName));
        if (f?.status === "SUCCESS") {
          logMsg("XHR fetch_files: SUCCESS");
          batch.fileReady = true;
          notifyFileReady(true, batch.currentFileName);
        } else if (f?.status === "FAIL") {
          logMsg("XHR fetch_files: 服务器拒绝 (FAIL)");
          notifyFileReady(false, batch.currentFileName);
        }
      }
      if (short.startsWith("/api/v0/file/upload_file")) {
        if (xhr.status !== 200) {
          logMsg(
            "upload_file 非 200 (" +
              xhr.status +
              "): " +
              String(xhr.responseText || "")
                .replace(/\s+/g, " ")
                .slice(0, 300),
          );
        }
        try {
          const d = JSON.parse(xhr.responseText);
          const biz = d?.data?.biz_data || {};
          // 服务器限流：立即停批，继续上传只会重复触发限流并残留异常附件
          if (d?.data?.biz_code === 7 || /rate limit/i.test(String(d?.data?.biz_msg || ""))) {
            logMsg("触发 rate limit（服务器限流），停止批量。建议调大发送间隔或稍后再试");
            batch.stop = true;
          }
          logMsg(
            "upload_file: " +
              xhr.status +
              " " +
              (biz.status || "?") +
              " (" +
              (biz.name || "?") +
              ")",
          );
          // 完整响应体（截断）——服务器繁忙时的错误信息在这里面
          logMsg(
            "upload_file 响应: " +
              String(xhr.responseText || "")
                .replace(/\s+/g, " ")
                .slice(0, 300),
          );
          const id = biz.id;
          if (id) {
            batch.uploadId = id;
            logMsg("upload_file id: " + id.slice(0, 24) + "…");
          } else {
            logMsg("upload_file 响应无 id，可能失败");
          }
          // 服务器直接回 SUCCESS（无需 PENDING→fetch_files 流程）时立即放行，
          // 否则前端可能不发 fetch_files，会一直等到超时
          if (biz.status === "SUCCESS" && !batch.fileReady) {
            logMsg("upload_file 即 SUCCESS，直接就绪");
            batch.fileReady = true;
            notifyFileReady(true, batch.currentFileName);
          }
        } catch {
          logMsg(
            "upload_file 响应解析失败: " +
              xhr.status +
              " " +
              String(xhr.responseText || "").slice(0, 120),
          );
        }
      }
      if (url.includes("/api/v0/chat/completion")) {
        // 发送响应：200 = 已受理（SSE 首行含消息状态），非 200 = 发送失败
        if (xhr.status === 200) {
          const first =
            String(xhr.responseText || "")
              .split("\n")
              .find((l) => l.trim().startsWith("data:")) || "";
          logMsg("completion 响应: 200" + (first ? " | " + first.trim().slice(0, 100) : ""));
        } else {
          // 发送失败：撤销 sent 标记，让 processFile 判「发送未确认」并记失败
          batch.sent = false;
          logMsg(
            "completion 响应: " +
              xhr.status +
              "（发送失败） " +
              String(xhr.responseText || "")
                .replace(/\s+/g, " ")
                .slice(0, 500),
          );
        }
      }
    } catch (e) {
      logMsg("信号解析错误: " + url + " " + e.message);
    }
  }

  const normName = (s) =>
    String(s || "")
      .replace(/\s+/g, " ")
      .trim();
  const shortName = (s) =>
    normName(s)
      .replace(/\.(md|srt|txt)$/i, "")
      .slice(0, 25);

  // 上传就绪：等 fetch_files SUCCESS（XHR 拦截或主动轮询）。
  // DOM chip 只说明 DeepSeek 已接收文件，不代表就绪（服务器繁忙时延后），发送才不会被吞。
  let fileReadyWaiters = []; // {name, resolve}，按文件名匹配，并发 2 互不误触
  function notifyFileReady(ok, name) {
    const target = name ? fileReadyWaiters.filter((w) => w.name === name) : fileReadyWaiters;
    fileReadyWaiters = name ? fileReadyWaiters.filter((w) => w.name !== name) : [];
    target.forEach((w) => w.resolve(ok));
  }
  // 主动 fetch_files 轮询：前端可能不发 fetch，必须等到明确状态才发送。返回停止函数。
  function pollFileStatus(name, resolve) {
    let stopped = false;
    let netErrLogged = false; // 网络错误只打一次，避免刷屏
    const poll = async () => {
      // 循环头检查停止标志：stop 可能在 await fetch 期间被调用，只清 timer 拦不住新一轮
      if (stopped) return;
      const id = batch.uploadId;
      if (!id) return setTimeout(poll, 2000);
      try {
        const r = await fetch("/api/v0/file/fetch_files?file_ids=" + encodeURIComponent(id), {
          credentials: "include",
          // 服务器繁忙时请求可能挂起，8s 无响应则放弃本轮重试（否则轮询死掉）
          signal: AbortSignal.timeout(8000),
        });
        if (!r.ok) {
          if (!netErrLogged) {
            netErrLogged = true;
            logMsg("主动 fetch_files: HTTP " + r.status);
          }
        } else {
          netErrLogged = false;
        }
        const d = await r.json();
        const files = d?.data?.biz_data?.files || [];
        const f = files.find((x) => normName(x.file_name || x.name) === normName(name));
        if (f?.status === "SUCCESS") {
          logMsg("主动 fetch_files: SUCCESS");
          batch.fileReady = true;
          resolve(true);
          return;
        }
        if (f?.status === "FAIL") {
          logMsg("主动 fetch_files: 服务器拒绝 (FAIL)");
          resolve(false);
          return;
        }
        // 每轮打状态（PENDING/PARSING 等），可见服务器处理进度与恢复时机
        logMsg(
          "主动 fetch_files 轮询: " +
            (f?.status || "未找到文件") +
            " (" +
            (f?.file_name || name).slice(0, 30) +
            ")",
        );
      } catch (e) {
        if (!netErrLogged) {
          netErrLogged = true;
          logMsg("主动 fetch_files: 请求异常 " + e.message);
        }
      }
      // fetch 返回后再查一次停止标志（stop 可能在 await 期间被调）
      if (stopped) return;
      setTimeout(poll, 2000);
    };
    poll();
    return () => (stopped = true);
  }
  async function waitFileReady(name, timeoutMs) {
    if (batch.fileReady || batch.stop) return true;
    return new Promise((resolve) => {
      let stop = null;
      let done = false;
      let timeoutId = null;
      let errMo = null;
      // 统一出口：resolve 后清理超时与轮询，避免残留回调
      const waiter = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timeoutId);
        if (errMo) errMo.disconnect();
        if (stop) stop();
        fileReadyWaiters = fileReadyWaiters.filter((w) => w !== waiter);
        resolve(ok);
      };
      fileReadyWaiters.push({ name, resolve: waiter });
      // DeepSeek 对上传失败的文件显示「请删除异常文件再发送」，用 MutationObserver 检测，命中即判失败
      errMo = new MutationObserver(() => {
        if (done) return;
        if (document.body.innerText.includes("请删除异常文件")) {
          logMsg("检测到「请删除异常文件」提示，文件上传失败");
          waiter(false);
        }
      });
      errMo.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      // upload_file 10s 无 id（服务器繁忙/响应异常）→ 快速失败，不空等 30s
      setTimeout(() => {
        if (done) return;
        if (!batch.uploadId) {
          logMsg("上传 10s 未拿到 uploadId，判定上传失败");
          waiter(false);
        }
      }, 10000);
      timeoutId = setTimeout(() => {
        logMsg("上传就绪等待超时，uploadId: " + (batch.uploadId || "空"));
        waiter(false);
      }, timeoutMs);
      // 先给 DeepSeek 前端 2s 发 fetch_files 的机会，未发则由主动轮询接管
      setTimeout(() => {
        if (batch.fileReady) return;
        stop = pollFileStatus(name, waiter);
      }, 2000);
    });
  }

  // 上传完成信号：fetch_files SUCCESS 或附件 chip 出现（兜底）。
  // MutationObserver 观察 body（React 可能重建输入框容器），只检查新增/变更节点文本。返回 observer 供调用方清理。
  function watchFileAppear(name) {
    const input = findInput();
    if (!input) {
      logMsg("watchFileAppear: 未找到输入框，跳过 DOM 监听");
      return null;
    }
    const needle = shortName(name); // 放宽匹配：chip 显示可能截断文件名
    const inPanel = (el) => el && el.nodeType === 1 && !!el.closest?.("#ds-panel");
    const check = () => {
      let el = input.parentElement;
      // 只查输入框附近的附件区（最多 8 层，不含 body——避免面板任务列表里的文件名误匹配）
      for (let i = 0; i < 8 && el && el !== document.body; i++) {
        if (inPanel(el)) break;
        if (el.innerText?.includes(needle)) return true;
        el = el.parentElement;
      }
      return false;
    };
    if (check()) {
      logMsg("附件区已见文件名（初始检查）");
      batch.fileReadyDom = true; // 仅标记：发送仍等 fetch_files SUCCESS（服务器繁忙时 chip 早于就绪）
      return null;
    }
    const mo = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === "characterData") {
          if (inPanel(m.target)) continue;
          if (m.target.textContent?.includes(needle)) {
            logMsg("附件区已见文件名（DOM 变更）");
            batch.fileReadyDom = true;
            mo.disconnect();
            return;
          }
        }
        for (const node of m.addedNodes) {
          if (inPanel(node)) continue;
          const t =
            node.nodeType === 3 ? node.textContent : node.nodeType === 1 ? node.innerText : "";
          if (t?.includes(needle)) {
            logMsg("附件区已见文件名（DOM 变更）");
            batch.fileReadyDom = true;
            mo.disconnect();
            return;
          }
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    return mo;
  }

  // 注入文件到 DeepSeek 隐藏 input 并触发 change（与拖入效果一致）
  function injectFile(file) {
    const input = document.querySelector('input[type="file"]');
    if (!input) return false;
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  // DeepSeek 发送按钮：圆形图标按钮（无 aria-label/title，tooltip 是自定义组件）。
  // 按位置+形状匹配：输入框附近范围内最后一个圆形小按钮（发送按钮在输入区最右）。
  function findSendButton() {
    const input = findInput();
    if (!input) return null;
    let root = input;
    for (let i = 0; i < 6 && root.parentElement; i++) root = root.parentElement;
    const btns = root.querySelectorAll('button, [role="button"]');
    let found = null;
    for (const b of btns) {
      if (b.closest("#ds-panel")) continue;
      const r = b.getBoundingClientRect();
      if (r.width < 60 && r.height < 60) {
        const cs = getComputedStyle(b);
        if (cs.borderRadius === "50%" || /%/.test(cs.borderRadius)) found = b;
      }
    }
    return found;
  }

  // 发送并确认：循环重试（服务器繁忙时 couldSubmit 延迟就绪，单次点击/Enter 会被吞）。
  // 每轮：点按钮（2s）→ 未确认则补 Enter（2.5s）→ 循环直到 sent 或 30s 超时。
  // 确认 = completion 请求已发出（send 拦截置 batch.sent）或 URL 跳会话页；
  // 不会双发：生效时 sent 立即置 true，未生效时无副作用。
  async function sendAndConfirm() {
    batch.sent = false;
    const deadline = Date.now() + 30000;
    let round = 0;
    while (Date.now() < deadline && !batch.stop) {
      round++;
      // 异常附件提示 = 当前文件无法发送，立即失败，不白等 30s 重试
      if (document.body.innerText.includes("请删除异常文件")) {
        logMsg("检测到「请删除异常文件」，发送中止");
        return false;
      }
      const btn = findSendButton();
      if (btn) {
        logMsg("点击发送按钮");
        btn.click();
        const ok = await waitFor(
          () => batch.sent || /\/a\/chat\/s\//.test(location.href) || batch.stop,
          2000,
        );
        if (ok || batch.stop) return !batch.stop;
      } else {
        logMsg("未找到发送按钮");
      }
      const input = findInput();
      if (input) {
        logMsg("改用 Enter 发送");
        input.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
        const ok = await waitFor(() => batch.sent || /\/a\/chat\/s\//.test(location.href), 2500);
        if (ok) return true;
      }
      logMsg(
        "发送未确认，重试（第 " +
          round +
          " 轮，剩余 " +
          Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) +
          "s）",
      );
    }
    return false;
  }

  // 确保输入框干净：会话页先回首页；首页有残留草稿则开新对话清除。
  // force=true 时无条件开新对话（失败后清残留附件，防止文件叠加进同一会话）
  async function ensureHomeInput(force) {
    if (force || /\/a\/chat\/s\//.test(location.href)) {
      logMsg(force ? "开新对话（强制清理残留）" : "开新对话（回首页）");
      const btn = findNewChatButton();
      if (btn) btn.click();
      else shortcutNewChat();
      const home = await waitFor(() => !/\/a\/chat\/s\//.test(location.href), 2500);
      if (!home) logMsg("回首页等待超时，仍停留在会话页");
    }
    const input = findInput();
    if (input && input.value.trim()) {
      logMsg("首页有残留草稿，开新对话清理");
      const btn = findNewChatButton();
      if (btn) btn.click();
      else shortcutNewChat();
      await waitFor(() => {
        const el = findInput();
        return !el || !el.value.trim();
      }, 2500);
    }
  }

  async function processFile(origFile) {
    await ensureHomeInput();
    logMsg("== 上传开始: " + origFile.name);
    const task = batch.tasks.find((t) => t.status === "等待");
    if (task) {
      task.status = "处理中";
      renderTaskList();
    }
    let file = origFile;
    // DeepSeek 不认 .srt，批量注入前伪装成 .txt（同单文件拖入逻辑）
    if (/\.srt$/i.test(file.name)) {
      file = new File([file], file.name.replace(/\.srt$/i, ".txt"), { type: "text/plain" });
    }
    batch.currentFileName = file.name;
    if (!injectFile(file)) throw new Error("未找到文件输入框");
    batch.fileReady = false;
    batch.fileReadyDom = false;
    batch.uploadId = "";
    logMsg("等待上传就绪: " + file.name);
    const mo = watchFileAppear(file.name);
    const ready = await waitFileReady(file.name, 30000);
    if (mo) mo.disconnect();
    if (batch.stop) throw new Error("已停止");
    if (!ready) {
      logMsg("上传超时: " + file.name);
      throw new Error("上传未就绪（服务器繁忙或处理失败）");
    }

    // 填空（输入框已有内容则不覆盖）
    await waitFor(() => !!findInput(), 5000);
    const input = findInput();
    if (input && !input.value.trim()) {
      nativeSetter.call(input, promptText);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      logMsg("批量填空: " + promptText);
    } else {
      logMsg("输入框已有内容或未找到，跳过填空");
    }

    await sendAndConfirm();
    const sent = await waitFor(() => batch.sent || /\/a\/chat\/s\//.test(location.href), 7000);
    if (!sent) throw new Error("发送未确认（无 completion 请求）");
    if (task) {
      task.status = "生成中";
      renderTaskList();
    }
    logMsg("已发送: " + file.name);
  }

  // 多轨道时下拉选择（不弹系统 prompt）
  function chooseTrack(tracks) {
    return new Promise((resolve) => {
      const select = document.createElement("select");
      select.style.cssText =
        "margin-top:10px;width:100%;background:#111;color:#e4e4e7;border:1px solid #3f3f46;" +
        "border-radius:8px;padding:6px;font-size:12px;";
      tracks.forEach((t, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent =
          (t.name?.simpleText || t.languageCode) +
          " (" +
          t.languageCode +
          ")" +
          (t.kind === "asr" ? " [自动]" : "");
        select.appendChild(opt);
      });
      // 轨道选择浮层（内联，唯一调用者）
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483001;" +
        "display:flex;align-items:center;justify-content:center;";
      const box = document.createElement("div");
      box.style.cssText =
        "background:#18181b;color:#fff;border-radius:12px;padding:16px;width:440px;" +
        "max-height:75vh;display:flex;flex-direction:column;font-size:12px;" +
        "box-shadow:0 8px 40px rgba(0,0,0,.5);";
      const title = document.createElement("div");
      title.textContent = "选择字幕轨道";
      title.style.cssText =
        "font-weight:600;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.12);";
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;";
      const mkBtn = (text, primary, onClick) => {
        const b = document.createElement("button");
        b.textContent = text;
        b.style.cssText =
          "padding:6px 16px;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;" +
          (primary ? "background:#4d6bfe;color:#fff;" : "background:#3f3f46;color:#e4e4e7;");
        b.addEventListener("click", onClick);
        return b;
      };
      row.appendChild(
        mkBtn("取消", false, () => {
          overlay.remove();
          resolve(null);
        }),
      );
      row.appendChild(
        mkBtn("下载", true, () => {
          overlay.remove();
          resolve(tracks[Number(select.value)]);
        }),
      );
      box.appendChild(title);
      box.appendChild(select);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
    });
  }

  // === 任务列表（面板内）===
  function renderTaskList() {
    const list = document.getElementById("ds-tasklist");
    if (!list) return;
    list.innerHTML = "";
    batch.tasks.forEach((t, i) => {
      const row = document.createElement("div");
      row.style.cssText =
        "padding:3px 0;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap;" +
        "overflow:hidden;text-overflow:ellipsis;";
      const color =
        t.status === "完成"
          ? "#4ade80"
          : t.status === "失败"
            ? "#f87171"
            : t.status === "生成中"
              ? "#fbbf24"
              : t.status === "处理中"
                ? "#60a5fa"
                : "#a1a1aa";
      row.style.color = color;
      row.textContent = i + 1 + ". " + t.name + (t.status === "等待" ? "" : "  " + t.status);
      list.appendChild(row);
    });
  }

  function setBatchBtnState() {
    const btn = document.getElementById("ds-batch-btn");
    if (!btn) return;
    if (batch.running) {
      btn.disabled = false;
      btn.textContent = "停止处理";
      btn.style.background = "#ef4444";
      return;
    }
    btn.style.background = "#4d6bfe";
    if (batch.tasks.length && batch.pendingFiles?.length) {
      btn.textContent = "开始处理（" + batch.tasks.length + "）";
      return;
    }
    btn.textContent = "批量上传 MD/SRT";
  }

  function stopBatch() {
    // 停止批量：剩余任务标记已停止，本次批次作废（需重新选文件）
    batch.stop = true;
    batch.running = false;
    batch.pendingFiles = null; // 已停止的批次作废，重新选文件
    batch.tasks.forEach((t) => {
      if (t.status === "处理中" || t.status === "生成中" || t.status === "等待") {
        t.status = "已停止";
      }
    });
    renderTaskList();
    setBatchBtnState();
    logMsg("已停止，剩余任务未处理");
    panelNotice("已停止，剩余任务未处理", true);
  }

  function clearTasks() {
    batchPreviewActive = false;
    batch.pendingFiles = null;
    logMsg("任务列表已清空");
    batch.tasks = [];
    const box = document.getElementById("ds-taskbox");
    if (box) box.style.display = "none";
    setBatchBtnState();
  }

  function showBatchPreview(files) {
    batchPreviewActive = true;
    batch.pendingFiles = files;
    logMsg("预览 " + files.length + " 个文件");
    batch.tasks = files.map((f) => ({ name: f.name, status: "等待" }));
    const box = document.getElementById("ds-taskbox");
    if (box) box.style.display = "block";
    renderTaskList();
    setBatchBtnState();
  }

  let sidebarBaseline = 0;
  let lastNewChatCount = 0;

  function countNewChatSessions() {
    return Math.max(
      0,
      [...document.querySelectorAll('a[href*="/a/chat/s/"]')].filter((l) =>
        /新对话/.test(l.innerText || ""),
      ).length - sidebarBaseline,
    );
  }

  // 侧边栏「新对话」会话数 = 真实进行中任务数（处理中 + 生成中）。
  // 生成完成时 DeepSeek 自动把标题改为内容摘要，计数减少 → 标记一个任务完成。
  let sidebarObserver = null;
  function startSidebarCounter() {
    if (sidebarObserver) sidebarObserver.disconnect();
    lastNewChatCount = countNewChatSessions();
    sidebarObserver = new MutationObserver(() => {
      const c = countNewChatSessions();
      if (c === lastNewChatCount) return;
      logMsg("侧边栏计数: " + lastNewChatCount + " → " + c);
      const delta = lastNewChatCount - c;
      lastNewChatCount = c;
      for (let i = 0; i < delta; i++) {
        const t = batch.tasks.find((t) => t.status === "生成中");
        if (t) {
          t.status = "完成";
          renderTaskList();
        }
      }
    });
    sidebarObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  // 批量主流程：排队 + 并发闸 + 失败记录。完成标记由 sidebarObserver 驱动。
  async function runBatch(files) {
    if (batch.running) return;
    batchPreviewActive = false;
    batch.running = true;
    batch.stop = false;
    batch.queue = [...files];
    batch.total = files.length;
    batch.done = 0;
    batch.failed = 0;
    batch.errors = [];
    batch.logs = [];
    const logBox = document.getElementById("ds-log");
    if (logBox) logBox.innerHTML = "";
    sidebarBaseline = countNewChatSessions(); // 历史「新对话」会话（用户手动开的）不计入并发
    logMsg("侧边栏基线: " + sidebarBaseline);
    lastNewChatCount = 0;
    startSidebarCounter();
    setBatchBtnState();
    logMsg("开始，共 " + batch.queue.length + " 个文件（并发 2）");
    while (batch.queue.length && !batch.stop) {
      // 并发闸：等侧边栏进行中会话 < 2。等待时提示当前占用。
      const cur = countNewChatSessions();
      if (cur >= MAX_CONCURRENT) {
        logMsg(
          "排队等待: 当前 " +
            cur +
            "/" +
            MAX_CONCURRENT +
            " 会话进行中（剩余 " +
            batch.queue.length +
            " 个文件）",
        );
      }
      await waitFor(() => countNewChatSessions() < MAX_CONCURRENT || batch.stop, 3600 * 1000);
      if (batch.stop) break;
      const file = batch.queue.shift();
      logMsg("出队: " + file.name + "（剩余 " + batch.queue.length + " 个）");
      try {
        await processFile(file);
        batch.done++;
        logMsg("完成 " + batch.done + "/" + batch.total);
        // 发送间隔节流：每处理完一个文件随机等 基准~基准+2s 再继续，防风控封禁
        if (!batch.stop && batch.queue.length && sendDelaySec > 0) {
          const waitMs = sendDelaySec * 1000 + Math.random() * 2000;
          logMsg("发送间隔等待 " + Math.round(waitMs / 1000) + "s…");
          await new Promise((r) => setTimeout(r, waitMs));
        }
      } catch (e) {
        if (batch.stop) break;
        batch.failed++;
        batch.lastError = e.message + "（" + file.name + "）";
        batch.errors.push({ file: file.name, msg: e.message });
        const failedTask = batch.tasks.find((t) => t.status === "处理中");
        if (failedTask) {
          failedTask.status = "失败";
          renderTaskList();
        }
        logMsg("失败: " + file.name + " - " + e.message);
        // 失败后强制开新对话，清掉残留附件/草稿，防止下一个文件叠加进同一会话
        try {
          await ensureHomeInput(true);
        } catch (e2) {
          logMsg("失败后清理异常: " + e2.message);
        }
        // 确认异常附件提示已消失；仍残留则等几秒再验一次（服务器繁忙时提示可能延迟消失）
        const errGone = await waitFor(
          () => !document.body.innerText.includes("请删除异常文件"),
          8000,
        );
        if (!errGone) logMsg("警告：异常文件提示未清除，下一个文件可能发送失败");
      }
    }
    await waitFor(() => countNewChatSessions() === 0 || batch.stop, 7200 * 1000);
    batch.running = false;
    logMsg("结束：成功 " + batch.done + " 失败 " + batch.failed + (batch.stop ? "（已停止）" : ""));
    setBatchBtnState();
  }

  function pickBatchFiles() {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".md,.srt";
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const files = [...input.files];
      input.remove();
      if (!files.length) return;
      showBatchPreview(files);
    });
    input.click();
  }

  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "u" || e.key === "U")) {
      e.preventDefault();
      try {
        pickBatchFiles();
      } catch {
        panelNotice("文件选择器需从面板按钮触发", true);
      }
    }
  });
  // 拦截 DeepSeek 附件按钮选中的文件：选多个 .md/.srt 时截住，不进 DeepSeek 附件区，直接批量处理。
  // 单文件走原流程（自动填空 + 手动发送），互不干扰。capture 阶段先于 React 监听。
  document.addEventListener(
    "change",
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || t.type !== "file" || t.hasAttribute("data-batch"))
        return;
      const files = [...t.files];
      if (files.length < 2) return;
      // 先锁批量预览再访问 f.name（getter 会触发自动填空，此时 showBatchPreview 还没跑）
      batchPreviewActive = true;
      if (!files.every((f) => /(\.md|\.srt)$/i.test(f.name))) {
        batchPreviewActive = false;
        return;
      }
      logMsg("拦截批量文件选择: " + files.length + " 个");
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      showBatchPreview(files);
    },
    true,
  );

  // === YouTube 字幕下载（仅 www.youtube.com 生效）===

  // pot token 捕获：YT 播放字幕时自己请求 api/timedtext（带 pot），从 XHR 响应 URL 提取缓存
  const timedtextUrlCache = new Map(); // videoId -> 完整 timedtext URL（含 pot，YT 自己请求的）
  const timedtextWaiters = new Map(); // videoId -> [resolve]，cacheTimedtextUrl 时直接 resolve（事件驱动）
  (function hookYoutubeNetwork() {
    function cacheTimedtextUrl(url) {
      try {
        if (url.includes("api/timedtext")) {
          const u = new URL(url);
          const v = u.searchParams.get("v");
          if (v) {
            timedtextUrlCache.set(v, url);
            const ws = timedtextWaiters.get(v);
            if (ws?.length) {
              timedtextWaiters.delete(v);
              ws.forEach((r) => r(url));
            }
          }
        }
      } catch (e) {
        logMsg("timedtext URL 缓存异常: " + e.message);
      }
    }

    // XHR
    const xhrProto = unsafeWindow.XMLHttpRequest?.prototype;
    if (xhrProto) {
      const origOpen = xhrProto.open;
      const origSend = xhrProto.send;
      xhrProto.open = function (method, url) {
        this.__ytSrtUrl = String(url);
        return origOpen.apply(this, arguments);
      };
      xhrProto.send = function () {
        try {
          const url = String(this.responseURL || this.__ytSrtUrl || "");
          // completion 请求发出 = 消息已成功发送（比 URL 跳转更可靠）
          if (url.includes("/api/v0/chat/completion") && batch.running) {
            batch.sent = true;
            logMsg("completion 请求已发出");
          }
          this.addEventListener("load", () => {
            const url = this.responseURL || this.__ytSrtUrl || "";
            cacheTimedtextUrl(url);
            handleDeepSeekSignals(url, this);
          });
        } catch (e) {
          // XHR 包装失败 = 信号系统整体失效（sent/fetch/upload 全无），必须暴露
          logMsg("XHR 包装异常: " + e.message);
        }
        return origSend.apply(this, arguments);
      };
    }
  })();

  // 播放器私有 API（getPlayerResponse）在沙箱不可用，改用 unsafeWindow 读页面全局。
  // 注意：SPA 切换视频后 ytInitialPlayerResponse 可能过期，用 videoId 校验。
  function getYoutubeVideoId() {
    return new URLSearchParams(location.search).get("v");
  }

  function getPlayerResponse() {
    const pr = unsafeWindow.ytInitialPlayerResponse;
    if (!pr?.videoDetails) return null;
    const videoId = getYoutubeVideoId();
    // SPA 切换视频后此变量可能是旧数据，校验 videoId
    if (videoId && pr.videoDetails.videoId !== videoId) return null;
    return pr;
  }

  // 确保字幕开启，触发 YT 发出 timedtext 请求（等按钮出现，等状态切换）
  async function ensureSubtitlesOn() {
    for (let i = 0; i < 10; i++) {
      const btn = document.querySelector(".ytp-subtitles-button");
      if (btn) {
        if (btn.getAttribute("aria-pressed") !== "true") {
          btn.click();
          // 等状态切换（最多 2s）
          for (let j = 0; j < 10; j++) {
            await new Promise((r) => setTimeout(r, 200));
            if (btn.getAttribute("aria-pressed") === "true") return;
          }
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  function waitForTimedtextUrl(videoId) {
    return new Promise((resolve) => {
      const existing = timedtextUrlCache.get(videoId);
      if (existing) return resolve(existing);
      const ws = timedtextWaiters.get(videoId) || [];
      ws.push(resolve);
      timedtextWaiters.set(videoId, ws);
      // 超时兜底：6s 没等到就放弃（事件源 = YT 播放器发 timedtext 请求的 XHR load）
      setTimeout(() => {
        const arr = timedtextWaiters.get(videoId) || [];
        const idx = arr.indexOf(resolve);
        if (idx >= 0) arr.splice(idx, 1);
        if (!arr.length) timedtextWaiters.delete(videoId);
        resolve(null);
      }, 6000);
    });
  }

  function formatTimestamp(ms) {
    const safe = Math.max(0, Math.floor(ms));
    const h = String(Math.floor(safe / 3600000)).padStart(2, "0");
    const m = String(Math.floor((safe % 3600000) / 60000)).padStart(2, "0");
    const s = String(Math.floor((safe % 60000) / 1000)).padStart(2, "0");
    const msPart = String(safe % 1000).padStart(3, "0");
    return h + ":" + m + ":" + s + "," + msPart;
  }

  function buildSrt(events) {
    const lines = [];
    events.forEach((event, index) => {
      const text = (event.segs || [])
        .map((seg) => (seg.utf8 || "").replace(/\s+/g, " ").trim())
        .join(" ")
        .trim();
      if (!text) return;

      const start = event.tStartMs || 0;
      const end = start + (event.dDurationMs || 0);
      lines.push(
        index + 1 + "\n" + formatTimestamp(start) + " --> " + formatTimestamp(end) + "\n" + text,
      );
    });
    return lines.join("\n\n");
  }

  function sanitizeFilename(name) {
    return (
      name
        .split("")
        .filter((c) => c.charCodeAt(0) >= 32) // 剔控制字符
        .join("")
        .replace(/[<>:"/\\|?*]/g, " ")
        .replace(/\s+/g, " ")
        .trim() || "youtube-subtitles"
    );
  }

  function downloadSrt(srt, filename) {
    const blob = new Blob([srt], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  // 生成 SRT 并触发下载；closeAfter 时尝试关闭标签页
  function finishDownload(events, closeAfter, title) {
    const srt = buildSrt(events);
    // SPA 切换后无播放器数据时用页面标题兜底
    const base = title || document.title.replace(/ - YouTube$/, "").trim() || getYoutubeVideoId();
    downloadSrt(srt, sanitizeFilename(base) + ".srt");
    if (closeAfter) {
      window.close();
      // 浏览器禁止关闭用户打开的标签页时，页面还在，此时提示
      setTimeout(() => {
        if (!window.closed) alert("浏览器不允许自动关闭页面，请手动关闭标签");
      }, 800);
    }
  }

  async function onDownload(button, closeAfter) {
    button.disabled = true;
    button.textContent = "获取中...";
    try {
      const playerResponse = getPlayerResponse();
      if (!playerResponse) {
        // SPA 切换视频后 ytInitialPlayerResponse 不更新 → 降级：
        // 触发字幕，复用 YT 自己的 timedtext 请求 URL（含 pot），不需要播放器数据
        logMsg("YT 下载: 播放器数据过期（SPA 切换），改用 timedtext 缓存路径");
        await ensureSubtitlesOn();
        const u = await waitForTimedtextUrl(getYoutubeVideoId());
        if (u) {
          const r = await fetch(u);
          if (r.ok) {
            const text = await r.text();
            try {
              const events = JSON.parse(text).events || [];
              if (events.length > 0) {
                logMsg("YT 降级路径: " + events.length + " 条字幕事件");
                finishDownload(events, closeAfter);
                return;
              }
            } catch {}
          }
        }
        logMsg("YT 下载: 未获取到播放器数据（无 timedtext 缓存）");
        alert("未获取到播放器数据，请刷新页面后重试");
        return;
      }
      const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      logMsg(
        "YT 下载: " +
          tracks.length +
          " 条字幕轨道（视频: " +
          (playerResponse.videoDetails?.title || "?").slice(0, 40) +
          "）",
      );
      if (tracks.length === 0) {
        alert("该视频没有可用字幕");
        return;
      }

      let track = tracks[0];
      if (tracks.length > 1) {
        track = await chooseTrack(tracks);
        if (!track) return;
        logMsg("YT 下载: 选择轨道 " + (track.name?.simpleText || track.languageCode));
      }

      const url = new URL(track.baseUrl);
      url.searchParams.set("fmt", "json3");

      let response = await fetch(url);
      let text = await response.text();
      logMsg("YT 字幕接口: HTTP " + response.status + " 长度 " + text.length);

      // 200 但空内容 = 需要 pot token。开字幕触发 YT 自己的 timedtext 请求，
      // 直接复用 YT 正在用的完整 URL（含 pot 和全部参数），比拼接 pot 可靠
      if (response.ok && !text.trim()) {
        logMsg("YT 字幕接口返回空，尝试开启字幕获取 pot token 版 URL");
        await ensureSubtitlesOn();
        const timedtextUrl = await waitForTimedtextUrl(playerResponse?.videoDetails?.videoId);
        if (timedtextUrl) {
          logMsg("YT timedtext 缓存命中（含 pot token）");
          const cachedResponse = await fetch(timedtextUrl);
          if (cachedResponse.ok) {
            const cachedText = await cachedResponse.text();
            try {
              const cachedEvents = JSON.parse(cachedText).events || [];
              if (cachedEvents.length > 0) {
                logMsg("YT 缓存字幕解析: " + cachedEvents.length + " 条事件");
                finishDownload(cachedEvents, closeAfter, playerResponse?.videoDetails?.title);
                return;
              }
            } catch {
              logMsg("YT 缓存 URL 非 JSON，落回常规路径");
            }
          }
        } else {
          logMsg("YT timedtext 6s 内未捕获，回退常规路径");
        }
      }

      if (!response.ok) {
        throw new Error(
          response.status === 403 ? "字幕接口被限流（403）" : "HTTP " + response.status,
        );
      }
      if (!text.trim()) {
        throw new Error("字幕接口返回空内容，请确认字幕可用并重试");
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error("接口返回异常: " + text.slice(0, 120));
      }
      const events = json.events || [];
      logMsg("YT 字幕解析: " + events.length + " 条事件");
      if (events.length === 0) {
        alert("未获取到字幕内容");
        return;
      }

      finishDownload(events, closeAfter, playerResponse?.videoDetails?.title);
      logMsg("YT 下载完成: " + (playerResponse.videoDetails?.title || "").slice(0, 40) + ".srt");
    } catch (error) {
      logMsg("YT 下载失败: " + error.message);
      alert("下载失败: " + error.message);
    } finally {
      button.disabled = false;
      button.textContent = closeAfter ? "下载并关闭" : "下载字幕";
    }
  }

  function createDownloadButton(text, closeAfter) {
    const button = document.createElement("button");
    button.textContent = text;
    button.style.cssText =
      "margin-left:12px;align-self:center;flex-shrink:0;" +
      "padding:6px 14px;border:none;border-radius:18px;" +
      "background:#065fd4;color:#fff;font-size:13px;font-weight:500;" +
      "cursor:pointer;white-space:nowrap;";
    button.addEventListener("click", () => onDownload(button, closeAfter));
    return button;
  }

  function ensureYoutubeButton() {
    if (!location.hostname.endsWith("youtube.com")) return;
    if (document.getElementById("yt-srt-download-btn")) return;

    // 视频标题右侧
    const titleEl = document.querySelector("#above-the-fold h1");
    if (!titleEl) return;
    const container = titleEl.closest("#title") || titleEl.parentElement;

    // 标题容器改成横向 flex，按钮才能跟在标题右侧
    container.style.cssText = "display:flex;align-items:center;flex-direction:row;flex-wrap:wrap;";
    const btnDownload = createDownloadButton("下载字幕", false);
    btnDownload.id = "yt-srt-download-btn";
    container.appendChild(btnDownload);
    container.appendChild(createDownloadButton("下载并关闭", true));
  }
  setInterval(ensureYoutubeButton, 2000);

  // 启动日志：确认脚本加载、配置与关键钩子状态（出问题先看这一行）
  logMsg(
    "SRT 助手已加载 | 自动填空 srt/md: " +
      autoFillEnabled +
      "/" +
      mdAutoFillEnabled +
      " | 提示词: " +
      promptText +
      " | 发送后新对话: " +
      newChatAfterSend +
      " | XHR 钩子: " +
      !!unsafeWindow.XMLHttpRequest +
      " | FormData 钩子: " +
      true,
  );
  // 面板首次构建（状态刷新已并入 logMsg）
  if (location.hostname === "chat.deepseek.com") buildPanel();
})();
