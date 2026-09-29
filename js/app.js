/* 主逻辑：剪贴板读取、格式识别、转换调度、导出、历史记录 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    supportList: $('support-list'), dropZone: $('drop-zone'),
    readBtn: $('read-clipboard-btn'), fileInput: $('file-input'),
    status: $('status-msg'), convertPanel: $('convert-panel'),
    targetFormat: $('target-format'), quality: $('quality'),
    qualityVal: $('quality-val'), qualityWrap: $('quality-wrap'),
    bgWrap: $('bg-wrap'), bgColor: $('bg-color'), maxDim: $('max-dim'),
    convertBtn: $('convert-btn'), retryBtn: $('retry-btn'),
    comparePanel: $('compare-panel'), srcPreview: $('src-preview'),
    dstPreview: $('dst-preview'), srcMeta: $('src-meta'), dstMeta: $('dst-meta'),
    exportBtn: $('export-btn'), historyList: $('history-list'),
    clearHistoryBtn: $('clear-history-btn'),
  };

  const state = {
    srcBlob: null, srcInfo: null, dstBlob: null, dstInfo: null,
    srcUrl: null, dstUrl: null, worker: null, reqId: 0, pending: new Map(),
  };

  /* ---------- 能力检测 ---------- */
  const caps = {
    clipboardRead: !!(navigator.clipboard && navigator.clipboard.read),
    createImageBitmap: typeof createImageBitmap === 'function',
    worker: typeof Worker !== 'undefined',
    offscreenCanvas: typeof OffscreenCanvas !== 'undefined' &&
      !!OffscreenCanvas.prototype.convertToBlob,
    indexedDB: typeof indexedDB !== 'undefined',
    encode: {},
  };

  function detectEncodeSupport() {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
      try {
        caps.encode[mime] = canvas.toDataURL(mime).startsWith('data:' + mime);
      } catch { caps.encode[mime] = false; }
    }
  }

  function renderCaps() {
    const items = [
      ['Clipboard API', caps.clipboardRead],
      ['createImageBitmap', caps.createImageBitmap],
      ['Web Worker', caps.worker],
      ['OffscreenCanvas', caps.offscreenCanvas],
      ['IndexedDB', caps.indexedDB],
      ['编码 PNG', caps.encode['image/png']],
      ['编码 JPEG', caps.encode['image/jpeg']],
      ['编码 WebP', caps.encode['image/webp']],
    ];
    els.supportList.innerHTML = items.map(([name, ok]) =>
      `<li class="${ok ? '' : 'no'}">${ok ? '✓' : '✗'} ${name}</li>`).join('');
    for (const opt of els.targetFormat.options) {
      opt.disabled = !caps.encode[opt.value];
    }
    if (!caps.encode[els.targetFormat.value]) {
      const first = [...els.targetFormat.options].find((o) => !o.disabled);
      if (first) els.targetFormat.value = first.value;
    }
  }

  /* ---------- 状态提示 ---------- */
  function setStatus(msg, type) {
    els.status.textContent = msg || '';
    els.status.className = 'status' + (type ? ' ' + type : '');
  }

  /* ---------- 剪贴板 / 文件输入 ---------- */
  async function readClipboard() {
    if (!caps.clipboardRead) {
      setStatus('当前浏览器不支持 Clipboard API，请使用 Ctrl+V 粘贴。', 'error');
      return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/')) ||
                     item.types.includes('text/html') && null;
        if (type) {
          const blob = await item.getType(type);
          await loadSource(blob);
          return;
        }
      }
      setStatus('剪贴板中没有图片（内容为空或不是图片）。', 'error');
    } catch (err) {
      if (err && err.name === 'NotAllowedError') {
        setStatus('剪贴板权限被拒绝，请授权后重试，或使用 Ctrl+V 粘贴。', 'error');
      } else {
        setStatus('读取剪贴板失败：' + err.message, 'error');
      }
    }
  }

  async function loadSource(blob) {
    if (!blob || !blob.size) {
      setStatus('剪贴板为空或未获取到图片数据。', 'error');
      return;
    }
    const buffer = await blob.arrayBuffer();
    const info = FormatDetect.analyze(buffer);
    if (info.format === 'unknown') {
      setStatus('无法识别的图片格式，可能不是 PNG/JPEG/WebP/GIF/BMP/SVG。', 'error');
      return;
    }
    revokeUrls();
    state.srcBlob = blob;
    state.srcInfo = info;
    state.dstBlob = null;
    state.srcUrl = URL.createObjectURL(blob);
    els.srcPreview.src = state.srcUrl;
    els.dstPreview.removeAttribute('src');
    els.dstMeta.innerHTML = '';
    els.exportBtn.disabled = true;
    renderSrcMeta();
    els.convertPanel.classList.remove('hidden');
    els.comparePanel.classList.remove('hidden');
    els.retryBtn.classList.add('hidden');

    const notes = [];
    if (info.animated) notes.push('动画图将降级为静态首帧');
    if (info.format === 'svg') notes.push('SVG 将被栅格化');
    if (info.width * info.height > 4e7) notes.push('超大图，建议限制最大边长');
    setStatus(`已读取 ${info.label} 图片。${notes.join('；')}`, 'ok');
  }

  function renderSrcMeta() {
    const i = state.srcInfo;
    els.srcMeta.innerHTML = metaHtml([
      ['格式', `<span class="badge">${i.label}</span>`],
      ['尺寸', i.width ? `${i.width} × ${i.height} px` : '未知'],
      ['大小', formatBytes(state.srcBlob.size)],
      ['透明通道', i.hasAlpha ? '有' : '无'],
      ['动画', i.animated ? '<span class="badge warn">是（将转静态）</span>' : '否'],
    ]);
  }

  function metaHtml(rows) {
    return rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  /* ---------- 转换 ---------- */
  function getWorker() {
    if (!state.worker) {
      state.worker = new Worker('js/worker.js');
      state.worker.onmessage = (e) => {
        const cb = state.pending.get(e.data.id);
        if (cb) { state.pending.delete(e.data.id); cb(e.data); }
      };
    }
    return state.worker;
  }

  function convertInWorker(blob, opts) {
    return new Promise((resolve, reject) => {
      const id = ++state.reqId;
      state.pending.set(id, (res) => res.ok ? resolve(res) : reject(new Error(res.error)));
      getWorker().postMessage(Object.assign({ id, blob }, opts));
    });
  }

  async function convertOnMainThread(blob, opts) {
    const bitmap = await createImageBitmap(blob);
    let { width, height } = bitmap;
    if (opts.maxDim > 0 && Math.max(width, height) > opts.maxDim) {
      const scale = opts.maxDim / Math.max(width, height);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (opts.targetMime === 'image/jpeg') {
      ctx.fillStyle = opts.bgColor || '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const out = await new Promise((res) => canvas.toBlob(res, opts.targetMime, opts.quality));
    if (!out) throw new Error('编码失败：当前浏览器不支持 ' + opts.targetMime);
    return { blob: out, width, height };
  }

  /* SVG 栅格化（部分浏览器 createImageBitmap 不支持无尺寸 SVG，走 <img> 兜底） */
  async function rasterizeSvgOnMain(blob, opts) {
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('SVG 解析失败'));
        im.src = url;
      });
      let width = img.naturalWidth || 512;
      let height = img.naturalHeight || 512;
      if (opts.maxDim > 0 && Math.max(width, height) > opts.maxDim) {
        const scale = opts.maxDim / Math.max(width, height);
        width = Math.max(1, Math.round(width * scale));
        height = Math.max(1, Math.round(height * scale));
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (opts.targetMime === 'image/jpeg') {
        ctx.fillStyle = opts.bgColor || '#ffffff';
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(img, 0, 0, width, height);
      const out = await new Promise((res) => canvas.toBlob(res, opts.targetMime, opts.quality));
      if (!out) throw new Error('编码失败');
      return { blob: out, width, height };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function doConvert() {
    if (!state.srcBlob) return;
    const opts = {
      targetMime: els.targetFormat.value,
      quality: parseFloat(els.quality.value),
      maxDim: parseInt(els.maxDim.value, 10),
      bgColor: els.bgColor.value,
    };
    els.convertBtn.disabled = true;
    els.retryBtn.classList.add('hidden');
    setStatus('转换中…');
    const started = performance.now();
    try {
      let result;
      if (state.srcInfo.format === 'svg') {
        result = await rasterizeSvgOnMain(state.srcBlob, opts);
      } else if (caps.worker && caps.offscreenCanvas) {
        result = await convertInWorker(state.srcBlob, opts);
      } else {
        result = await convertOnMainThread(state.srcBlob, opts);
      }
      const elapsed = performance.now() - started;
      state.dstBlob = result.blob;
      state.dstInfo = { width: result.width, height: result.height, elapsed };
      if (state.dstUrl) URL.revokeObjectURL(state.dstUrl);
      state.dstUrl = URL.createObjectURL(result.blob);
      els.dstPreview.src = state.dstUrl;
      const keepAlpha = opts.targetMime !== 'image/jpeg';
      els.dstMeta.innerHTML = metaHtml([
        ['格式', `<span class="badge">${opts.targetMime.split('/')[1].toUpperCase()}</span>`],
        ['尺寸', `${result.width} × ${result.height} px`],
        ['大小', `${formatBytes(result.blob.size)}（原 ${formatBytes(state.srcBlob.size)}）`],
        ['透明通道', keepAlpha ? (state.srcInfo.hasAlpha ? '已保留' : '无') : '已铺底去除'],
        ['耗时', elapsed.toFixed(0) + ' ms'],
      ]);
      els.exportBtn.disabled = false;
      setStatus('转换完成。', 'ok');
      saveHistory(result.blob, opts.targetMime, elapsed).catch(() => {});
    } catch (err) {
      setStatus('转换失败：' + err.message + '。可点击“重试”。', 'error');
      els.retryBtn.classList.remove('hidden');
    } finally {
      els.convertBtn.disabled = false;
    }
  }

  /* ---------- 导出 ---------- */
  function exportResult() {
    if (!state.dstBlob) return;
    const ext = state.dstBlob.type.split('/')[1] || 'png';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(state.dstBlob);
    a.download = `converted-${Date.now()}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------- 历史记录 ---------- */
  async function makeThumb(blob) {
    try {
      const bitmap = await createImageBitmap(blob);
      const scale = Math.min(1, 80 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return await new Promise((res) => canvas.toBlob(res, 'image/png'));
    } catch { return null; }
  }

  async function saveHistory(blob, mime, elapsed) {
    if (!caps.indexedDB) return;
    const thumb = await makeThumb(blob);
    await HistoryDB.add({
      time: Date.now(),
      from: state.srcInfo.label, to: mime.split('/')[1].toUpperCase(),
      srcSize: state.srcBlob.size, dstSize: blob.size,
      elapsed: Math.round(elapsed), thumb,
    });
    renderHistory();
  }

  async function renderHistory() {
    if (!caps.indexedDB) return;
    let records = [];
    try { records = await HistoryDB.list(); } catch { return; }
    if (!records.length) {
      els.historyList.innerHTML = '<li class="empty">暂无记录</li>';
      return;
    }
    els.historyList.innerHTML = '';
    for (const r of records.slice(0, 20)) {
      const li = document.createElement('li');
      const img = document.createElement('img');
      if (r.thumb) img.src = URL.createObjectURL(r.thumb);
      const text = document.createElement('span');
      text.className = 'grow';
      text.textContent = `${new Date(r.time).toLocaleString()} ｜ ${r.from} → ${r.to} ｜ ` +
        `${formatBytes(r.srcSize)} → ${formatBytes(r.dstSize)} ｜ ${r.elapsed} ms`;
      li.append(img, text);
      els.historyList.appendChild(li);
    }
  }

  /* ---------- 事件绑定 ---------- */
  function revokeUrls() {
    if (state.srcUrl) URL.revokeObjectURL(state.srcUrl);
    if (state.dstUrl) URL.revokeObjectURL(state.dstUrl);
    state.srcUrl = state.dstUrl = null;
  }

  function bindEvents() {
    els.readBtn.addEventListener('click', readClipboard);
    els.convertBtn.addEventListener('click', doConvert);
    els.retryBtn.addEventListener('click', doConvert);
    els.exportBtn.addEventListener('click', exportResult);
    els.clearHistoryBtn.addEventListener('click', () =>
      HistoryDB.clear().then(renderHistory).catch(() => {}));

    els.quality.addEventListener('input', () => {
      els.qualityVal.textContent = els.quality.value;
    });
    els.targetFormat.addEventListener('change', () => {
      const isJpeg = els.targetFormat.value === 'image/jpeg';
      const isPng = els.targetFormat.value === 'image/png';
      els.qualityWrap.classList.toggle('hidden', isPng);
      els.bgWrap.classList.toggle('hidden', !isJpeg);
    });

    document.addEventListener('paste', (e) => {
      const item = [...(e.clipboardData ? e.clipboardData.items : [])]
        .find((it) => it.type.startsWith('image/'));
      if (item) {
        e.preventDefault();
        loadSource(item.getAsFile());
      } else if (e.clipboardData) {
        setStatus('剪贴板中没有图片。', 'error');
      }
    });

    els.dropZone.addEventListener('click', (e) => {
      if (e.target === els.dropZone || e.target.closest('.drop-sub')) els.fileInput.click();
    });
    els.dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') els.fileInput.click();
    });
    els.fileInput.addEventListener('change', () => {
      if (els.fileInput.files[0]) loadSource(els.fileInput.files[0]);
    });
    els.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      els.dropZone.classList.add('dragover');
    });
    els.dropZone.addEventListener('dragleave', () => els.dropZone.classList.remove('dragover'));
    els.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      els.dropZone.classList.remove('dragover');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadSource(file);
    });
  }

  /* ---------- 启动 ---------- */
  detectEncodeSupport();
  renderCaps();
  bindEvents();
  renderHistory();
  els.qualityWrap.classList.add('hidden');
  els.bgWrap.classList.add('hidden');
})();
