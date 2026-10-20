const fields = {
  actionDelayMs: document.getElementById("actionDelayMs"),
  autoSubmitLighthouse: document.getElementById("autoSubmitLighthouse"),
  maxTasksPerRun: document.getElementById("maxTasksPerRun"),
  replyMode: document.getElementById("replyMode"),
  replyProvider: document.getElementById("replyProvider"),
  aiModel: document.getElementById("aiModel"),
  aiApiKey: document.getElementById("aiApiKey"),
  aiSystemPrompt: document.getElementById("aiSystemPrompt")
};

const statusBadge = document.getElementById("statusBadge");
const completedCount = document.getElementById("completedCount");
const failedCount = document.getElementById("failedCount");
const logList = document.getElementById("logList");

document.getElementById("saveBtn").addEventListener("click", saveSettings);
document.getElementById("debugBtn").addEventListener("click", openDebugPage);
document.getElementById("startBtn").addEventListener("click", startRun);
document.getElementById("stopBtn").addEventListener("click", stopRun);

loadState();
setInterval(loadState, 1500);

async function loadState() {
  const response = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!response || !response.ok) return;
  renderSettings(response.settings);
  renderState(response.state);
}

async function saveSettings() {
  const settings = readSettings();
  const status = document.getElementById("saveStatus");
  try {
    const current = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    if (!current?.ok) throw new Error(current?.error || "读取配置失败，未保存");
    const response = await chrome.runtime.sendMessage({
      type: "SAVE_SETTINGS", settings: { ...current.settings, ...settings }
    });
    if (!response?.ok) throw new Error(response?.error || "保存失败，后台没有确认");
    renderSettings(response.settings || settings);
    if (status) status.textContent = "已保存，重启后无需重新输入 API Key";
    return true;
  } catch (error) {
    if (status) status.textContent = `保存失败：${error.message || "请重试"}`;
    return false;
  }
}

async function startRun() {
  if (await saveSettings() !== true) return;
  await chrome.runtime.sendMessage(await withClientWindowId({ type: "START_RUN" }));
  await loadState();
}

async function stopRun() {
  await chrome.runtime.sendMessage({ type: "STOP_RUN" });
  await loadState();
}

async function openDebugPage() {
  if (await saveSettings() !== true) return;
  await chrome.runtime.sendMessage(await withClientWindowId({ type: "OPEN_DEBUG_PAGE" }));
}

async function withClientWindowId(payload) {
  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (Number.isInteger(currentWindow?.id)) {
      return { ...payload, clientWindowId: currentWindow.id };
    }
  } catch (_) {}
  return payload;
}

function readSettings() {
  return {
    actionDelayMs: Number(fields.actionDelayMs.value),
    autoSubmitLighthouse: fields.autoSubmitLighthouse.checked,
    maxTasksPerRun: Number(fields.maxTasksPerRun.value),
    replyMode: fields.replyMode.value,
    replyProvider: fields.replyProvider.value,
    aiProvider: "openai",
    aiModel: fields.aiModel.value.trim(),
    aiApiKey: fields.aiApiKey.value.trim(),
    aiSystemPrompt: fields.aiSystemPrompt.value.trim()
  };
}

function renderSettings(settings) {
  const active = document.activeElement;
  if (Object.values(fields).includes(active)) return;

  fields.actionDelayMs.value = settings.actionDelayMs;
  fields.autoSubmitLighthouse.checked = settings.autoSubmitLighthouse;
  fields.maxTasksPerRun.value = settings.maxTasksPerRun;
  fields.replyMode.value = settings.replyMode;
  fields.replyProvider.value = settings.replyProvider;
  fields.aiModel.value = settings.aiModel || "gpt-6.1-sol";
  fields.aiApiKey.value = settings.aiApiKey || "";
  fields.aiSystemPrompt.value = settings.aiSystemPrompt || "";
}

function renderState(state) {
  statusBadge.textContent = state.running ? "Running" : "Idle";
  statusBadge.classList.toggle("running", Boolean(state.running));
  completedCount.textContent = state.completed || 0;
  failedCount.textContent = state.failed || 0;

  logList.replaceChildren(...(state.logs || []).slice(0, 20).map((entry) => {
    const item = document.createElement("li");
    item.className = entry.level || "info";
    item.textContent = `${formatTime(entry.at)} [${entry.level}] ${entry.text}`;
    return item;
  }));
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}
