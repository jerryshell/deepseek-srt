// ==UserScript==
// @name         DeepSeek SRT 上传助手
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  允许在 DeepSeek 直接上传 .srt 字幕文件（自动伪装为 .txt）。可选拖入 .srt/.md 时自动填入提示词。
// @author       Jerry
// @match        https://chat.deepseek.com/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=deepseek.com
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
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

  // === 油猴菜单：开关注册一次，修改后刷新让新标签生效 ===
  function registerToggle(label, key, get, set) {
    GM_registerMenuCommand((get() ? "✅ " : "❌ ") + label + "：" + (get() ? "开" : "关"), () => {
      set(!get());
      GM_setValue(key, get());
      location.reload();
    });
  }
  registerToggle(
    "自动填空",
    STORAGE.ENABLED,
    () => autoFillEnabled,
    (v) => (autoFillEnabled = v),
  );
  registerToggle(
    "自动填空（MD）",
    STORAGE.MD,
    () => mdAutoFillEnabled,
    (v) => (mdAutoFillEnabled = v),
  );
  registerToggle(
    "发送后新对话",
    STORAGE.NEWCHAT,
    () => newChatAfterSend,
    (v) => (newChatAfterSend = v),
  );

  GM_registerMenuCommand(
    "✏️ 修改提示词（当前：" + promptText.slice(0, 12) + (promptText.length > 12 ? "…" : "") + "）",
    () => {
      const input = prompt("拖入 SRT / MD 后自动填入的提示词：", promptText);
      if (input !== null && input.trim()) {
        promptText = input.trim();
        GM_setValue(STORAGE.PROMPT, promptText);
        location.reload();
      }
    },
  );

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

  console.log("[DeepSeek-SRT] ✅ v1.9 已就绪 — .srt→.txt + 自动填空 + 发送后新对话(URL监听)");
})();
