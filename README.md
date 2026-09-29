# 剪贴板图片格式转换器

纯原生 HTML/CSS/JS，无任何框架与构建步骤。

## 运行

需通过 HTTP(S) 访问（Clipboard API 要求安全上下文）：

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

## 功能

- **读取剪贴板**：`navigator.clipboard.read()` 按钮读取 + `Ctrl+V` 粘贴事件兜底，支持拖拽/文件选择
- **格式识别**：纯字节解析（魔数 + 头部结构），识别 PNG/JPEG/WebP/GIF/BMP/SVG/AVIF/ICO/TIFF，并提取尺寸、透明通道、动画标记
- **格式转换**：Web Worker + OffscreenCanvas 中解码（`createImageBitmap`）并编码（`convertToBlob`），不卡主线程；不支持时自动回退主线程 Canvas
- **透明通道**：PNG/WebP 保留 alpha；转 JPEG 时用可选背景色铺底
- **动画降级**：GIF/APNG/动态 WebP 自动取首帧转静态
- **大图保护**：可限制最大边长（默认 2048px），防止解码崩溃
- **失败重试**：转换失败显示重试按钮，源图保留
- **导出**：一键下载转换结果
- **历史记录**：IndexedDB 保存最近 20 条转换记录（含缩略图）

## 边界处理

| 场景 | 行为 |
|---|---|
| 剪贴板为空 | 明确提示 |
| 权限被拒（NotAllowedError） | 提示改用 Ctrl+V |
| 不支持的格式 | 识别为“未知格式”并提示 |
| SVG | 主线程 `<img>` 栅格化（兼容无 intrinsic size 的 SVG） |
| 浏览器不支持某编码格式 | 下拉框禁用对应选项，能力面板标红 |

## 文件结构

- `index.html` — 页面结构
- `styles.css` — 样式（棋盘格背景展示透明区域）
- `js/format-detect.js` — 格式嗅探与元信息解析
- `js/worker.js` — Worker 内解码/缩放/编码
- `js/db.js` — IndexedDB 历史记录
- `js/app.js` — 主逻辑与事件绑定
