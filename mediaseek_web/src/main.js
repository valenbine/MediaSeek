const form = document.querySelector("#parse-form");
const searchForm = document.querySelector("#search-form");
const searchInput = document.querySelector("#search-keyword");
const searchButton = document.querySelector("#search-button");
const searchResults = document.querySelector("#search-results");
const enginePickerDialog = document.querySelector("#engine-picker-dialog");
const enginePickerOptions = document.querySelector("#engine-picker-options");
const enginePickerCopy = document.querySelector("#engine-picker-copy");
const enginePickerCancel = document.querySelector("#engine-picker-cancel");
const urlInput = document.querySelector("#video-url");
const cookieInput = document.querySelector("#cookie-file");
const engineSelect = document.querySelector("#engine-select");
const cookieFileTitle = document.querySelector("#cookie-file-title");
const cookieFileHint = document.querySelector("#cookie-file-hint");
const cookieLoadButton = document.querySelector("#cookie-load-button");
const cookieClearButton = document.querySelector("#cookie-clear-button");
const cookieSessionPill = document.querySelector("#cookie-session-pill");
const cookieSessionCopy = document.querySelector("#cookie-session-copy");
const cookieSessionMeta = document.querySelector("#cookie-session-meta");
const parseButton = document.querySelector("#parse-button");
const statusTitle = document.querySelector("#status-title");
const statusCopy = document.querySelector("#status-copy");
const statusPill = document.querySelector("#status-pill");
const progressBar = document.querySelector("#progress-bar");
const formatCount = document.querySelector("#format-count");
const subtitleCount = document.querySelector("#subtitle-count");
const durationEl = document.querySelector("#duration");
const extractorEl = document.querySelector("#extractor");
const videoPreview = document.querySelector("#video-preview");
const videoFormatSelect = document.querySelector("#video-format-select");
const audioFormatSelect = document.querySelector("#audio-format-select");
const mergeMediaButton = document.querySelector("#merge-media-button");
const downloadAudioButton = document.querySelector("#download-audio-button");
const downloadCoverButton = document.querySelector("#download-cover-button");
const downloadDescriptionButton = document.querySelector("#download-description-button");
const downloadSubtitleButton = document.querySelector("#download-subtitle-button");
const mergeLogDetails = document.querySelector("#merge-log-details");
const mergeLog = document.querySelector("#merge-log");
const mergeLogClearButton = document.querySelector("#merge-log-clear-button");

let latestResult = null;
let ffmpegInstance = null;
let ffmpegModules = null;
let previewObjectUrl = null;
let activeMediaTask = null;
let cookieSessionState = null;
let mergeLogLines = ["等待合并任务开始..."];
let pendingSearchSelection = null;
const previewPlaybackProbe = document.createElement("video");

const FFMPEG_LOAD_TIMEOUT_MS = 0;
const FFMPEG_EXEC_TIMEOUT_MS = 10 * 60_000;
const MEDIA_FETCH_TIMEOUT_MS = 0;

const MEDIA_TASK_LABELS = {
  "download-video": "下载视频",
  "download-audio": "下载音频",
  preview: "生成预览",
};

const COOKIE_HINTS = {
  "you-get": "you-get 仅支持 Firefox 导出的 cookies.sqlite；解析完成后立即删除临时文件。",
  "yt-dlp": "yt-dlp 支持 cookies.txt，也支持 Firefox 导出的 cookies.sqlite；解析完成后立即删除临时文件。",
  lux: "lux 支持 cookies.txt，也支持 Firefox 导出的 cookies.sqlite；解析完成后立即删除临时文件。",
};

const COOKIE_TITLES = {
  "you-get": "可选：上传 Firefox cookies.sqlite",
  "yt-dlp": "可选：上传 Cookie 文件，推荐 cookies.txt",
  lux: "可选：上传 Cookie 文件，推荐 cookies.txt",
};

const COOKIE_ACCEPTS = {
  "you-get": ".sqlite,application/x-sqlite3",
  "yt-dlp": ".txt,.sqlite,text/plain,application/x-sqlite3",
  lux: ".txt,.sqlite,text/plain,application/x-sqlite3",
};

checkHealth();
refreshCookieSessionStatus();
updateCookieHint();

searchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const keyword = searchInput.value.trim();
  if (!keyword) return;

  searchButton.disabled = true;
  searchButton.textContent = "搜索中...";
  setStatus("正在搜索", "Search", "正在搜索视频网站关键词结果。", 20);

  try {
    const response = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, limit: 8 }),
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "搜索失败");
    }
    renderSearchResults(payload.results || []);
    setStatus("搜索完成", "Search", `共找到 ${payload.count || 0} 个候选结果。选择一项后会先确认解析器。`, 100);
  } catch (error) {
    renderSearchResults([]);
    setStatus("搜索失败", "Error", error.message || "关键词搜索失败。", 0, true);
  } finally {
    searchButton.disabled = false;
    searchButton.textContent = "开始搜索";
  }
});

searchResults.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-search-url]");
  if (!button) return;
  const url = button.dataset.searchUrl || "";
  if (!url) return;
  openEnginePicker({
    url,
    title: button.dataset.searchTitle || "未命名结果",
  });
});

enginePickerCancel?.addEventListener("click", () => {
  pendingSearchSelection = null;
  enginePickerDialog?.close();
});

enginePickerDialog?.addEventListener("close", async () => {
  if (enginePickerDialog.returnValue !== "confirm-parse" || !pendingSearchSelection) return;
  const selectedEngine = enginePickerOptions.querySelector("input[name='search-result-engine']:checked")?.value || engineSelect?.value || "you-get";
  const { url } = pendingSearchSelection;
  pendingSearchSelection = null;
  if (engineSelect) {
    engineSelect.value = selectedEngine;
  }
  updateCookieHint();
  renderCookieSessionStatus(cookieSessionState);
  urlInput.value = url;
  await parseUrl(url);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const targetUrl = urlInput.value.split(/\s+/).find(Boolean) || "";
  await parseUrl(targetUrl);
});

cookieInput?.addEventListener("change", () => {
  const file = cookieInput.files?.[0];
  if (!file) {
    cookieFileTitle.textContent = "可选：上传 Cookie 文件";
    updateCookieHint();
    return;
  }
  cookieFileTitle.textContent = file.name;
  cookieFileHint.textContent = `${formatBytes(file.size)} · 仅用于本次解析，不保存、不写日志`;
});

engineSelect?.addEventListener("change", () => {
  updateCookieHint();
  renderCookieSessionStatus(cookieSessionState);
});

cookieLoadButton?.addEventListener("click", async () => {
  await loadCookieSession();
});

cookieClearButton?.addEventListener("click", async () => {
  await clearCookieSession();
});

videoFormatSelect.addEventListener("change", () => {
  updateDownloadButtons();
});

audioFormatSelect.addEventListener("change", () => {
  updateDownloadButtons();
});

mergeMediaButton.addEventListener("click", async () => {
  const selected = getSelectedVideoFormat();
  if (!latestResult || !selected) return;
  await mergeSelectedVideo(selected);
});

