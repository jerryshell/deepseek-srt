// ==UserScript==
// @name         DeepSeek SRT 上传助手 + YouTube 字幕下载
// @namespace    http://tampermonkey.net/
// @version      2.8
// @description  允许在 DeepSeek 直接上传 .srt 字幕文件（自动伪装为 .txt）。可选拖入 .srt/.md 时自动填入提示词。YouTube 页面添加“下载字幕”按钮。
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

  // === 油猴菜单（仅 DeepSeek 页面）：开关注册一次，修改后刷新让新标签生效 ===
  function registerToggle(label, key, get, set) {
    GM_registerMenuCommand((get() ? "✅ " : "❌ ") + label + "：" + (get() ? "开" : "关"), () => {
      set(!get());
      GM_setValue(key, get());
      location.reload();
    });
  }
  if (location.hostname === "chat.deepseek.com") {
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
      "✏️ 修改提示词（当前：" +
        promptText.slice(0, 12) +
        (promptText.length > 12 ? "…" : "") +
        "）",
      () => {
        const input = prompt("拖入 SRT / MD 后自动填入的提示词：", promptText);
        if (input !== null && input.trim()) {
          promptText = input.trim();
          GM_setValue(STORAGE.PROMPT, promptText);
          location.reload();
        }
      },
    );
  }

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
          this.addEventListener("load", () => {
            cacheTimedtextUrl(this.responseURL || this.__ytSrtUrl || "");
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

  // 生成 SRT 并触发下载（两个下载路径共用）
  function finishDownload(playerResponse, events) {
    const srt = buildSrt(events);
    const title = sanitizeFilename(playerResponse?.videoDetails?.title || "");
    downloadSrt(srt, title + ".srt");
  }

  async function onDownload(button) {
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
        const options = tracks
          .map(
            (t, i) =>
              i +
              1 +
              ". " +
              t.name?.simpleText +
              " (" +
              t.languageCode +
              ")" +
              (t.kind === "asr" ? " [自动]" : ""),
          )
          .join("\n");
        const choice = prompt("选择字幕轨道（默认 1）:\n\n" + options, "1");
        if (choice === null) return;
        const index = parseInt(choice, 10) - 1;
        if (!tracks[index]) {
          alert("无效选择");
          return;
        }
        track = tracks[index];
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
                finishDownload(playerResponse, cachedEvents);
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

      finishDownload(playerResponse, events);
    } catch (error) {
      alert("下载失败: " + error.message);
    } finally {
      button.disabled = false;
      button.textContent = "下载字幕";
    }
  }

  function ensureYoutubeButton() {
    if (!location.hostname.endsWith("youtube.com")) return;
    if (document.getElementById("yt-srt-download-btn")) return;

    // 视频标题右侧
    const titleEl = document.querySelector("#above-the-fold h1");
    if (!titleEl) return;
    const container = titleEl.closest("#title") || titleEl.parentElement;

    const button = document.createElement("button");
    button.id = "yt-srt-download-btn";
    button.textContent = "下载字幕";
    button.style.cssText =
      "margin-left:12px;align-self:center;flex-shrink:0;" +
      "padding:6px 14px;border:none;border-radius:18px;" +
      "background:#065fd4;color:#fff;font-size:13px;font-weight:500;" +
      "cursor:pointer;white-space:nowrap;";
    // 标题容器改成横向 flex，按钮才能跟在标题右侧
    container.style.cssText = "display:flex;align-items:center;flex-direction:row;flex-wrap:wrap;";
    button.addEventListener("click", () => onDownload(button));
    container.appendChild(button);
  }
  setInterval(ensureYoutubeButton, 2000);

  console.log(
    "[DeepSeek-SRT] ✅ v2.8 已就绪 — .srt→.txt + 自动填空 + 发送后新对话 + YouTube 字幕下载",
  );
})();
