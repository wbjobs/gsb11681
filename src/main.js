// 应用编排：剪贴板/文件读取 -> 格式检测 -> 转换（Worker 优先，主线程兜底）
// -> 结果展示/导出 -> IndexedDB 历史。
import { detectFormat, inspectAlpha } from './format-detect.js';
import { convertImageMainThread } from './converter-main.js';
import {
  readClipboardImage, imageFromPasteEvent, isAsyncClipboardSupported,
} from './clipboard.js';
import { addHistory, listHistory, clearHistory } from './db.js';
import { formatBytes, formatDuration, labelForMime, makeDownloadName } from './util.js';

const $ = (id) => document.getElementById(id);

const els = {
  btnPaste: $('btn-paste'),
  btnPick: $('btn-pick'),
  fileInput: $('file-input'),
  sourceEmpty: $('source-empty'),
  sourceBody: $('source-body'),
  sourcePreview: $('source-preview'),
  sourceBadge: $('source-badge'),
  warning: $('source-warning'),
  outFormat: $('out-format'),
  qualityRow: $('quality-row'),
  quality: $('out-quality'),
  qualityVal: $('quality-val'),
  btnConvert: $('btn-convert'),
  resultEmpty: $('result-empty'),
  resultBody: $('result-body'),
  resultPreview: $('result-preview'),
  resultBadge: $('result-badge'),
  progress: $('result-progress'),
  progressText: $('progress-text'),
  errorBox: $('result-error'),
  errorText: $('error-text'),
  btnRetryError: $('btn-retry-error'),
  btnFallback: $('btn-fallback'),
  btnExport: $('btn-export'),
  btnRetry: $('btn-retry'),
  btnOpenBlob: $('btn-open-blob'),
  historyList: $('history-list'),
  btnClearHistory: $('btn-clear-history'),
  toast: $('toast'),
  meta: {
    format: $('m-format'), size: $('m-size'), alpha: $('m-alpha'),
    animated: $('m-animated'), bytes: $('m-bytes'), origin: $('m-origin'),
  },
  result: {
    format: $('r-format'), size: $('r-size'), alpha: $('r-alpha'),
    bytes: $('r-bytes'), elapsed: $('r-elapsed'), delta: $('r-delta'),
  },
};

// ---------- Worker 客户端（带超时与崩溃检测） ----------
class WorkerClient {
  constructor(url) {
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.available = typeof Worker !== 'undefined';
    this.url = url;
  }

  ensure() {
    if (!this.available) return null;
    if (!this.worker) {
      try {
        this.worker = new Worker(this.url, { type: 'module' });
        this.worker.addEventListener('message', (e) => this.onMessage(e.data));
        this.worker.addEventListener('error', (e) => this.onFatal(e.message || 'Worker 运行错误'));
      } catch {
        this.available = false;
        this.worker = null;
      }
    }
    return this.worker;
  }

  onMessage(data) {
    const { id, ok, result, error } = data || {};
    const task = this.pending.get(id);
    if (!task) return;
    this.pending.delete(id);
    if (ok) task.resolve(result);
    else task.reject(Object.assign(new Error(error.message), { code: error.code }));
  }

  onFatal(message) {
    // Worker 整体崩溃：拒绝所有在途任务，并标记不可用
    this.available = false;
    for (const task of this.pending.values()) {
      task.reject(Object.assign(new Error(message), { code: 'WORKER_CRASHED' }));
    }
    this.pending.clear();
    try { this.worker?.terminate(); } catch { /* noop */ }
    this.worker = null;
  }

  run(payload, timeoutMs = 120_000) {
    const worker = this.ensure();
    if (!worker) {
      return Promise.reject(Object.assign(new Error('Worker 不可用'), { code: 'WORKER_UNAVAILABLE' }));
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error('转换超时，图片可能过大'), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      worker.postMessage({ id, payload });
    });
  }
}

const workerClient = new WorkerClient(new URL('./worker.js', import.meta.url));

// ---------- Toast ----------
let toastTimer = null;
function toast(message, kind = '') {
  els.toast.textContent = message;
  els.toast.className = `toast${kind ? ` toast-${kind}` : ''}`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, 3200);
}

