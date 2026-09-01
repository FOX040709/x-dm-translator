# X 私信翻译助手 V0.2

这是一个 Microsoft Edge Manifest V3 扩展原型。

## 功能

- 在 X 私信页面识别外语消息并翻译为中文。
- 增加“翻译当前已加载消息”按钮，可重新扫描打开对话中已经渲染的历史消息。
- 滚动、页面文本更新和定时检查都会触发扫描，改善 X 虚拟消息列表兼容性。
- 首次使用某个语言组合时，显示模型下载按钮。
- 把 X 输入框中的中文翻译成所选目标语言。
- 先显示预览，再由用户替换输入框；不会自动发送私信。
- 只使用 `chrome.storage.sync` 保存开关和语言设置，不保存私信原文。

## 安装

1. 解压项目压缩包。
2. 在 Edge 地址栏输入 `edge://extensions`。
3. 打开“开发人员模式”。
4. 点击“加载解压缩的扩展”。
5. 选择包含 `manifest.json` 的 `x-dm-translator-v0.1` 文件夹。
6. 打开或刷新 X 私信页面。

## 首次使用

1. 在 X 私信页点击右下角“初始化本地翻译”。
2. 等待状态变为“本地翻译已就绪”。
3. 点击“翻译当前已加载消息”，处理当前对话中已经显示或已经加载的历史消息。
4. 向上滚动加载更早消息；每次滚动后扩展会自动扫描，也可以再次点击手动扫描。
5. 首次遇到日语、韩语等新语种时，点击消息下方“下载模型并翻译”。以后该语言组合会自动工作。

## 修改代码后重新加载

1. 保存代码。
2. 回到 `edge://extensions`。
3. 点击扩展卡片上的“重新加载”。
4. 刷新 X 私信页面。

## 常见检查

在 X 私信页面按 `F12`，在 Console 中运行：

```js
document.querySelectorAll('[data-testid="messageEntry"]').length
document.querySelectorAll('[data-testid="messageText"]').length
document.querySelectorAll('[data-testid="dmComposerTextInput"]').length
```

若消息相关结果都为 0，说明 X 修改了页面元素标识，需要在 `content.js` 中更新：

- `findMessageTextElement()`
- `collectMessageTextElements()`
- `findComposer()`

## 文件说明

- `manifest.json`：扩展配置和网站权限。
- `content.js`：页面识别、模型管理、翻译和输入框替换。
- `content.css`：浮动工具栏和译文样式。
- `popup.html` / `popup.js`：扩展设置窗口。

## 为什么不能一次翻译全部历史私信

本扩展不调用 X 私信 API，只读取浏览器当前页面。X 使用虚拟消息列表：未向上滚动加载的旧消息不在网页 DOM 中，扩展无法读取。进入具体对话后向上滚动，等旧消息出现，再点击“翻译当前已加载消息”。

## V0.2 修复

- 将容易被持续页面变化推迟的防抖扫描改为尽早执行的节流扫描。
- 监听 `characterData`，兼容 React 复用节点后只替换文字的情况。
- 监听滚动、窗口重新聚焦和页面恢复可见。
- 每 1.5 秒做一次轻量兜底扫描，已处理消息不会重复翻译。
- 扩展旧版和新版 X Chat 的候选消息选择器。