downloadAudioButton.addEventListener("click", async () => {
  const audio = getSelectedAudioFormat();
  const video = getSelectedVideoFormat();
  if (!latestResult) return;
  if (audio) {
    await downloadSelectedAudio(audio);
    return;
  }
  if (video?.hasAudio) {
    if (!beginMediaTask("download-audio")) return;
    try {
      await extractAudioFromVideo(video);
      setStatus("音频下载完成", "Ready", "已生成从当前视频格式提取的音频文件，浏览器开始下载。", 100);
    } catch (error) {
      setStatus("音频下载失败", "Error", error.message || "音频提取失败，请重新解析后再试。", 0, true);
    } finally {
      endMediaTask("download-audio");
    }
  }
});

downloadCoverButton.addEventListener("click", async () => {
  if (!latestResult?.thumbnail) return;
  await requestDownload({ asset: "thumbnail" });
});

downloadDescriptionButton.addEventListener("click", async () => {
  if (!latestResult) return;
  const payload = await requestDownload({ asset: "description" }, false);
  if (payload?.content !== undefined) {
    downloadBlob(payload.content || "", payload.filename || "description.txt", "text/plain");
  }
});

downloadSubtitleButton.addEventListener("click", async () => {
  if (!latestResult) return;
  const subtitles = latestResult.subtitles || {};
  const automatic = latestResult.automaticCaptions || {};
  const firstLanguage = Object.keys(subtitles)[0] || Object.keys(automatic)[0];
  if (!firstLanguage) return;
  await requestDownload({
    asset: "subtitle",
    language: firstLanguage,
    subtitleKind: subtitles[firstLanguage] ? "manual" : "automatic",
  });
});

mergeLogClearButton?.addEventListener("click", () => {
  clearMergeLog();
});

videoPreview.addEventListener("click", async (event) => {
  const playButton = event.target.closest("[data-preview-play]");
  if (!playButton) return;
  await playPreviewVideo();
});

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    if (health.ok) {
      const available = [
        health.youGetAvailable ? "you-get" : null,
        health.ytDlpAvailable ? "yt-dlp" : null,
        health.luxAvailable ? "lux" : null,
      ].filter(Boolean).join(" / ");
      const detail = `${health.message}。默认解析器为 ${health.defaultEngine || "you-get"}。当前可用解析器：${available || "无"}。支持可选 Cookie 文件解析，Cookie 仅临时使用。`;
      setStatus("服务就绪", "Ready", detail, 0, !(health.youGetAvailable || health.ytDlpAvailable || health.luxAvailable));
      return;
    }
    setStatus("服务异常", "Warning", health.message || "服务状态异常。", 0, true);
  } catch {
    setStatus("服务未连接", "离线", "未检测到解析服务，请稍后重试。", 0, true);
  }
}

async function refreshCookieSessionStatus() {
  try {
    const response = await fetch("/api/cookie/status");
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "无法获取 Cookie 会话状态");
    }
    cookieSessionState = payload;
    renderCookieSessionStatus(payload);
  } catch {
    renderCookieSessionStatus(null);
  }
}

async function loadCookieSession() {
  const file = cookieInput?.files?.[0] || null;
  const engine = engineSelect?.value || "you-get";
  if (!file) {
    setStatus("缺少 Cookie 文件", "Warning", "请先选择要加载的 Cookie 文件。", 0, true);
    return;
  }

  cookieLoadButton.disabled = true;
  setStatus("加载 Cookie 会话", "Preparing", `正在为 ${engine} 加载 Cookie 会话。`, 30);

  try {
    const formData = new FormData();
    formData.append("engine", engine);
    formData.append("cookieFile", file);
    const response = await fetch("/api/cookie/load", {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "加载 Cookie 会话失败");
    }
    cookieSessionState = payload;
    renderCookieSessionStatus(payload);
    cookieInput.value = "";
    updateCookieHint();
    setStatus("Cookie 会话已加载", "Ready", payload.message || "后续解析会自动复用当前 Cookie 会话。", 100);
  } catch (error) {
    setStatus("加载失败", "Error", error.message || "Cookie 会话加载失败。", 0, true);
  } finally {
    cookieLoadButton.disabled = false;
  }
}

async function clearCookieSession() {
  cookieClearButton.disabled = true;
  try {
    const response = await fetch("/api/cookie/clear", { method: "POST" });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "清除 Cookie 会话失败");
    }
    cookieSessionState = payload;
    renderCookieSessionStatus(payload);
    setStatus("Cookie 会话已清除", "Ready", payload.message || "服务端不再保留已加载的 Cookie 会话。", 100);
  } catch (error) {
    setStatus("清除失败", "Error", error.message || "清除 Cookie 会话失败。", 0, true);
    cookieClearButton.disabled = false;
  }
}

async function parseUrl(targetUrl) {
  if (!targetUrl) return;
  const cookieFile = cookieInput?.files?.[0] || null;
  const engine = engineSelect?.value || "you-get";

  setBusy(true);
  setStatus("正在解析", "处理中", `${engine} 正在读取视频信息${cookieFile ? "，并临时使用你上传的 Cookie 文件。" : "，请稍候。"}`, 40);
  resetResult();

  try {
    const formData = new FormData();
    formData.append("url", targetUrl);
    formData.append("engine", engine);
    if (cookieFile) {
      formData.append("cookieFile", cookieFile);
    }

    const response = await fetch("/api/parse", {
      method: "POST",
      body: formData,
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.detail || payload.message || "解析失败");
    }
    latestResult = payload.result;
    renderResult(latestResult);
    setStatus("解析完成", "Ready", `${latestResult.extractor || engine} 解析完成。${cookieFile ? "Cookie 文件已由后端临时使用并清理。请选择格式下载。" : "请选择格式下载。优先直连源站，必要时使用后端无落盘流式转发。"}`, 100);
  } catch (error) {
    setStatus("解析失败", "Error", error.message || "视频解析时发生未知错误。", 0, true);
  } finally {
    setBusy(false);
  }
}