// ---------- 应用状态 ----------
const state = {
  source: null, // { buffer, mime(真实), claimedMime, width, height, animated,
                //   hasAlpha, alphaMode, bytes, origin, name, blobUrl }
  result: null, // { blob, blobUrl, mime, width, height, elapsed, ... }
  lastOptions: { targetMime: 'image/png', quality: 0.92 },
};

const SUPPORTED_INPUT = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/svg+xml',
]);

function setBadge(el, text, kind = 'muted') {
  el.textContent = text;
  el.className = `badge badge-${kind}`;
}

async function loadSource({ blob, mime: claimedMime, origin }, name) {
  resetResult();
  setResultBusy('正在读取与检测图片…');

  const buffer = await blob.arrayBuffer();
  const detected = detectFormat(buffer);
  const realMime = detected.mime;
  const bytes = buffer.byteLength;

  if (!realMime) {
    // 不支持的格式：明确检测并提示，不继续转换
    setResultIdle();
    els.sourceBody.hidden = true;
    els.sourceEmpty.hidden = false;
    setBadge(els.sourceBadge, '格式不受支持', 'error');
    toast(`无法识别的图片格式（剪贴板类型：${claimedMime || '未知'}）`, 'error');
    return;
  }

  const baseName = name || (origin === 'file' ? (blob.name || 'image') : 'clipboard-image');
  const source = {
    buffer,
    mime: realMime,
    claimedMime: claimedMime || realMime,
    width: detected.width,
    height: detected.height,
    animated: detected.animated,
    hasAlpha: detected.alphaHint,
    alphaMode: detected.alphaHint ? 'header' : 'none',
    bytes,
    origin,
    name: baseName,
    blobUrl: URL.createObjectURL(new Blob([buffer], { type: realMime })),
    supported: SUPPORTED_INPUT.has(realMime),
    convertedFromUnsupported: false,
  };

  state.source = source;
  renderSourceSkeleton(source);

  // 解码校验：尺寸缺失（如部分 WebP/SVG）或需要核验透明通道时执行
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(new Blob([buffer], { type: realMime }));
    if (!source.width || !source.height) {
      source.width = bitmap.width;
      source.height = bitmap.height;
    }
    // 对声明/疑似带 alpha 的容器做像素级核验；其他容器也抽样确认真实透明
    const alphaInfo = inspectAlphaWithFallback(bitmap);
    if (alphaInfo) {
      source.hasAlpha = alphaInfo.hasAlpha;
      source.alphaMode = 'pixel';
    }
  } catch {
    // 解码失败：保留头部信息，转换阶段会再次报错并给出重试/主线程兜底
    source.decodeWarning = true;
  } finally {
    bitmap?.close?.();
  }

  renderSource(source);
  setResultIdle();

  // 自动选择推荐输出格式
  els.outFormat.value = source.hasAlpha ? 'image/png' : 'image/webp';
  syncQualityVisibility();
}

function inspectAlphaWithFallback(bitmap) {
  try {
    return inspectAlpha(bitmap);
  } catch {
    return null;
  }
}

function renderSourceSkeleton(source) {
  els.sourceEmpty.hidden = true;
  els.sourceBody.hidden = false;
  els.sourcePreview.innerHTML = '';
  const img = document.createElement('img');
  img.src = source.blobUrl;
  img.alt = '源图片预览';
  els.sourcePreview.appendChild(img);
  setBadge(els.sourceBadge, labelForMime(source.mime), source.supported ? 'ok' : 'warn');
}

function alphaText(source) {
  if (source.mime === 'image/jpeg') return { text: '不支持', cls: 'alpha-no' };
  if (source.hasAlpha) {
    return { text: `有（${source.alphaMode === 'pixel' ? '像素确认' : '头部声明'}）`, cls: 'alpha-yes' };
  }
  return { text: '无', cls: 'alpha-no' };
}

