// ==UserScript==
// @name         DeepSeek SRT 上传助手 + YouTube 字幕下载
// @namespace    http://tampermonkey.net/
// @version      3.2
// @description  允许在 DeepSeek 直接上传 .srt 字幕文件（自动伪装为 .txt）。可选拖入 .srt/.md 时自动填入提示词。批量处理 MD 文件（并发 2 自动排队）。YouTube 页面添加“下载字幕”按钮。
// @author       Jerry
// @match        https://chat.deepseek.com/*
// @match        https://www.youtube.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=deepseek.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  // === 配置 ===
  const DEFAULT_PROMPT = "通俗易懂总结";
  const STORAGE = {
    ENABLED: "srtAutoFill",
    MD: "mdAutoFill",
    PROMPT: "srtPrompt",
    NEWCHAT: "newChatAfterSend",
  };
  let autoFillEnabled = GM_getValue(STORAGE.ENABLED, true);
  let mdAutoFillEnabled = GM_getValue(STORAGE.MD, false);
  let promptText = GM_getValue(STORAGE.PROMPT, DEFAULT_PROMPT);
  let newChatAfterSend = GM_getValue(STORAGE.NEWCHAT, false);

  // === 页面控制面板（仅 DeepSeek 页面）===
  function buildPanel() {
    if (location.hostname !== "chat.deepseek.com" || document.getElementById("ds-panel")) return;
    const panel = document.createElement("div");
    panel.id = "ds-panel";
    panel.style.cssText =
      "position:fixed;right:12px;top:64px;z-index:2147483000;width:190px;" +
      "background:rgba(24,24,27,.96);color:#fff;border-radius:10px;padding:10px 0;" +
      "font-size:12px;box-shadow:0 4px 20px rgba(0,0,0,.35);user-select:none;";

    // 标题栏：点击收起/展开面板内容
    const title = document.createElement("div");
    title.id = "ds-title";
    title.textContent = "SRT 助手 ▼";
    title.style.cssText =
      "padding:0 12px 8px;font-weight:600;border-bottom:1px solid rgba(255,255,255,.12);" +
      "margin-bottom:4px;cursor:pointer;";
    const body = document.createElement("div");
    body.id = "ds-body";
    panel.appendChild(title);
    panel.appendChild(body);
    title.addEventListener("click", () => {
      const open = body.style.display === "none";
      body.style.display = open ? "" : "none";
      title.textContent = open ? "SRT 助手 ▼" : "SRT 助手 ▶";
    });

    const rowStyle =
      "display:flex;align-items:center;justify-content:space-between;padding:5px 12px;cursor:pointer;";
    const labelStyle = "color:#e4e4e7;";

    function toggleRow(label, key, get, set) {
      const row = document.createElement("div");
      row.style.cssText = rowStyle;
      const span = document.createElement("span");
      span.textContent = label;
      span.style.cssText = labelStyle;
      // 滑动开关
      const state = document.createElement("span");
      state.style.cssText =
        "width:26px;height:14px;border-radius:7px;background:#3f3f46;position:relative;" +
        "transition:background .15s;flex-shrink:0;";
      const knob = document.createElement("span");
      knob.style.cssText =
        "position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;" +
        "background:#a1a1aa;transition:left .15s,background .15s;";
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

    const promptRow = document.createElement("div");
    promptRow.style.cssText = rowStyle;
    const promptLabel = document.createElement("span");
    promptLabel.style.cssText =
      labelStyle + "flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const paintPrompt = () => {
      promptLabel.textContent =
        "提示词: " + (promptText.length > 8 ? promptText.slice(0, 8) + "…" : promptText);
    };
    paintPrompt();
    promptRow.appendChild(promptLabel);
    promptRow.appendChild(editIcon());
    // 点击 → 行内编辑（替换为输入框，回车/失焦保存）
    promptRow.addEventListener("click", () => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = promptText;
      input.style.cssText =
        "flex:1;min-width:0;background:#111;color:#fff;border:1px solid #4d6bfe;" +
        "border-radius:6px;padding:3px 6px;font-size:11px;outline:none;";
      promptLabel.replaceWith(input);
      input.focus();
      input.select();
      const save = () => {
        const v = input.value.trim();
        if (v) {
          promptText = v;
          GM_setValue(STORAGE.PROMPT, promptText);
        }
        input.replaceWith(promptLabel);
        paintPrompt();
      };
      input.addEventListener("blur", save);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          save();
        }
        if (e.key === "Escape") input.replaceWith(promptLabel);
      });
    });

    function editIcon() {
      const ic = document.createElement("span");
      ic.textContent = "✎";
      ic.style.cssText = "color:#71717a;margin-left:6px;flex-shrink:0;";
      return ic;
    }

    const batchBtn = document.createElement("button");
    batchBtn.id = "ds-batch-btn";
    batchBtn.textContent = "批量上传 MD/SRT";
    batchBtn.style.cssText =
      "width:calc(100% - 24px);margin:6px 12px 2px;padding:7px 0;border:none;border-radius:8px;" +
      "background:#4d6bfe;color:#fff;font-size:12px;font-weight:600;cursor:pointer;";
    batchBtn.addEventListener("click", () => {
      if (batch.running) {
        stopBatch();
        return;
      }
      if (batch.tasks.length && batch.pendingFiles?.length) {
        runBatch(batch.pendingFiles);
      } else {
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
    bar.style.cssText = "height:100%;width:0;background:#4d6bfe;transition:width .3s;";
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
    window.__dsToggleLog = toggleLog;

    document.body.appendChild(panel);
    return statusRow;
  }

  function panelNotice(text, isError) {
    const panel = document.getElementById("ds-panel");
    if (!panel) buildPanel();
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
    return "就绪";
  }
  setInterval(() => {
    const panel = document.getElementById("ds-panel");
    if (!panel) {
      buildPanel();
      return;
    }
    const status = panel.querySelector("#ds-status");
    if (status) status.textContent = getStatusText();
    // 进度条同步
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
  }, 1500);

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
          return new File([value], name.replace(/\.srt$/i, ".txt"), {
            type: "text/plain",
            lastModified: value.lastModified,
          });
        }
      } catch {}
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

  // 发送后开新对话：监听 URL。DeepSeek 发消息后进会话页 /a/chat/s/...，开新对话回 /。
  // 注意：若在已有会话里发消息（URL 不变）则检测不到。
  function watchSendThenNewChat() {
    if (!newChatAfterSend || watchingSend) return;
    watchingSend = true;
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
          btn.click();
        } else {
          shortcutNewChat();
        }
      }, 300);
    }, 300);
  }

  // 自动填空：等输入框渲染出来；已有内容则不覆盖
  function scheduleAutoFill() {
    if (pendingFill) return;
    pendingFill = true;

    let attempts = 0;
    const maxAttempts = 15;
    function retry() {
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
        pendingFill = false;
        watchSendThenNewChat();
      } else if (attempts < maxAttempts) {
        setTimeout(retry, 300);
      } else {
        pendingFill = false;
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

  // 面板日志：进面板（ds-log）实时显示、可复制，同时输出到 console 备份
  function logMsg(line) {
    const d = new Date();
    const ts =
      String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
    batch.logs.push("[" + ts + "] " + line);
    if (batch.logs.length > 400) batch.logs.shift();
    const box = document.getElementById("ds-log");
    if (box) {
      // 运行中自动展开日志区
      if (typeof window.__dsToggleLog === "function") window.__dsToggleLog(true);
      const row = document.createElement("div");
      row.textContent = "[" + ts + "] " + line;
      box.appendChild(row);
      box.scrollTop = box.scrollHeight;
    }
    console.log("[批量]", line);
  }

  // DeepSeek XHR 信号：fetch_files 确认上传成功，upload_file 记录日志。
  // 生成完成信号已改为侧边栏计数（startSidebarCounter），此处不再处理 completion。
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
        const f = files.find((f) => (f.file_name || f.name) === batch.currentFileName);
        if (f?.status === "SUCCESS") batch.fileReady = true;
      }
      if (short.startsWith("/api/v0/file/upload_file")) logMsg("upload_file -> " + xhr.status);
      if (url.includes("/api/v0/chat/completion") && xhr.status === 200) {
        // 生成完成信号以侧边栏标题为准（startSidebarCounter），这里不处理
      }
    } catch (e) {
      logMsg("信号解析错误: " + url + " " + e.message);
    }
  }

  // 上传完成信号：fetch_files 返回 SUCCESS，或附件 chip 出现在输入框附近（兜底）。
  // MutationObserver 事件驱动，不轮询。返回 observer 供调用方清理。
  function watchFileAppear(name) {
    const input = findInput();
    if (!input) return null;
    const check = () => {
      let el = input.parentElement;
      for (let i = 0; i < 12 && el; i++) {
        if (el.innerText?.includes(name)) return true;
        el = el.parentElement;
      }
      return false;
    };
    if (check()) {
      batch.fileReadyDom = true;
      return null;
    }
    let root = input;
    for (let i = 0; i < 12 && root.parentElement; i++) root = root.parentElement;
    const mo = new MutationObserver(() => {
      if (check()) {
        batch.fileReadyDom = true;
        mo.disconnect();
      }
    });
    mo.observe(root, { childList: true, subtree: true, characterData: true });
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

  function findSendButton() {
    const els = document.querySelectorAll('button, div[role="button"], [aria-label], [title]');
    for (const el of els) {
      const hint = (el.getAttribute("aria-label") || "") + (el.getAttribute("title") || "");
      if (/发送|send/i.test(hint)) return el;
    }
    return null;
  }

  function sendAndConfirm() {
    // 先点发送按钮，2.5s 未确认则补一次 Enter 键；
    // 确认依据 = completion 请求已发出（xhrProto.send 里置 batch.sent）或 URL 跳会话页
    batch.sent = false;
    const btn = findSendButton();
    if (btn) btn.click();
    return waitFor(
      () => batch.sent || /\/a\/chat\/s\//.test(location.href) || batch.stop,
      2500,
    ).then((ok) => {
      if (ok || batch.stop) return !batch.stop;
      const input = findInput();
      if (!input) return false;
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          code: "Enter",
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
      return waitFor(() => batch.sent || /\/a\/chat\/s\//.test(location.href), 4000);
    });
  }

  // 确保输入框干净：会话页先回首页；首页有残留草稿（上次失败）则开新对话清除
  async function ensureHomeInput() {
    if (/\/a\/chat\/s\//.test(location.href)) {
      const btn = findNewChatButton();
      if (btn) btn.click();
      else shortcutNewChat();
      await waitFor(() => !/\/a\/chat\/s\//.test(location.href), 2500);
    }
    const input = findInput();
    if (input && input.value.trim()) {
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
    const mo = watchFileAppear(file.name);
    const ready = await waitFor(() => batch.fileReady || batch.fileReadyDom || batch.stop, 20000);
    if (mo) mo.disconnect();
    if (batch.stop) throw new Error("已停止");
    if (!ready) {
      logMsg("上传超时: " + file.name);
      throw new Error("上传超时（附件区未出现文件）");
    }

    // 填空（输入框已有内容则不覆盖）
    await waitFor(() => !!findInput(), 5000);
    const input = findInput();
    if (input && !input.value.trim()) {
      nativeSetter.call(input, promptText);
      input.dispatchEvent(new Event("input", { bubbles: true }));
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

  // === 通用浮层（批量结果弹窗已移除，仍用于 YouTube 轨道选择）===
  function createOverlay(titleText, contentEl, footerBtns) {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483001;" +
      "display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText =
      "background:#18181b;color:#fff;border-radius:12px;padding:16px;width:440px;max-height:75vh;" +
      "display:flex;flex-direction:column;font-size:12px;box-shadow:0 8px 40px rgba(0,0,0,.5);";
    const title = document.createElement("div");
    title.textContent = titleText;
    title.style.cssText =
      "font-weight:600;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.12);";
    box.appendChild(title);
    box.appendChild(contentEl);
    if (footerBtns.length) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px;";
      footerBtns.forEach((b) => row.appendChild(b));
      box.appendChild(row);
    }
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    return overlay;
  }

  function ovlBtn(text, primary, onClick) {
    const b = document.createElement("button");
    b.textContent = text;
    b.style.cssText =
      "padding:6px 16px;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:600;" +
      (primary ? "background:#4d6bfe;color:#fff;" : "background:#3f3f46;color:#e4e4e7;");
    b.addEventListener("click", onClick);
    return b;
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
    panelNotice("已停止，剩余任务未处理", true);
  }

  function clearTasks() {
    batch.pendingFiles = null;
    batch.tasks = [];
    const box = document.getElementById("ds-taskbox");
    if (box) box.style.display = "none";
    setBatchBtnState();
  }

  function showBatchPreview(files) {
    batch.pendingFiles = files;
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
    lastNewChatCount = 0;
    startSidebarCounter();
    setBatchBtnState();
    logMsg("开始，共 " + batch.queue.length + " 个文件（并发 2）");
    while (batch.queue.length && !batch.stop) {
      await waitFor(() => countNewChatSessions() < MAX_CONCURRENT || batch.stop, 3600 * 1000);
      if (batch.stop) break;
      const file = batch.queue.shift();
      try {
        await processFile(file);
        batch.done++;
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

  function startBatchPicker() {
    try {
      pickBatchFiles();
    } catch {
      panelNotice("文件选择器需从面板按钮触发", true);
    }
  }

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
      if (!files.every((f) => /\.(md|srt)$/i.test(f.name))) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      showBatchPreview(files);
    },
    true,
  );
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "u" || e.key === "U")) {
      e.preventDefault();
      startBatchPicker();
    }
  });

  // === YouTube 字幕下载（仅 www.youtube.com 生效）===

  // pot token 捕获：沙箱包装 unsafeWindow.XMLHttpRequest.prototype 可影响页面请求。
  // YT 播放字幕时自己会请求 api/timedtext（带 pot），从响应 URL 里提取缓存。
  // （uBO 拦动态 script 注入，但拦不住原型包装；YT 用 XHR 发 timedtext，见 read-frog 同款做法）
  const timedtextUrlCache = new Map(); // videoId -> 完整 timedtext URL（含 pot，YT 自己请求的）
  (function hookYoutubeNetwork() {
    function cacheTimedtextUrl(url) {
      try {
        if (url.includes("api/timedtext")) {
          const u = new URL(url);
          const v = u.searchParams.get("v");
          if (v) {
            timedtextUrlCache.set(v, url);
          }
        }
      } catch {}
    }

    // XHR（YT 用 XHR 发 timedtext，实证有效）
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
          if (url.includes("/api/v0/chat/completion") && batch.running) batch.sent = true;
          this.addEventListener("load", () => {
            const url = this.responseURL || this.__ytSrtUrl || "";
            cacheTimedtextUrl(url);
            handleDeepSeekSignals(url, this);
          });
        } catch {}
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
      const start = Date.now();
      const timeoutMs = 6000;
      (function poll() {
        const url = timedtextUrlCache.get(videoId);
        if (url) return resolve(url);
        if (Date.now() - start > timeoutMs) return resolve(null);
        setTimeout(poll, 200);
      })();
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
  function finishDownload(playerResponse, events, closeAfter) {
    const srt = buildSrt(events);
    const title = sanitizeFilename(playerResponse?.videoDetails?.title || "");
    downloadSrt(srt, title + ".srt");
    if (closeAfter) {
      window.close();
      // 浏览器禁止关闭用户打开的标签页时，页面还在，此时提示
      setTimeout(() => {
        if (!window.closed) alert("浏览器不允许自动关闭页面，请手动关闭标签");
      }, 800);
    }
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
      const overlay = createOverlay("选择字幕轨道", select, [
        ovlBtn("取消", false, () => {
          overlay.remove();
          resolve(null);
        }),
        ovlBtn("下载", true, () => {
          overlay.remove();
          resolve(tracks[Number(select.value)]);
        }),
      ]);
    });
  }

  async function onDownload(button, closeAfter) {
    button.disabled = true;
    button.textContent = "获取中...";
    try {
      const playerResponse = getPlayerResponse();
      if (!playerResponse) {
        alert("未获取到播放器数据，请刷新页面后重试");
        return;
      }
      const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
      if (tracks.length === 0) {
        alert("该视频没有可用字幕");
        return;
      }

      let track = tracks[0];
      if (tracks.length > 1) {
        track = await chooseTrack(tracks);
        if (!track) return;
      }

      const url = new URL(track.baseUrl);
      url.searchParams.set("fmt", "json3");

      let response = await fetch(url);
      let text = await response.text();

      // 200 但空内容 = 需要 pot token。开字幕触发 YT 自己的 timedtext 请求，
      // 直接复用 YT 正在用的完整 URL（含 pot 和全部参数），比拼接 pot 可靠
      if (response.ok && !text.trim()) {
        await ensureSubtitlesOn();
        const timedtextUrl = await waitForTimedtextUrl(playerResponse?.videoDetails?.videoId);
        if (timedtextUrl) {
          const cachedResponse = await fetch(timedtextUrl);
          if (cachedResponse.ok) {
            const cachedText = await cachedResponse.text();
            try {
              const cachedEvents = JSON.parse(cachedText).events || [];
              if (cachedEvents.length > 0) {
                finishDownload(playerResponse, cachedEvents, closeAfter);
                return;
              }
            } catch {
              // 缓存 URL 非 JSON，落回下方常规路径（会报空内容）
            }
          }
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
      if (events.length === 0) {
        alert("未获取到字幕内容");
        return;
      }

      finishDownload(playerResponse, events, closeAfter);
    } catch (error) {
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

  console.log(
    "[DeepSeek-SRT] ✅ v3.0 已就绪 — .srt→.txt + 自动填空 + 发送后新对话 + 批量处理 MD（Ctrl+Shift+U）+ YouTube 字幕下载",
  );
})();