async function requestDownload(options, shouldOpen = true, config = {}) {
  if (!latestResult?.parseId) return null;
  if (!config.silent) {
    setStatus("正在生成下载链接", "Preparing", "后端正在生成短期有效的下载地址。", 65);
  }

  const response = await fetch("/api/download-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parseId: latestResult.parseId, ...options }),
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { ok: false, detail: await response.text() };
  if (!response.ok || !payload.ok) {
    if (!config.silent) {
      setStatus("生成失败", "Error", payload.detail || payload.message || "无法生成下载链接。", 0, true);
    }
    return null;
  }

  if (!config.silent) {
    setStatus("下载链接已生成", "Ready", "正在使用后端代理流下载，以便携带解析时获得的源站请求头。", 100);
  }
  if (shouldOpen) {
    openDownload(payload.proxyUrl || payload.directUrl, payload.filename);
  }
  return payload;
}

function clearMergeLog() {
  mergeLogLines = ["等待合并任务开始..."];
  renderMergeLog();
}

function renderMergeLog() {
  if (!mergeLog) return;
  mergeLog.textContent = mergeLogLines.join("\n");
  mergeLog.scrollTop = mergeLog.scrollHeight;
}

function mergeTimestamp() {
  const now = new Date();
  return now.toLocaleTimeString("zh-CN", { hour12: false });
}

function logMerge(message) {
  const line = `[${mergeTimestamp()}] ${message}`;
  console.log(`[merge] ${message}`);
  mergeLogLines.push(line);
  if (mergeLogLines.length > 200) {
    mergeLogLines = mergeLogLines.slice(-200);
  }
  if (mergeLogDetails) {
    mergeLogDetails.open = true;
  }
  renderMergeLog();
}

async function withTimeout(task, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) {
    return await task;
  }
  let timer = null;
  try {
    return await Promise.race([
      task,
      new Promise((_, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`${label}超时，当前阶段耗时过长。`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) {
      window.clearTimeout(timer);
    }
  }
}

async function measureStep(label, task) {
  const startedAt = performance.now();
  logMerge(`${label}开始`);
  try {
    const result = await task();
    const elapsed = Math.round(performance.now() - startedAt);
    logMerge(`${label}完成，用时 ${elapsed} ms`);
    return result;
  } catch (error) {
    const elapsed = Math.round(performance.now() - startedAt);
    logMerge(`${label}失败，用时 ${elapsed} ms，错误：${error.message || error}`);
    throw error;
  }
}

async function mergeSelectedVideo(selected) {
  if (!beginMediaTask("download-video")) return;

  if (!selected.hasVideo) {
    setStatus("无法合并", "Warning", "请选择一个视频流，再执行音视频合并。", 0, true);
    endMediaTask("download-video");
    return;
  }

  if (selected.hasAudio) {
    try {
      setStatus("准备下载视频", "处理中", "当前格式已包含音频，正在直接下载视频文件。", 20);
      const payload = await requestDownload({ asset: "video", formatId: selected.formatId }, false);
      if (!payload?.proxyUrl && !payload?.directUrl) {
        throw new Error("无法生成视频下载地址。");
      }
      const ext = extensionFromFormat(selected, "mp4");
      const videoData = await fetchBinary(payload.proxyUrl || payload.directUrl, "视频", 35, 95);
      const filename = payload.filename || `${safeDownloadName(latestResult.title || "video")}.${ext}`;
      downloadBlob(videoData, filename, mimeTypeForVideo(ext));
      setStatus("视频下载完成", "Ready", "视频文件已下载完成。", 100);
    } catch (error) {
      setStatus("视频下载失败", "Error", error.message || "视频下载失败，请重新解析后再试。", 0, true);
    } finally {
      endMediaTask("download-video");
    }
    return;
  }

  const audio = getSelectedAudioFormat();
  if (!audio) {
    setStatus("缺少音频", "Warning", "没有找到可单独合并的音频流。", 0, true);
    endMediaTask("download-video");
    return;
  }

  try {
    clearMergeLog();
    logMerge("开始合并流程");
    setStatus("准备下载", "处理中", "正在准备视频和音频文件，首次使用可能需要稍等。", 10);
    const ffmpeg = await measureStep("加载 FFmpeg.wasm", () => withTimeout(loadFfmpeg(), FFMPEG_LOAD_TIMEOUT_MS, "加载 FFmpeg.wasm"));
    logMerge("FFmpeg.wasm 已加载");
    const { outputData, outputExt } = await mergeMediaStreams(ffmpeg, selected, audio, "下载视频");
    const filename = `${safeDownloadName(latestResult.title || "video")}-merged.${outputExt}`;
    downloadBlob(outputData, filename, mimeTypeForVideo(outputExt));
    setStatus("合并完成", "Ready", "已在浏览器本地生成合并后的视频文件。", 100);
  } catch (error) {
    logMerge(`合并失败：${error.message || error}`);
    setStatus("合并失败", "Error", error.message || "浏览器合并音视频失败。", 0, true);
  } finally {
    endMediaTask("download-video");
  }
}

async function downloadSelectedAudio(audio) {
  if (!beginMediaTask("download-audio")) return;

  try {
  setStatus("准备下载音频", "处理中", "正在准备音频文件。", 20);
    const payload = await requestDownload({ asset: "audio", formatId: audio.formatId }, false);
    if (!payload?.proxyUrl && !payload?.directUrl) {
      throw new Error("无法生成音频下载地址。");
    }

    const audioData = await fetchBinary(payload.proxyUrl || payload.directUrl, "音频", 35, 95);
    const filename = payload.filename || `${safeDownloadName(latestResult.title || "audio")}.${extensionFromFormat(audio, "m4a")}`;
    downloadBlob(audioData, filename, mimeTypeForAudio(extensionFromFormat(audio, "m4a")));
    setStatus("音频下载完成", "Ready", "音频文件已下载完成。", 100);
  } catch (error) {
    setStatus("音频下载失败", "Error", error.message || "音频下载失败，请重新解析后再试。", 0, true);
  } finally {
    endMediaTask("download-audio");
  }
}

async function extractAudioFromVideo(selected) {
  if (!selected?.hasAudio) {
    throw new Error("当前视频格式不包含音频，无法提取音频。");
  }

  setStatus("准备提取音频", "处理中", "当前格式已包含音频，正在从视频流提取音频。", 20);
  const payload = await requestDownload({ asset: "video", formatId: selected.formatId }, false);
  if (!payload?.proxyUrl && !payload?.directUrl) {
    throw new Error("无法生成视频下载地址。");
  }

  clearMergeLog();
  const mediaData = await measureStep("下载待提取视频流", () => withTimeout(fetchBinary(payload.proxyUrl || payload.directUrl, "视频", 35, 75), MEDIA_FETCH_TIMEOUT_MS, "下载待提取视频流"));
  const ffmpeg = await measureStep("加载 FFmpeg.wasm", () => withTimeout(loadFfmpeg(), FFMPEG_LOAD_TIMEOUT_MS, "加载 FFmpeg.wasm"));
  const inputExt = extensionFromFormat(selected, "mp4");
  const audioExt = audioExtensionFromCombined(selected);
  const id = Date.now().toString(36);
  const inputName = `input-av-${id}.${inputExt}`;
  const outputName = `output-audio-${id}.${audioExt}`;
  await measureStep(`写入 ${inputName}`, () => ffmpeg.writeFile(inputName, mediaData));
  const command = ["-y", "-i", inputName, "-vn", "-c:a", "copy", outputName];
  logMerge(`FFmpeg 命令：${command.join(" ")}`);
  const exitCode = await measureStep("执行音频提取命令", () => withTimeout(ffmpeg.exec(command), FFMPEG_EXEC_TIMEOUT_MS, "执行音频提取命令"));
  if (typeof exitCode === "number" && exitCode !== 0) {
    throw new Error("音频提取失败，请稍后重试。");
  }
  const outputData = await measureStep(`读取 ${outputName}`, () => ffmpeg.readFile(outputName));
  await measureStep("清理 FFmpeg 临时文件", () => cleanupFfmpegFiles(ffmpeg, [inputName, outputName]));
  return { outputData, audioExt };
}

async function fetchBinary(url, label = "媒体流", startProgress = 0, endProgress = 100) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("下载待合并媒体流失败，请重新解析后再试。");
  }
  const total = Number(response.headers.get("content-length")) || 0;
  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const ratio = total ? received / total : 0;
    const progress = total ? startProgress + Math.round((endProgress - startProgress) * ratio) : Math.min(endProgress, startProgress + 1);
    setStatus(`下载${label}`, "Fetching", total ? `${formatBytes(received)} / ${formatBytes(total)}` : `已下载 ${formatBytes(received)}`, progress);
  }

  const data = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

async function mergeMediaStreams(ffmpeg, video, audio, labelPrefix) {
  setStatus("准备文件", "处理中", "正在生成视频和音频下载地址。", 18);
  const videoPayload = await requestDownload({ asset: "video", formatId: video.formatId }, false);
  const audioPayload = await requestDownload({ asset: "audio", formatId: audio.formatId }, false);
  if (!videoPayload?.proxyUrl || !audioPayload?.proxyUrl) {
    throw new Error("无法生成音视频代理下载地址。");
  }

  setStatus("下载视频流", "Fetching", "正在把视频流加载到浏览器内存。", 25);
  const videoData = await measureStep(`下载${labelPrefix}视频流`, () => withTimeout(fetchBinary(videoPayload.proxyUrl, `${labelPrefix}视频流`, 25, 43), MEDIA_FETCH_TIMEOUT_MS, `下载${labelPrefix}视频流`));
  logMerge(`视频流下载完成：${formatBytes(videoData.byteLength)}`);
  setStatus("下载音频流", "Fetching", "正在把音频流加载到浏览器内存。", 45);
  const audioData = await measureStep(`下载${labelPrefix}音频流`, () => withTimeout(fetchBinary(audioPayload.proxyUrl, `${labelPrefix}音频流`, 45, 53), MEDIA_FETCH_TIMEOUT_MS, `下载${labelPrefix}音频流`));
  logMerge(`音频流下载完成：${formatBytes(audioData.byteLength)}`);

  const videoExt = extensionFromFormat(video, "mp4");
  const audioExt = extensionFromFormat(audio, "m4a");
  const outputExt = outputExtension(video, audio);
  const id = Date.now().toString(36);
  const videoName = `input-video-${id}.${videoExt}`;
  const audioName = `input-audio-${id}.${audioExt}`;
  const outputName = `merged-output-${id}.${outputExt}`;

  setStatus("处理视频", "处理中", "正在整理视频文件。", 55);
  await measureStep(`写入 ${videoName}`, () => ffmpeg.writeFile(videoName, videoData));
  logMerge("视频流已写入 FFmpeg 文件系统");
  setStatus("处理音频", "处理中", "正在整理音频文件。", 60);
  await measureStep(`写入 ${audioName}`, () => ffmpeg.writeFile(audioName, audioData));
  logMerge("音频流已写入 FFmpeg 文件系统");
  setStatus("正在合并", "处理中", "正在生成最终视频文件，不会上传你的媒体内容。", 65);
  logMerge("开始执行 FFmpeg 合并命令");
  const command = [
    "-y",
    "-i",
    videoName,
    "-i",
    audioName,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c",
    "copy",
    "-shortest",
  ];
  if (outputExt === "mp4") {
    command.push("-movflags", "+faststart");
  }
  command.push(outputName);
  logMerge(`FFmpeg 命令：${command.join(" ")}`);
  const exitCode = await measureStep("执行 FFmpeg 合并命令", () => withTimeout(ffmpeg.exec(command), FFMPEG_EXEC_TIMEOUT_MS, "执行 FFmpeg 合并命令"));
  if (typeof exitCode === "number" && exitCode !== 0) {
    throw new Error("视频合并失败，请稍后重试。");
  }

  setStatus("生成文件", "处理中", "正在生成最终媒体文件。", 95);
  const outputData = await measureStep(`读取 ${outputName}`, () => ffmpeg.readFile(outputName));
  logMerge(`合并结果已生成：${formatBytes(outputData.byteLength)}`);
  await measureStep("清理 FFmpeg 临时文件", () => cleanupFfmpegFiles(ffmpeg, [videoName, audioName, outputName]));
  return { outputData, outputExt };
}

async function loadFfmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (!ffmpegModules) {
    const [ffmpegPackage, utilPackage] = await Promise.all([
      import("https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.15/+esm"),
      import("https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/+esm"),
    ]);
    ffmpegModules = { FFmpeg: ffmpegPackage.FFmpeg, toBlobURL: utilPackage.toBlobURL };
  }

  const { FFmpeg, toBlobURL } = ffmpegModules;
  const ffmpeg = new FFmpeg();
  ffmpeg.on("log", ({ message }) => {
    if (message) {
      logMerge(`[ffmpeg] ${message}`);
      statusCopy.textContent = message;
    }
  });
  ffmpeg.on("progress", ({ progress }) => {
    if (Number.isFinite(progress)) {
      setStatus("正在合并", "处理中", "正在生成视频文件。", 65 + Math.round(progress * 30));
    }
  });
  const baseURL = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm";
  await ffmpeg.load({
    classWorkerURL: `${window.location.origin}/ffmpeg/class-worker.js`,
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });
  ffmpegInstance = ffmpeg;
  return ffmpegInstance;
}