function renderSource(source) {
  els.meta.format.textContent = labelForMime(source.mime) +
    (source.claimedMime && source.claimedMime !== source.mime
      ? `（上报为 ${labelForMime(source.claimedMime)}）` : '');
  els.meta.size.textContent = source.width && source.height
    ? `${source.width} × ${source.height}` : '解析中…';
  const alpha = alphaText(source);
  els.meta.alpha.textContent = alpha.text;
  els.meta.alpha.className = alpha.cls;
  els.meta.animated.textContent = source.animated ? '是（将取首帧）' : '否';
  els.meta.bytes.textContent = formatBytes(source.bytes);
  els.meta.origin.textContent =
    source.origin === 'clipboard' ? '异步剪贴板'
    : source.origin === 'paste-event' ? '粘贴事件' : '本地文件';

  const warnings = [];
  if (!source.supported) warnings.push(`当前环境对 ${labelForMime(source.mime)} 的支持有限，将尝试转换处理`);
  if (source.animated) warnings.push('检测到动画图片：将降级为静态首帧（不保留动画）');
  if (source.mime === 'image/bmp') warnings.push('BMP 体积较大，建议转换为 PNG/WebP');
  if (source.mime === 'image/svg+xml') warnings.push('SVG 为矢量格式，栅格化后将变为位图');
  if (source.decodeWarning) warnings.push('预解码失败，转换时会重试；如持续失败可使用主线程模式');
  if (source.width * source.height > 20_000_000) {
    warnings.push('图片尺寸较大，转换时将自动限幅以避免内存崩溃');
  }
  if (warnings.length) {
    els.warning.innerHTML = warnings.map((w) => `• ${w}`).join('<br>');
    els.warning.hidden = false;
  } else {
    els.warning.hidden = true;
  }
}

// ---------- 结果区状态切换 ----------
function setResultBusy(text) {
  els.resultEmpty.hidden = true;
  els.resultBody.hidden = true;
  els.errorBox.hidden = true;
  els.progressText.textContent = text || '正在转换…';
  els.progress.hidden = false;
}
function setResultIdle() {
  els.progress.hidden = true;
  els.errorBox.hidden = true;
  if (!state.result) {
    els.resultBody.hidden = true;
    els.resultEmpty.hidden = false;
    setBadge(els.resultBadge, '—', 'muted');
  }
}
function showResultError(message) {
  els.progress.hidden = true;
  els.resultBody.hidden = true;
  els.resultEmpty.hidden = true;
  els.errorText.textContent = message;
  els.errorBox.hidden = false;
  setBadge(els.resultBadge, '转换失败', 'error');
}
function resetResult() {
  if (state.result?.blobUrl) URL.revokeObjectURL(state.result.blobUrl);
  state.result = null;
  setResultIdle();
}

// ---------- 转换 ----------
async function runConvert({ useMainThread = false } = {}) {
  if (!state.source) {
    toast('请先读取一张图片', 'error');
    return;
  }
  const targetMime = els.outFormat.value;
  const quality = Number(els.quality.value);
  state.lastOptions = { targetMime, quality };
  els.btnConvert.disabled = true;
  setResultBusy(useMainThread ? '主线程模式转换中（界面可能短暂卡顿）…' : '后台 Worker 转换中…');

  // 传转移一份 ArrayBuffer 给 Worker，源 buffer 保留副本以便重试
  const payload = {
    buffer: state.source.buffer.slice(0),
    sourceMime: state.source.mime,
    targetMime,
    quality,
  };

  const started = performance.now();
  try {
    let output;
    if (useMainThread) {
      output = await convertImageMainThread(payload);
    } else {
      try {
        output = await workerClient.run(payload);
      } catch (err) {
        // Worker 崩溃/不可用：自动透明降级到主线程，用户无感
        if (err.code === 'WORKER_UNAVAILABLE' || err.code === 'WORKER_CRASHED' ||
            err.code === 'TIMEOUT') {
          toast('Worker 不可用，已自动切换到主线程模式', 'warn');
          output = await convertImageMainThread(payload);
        } else {
          throw err;
        }
      }
    }
    const elapsed = performance.now() - started;
    renderResult(output, elapsed, targetMime, useMainThread);
  } catch (err) {
    showResultError(describeConvertError(err));
  } finally {
    els.btnConvert.disabled = false;
  }
}

function describeConvertError(err) {
  const base = err?.message || String(err);
  switch (err?.code) {
    case 'DECODE_FAILED':
    case 'SVG_DECODE_FAILED':
      return `${base}。可点击「使用主线程模式重试」（SVG/特殊编码更可能成功）。`;
    case 'ENCODE_FAILED':
      return `${base}。可尝试更换输出格式后重试。`;
    case 'TIMEOUT':
      return `${base}。可改用主线程模式重试。`;
    default:
      return `${base}。可点击「重试」再试一次。`;
  }
}

