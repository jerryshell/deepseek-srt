# DeepSeek SRT 上传助手

油猴脚本，让 DeepSeek 直接支持拖入 `.srt` 字幕文件（自动伪装为 `.txt`），并可选择拖入时自动填入提示词。

推荐使用 **[陪读蛙](https://github.com/mengxi-ream/read-frog)** 下载 YouTube 字幕，或使用脚本内置的 YouTube 字幕下载按钮（视频标题右侧）。

## 功能

- **自动伪装**: `.srt` 文件自动重命名为 `.txt`，绕过 DeepSeek 的前端格式校验
- **自动填空**: 可选拖入 `.srt` / `.md` 后自动在输入框填入预设提示词（默认: 通俗易懂总结，已有内容不覆盖）
- **发送后新对话**: 可选发送后自动开启新对话，适合批量处理字幕（默认关，找不到按钮时用 Ctrl+J 快捷键兑底）
- **YouTube 字幕下载**: 在 YouTube 视频标题右侧显示“下载字幕”按钮，一键下载 `.srt` 字幕（支持多轨道选择）
- **油猴菜单控制**: 无需页面 UI，通过 Tampermonkey 菜单开关（SRT / MD / 发送后新对话）和修改提示词

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，粘贴 [main.js](./main.js) 全部内容
3. 保存，打开 [DeepSeek 聊天页](https://chat.deepseek.com/) 或 [YouTube](https://www.youtube.com/) 即可使用

## 使用

- **拖入 .srt 文件**: 自动上传，无感知
- **点击 Tampermonkey 图标**: 切换 SRT / MD 自动填空开关（MD 默认关）、发送后新对话开关（默认关）、修改提示词
