# 剪贴板图片转换器

零框架、纯原生 Web API 实现的剪贴板图片读取 / 格式识别 / 转换 / 导出工具。

## 运行

模块脚本与 Web Worker 要求 http(s) 源，直接双击 `index.html`（file://）无法使用：

```bash
# 任选其一
python3 -m http.server 8080
npx serve .
```

然后打开 http://localhost:8080 ，复制一张图片后点击「读取剪贴板图片」或直接 `Ctrl/⌘ + V`。
剪贴板 API 通常要求安全上下文（localhost 或 https）。

## 功能

- 读取剪贴板图片：`navigator.clipboard.read()`（异步 Clipboard API），并以全局 `paste` 事件兜底；另有「选择文件」入口用于无权限/测试场景。
- 识别真实格式：不依赖浏览器给出的 MIME，直接嗅探文件头魔数，支持 PNG / JPEG / WebP / GIF / BMP / SVG，并解析尺寸、动画标志与透明通道线索。
- 透明通道：头部声明 + 解码后像素采样双重确认；转 JPEG 时统一铺白底，转 PNG/WebP 时保留透明。
- 动画降级：GIF / APNG / 动态 WebP 经 `createImageBitmap` 只解码首帧，界面明确提示「降级为静态」。
- 大图保护：超过 8192px 单边或 2400 万像素时等比限幅，避免 canvas 内存崩溃。
- 转换在 Web Worker（module worker）中执行，不阻塞界面；Worker 不可用/崩溃/超时时自动或手动切换主线程模式（`<img>` 路径，SVG 栅格化走该路径）。
- 失败可重试：错误面板提供「重试」与「使用主线程模式重试」。
- 转换前后展示格式、尺寸、文件大小、体积变化百分比与耗时；棋盘格背景预览透明效果。
- 导出：`a[download]` 下载转换结果；「新窗口查看」Blob URL。
- IndexedDB 持久化最近转换历史（缩略 Blob + 元信息），可再次导出。
- 编码器不支持时自动降级（如旧浏览器不支持 WebP 编码时回退 PNG）并在结果中标注。

## 异常分支

剪贴板为空、权限被拒、浏览器不支持异步剪贴板、无法识别的格式、解码失败、编码失败、超时、大图、动画、透明通道、Worker 崩溃均有对应提示或兜底。

## 文件结构

- `index.html` / `styles/main.css`：页面与样式
- `src/main.js`：应用编排、UI、导出、历史、事件
- `src/clipboard.js`：剪贴板读取（异步 API + paste 事件）
- `src/format-detect.js`：魔数嗅探、各格式头解析（尺寸/动画/alpha）、像素 alpha 采样
- `src/converter.js`：解码、限幅、透明处理、编码（Worker 与主线程共享的纯逻辑）
- `src/worker.js`：Web Worker 包装
- `src/converter-main.js`：主线程降级转换（HTMLImageElement + canvas.toBlob）
- `src/db.js`：IndexedDB 历史
- `src/util.js`：大小/耗时格式化等