async function renderResult(output, elapsed, requestedMime, usedMainThread) {
  const blobUrl = URL.createObjectURL(output.blob);
  if (state.result?.blobUrl) URL.revokeObjectURL(state.result.blobUrl);
  state.result = { ...output, blobUrl, elapsed, requestedMime, usedMainThread };

  els.progress.hidden = true;
  els.errorBox.hidden = true;
  els.resultEmpty.hidden = true;
  els.resultBody.hidden = false;

  els.resultPreview.innerHTML = '';
  const img = document.createElement('img');
  img.src = blobUrl;
  img.alt = '转换结果预览';
  els.resultPreview.appendChild(img);

  els.result.format.textContent = labelForMime(output.outputMime);
  els.result.size.textContent = `${output.width} × ${output.height}`;
  els.result.alpha.textContent = output.outputMime === 'image/jpeg'
    ? '已铺白底（JPEG 无透明）'
    : output.sourceHadAlpha ? '保留透明' : '无透明';
  els.result.alpha.className =
    output.outputMime === 'image/jpeg' || !output.sourceHadAlpha ? 'alpha-no' : 'alpha-yes';
  els.result.bytes.textContent = formatBytes(output.blob.size);
  els.result.elapsed.textContent = formatDuration(elapsed);

  const before = state.source.bytes;
  const diff = output.blob.size - before;
  const pct = before ? ((diff / before) * 100) : 0;
  const abs = Math.abs(diff);
  const compact = abs >= 1024 * 1024
    ? `${(abs / 1024 / 1024).toFixed(2)} MB`
    : abs >= 1024 ? `${(abs / 1024).toFixed(1)} KB` : `${abs} B`;
  const sign = diff > 0 ? '+' : diff < 0 ? '-' : '±';
  els.result.delta.textContent = `${sign}${compact}（${diff > 0 ? '+' : ''}${pct.toFixed(1)}%）`;
  els.result.delta.className = diff <= 0 ? 'alpha-yes' : '';

  const notes = [];
  if (output.downgraded && output.outputMime !== requestedMime) {
    notes.push(`当前浏览器不支持输出 ${labelForMime(requestedMime)}，已自动改用 ${labelForMime(output.outputMime)}`);
  }
  if (output.scaledDown) notes.push('超过安全尺寸/像素上限，已等比缩小以保证不崩溃');
  if (output.alphaFlattened && output.sourceHadAlpha) {
    notes.push('源图含透明通道，转 JPEG 时已铺白色底');
  }
  if (usedMainThread) notes.push('本次使用主线程模式完成');
  setBadge(els.resultBadge, notes.length ? '完成（含降级）' : '转换成功', notes.length ? 'warn' : 'ok');
  if (notes.length) toast(notes[0], 'warn');

  els.btnOpenBlob.href = blobUrl;
  els.btnOpenBlob.hidden = false;

  // 写入 IndexedDB（缩略图 + 元信息，Blob 可结构化克隆）
  try {
    await addHistory({
      name: state.source.name,
      sourceMime: state.source.mime,
      outputMime: output.outputMime,
      sourceBytes: state.source.bytes,
      outputBytes: output.blob.size,
      width: output.width,
      height: output.height,
      elapsed,
      thumbnail: output.blob,
    });
    refreshHistory();
  } catch {
    // 持久化失败不影响主流程
  }
}

// ---------- 导出 ----------
function exportResult() {
  if (!state.result) return;
  const a = document.createElement('a');
  a.href = state.result.blobUrl;
  a.download = makeDownloadName(state.source.name, state.result.outputMime, '-converted');
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast('已开始导出', 'ok');
}