async function cleanupFfmpegFiles(ffmpeg, files) {
  await Promise.all(files.map(async (file) => {
    try {
      await ffmpeg.deleteFile(file);
    } catch {
      // Ignore cleanup failures in the in-memory FFmpeg filesystem.
    }
  }));
}

function renderResult(result) {
  const formats = result.formats || [];
  const manualSubtitleCount = countSubtitleEntries(result.subtitles);
  const autoSubtitleCount = countSubtitleEntries(result.automaticCaptions);

  formatCount.textContent = String(formats.length);
  subtitleCount.textContent = String(manualSubtitleCount + autoSubtitleCount);
  durationEl.textContent = result.durationText || "--";
  extractorEl.textContent = result.extractor || "--";

  videoPreview.innerHTML = `
    <div class="video-preview__media">
      ${result.thumbnail ? `
        <button class="video-preview__play" type="button" data-preview-play aria-label="播放视频预览">
          <img src="${escapeAttribute(browserSafeUrl(result.thumbnail))}" alt="视频封面" data-preview-thumbnail />
          <span>点击播放</span>
        </button>
      ` : `<div class="video-preview__placeholder">无可用封面</div>`}
    </div>
    <div class="video-preview__body">
      <p class="eyebrow">${escapeHtml(result.extractor || "解析工具")}</p>
      <h3>${escapeHtml(result.title || "未命名视频")}</h3>
      <p>${escapeHtml(result.uploader || "--")} · ${escapeHtml(result.durationText || "--")}</p>
      <p class="video-description">${escapeHtml(truncate(result.description || "暂无描述", 180))}</p>
    </div>
  `;

  renderFormats(formats);
  downloadCoverButton.disabled = !result.thumbnail;
  downloadDescriptionButton.disabled = !result.description;
  downloadSubtitleButton.disabled = manualSubtitleCount + autoSubtitleCount === 0;
  downloadAudioButton.disabled = !getSelectedAudioFormat();
  hydrateThumbnailPreview();
}

async function hydrateThumbnailPreview() {
  if (!latestResult?.thumbnail) return;
  const image = videoPreview.querySelector("[data-preview-thumbnail]");
  if (!image) return;
  const payload = await requestDownload({ asset: "thumbnail" }, false, { silent: true });
  const source = payload?.proxyUrl || payload?.directUrl;
  if (source) {
    image.src = source;
  }
}

