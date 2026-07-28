# DeepSeek SRT 上传助手

油猴脚本，让 DeepSeek 直接支持拖入 `.srt` 字幕文件（自动伪装为 `.txt`），并可选择拖入时自动填入提示词。

推荐使用 **[陪读蛙](https://github.com/mengxi-ream/read-frog)** 下载 YouTube 字幕。

## 功能

- **自动伪装**: `.srt` 文件自动重命名为 `.txt`，绕过 DeepSeek 的前端格式校验
- **自动填空**: 可选拖入 SRT 后自动在输入框填入预设提示词（默认: 通俗易懂总结）
- **油猴菜单控制**: 无需页面 UI，通过 Tampermonkey 菜单开关和修改提示词

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)
2. 新建脚本，粘贴 [main.js](./main.js) 全部内容
3. 保存，打开 [DeepSeek 聊天页](https://chat.deepseek.com/) 即可使用

## 使用

- **拖入 .srt 文件**: 自动上传，无感知
- **点击 Tampermonkey 图标**: 切换自动填空开关 / 修改提示词

## License

MIT
