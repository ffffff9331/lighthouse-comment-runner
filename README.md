# Lighthouse 自动接单助手

适用于 [Lighthouse](https://app.lhdao.top/campaigns) 的 Chrome MV3 扩展，用于自动检测任务、接取评论类任务、打开目标 X 推文、生成并提交回复，并回到任务广场继续扫描。

## 功能

- 自动扫描 Lighthouse 任务广场并接取符合条件的评论任务。
- 支持任务倒计时监控、倒计时任务选中启动，以及最后 5 秒抢单窗口。
- 接取席位后等待 Lighthouse 自动打开目标 X；超过兜底等待时间时补开精确推文页。
- 在 X 页面执行关注、点赞、回复和任务组件提交流程。
- 通过 Lighthouse 官方完成状态和任务广场收入变化进行完成核验。
- 任务完成后自动返回任务广场，异常时保留已接订单，避免串单。
- 确认未接到单时刷新广场并重新检测，不把失败任务加入去重；临时等待到期会在当前扫描中生效。已接单或动作结果未知时仍保留订单，避免重复执行。
- 侧边栏提供运行控制、倒计时面板、详细日志、回复记录和配置管理。
- 停止会取消当前流程，清空本轮订单状态、倒计时、统计和运行日志，仅保留一条停止记录；设置与回复历史保留，后台唤醒后保持停止。
- 任务广场连续等待 5 分钟仍无可执行任务时，先确认未尝试接单，再刷新并继续检测；已点击接单或结果未知的动作保留核对，不自动重发。
- 单步按钮从所选步骤继续执行后续流程。接管前核对旧流程的取消回执，停止按钮取消整条步骤队列；保存设置失败后可重试，不会锁死按钮。
- 广场已加载但没有可执行评论任务时正常等待新任务，不再把只有原创任务或空列表误判为页面一直加载。

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
- AI 模型名称、API Key 和系统提示词。
- 可选的运行时间段。
- 倒计时监控、最低监控赏金和语音提醒。

默认 AI 模型为 `gpt-5.6-terra`，可自行填写其他模型。AI 回复固定使用 `https://api.vayne.cc.cd/v1/responses`，接口配置只保留模型与 API Key 输入，不提供地址或协议入口。原地址不匹配的旧 Key 会清除，需要重新填写中转站 Key；系统提示词保持不变。

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
node --test tests/*.test.cjs
```

其中 `claim-recovery.test.cjs` 覆盖放号延期、继续扫描和已点击接单后的未知结果保护；`monitor-cards.test.cjs` 覆盖任务卡识别与重复项合并。`composite-task-types.test.cjs` 和 `composite-x-actions.test.cjs` 覆盖评论＋点赞的类型保留、任务面板延迟加载、动作执行与失败保护。`stopped-state-restore.test.cjs` 覆盖旧版已停止快照的订单和日志兼容读取、中断恢复，以及停止后重启不自动运行；`manual-stop-reset.test.cjs` 覆盖新版停止清理与设置、回复历史保留。`idle-refresh-recovery.test.cjs` 覆盖五分钟冷却等待后的安全刷新续扫，以及刷新、停止和延迟回执并发时的保护。`manual-takeover.test.cjs`、`manual-step-stop.test.cjs` 和 `step-queue.test.cjs` 覆盖单步接管、停止后取消后续步骤、迟到回执和异常后重试；`campaigns-readiness.test.cjs` 覆盖空广场、只有原创任务和未加载页面的区分。测试使用离线模拟，不会实际接单或发布评论。

也可以检查全部 JavaScript 语法：

```bash
find src tests -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check
```

## 权限与安全

扩展需要访问 Lighthouse、X、浏览器标签页、存储、脚本注入、通知和定时器权限，以完成自动任务流程。API Key 仅保存于扩展本地存储；不要把包含 API Key 的配置、截图或日志提交到公开仓库。