async function playPreviewVideo() {
  if (!beginMediaTask("preview")) return;

  if (!latestResult) {
    setStatus("无法播放", "Warning", "请先解析视频。", 0, true);
    endMediaTask("preview");
    return;
  }

  try {
    setPreviewOverlay("正在缓冲...");
    const preview = pickPreviewFormats(latestResult.formats || []);
    logMerge(`预览格式选择：video=${preview.video?.formatId || "none"}, audio=${preview.audio?.formatId || "none"}, reason=${preview.reason}, score=${preview.score ?? "n/a"}`);
    if (!preview.video) {
      setStatus("无法播放", "Warning", "没有找到可播放的视频格式。", 0, true);
      return;
    }

    let source = "";
    let message = "";
    if (preview.audio) {
      clearMergeLog();
      logMerge("开始生成带声音预览");
      setStatus("准备预览", "Preview", "正在选择最小视频流和音频流生成带声音预览。", 10);
      const ffmpeg = await measureStep("加载 FFmpeg.wasm", () => withTimeout(loadFfmpeg(), FFMPEG_LOAD_TIMEOUT_MS, "加载 FFmpeg.wasm"));
      const { outputData, outputExt } = await mergeMediaStreams(ffmpeg, preview.video, preview.audio, "预览");
      revokePreviewObjectUrl();
      previewObjectUrl = URL.createObjectURL(new Blob([outputData], { type: mimeTypeForVideo(outputExt) }));
      source = previewObjectUrl;
      message = "已使用最小视频流和音频流生成同步预览。";
    } else {
      setStatus("准备播放", "Preview", "没有独立音频流，正在播放最小有声视频格式。", 60);
      const payload = await requestDownload({ asset: "video", formatId: preview.video.formatId }, false);
      source = payload?.proxyUrl || payload?.directUrl || "";
      message = preview.video.hasAudio ? "正在播放最小有声视频格式。" : "正在播放最小视频格式；该格式可能没有声音。";
    }

    if (!source) {
      setStatus("播放失败", "Error", "无法生成视频预览地址。", 0, true);
      return;
    }

    videoPreview.querySelector(".video-preview__media").innerHTML = `
      <video class="video-preview__player" controls autoplay playsinline poster="${escapeAttribute(browserSafeUrl(latestResult.thumbnail || ""))}">
        <source src="${escapeAttribute(source)}" />
        当前浏览器不支持直接播放该视频格式。
      </video>
      <div class="video-preview__overlay" data-preview-overlay>正在缓冲...</div>
    `;
    setStatus("开始播放", "Preview", message, 100);
    await bindPreviewPlayerEvents(message);
  } catch (error) {
    logMerge(`预览失败：${error.message || error}`);
    setPreviewOverlay("播放失败");
    setStatus("播放失败", "Error", error.message || "生成带声音预览失败。", 0, true);
  } finally {
    endMediaTask("preview");
  }
}

function pickPreviewFormats(formats) {
  const tiers = [
    { name: "confirmed", items: formats.filter((item) => item.formatConfidence === "confirmed") },
    { name: "fallback", items: formats },
  ];

  for (const tier of tiers) {
    if (!tier.items.length) continue;
    const videoOnly = tier.items.filter((item) => item.hasVideo && !item.hasAudio);
    const anyVideo = tier.items.filter((item) => item.hasVideo);
    const audioOnly = tier.items.filter((item) => item.hasAudio && !item.hasVideo);
    const combined = tier.items.filter((item) => item.hasVideo && item.hasAudio);

    const bestCombined = chooseBestPreviewCombined(combined);
    const bestPair = chooseBestPreviewPair(videoOnly.length ? videoOnly : anyVideo, audioOnly);

    logMerge(`预览选流 ${tier.name}：combined=${combined.length} videoOnly=${videoOnly.length} anyVideo=${anyVideo.length} audioOnly=${audioOnly.length}`);
    if (bestCombined) {
      logMerge(`预览候选 combined：${bestCombined.format.formatId || "unknown"} ext=${bestCombined.format.ext || "unknown"} v=${bestCombined.format.videoCodec || "unknown"} a=${bestCombined.format.audioCodec || "unknown"} score=${bestCombined.score}`);
    }
    if (bestPair) {
      logMerge(`预览候选 pair：video=${bestPair.video.formatId || "unknown"}/${bestPair.video.ext || "unknown"}/${bestPair.video.videoCodec || "unknown"} audio=${bestPair.audio.formatId || "unknown"}/${bestPair.audio.ext || "unknown"}/${bestPair.audio.audioCodec || "unknown"} score=${bestPair.score}`);
    }

    if (bestCombined && bestPair) {
      return bestCombined.score <= bestPair.score
        ? { video: bestCombined.format, audio: null, reason: `prefer-compatible-combined-${tier.name}`, score: bestCombined.score }
        : { video: bestPair.video, audio: bestPair.audio, reason: `prefer-compatible-separate-${tier.name}`, score: bestPair.score };
    }

    if (bestCombined) {
      return { video: bestCombined.format, audio: null, reason: `fallback-compatible-combined-${tier.name}`, score: bestCombined.score };
    }

    if (bestPair) {
      return { video: bestPair.video, audio: bestPair.audio, reason: `fallback-compatible-separate-${tier.name}`, score: bestPair.score };
    }
  }

  const fallback = formats.filter((item) => item.hasVideo).sort(compareSmallVideo)[0] || null;
  return { video: fallback, audio: null, reason: "fallback-video-only", score: fallback ? previewVideoScore(fallback) : Number.MAX_SAFE_INTEGER };
}

function compareSmallVideo(left, right) {
  return formatSizeScore(left) - formatSizeScore(right) || (left.height || 0) - (right.height || 0);
}

function compareSmallAudio(left, right) {
  return formatSizeScore(left) - formatSizeScore(right);
}

function chooseBestPreviewCombined(formats) {
  if (!formats.length) return null;

  let best = null;
  let bestScore = Number.MAX_SAFE_INTEGER;
  let bestSize = Number.MAX_SAFE_INTEGER;
  for (const format of formats) {
    const score = previewCombinedScore(format);
    const size = formatSizeScore(format);
    if (score < bestScore || (score === bestScore && size < bestSize)) {
      best = format;
      bestScore = score;
      bestSize = size;
    }
  }

  return best ? { format: best, score: bestScore } : null;
}

function chooseBestPreviewPair(videoFormats, audioFormats) {
  if (!videoFormats.length || !audioFormats.length) return null;

  let best = null;
  let bestScore = Number.MAX_SAFE_INTEGER;
  let bestSize = Number.MAX_SAFE_INTEGER;
  for (const video of videoFormats) {
    for (const audio of audioFormats) {
      const score = previewPairScore(video, audio);
      const size = formatSizeScore(video) + formatSizeScore(audio);
      if (score < bestScore || (score === bestScore && size < bestSize)) {
        best = { video, audio, score };
        bestScore = score;
        bestSize = size;
      }
    }
  }

  return best;
}

function previewCombinedScore(format) {
  return previewFormatConfidencePenalty(format) + previewBrowserScore(combinedPreviewMimeType(format), "video") + previewVideoScore(format) + previewAudioScore(format) - 1;
}

function previewPairScore(video, audio) {
  let score = previewFormatConfidencePenalty(video) + previewFormatConfidencePenalty(audio) + previewVideoScore(video) + previewAudioScore(audio) + 1;
  const outputExt = outputExtension(video, audio);
  score += previewBrowserScore(outputPreviewMimeType(video, audio), "video");
  score += previewBrowserScore(singleTrackMimeType(video, "video"), "video");
  score += previewBrowserScore(singleTrackMimeType(audio, "audio"), "audio");
  if (outputExt === "mkv") score += 6;
  if (outputExt === "webm") score += 1;
  return score;
}