// ---------- 历史 ----------
async function refreshHistory() {
  let rows = [];
  try {
    rows = await listHistory(8);
  } catch {
    return;
  }
  els.historyList.innerHTML = '';
  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'history-empty';
    li.textContent = '暂无记录，最近的源图片与转换结果会保存在本地';
    els.historyList.appendChild(li);
    return;
  }
  for (const row of rows) {
    const li = document.createElement('li');

    const thumb = document.createElement('img');
    thumb.className = 'history-thumb';
    thumb.alt = '';
    if (row.thumbnail) {
      const u = URL.createObjectURL(row.thumbnail);
      thumb.src = u;
      thumb.addEventListener('load', () => URL.revokeObjectURL(u), { once: true });
    }
    li.appendChild(thumb);

    const main = document.createElement('div');
    main.className = 'history-main';
    const title = document.createElement('div');
    title.className = 'history-title';
    title.textContent = `${labelForMime(row.sourceMime)} → ${labelForMime(row.outputMime)} · ${row.name || 'image'}`;
    const sub = document.createElement('div');
    sub.className = 'history-sub';
    const date = new Date(row.createdAt).toLocaleString();
    sub.textContent = `${row.width}×${row.height} · ${formatBytes(row.sourceBytes)} → ${formatBytes(row.outputBytes)} · ${formatDuration(row.elapsed)} · ${date}`;
    main.append(title, sub);
    li.appendChild(main);

    if (row.thumbnail) {
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      const dl = document.createElement('button');
      dl.className = 'btn btn-ghost btn-sm';
      dl.textContent = '导出';
      dl.addEventListener('click', () => {
        const a = document.createElement('a');
        const u = URL.createObjectURL(row.thumbnail);
        a.href = u;
        a.download = makeDownloadName(row.name, row.outputMime, '-converted');
        a.click();
        setTimeout(() => URL.revokeObjectURL(u), 1000);
      });
      actions.appendChild(dl);
      li.appendChild(actions);
    }
    els.historyList.appendChild(li);
  }
}

// ---------- 事件绑定 ----------
function syncQualityVisibility() {
  els.qualityRow.hidden = els.outFormat.value === 'image/png';
}

async function handlePasteButton() {
  try {
    const data = await readClipboardImage();
    try {
      await loadSource(data, 'clipboard-image');
      toast('已从剪贴板读取图片', 'ok');
    } catch (loadErr) {
      toast(`图片读取失败：${loadErr.message || loadErr}`, 'error');
      setResultIdle();
    }
  } catch (err) {
    if (err.code === 'PERMISSION_DENIED') {
      toast(err.message, 'error');
    } else if (err.code === 'EMPTY') {
      toast('剪贴板中没有图片', 'error');
    } else {
      toast(err.message, 'error');
    }
  }
}

function init() {
  els.sourceBadge.textContent = '等待读取';
  syncQualityVisibility();

  els.btnPaste.addEventListener('click', handlePasteButton);
  els.btnPick.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', async () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (!file) return;
    try {
      await loadSource({ blob: file, mime: file.type, origin: 'file' }, file.name);
      toast('已载入文件', 'ok');
    } catch (err) {
      toast(`读取失败：${err.message || err}`, 'error');
    } finally {
      els.fileInput.value = '';
    }
  });

  // 全局 Ctrl/⌘ + V 兜底（对权限受限的浏览器尤其重要）
  window.addEventListener('paste', async (event) => {
    const data = imageFromPasteEvent(event);
    if (!data) return;
    event.preventDefault();
    try {
      await loadSource(data, 'clipboard-image');
      toast('已从粘贴事件读取图片', 'ok');
    } catch (err) {
      toast(`读取失败：${err.message || err}`, 'error');
    }
  });

  els.outFormat.addEventListener('change', syncQualityVisibility);
  els.quality.addEventListener('input', () => {
    els.qualityVal.textContent = Number(els.quality.value).toFixed(2);
  });

  els.btnConvert.addEventListener('click', () => runConvert({ useMainThread: false }));
  els.btnRetry.addEventListener('click', () => runConvert({ useMainThread: false }));
  els.btnRetryError.addEventListener('click', () => runConvert({ useMainThread: false }));
  els.btnFallback.addEventListener('click', () => runConvert({ useMainThread: true }));
  els.btnExport.addEventListener('click', exportResult);

  els.btnClearHistory.addEventListener('click', async () => {
    await clearHistory();
    refreshHistory();
    toast('历史记录已清空');
  });

  if (!isAsyncClipboardSupported()) {
    els.btnPaste.title = '当前浏览器不支持异步读取，可直接 Ctrl/⌘+V';
  }

  refreshHistory();
}

init();
