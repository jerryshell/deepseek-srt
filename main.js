// ==UserScript==
// @name         DeepSeek SRT 上传助手
// @namespace    http://tampermonkey.net/
// @version      1.5
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
  // 默认提示词
  const DEFAULT_PROMPT = "通俗易懂总结";
  // 存储键：SRT 自动填空开关 / MD 自动填空开关 / 提示词
  const STORAGE_KEY_ENABLED = "srtAutoFill";
  const STORAGE_KEY_MD = "mdAutoFill";
  const STORAGE_KEY_PROMPT = "srtPrompt";

  // 读取持久化配置，SRT 默认开，MD 默认关
  let autoFillEnabled = GM_getValue(STORAGE_KEY_ENABLED, true);
  let mdAutoFillEnabled = GM_getValue(STORAGE_KEY_MD, false);
  let promptText = GM_getValue(STORAGE_KEY_PROMPT, DEFAULT_PROMPT);

  // === 油猴菜单 ===
  // 菜单项无法动态更新，注册时就要定好，状态在标签里体现；修改后刷新页面让新标签生效

  // SRT 自动填空开关
  GM_registerMenuCommand(autoFillEnabled ? "✅ 自动填空：开" : "❌ 自动填空：关", () => {
    autoFillEnabled = !autoFillEnabled;
    GM_setValue(STORAGE_KEY_ENABLED, autoFillEnabled);
    alert("自动填空已" + (autoFillEnabled ? "开启 ✅" : "关闭 ❌"));
    // 刷新以更新菜单标签——重新注册会覆盖旧项
    location.reload();
  });

  // 修改提示词
  GM_registerMenuCommand(
    "✏️ 修改提示词（当前：" + promptText.slice(0, 12) + (promptText.length > 12 ? "…" : "") + "）",
    () => {
      const input = prompt("拖入 SRT / MD 后自动填入的提示词：", promptText);
      if (input !== null && input.trim()) {
        promptText = input.trim();
        GM_setValue(STORAGE_KEY_PROMPT, promptText);
        location.reload();
      }
    },
  );

  // MD 自动填空开关（独立于 SRT）
  GM_registerMenuCommand(
    mdAutoFillEnabled ? "✅ 自动填空（MD）：开" : "❌ 自动填空（MD）：关",
    () => {
      mdAutoFillEnabled = !mdAutoFillEnabled;
      GM_setValue(STORAGE_KEY_MD, mdAutoFillEnabled);
      alert("MD 自动填空已" + (mdAutoFillEnabled ? "开启 ✅" : "关闭 ❌"));
      location.reload();
    },
  );

  // === 核心：拦截 File 名称，把 .srt 伪装成 .txt ===
  // 记录原生 getter，避免递归
  const origNameDesc = Object.getOwnPropertyDescriptor(File.prototype, "name");
  const origTypeDesc = Object.getOwnPropertyDescriptor(File.prototype, "type");

  // 拦截 name：.srt 触发自动填空并改成 .txt；.md 在开关开启时只填空不改名
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

  // 拦截 type：.srt 伪装为 text/plain，绕过前端格式校验
  if (origTypeDesc) {
    Object.defineProperty(File.prototype, "type", {
      get() {
        const name = origNameDesc.get.call(this);
        return /\.srt$/i.test(name) ? "text/plain" : origTypeDesc.get.call(this);
      },
      configurable: true,
    });
  }

  // === 兜底：拦截 FormData，防止部分场景绕过 name 拦截 ===
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
      } catch {} // 忽略异常，保持原值
    }
    return value;
  }
  // append / set 都包一层，确保统一处理
  const fdProto = FormData.prototype;
  const origAppend = fdProto.append;
  fdProto.append = function (name, value, filename) {
    return origAppend.call(this, name, wrap(value), filename);
  };
  const origSet = fdProto.set;
  fdProto.set = function (name, value, filename) {
    return origSet.call(this, name, wrap(value), filename);
  };

  // === 自动填入输入框 ===
  // React 受控组件必须用原生 setter 赋值并派发 input 事件，才能触发其 onChange
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  ).set;
  const nativeInputSetter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  ).set;

  function findInput() {
    // 按优先级查找聊天输入框
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
    // 用原生 setter 写入，再派发 input 事件让 React 感知
    if (el.tagName === "TEXTAREA") {
      nativeTextareaSetter.call(el, value);
    } else if (el.tagName === "INPUT") {
      nativeInputSetter.call(el, value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  let pendingFill = false;

  // 自动填空：延迟等输入框渲染出来；已有内容则跳过，不覆盖
  function scheduleAutoFill() {
    if (pendingFill) return;
    pendingFill = true;

    let attempts = 0;
    const maxAttempts = 15;
    function retry() {
      attempts++;
      const input = findInput();
      if (input) {
        // 已有内容则不覆盖
        const existing =
          input.tagName === "TEXTAREA" || input.tagName === "INPUT"
            ? input.value.trim()
            : (input.textContent || "").trim();
        if (existing) {
          pendingFill = false;
          return;
        }
        if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
          setNativeValue(input, promptText);
        } else if (input.getAttribute("contenteditable") === "true") {
          input.textContent = promptText;
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
        input.focus();
        pendingFill = false;
      } else if (attempts < maxAttempts) {
        // 输入框还没渲染，稍后重试
        setTimeout(retry, 300);
      } else {
        pendingFill = false;
      }
    }
    setTimeout(retry, 500);
  }

  console.log(
    "[DeepSeek-SRT] ✅ v1.5 已就绪 — .srt→.txt + .srt/.md 自动填空（菜单控制，已有内容不覆盖）",
  );
})();