function previewVideoScore(format) {
  return previewContainerScore(format.ext) + previewVideoCodecScore(format.videoCodec) + previewResolutionScore(format) + previewFilesizeScore(format);
}

function previewAudioScore(format) {
  return previewContainerScore(format.ext) + previewAudioCodecScore(format.audioCodec) + previewFilesizeScore(format);
}

function previewContainerScore(ext) {
  switch (String(ext || "").toLowerCase()) {
    case "mp4":
    case "m4a":
    case "mp3":
    case "aac":
      return 0;
    case "webm":
    case "ogg":
      return 1;
    case "mov":
      return 2;
    case "mkv":
      return 5;
    default:
      return 3;
  }
}

function previewVideoCodecScore(codec) {
  const value = String(codec || "unknown").toLowerCase();
  if (value === "none") return 99;
  if (value === "unknown") return 6;
  if (value.includes("avc") || value.includes("h264")) return 0;
  if (value.includes("vp9") || value.includes("vp8")) return 1;
  if (value.includes("hev") || value.includes("h265") || value.includes("hevc")) return 3;
  if (value.includes("av01") || value.includes("av1")) return 4;
  return 2;
}

function previewAudioCodecScore(codec) {
  const value = String(codec || "unknown").toLowerCase();
  if (value === "none") return 99;
  if (value === "unknown") return 4;
  if (value.includes("mp4a") || value.includes("aac") || value.includes("mp3")) return 0;
  if (value.includes("opus") || value.includes("vorbis")) return 1;
  return 2;
}

function previewResolutionScore(format) {
  const height = Number(format.height) || 0;
  if (!height) return 3;
  if (height <= 360) return 0;
  if (height <= 480) return 1;
  if (height <= 720) return 2;
  if (height <= 1080) return 3;
  return 4;
}

function previewFilesizeScore(format) {
  const size = Number(format.filesize) || 0;
  if (!size) return 1;
  if (size <= 20 * 1024 * 1024) return 0;
  if (size <= 80 * 1024 * 1024) return 1;
  if (size <= 160 * 1024 * 1024) return 2;
  if (size <= 320 * 1024 * 1024) return 3;
  return 3;
}

function previewFormatConfidencePenalty(format) {
  return format?.formatConfidence === "confirmed" ? 0 : 5;
}


function previewBrowserScore(mimeType, kind) {
  if (!mimeType || typeof previewPlaybackProbe.canPlayType !== "function") return 3;
  const support = previewPlaybackProbe.canPlayType(mimeType);
  if (support === "probably") return 0;
  if (support === "maybe") return 1;
  return kind === "audio" ? 2 : 4;
}

function combinedPreviewMimeType(format) {
  return singleTrackMimeType(format, format.hasVideo ? "video" : "audio");
}

function outputPreviewMimeType(video, audio) {
  const ext = outputExtension(video, audio);
  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    default:
      return `video/${ext}`;
  }
}

function singleTrackMimeType(format, kind) {
  const ext = String(format?.ext || "").toLowerCase();
  if (!ext) return "";
  if (kind === "audio") {
    switch (ext) {
      case "m4a":
      case "mp4":
        return "audio/mp4";
      case "mp3":
        return "audio/mpeg";
      case "aac":
        return "audio/aac";
      case "webm":
        return "audio/webm";
      case "ogg":
        return "audio/ogg";
      case "wav":
        return "audio/wav";
      default:
        return `audio/${ext}`;
    }
  }

  switch (ext) {
    case "mp4":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mov":
      return "video/quicktime";
    case "mkv":
      return "video/x-matroska";
    case "ogg":
      return "video/ogg";
    default:
      return `video/${ext}`;
  }
}

function bindPreviewPlayerEvents(successMessage) {
  const player = videoPreview.querySelector(".video-preview__player");
  if (!player) return Promise.resolve();

  return new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    player.addEventListener("loadedmetadata", () => logMerge(`预览 loadedmetadata：${player.duration || "unknown"}s ${player.videoWidth || 0}x${player.videoHeight || 0}`), { once: true });
    player.addEventListener("canplay", () => {
      if (!player.videoWidth || !player.videoHeight) {
        logMerge("预览 canplay 但视频尺寸为 0，判定为不适合预览的格式");
        setPreviewOverlay("播放失败");
        setStatus("播放失败", "Error", "当前预览格式只有音频或浏览器不支持视频画面，请稍后重试。", 0, true);
        settle();
        return;
      }
      logMerge("预览 canplay");
      clearPreviewOverlay();
      setStatus("可以播放", "Preview", successMessage, 100);
      settle();
    }, { once: true });
    player.addEventListener("waiting", () => logMerge("预览 waiting：浏览器正在缓冲"));
    player.addEventListener("error", () => {
      const mediaError = player.error;
      logMerge(`预览播放器错误：${mediaError?.code || "unknown"} ${mediaError?.message || ""}`);
      setPreviewOverlay("播放失败");
      setStatus("播放失败", "Error", "浏览器无法播放生成的预览文件，请查看控制台 [merge] 日志。", 0, true);
      settle();
    }, { once: true });
    player.load();
    player.play().catch((error) => {
      logMerge(`预览自动播放被阻止或失败：${error.message || error}`);
      clearPreviewOverlay();
      settle();
    });
  });
}

function formatSizeScore(item) {
  return Number.isFinite(item.filesize) && item.filesize > 0 ? item.filesize : Number.MAX_SAFE_INTEGER;
}

function setPreviewOverlay(message) {
  const media = videoPreview.querySelector(".video-preview__media");
  if (!media) return;
  const existing = media.querySelector("[data-preview-overlay]");
  if (existing) {
    existing.textContent = message;
    return;
  }
  const overlay = document.createElement("div");
  overlay.className = "video-preview__overlay";
  overlay.dataset.previewOverlay = "";
  overlay.textContent = message;
  media.append(overlay);
}

function clearPreviewOverlay() {
  videoPreview.querySelector("[data-preview-overlay]")?.remove();
}

function renderFormats(formats) {
  videoFormatSelect.innerHTML = "";
  audioFormatSelect.innerHTML = "";

  if (!formats.length) {
    setEmptySelect(videoFormatSelect, "未找到视频格式");
    setEmptySelect(audioFormatSelect, "未找到音频格式");
    mergeMediaButton.disabled = true;
    downloadAudioButton.disabled = true;
    return;
  }

  const videoFormats = formats.filter((item) => item.formatType === "video" || item.formatType === "combined" || item.hasVideo);
  const audioFormats = annotateAudioQuality(dedupeAudioFormats(formats.filter((item) => item.formatType === "audio" || (item.hasAudio && !item.hasVideo))));

  renderFormatOptions(videoFormatSelect, sortVideoFormatsDesc(videoFormats), "未找到视频格式");
  renderFormatOptions(audioFormatSelect, sortAudioFormatsDesc(audioFormats), "未找到独立音频格式");
  updateDownloadButtons();
}

