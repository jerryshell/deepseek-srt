// ==UserScript==
// @name         DeepSeek SRT 上传助手 + YouTube 字幕下载
// @namespace    http://tampermonkey.net/
// @version      3.1
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

  // === 页面控制面板（替代油猴菜单，仅 DeepSeek 页面）===
  function buildPanel() {
    if (location.hostname !== "chat.deepseek.com" || document.getElementById("ds-panel")) return;
    const panel = document.createElement("div");
    panel.id = "ds-panel";
    panel.style.cssText =
      "position:fixed;right:12px;top:64px;z-index:2147483000;width:172px;" +
      "background:rgba(24,24,27,.96);color:#fff;border-radius:10px;padding:10px 0;" +
      "font-size:12px;box-shadow:0 4px 20px rgba(0,0,0,.35);user-select:none;";

    const title = document.createElement("div");
    title.textContent = "SRT 助手";
    title.style.cssText =
      "padding:0 12px 8px;font-weight:600;border-bottom:1px solid rgba(255,255,255,.12);margin-bottom:4px;";

    const rowStyle =
      "display:flex;align-items:center;justify-content:space-between;padding:5px 12px;cursor:pointer;";
    const labelStyle = "color:#e4e4e7;";

    function toggleRow(label, key, get, set) {
      const row = document.createElement("div");
      row.style.cssText = rowStyle;
      const span = document.createElement("span");
      span.textContent = label;
      span.style.cssText = labelStyle;
      const state = document.createElement("span");
      const paint = () => {
        state.textContent = get() ? "开" : "关";
        state.style.color = get() ? "#4ade80" : "#a1a1aa";
        state.style.fontWeight = "600";
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
    promptLabel.style.cssText = labelStyle;
    const paintPrompt = () => {
      promptLabel.textContent =
        "提示词: " + (promptText.length > 8 ? promptText.slice(0, 8) + "…" : promptText);
    };
    paintPrompt();
    promptRow.appendChild(promptLabel);
    promptRow.addEventListener("click", () => {
      const input = prompt("拖入 SRT / MD 后自动填入的提示词：", promptText);
      if (input !== null && input.trim()) {
        promptText = input.trim();
        GM_setValue(STORAGE.PROMPT, promptText);
        paintPrompt();
      }
    });

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
      if (batch.tasks.length) {
        const files = batch.pendingFiles;
        if (files?.length) runBatch(files);
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

    panel.appendChild(title);
    panel.appendChild(taskBox);
    panel.appendChild(
      toggleRow(
        "自动填空 (SRT)",
        STORAGE.ENABLED,
        () => autoFillEnabled,
        (v) => (autoFillEnabled = v),
      ),
    );
    panel.appendChild(
      toggleRow(
        "自动填空 (MD)",
        STORAGE.MD,
        () => mdAutoFillEnabled,
        (v) => (mdAutoFillEnabled = v),
      ),
    );
    panel.appendChild(
      toggleRow(
        "发送后新对话",
        STORAGE.NEWCHAT,
        () => newChatAfterSend,
        (v) => (newChatAfterSend = v),
      ),
    );
    panel.appendChild(promptRow);
    panel.appendChild(batchBtn);
    setBatchBtnState();

    const statusRow = document.createElement("div");
    statusRow.id = "ds-status";
    statusRow.style.cssText =
      "margin:8px 12px 0;padding-top:8px;border-top:1px solid rgba(255,255,255,.12);" +
      "color:#a1a1aa;font-size:11px;line-height:1.5;";
    statusRow.textContent = getStatusText();
    panel.appendChild(statusRow);

    const notice = document.createElement("div");
    notice.id = "ds-notice";
    notice.style.cssText =
      "margin:6px 12px 0;color:#a1a1aa;font-size:11px;line-height:1.4;min-height:1.2em;word-break:break-all;";
    panel.appendChild(notice);

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
        "（生成中 " +
        batch.generating +
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
  }, 1500);

  // === 核心：拦截 File 名称，把 .srt 伪装成 .txt ===
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

  // === 关键：FormData 序列化不走 JS getter（Blink 读内部槽位）===
  // File.prototype.name 拦截骗过前端校验，但服务器收到的是真 .srt 名，会报格式不支持。
  // 必须在入 FormData 时替换成新的 File 对象。
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

  // === 自动填入输入框 ===
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

  // 发送后开启新对话：监听 URL。DeepSeek 发送消息后进入会话页 /a/chat/s/...，
  // 新对话后回到 /。从非会话页跳到会话页 = 消息已发送。
  // ponytail: 假设用户流程是“开新对话→拖字幕→发送”，URL 每次从 / 跳到会话页；
  // 若在已有会话里发消息（URL 不变）检测不到，需要时再兜输入框轮询。
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

  // === 批量处理 MD 文件 ===
  // 上传无并发限制（约 1s），发送有 2 并发限制。脚本控制发送节奏：
  // 发送前查闸（生成中 < 2），完成信号 = chat/completion 的 XHR load（SSE 流结束）。
  const MAX_CONCURRENT = 2;
  const batch = {
    running: false,
    queue: [],
    generating: 0,
    stop: false,
    fileReady: false,
    currentFileName: "",
    sent: false,
    lastError: "",
    errors: [],
    tasks: [],
    pendingFiles: null,
    fileLog: [],
    debug: [],
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

  // XHR 信号（DeepSeek 全部走 axios/XHR）：fetch_files 轮询到 SUCCESS=文件就绪；
  // chat/completion 的 load=SSE 流结束=生成完成。
  function dbg(line) {
    if (!Array.isArray(batch.fileLog)) return;
    const d = new Date();
    const ts =
      String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
    batch.fileLog.push("[" + ts + "] " + line);
  }

  function handleDeepSeekSignals(url, xhr) {
    if (!batch.running && batch.generating === 0) return;
    try {
      const short = url.replace("https://chat.deepseek.com", "");
      if (url.includes("fetch_files")) {
        const d = JSON.parse(xhr.responseText);
        const files = d?.data?.biz_data?.files || d?.data?.files || [];
        const summary = files.map((f) => (f.file_name || f.name) + ":" + (f.status || "?"));
        dbg(
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
      if (short.startsWith("/api/v0/file/upload_file")) dbg("upload_file -> " + xhr.status);
      if (url.includes("/api/v0/chat/completion") && xhr.status === 200) {
        if (batch.generating > 0) {
          batch.generating--;
          const done = batch.tasks.find((t) => t.status === "生成中");
          if (done) {
            done.status = "完成";
            renderTaskList();
          }
          console.log("[批量] 一个总结完成，剩余生成中:", batch.generating);
        }
      }
    } catch (e) {
      console.error("[批量] 信号解析错误:", url, e.message);
    }
  }

  // 后备信号：附件 chip 出现在输入框附近（fetch_files 解析失败时兜底）
  // 后备信号：附件 chip 出现在输入框附近（fetch_files 解析失败时兜底）。
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

  // 确保输入框干净：会话页先回首页；首页有残留内容（上次失败）则开新对话清草稿
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
    batch.fileLog = [];
    dbg("== 上传开始: " + origFile.name);
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
      batch.debug.push("【" + file.name + "】", ...batch.fileLog);
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
    batch.generating++;
    if (task) {
      task.status = "生成中";
      renderTaskList();
    }
    console.log("[批量] 已发送:", file.name, "| 生成中:", batch.generating);
  }

  // === 批量任务浮层 ===
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
    if (batch.tasks.length) {
      btn.textContent = "开始处理（" + batch.tasks.length + "）";
      return;
    }
    btn.textContent = "批量上传 MD/SRT";
  }

  function stopBatch() {
    batch.stop = true;
    batch.running = false;
    batch.generating = 0; // 已发出的生成不撤销，但释放并发闸
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

  function showResult() {
    const log = ["成功 " + batch.done + "，失败 " + batch.failed + "，共 " + batch.total + " 个"];
    if (batch.errors.length) {
      log.push("", "失败明细：");
      batch.errors.forEach((e, i) => log.push(i + 1 + ". " + e.file + "： " + e.msg));
    }
    if (batch.debug.length) {
      log.push("", "诊断日志（上传环节）:");
      log.push(...batch.debug);
    }
    const text = document.createElement("textarea");
    text.readOnly = true;
    text.value = log.join("\n");
    text.style.cssText =
      "flex:1;margin-top:10px;background:#111;color:#e4e4e7;border:1px solid #3f3f46;" +
      "border-radius:8px;padding:8px;font-size:11px;resize:none;height:50vh;min-height:240px;";
    const overlay = createOverlay("批量处理完成", text, [
      ovlBtn("复制日志", true, () => {
        navigator.clipboard.writeText(text.value).then(() => {
          const prev = text.value;
          text.value = "已复制！";
          setTimeout(() => (text.value = prev), 1200);
        });
      }),
      ovlBtn("关闭", false, () => overlay.remove()),
    ]);
  }

  async function runBatch(files) {
    if (batch.running) return;
    batch.running = true;
    batch.stop = false;
    batch.queue = [...files];
    batch.total = files.length;
    batch.done = 0;
    batch.failed = 0;
    batch.errors = [];
    batch.debug = [];
    setBatchBtnState();
    console.log("[批量] 开始，共", batch.queue.length, "个文件（并发 2）");
    while (batch.queue.length && !batch.stop) {
      await waitFor(() => batch.generating < MAX_CONCURRENT || batch.stop, 3600 * 1000);
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
        console.error("[批量] 失败:", file.name, "-", e.message);
      }
    }
    await waitFor(() => batch.generating === 0 || batch.stop, 7200 * 1000);
    batch.running = false;
    console.log(
      "[批量] 结束：成功",
      batch.done,
      "失败",
      batch.failed,
      batch.stop ? "（已停止）" : "",
    );
    setBatchBtnState();
    if (batch.stop) return; // 用户主动停止：不弹结果窗
    showResult();
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
  // ponytail: SPA 切换视频后 ytInitialPlayerResponse 可能过期，用 videoId 校验。
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
