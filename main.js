// ==UserScript==
// @name         DeepSeek SRT 上传助手
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  允许在 DeepSeek 直接上传 .srt 字幕文件（自动伪装为 .txt）。可选拖入时自动填入提示词。
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

  // ========================= 配置 =========================
  const DEFAULT_PROMPT = "通俗易懂总结";
  const STORAGE_KEY_ENABLED = "srtAutoFill";
  const STORAGE_KEY_PROMPT = "srtPrompt";

  let autoFillEnabled = GM_getValue(STORAGE_KEY_ENABLED, true);
  let promptText = GM_getValue(STORAGE_KEY_PROMPT, DEFAULT_PROMPT);

  // ========================= 油猴菜单 =========================
  function updateMenuLabel() {
    // 菜单项无法动态更新，注册时就要定好，这里用一个标记让用户知道当前状态
  }

  GM_registerMenuCommand(autoFillEnabled ? "✅ 自动填空：开" : "❌ 自动填空：关", () => {
    autoFillEnabled = !autoFillEnabled;
    GM_setValue(STORAGE_KEY_ENABLED, autoFillEnabled);
    alert("自动填空已" + (autoFillEnabled ? "开启 ✅" : "关闭 ❌"));
    // 刷新菜单标签——重新注册会覆盖
    location.reload();
  });

  GM_registerMenuCommand(
    "✏️ 修改提示词（当前：" + promptText.slice(0, 12) + (promptText.length > 12 ? "…" : "") + "）",
    () => {
      const input = prompt("拖入 SRT 后自动填入的提示词：", promptText);
      if (input !== null && input.trim()) {
        promptText = input.trim();
        GM_setValue(STORAGE_KEY_PROMPT, promptText);
        location.reload();
      }
    },
  );

  // ========================= 核心：拦截 File.prototype.name =========================
  const origNameDesc = Object.getOwnPropertyDescriptor(File.prototype, "name");
  const origTypeDesc = Object.getOwnPropertyDescriptor(File.prototype, "type");

  if (origNameDesc) {
    Object.defineProperty(File.prototype, "name", {
      get() {
        const name = origNameDesc.get.call(this);
        if (/\.srt$/i.test(name)) {
          scheduleAutoFill();
          return name.replace(/\.srt$/i, ".txt");
        }
        return name;
      },
      configurable: true,
    });
  }

  if (origTypeDesc) {
    Object.defineProperty(File.prototype, "type", {
      get() {
        const name = origNameDesc.get.call(this);
        return /\.srt$/i.test(name) ? "text/plain" : origTypeDesc.get.call(this);
      },
      configurable: true,
    });
  }

  // ---- 兜底 FormData ----
  function wrap(value) {
    if (value instanceof File) {
      try {
        const name = origNameDesc.get.call(value);
        if (/\.srt$/i.test(name)) {
          return new File([value], name.replace(/\.srt$/i, ".txt"), {
            type: "text/plain",
            lastModified: value.lastModified,
          });
        }
      } catch (_) {}
    }
    return value;
  }
  const fdProto = FormData.prototype;
  const origAppend = fdProto.append;
  fdProto.append = function (name, value, filename) {
    return origAppend.call(this, name, wrap(value), filename);
  };
  const origSet = fdProto.set;
  fdProto.set = function (name, value, filename) {
    return origSet.call(this, name, wrap(value), filename);
  };

  // ========================= 自动填入输入框 =========================
  // React 中必须用原生 setter 才能触发其 onChange 同步到内部状态
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  ).set;
  const nativeInputSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  ).set;

  function findInput() {
    const sel = [
      'textarea[placeholder*="消息"]',
      'textarea[placeholder*="Message"]',
      "#chat-input",
      '[role="textbox"]',
      '[contenteditable="true"]',
      "textarea",
    ];
    for (const s of sel) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    return null;
  }

  function setNativeValue(el, value) {
    if (el.tagName === "TEXTAREA") {
      nativeTextareaSetter.call(el, value);
    } else if (el.tagName === "INPUT") {
      nativeInputSetter.call(el, value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  let pendingFill = false;

  function scheduleAutoFill() {
    if (!autoFillEnabled || pendingFill) return;
    pendingFill = true;

    let attempts = 0;
    const maxAttempts = 15;
    function retry() {
      attempts++;
      const input = findInput();
      if (input) {
        if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
          setNativeValue(input, promptText);
        } else if (input.getAttribute("contenteditable") === "true") {
          input.textContent = promptText;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        input.focus();
        pendingFill = false;
      } else if (attempts < maxAttempts) {
        setTimeout(retry, 300);
      } else {
        pendingFill = false;
      }
    }
    setTimeout(retry, 500);
  }

  console.log("[DeepSeek-SRT] ✅ v1.4 已就绪 — .srt→.txt + 油猴菜单控制");
})();