function renderSearchResults(results) {
  if (!results.length) {
    searchResults.innerHTML = '<div class="search-results__empty">没有找到可用结果，换个关键词试试。</div>';
    return;
  }

  searchResults.innerHTML = results.map((item) => `
    <article class="search-result-item">
      <div class="search-result-item__thumb">
        ${item.thumbnail || item.thumbnailProxyUrl ? `<img src="${escapeAttribute(item.thumbnailProxyUrl || browserSafeUrl(item.thumbnail))}" alt="${escapeAttribute(item.title || "搜索结果封面")}" />` : '<div class="search-result-item__placeholder">NO COVER</div>'}
      </div>
      <div class="search-result-item__body">
        <p class="eyebrow">${escapeHtml(item.source || item.engine || "Search")}</p>
        <h3>${escapeHtml(item.title || "未命名结果")}</h3>
        <p>${escapeHtml(item.uploader || "--")} · ${escapeHtml(item.durationText || "--")}</p>
        <button class="secondary-action" type="button" data-search-url="${escapeAttribute(item.webpageUrl || "")}" data-search-title="${escapeAttribute(item.title || "未命名结果")}">解析这个结果</button>
      </div>
    </article>
  `).join("");
}

function openEnginePicker(selection) {
  pendingSearchSelection = selection;
  const currentEngine = engineSelect?.value || "you-get";
  const options = [
    { value: "you-get", label: "you-get", description: "默认解析器" },
    { value: "yt-dlp", label: "yt-dlp", description: "兼容性更强" },
    { value: "lux", label: "lux", description: "可作为备选" },
  ];
  enginePickerCopy.textContent = `即将解析：${selection.title || "未命名结果"}`;
  enginePickerOptions.innerHTML = options.map((option) => `
    <label class="engine-picker-option">
      <input type="radio" name="search-result-engine" value="${option.value}" ${option.value === currentEngine ? "checked" : ""} />
      <span>
        <strong>${option.label}</strong>
        <small>${option.description}</small>
      </span>
    </label>
  `).join("");
  enginePickerDialog?.showModal?.();
}

function getSelectedVideoFormat() {
  const selectedId = videoFormatSelect.value;
  return (latestResult?.formats || []).find((item) => item.formatId === selectedId) || null;
}

function getSelectedAudioFormat() {
  const selectedId = audioFormatSelect.value;
  return (latestResult?.formats || []).find((item) => item.formatId === selectedId) || null;
}

function renderFormatOptions(select, formats, emptyLabel) {
  select.innerHTML = "";
  if (!formats.length) {
    setEmptySelect(select, emptyLabel);
    return;
  }
  for (const item of formats) {
    const option = document.createElement("option");
    option.value = item.formatId;
    option.textContent = buildFormatLabel(item);
    select.append(option);
  }
  select.selectedIndex = 0;
  select.disabled = false;
}

function sortVideoFormatsDesc(formats) {
  return [...formats].sort((left, right) => {
    return (Number(right.height) || 0) - (Number(left.height) || 0)
      || previewVideoCodecScore(left.videoCodec) - previewVideoCodecScore(right.videoCodec)
      || (Number(right.vbr) || 0) - (Number(left.vbr) || 0)
      || (Number(right.filesize) || 0) - (Number(left.filesize) || 0)
      || String(left.formatId || "").localeCompare(String(right.formatId || ""));
  });
}

function sortAudioFormatsDesc(formats) {
  return [...formats].sort((left, right) => {
    return audioQualityRank(right) - audioQualityRank(left)
      || (Number(right.abr) || 0) - (Number(left.abr) || 0)
      || previewAudioCodecScore(left.audioCodec) - previewAudioCodecScore(right.audioCodec)
      || (Number(right.filesize) || 0) - (Number(left.filesize) || 0)
      || String(left.formatId || "").localeCompare(String(right.formatId || ""));
  });
}

function setEmptySelect(select, label) {
  select.innerHTML = "";
  const option = document.createElement("option");
  option.value = "";
  option.textContent = label;
  select.append(option);
  select.disabled = true;
}

function buildFormatLabel(item) {
  const parts = [item.formatType === "audio" ? buildAudioLabel(item) : (item.label || item.formatId || "default")];
  if (item.filesizeText) parts.push(item.filesizeText);
  if (item.formatType === "video" || (item.hasVideo && !item.hasAudio)) parts.push("video only");
  if (item.formatType === "audio" || (!item.hasVideo && item.hasAudio)) parts.push("audio only");
  if (item.formatType === "combined") parts.push("video+audio");
  if (item.protocol) parts.push(item.protocol);
  return parts.join(" · ");
}

