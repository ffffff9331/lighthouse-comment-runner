# Lighthouse 自动接单助手

适用于 [Lighthouse](https://app.lhdao.top/campaigns) 的 Chrome MV3 扩展，用于自动检测任务、接取评论类任务、打开目标 X 推文、生成并提交回复，并回到任务广场继续扫描。

## 功能

- 自动扫描 Lighthouse 任务广场并接取符合条件的评论任务。
- 支持任务倒计时监控、倒计时任务选中启动，以及最后 5 秒抢单窗口。
- 接取席位后等待 Lighthouse 自动打开目标 X；超过兜底等待时间时补开精确推文页。
- 在 X 页面执行关注、点赞、回复和任务组件提交流程。
- 通过 Lighthouse 官方完成状态和任务广场收入变化进行完成核验。
- 任务完成后自动返回任务广场，异常时保留已接订单，避免串单。
- 侧边栏提供运行控制、倒计时面板、详细日志、回复记录和配置管理。

## 安装

1. 解压发布包。
2. 打开 Chrome 的 `chrome://extensions`。
3. 开启右上角“开发者模式”。
4. 点击“加载已解压的扩展程序”，选择本项目目录。
5. 打开 Lighthouse 和 X，并点击扩展图标打开侧边栏。

## 配置

在侧边栏中设置：

- 运行模式、单次任务上限、接单尝试上限。
- 最低赏金、倒计时抢单、轮询间隔和锁席位超时。
- X 回复模式和 Lighthouse 自动提交。
- AI 模型名称、Responses API 地址、API Key 和系统提示词。
- 可选的运行时间段。
- 倒计时监控、最低监控赏金和语音提醒。

默认 AI 模型为 `gpt-5.6-terra`。自定义 API 地址应使用 HTTPS，并填写兼容 Responses API 的接口地址，例如 `https://.../v1/responses`。

## 自动流程

```text
任务广场扫描
  -> 过滤任务
  -> 打开任务详情
  -> 锁定席位
  -> 打开目标 X 推文
  -> 执行 X 互动与回复
  -> 提交 X 任务组件
  -> 等待 Lighthouse 官方完成
  -> 返回任务广场
```

如果 X 页面没有自动跳转，扩展会在等待后使用目标推文 URL 兜底打开。已接取订单的后续步骤失败时不会继续抢新单，应先人工核对订单状态。

## 本地检查

项目没有 npm 构建步骤，使用 Node.js 运行检查：

```bash
node tests/behavior-check.mjs
node tests/review-check.mjs
node tests/regression-check.mjs
```

也可以检查全部 JavaScript 语法：

```bash
find src tests -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
```

## 权限与安全

扩展需要访问 Lighthouse、X、浏览器标签页、存储、脚本注入、通知和定时器权限，以完成自动任务流程。API Key 仅保存于扩展本地存储；不要把包含 API Key 的配置、截图或日志提交到公开仓库。