function dedupeAudioFormats(formats) {
  const seen = new Set();
  const deduped = [];
  for (const item of formats) {
    const key = [
      item.directUrl || "",
      extensionFromFormat(item, "m4a"),
      formatAudioBitrate(item),
      item.audioCodec || "unknown",
      item.filesize || 0,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return sortAudioFormatsDesc(deduped);
}

function annotateAudioQuality(formats) {
  const sorted = sortAudioFormatsDesc(formats);
  return sorted.map((item, index) => ({
    ...item,
    audioQualityLabel: audioQualityLabel(item, index, sorted.length),
  }));
}

function audioQualityRank(item) {
  const abr = Number(item?.abr);
  if (Number.isFinite(abr) && abr > 0) {
    if (abr >= 160) return 3;
    if (abr >= 96) return 2;
    return 1;
  }
  const codec = String(item?.audioCodec || "").toLowerCase();
  if (codec.includes("mp4a") || codec.includes("aac") || codec.includes("opus")) return 2;
  if (codec.includes("mp3") || codec.includes("vorbis")) return 1;
  return 0;
}

function formatAudioBitrate(item) {
  const abr = Number(item?.abr);
  return Number.isFinite(abr) && abr > 0 ? `${Math.round(abr)} kbps` : "";
}

function buildAudioLabel(item) {
  const parts = [item.formatId || "audio", item.audioQualityLabel || "", formatAudioBitrate(item), extensionFromFormat(item, "m4a").toUpperCase()];
  return Array.from(new Set(parts.filter(Boolean))).join(" · ");
}

function audioQualityLabel(item, index, total) {
  const abr = Number(item?.abr);
  if (Number.isFinite(abr) && abr > 0) {
    if (abr >= 160) return "高音质";
    if (abr >= 96) return "标准音质";
    return "基础音质";
  }
  if (index === 0) return "较高音质";
  if (index === total - 1) return "较低音质";
  return "均衡音质";
}

function formatTypeLabel(item) {
  if (item.formatType === "audio" || (!item.hasVideo && item.hasAudio)) return "Audio";
  if (item.formatType === "combined" || (item.hasVideo && item.hasAudio)) return "Video+Audio";
  return "Video";
}

function updateDownloadButtons() {
  if (activeMediaTask) {
    mergeMediaButton.disabled = true;
    downloadAudioButton.disabled = true;
    return;
  }
  const selectedVideo = getSelectedVideoFormat();
  const selectedAudio = getSelectedAudioFormat();
  mergeMediaButton.disabled = !selectedVideo || (!selectedVideo.hasAudio && !selectedAudio);
  downloadAudioButton.disabled = !selectedAudio && !selectedVideo?.hasAudio;
}

function restoreFormatSelects() {
  videoFormatSelect.disabled = !hasSelectableOption(videoFormatSelect);
  audioFormatSelect.disabled = !hasSelectableOption(audioFormatSelect);
  updateDownloadButtons();
}

function hasSelectableOption(select) {
  return Array.from(select.options).some((option) => option.value);
}

function beginMediaTask(taskName) {
  if (activeMediaTask) {
    const current = MEDIA_TASK_LABELS[activeMediaTask] || "媒体任务";
    const next = MEDIA_TASK_LABELS[taskName] || "该操作";
    setStatus("请稍后", "Busy", `正在${current}，请完成后再${next}。`, progressBarValue());
    return false;
  }

  activeMediaTask = taskName;
  setMediaTaskLocked(true, taskName);
  return true;
}

function endMediaTask(taskName) {
  if (activeMediaTask !== taskName) return;
  activeMediaTask = null;
  setMediaTaskLocked(false, null);
}

function setMediaTaskLocked(isLocked, taskName) {
  videoFormatSelect.disabled = isLocked || !hasSelectableOption(videoFormatSelect);
  audioFormatSelect.disabled = isLocked || !hasSelectableOption(audioFormatSelect);
  const selectedVideo = getSelectedVideoFormat();
  const selectedAudio = getSelectedAudioFormat();
  mergeMediaButton.disabled = isLocked || !selectedVideo || (!selectedVideo.hasAudio && !selectedAudio);
  downloadAudioButton.disabled = isLocked || (!selectedAudio && !selectedVideo?.hasAudio);
  mergeMediaButton.textContent = taskName === "download-video" ? "合并中..." : "下载视频";
  downloadAudioButton.textContent = taskName === "download-audio" ? "下载中..." : "下载音频";
  setPreviewPlayDisabled(isLocked);
}

function setPreviewPlayDisabled(isDisabled) {
  videoPreview.querySelectorAll("[data-preview-play]").forEach((button) => {
    button.disabled = isDisabled;
  });
}

function progressBarValue() {
  const value = Number.parseFloat(progressBar.style.width);
  return Number.isFinite(value) ? value : 0;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function extensionFromFormat(item, fallback) {
  const ext = String(item.ext || fallback).replace(/[^a-z0-9]/gi, "").toLowerCase() || fallback;
  if (ext === "m4s") return fallback;
  return ext;
}

function outputExtension(video, audio) {
  const videoExt = extensionFromFormat(video, "mp4");
  const audioExt = extensionFromFormat(audio, "m4a");
  const videoCodec = String(video?.videoCodec || "").toLowerCase();
  const audioCodec = String(audio?.audioCodec || "").toLowerCase();
  const h264Like = videoCodec.includes("avc") || videoCodec.includes("h264") || videoCodec === "unknown";
  const aacLike = audioCodec.includes("mp4a") || audioCodec.includes("aac") || audioCodec === "unknown";
  if (videoExt === "mp4" && ["m4a", "mp4", "aac"].includes(audioExt) && h264Like && aacLike) return "mp4";
  if (videoExt === "webm" && audioExt === "webm") return "webm";
  return "mkv";
}

function audioExtensionFromCombined(format) {
  const ext = extensionFromFormat(format, "mp4");
  if (["mp3", "ogg", "wav", "webm"].includes(ext)) return ext;
  return "m4a";
}

function mimeTypeForVideo(ext) {
  if (ext === "webm") return "video/webm";
  if (ext === "mkv") return "video/x-matroska";
  return "video/mp4";
}

function mimeTypeForAudio(ext) {
  if (ext === "webm") return "audio/webm";
  if (ext === "mp3") return "audio/mpeg";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "wav") return "audio/wav";
  return "audio/mp4";
}

function safeDownloadName(value) {
  return String(value).replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "download";
}

function browserSafeUrl(value) {
  const text = String(value || "");
  if (text.startsWith("//")) return `https:${text}`;
  return text.startsWith("http://") ? `https://${text.slice("http://".length)}` : text;
}

function revokePreviewObjectUrl() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
}

function resetResult() {
  revokePreviewObjectUrl();
  latestResult = null;
  formatCount.textContent = "--";
  subtitleCount.textContent = "--";
  durationEl.textContent = "--";
  extractorEl.textContent = "--";
  videoPreview.innerHTML = '<div class="video-preview__empty">解析成功后显示视频信息</div>';
  videoFormatSelect.innerHTML = '<option value="">解析后选择视频</option>';
  audioFormatSelect.innerHTML = '<option value="">解析后选择音频</option>';
  videoFormatSelect.disabled = true;
  audioFormatSelect.disabled = true;
  mergeMediaButton.disabled = true;
  downloadAudioButton.disabled = true;
  downloadCoverButton.disabled = true;
  downloadDescriptionButton.disabled = true;
  downloadSubtitleButton.disabled = true;
}

function setBusy(isBusy) {
  parseButton.disabled = isBusy;
  parseButton.textContent = isBusy ? "解析中..." : "开始解析";
}

function setStatus(title, pill, copy, progress, isError = false) {
  statusTitle.textContent = title;
  statusPill.textContent = pill;
  statusCopy.textContent = copy;
  progressBar.style.width = `${Math.max(0, Math.min(100, progress))}%`;
  statusPill.classList.toggle("is-error", isError);
}

function updateCookieHint() {
  const engine = engineSelect?.value || "you-get";
  cookieFileTitle.textContent = COOKIE_TITLES[engine] || COOKIE_TITLES["you-get"];
  cookieFileHint.textContent = COOKIE_HINTS[engine] || COOKIE_HINTS["you-get"];
  if (cookieInput) {
    cookieInput.setAttribute("accept", COOKIE_ACCEPTS[engine] || COOKIE_ACCEPTS["you-get"]);
    cookieInput.value = "";
  }
}

function renderCookieSessionStatus(status) {
  const engine = engineSelect?.value || "you-get";
  if (!status?.active) {
    cookieSessionPill.textContent = "未加载";
    cookieSessionCopy.textContent = "当前没有已加载的 Cookie 会话。你可以先选择文件，再加载到服务端会话中反复复用。";
    cookieSessionMeta.innerHTML = "";
    cookieClearButton.disabled = true;
    return;
  }

  const compatible = Boolean(status.engineCompatibility?.[engine]);
  cookieSessionPill.textContent = compatible ? "已加载" : "需切换";
  cookieSessionCopy.textContent = compatible
    ? `当前会话 Cookie 可直接用于 ${engine}。后续解析会自动复用。`
    : `当前会话 Cookie 与 ${engine} 不兼容。请切换解析器或重新加载符合要求的 Cookie 文件。`;
  cookieSessionMeta.innerHTML = [
    `<span>文件：${escapeHtml(status.originalName || "未知")}</span>`,
    `<span>类型：${escapeHtml(status.fileType || "未知")}</span>`,
    `<span>加载时间：${formatDateTime(status.updatedAt)}</span>`,
    `<span>过期时间：${formatDateTime(status.expiresAt)}</span>`,
    `<span>兼容性：${formatCompatibility(status.engineCompatibility || {})}</span>`,
  ].join("");
  cookieClearButton.disabled = false;
}

function formatCompatibility(map) {
  return Object.entries(map)
    .map(([name, ok]) => `${name}:${ok ? "可用" : "不支持"}`)
    .join(" / ");
}

function formatDateTime(value) {
  if (!value) return "--";
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function openDownload(url, filename) {
  if (!url) return;
  const link = document.createElement("a");
  link.href = url;
  if (filename) link.download = filename;
  link.rel = "noopener noreferrer";
  link.target = "_blank";
  document.body.append(link);
  link.click();
  link.remove();
}

function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  openDownload(url, filename);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function countSubtitleEntries(groups = {}) {
  return Object.values(groups).reduce((total, entries) => total + entries.length, 0);
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#096;");
}
