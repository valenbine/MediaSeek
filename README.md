# MediaSeek / 寻音觅影

MediaSeek 是一个 Web 音视频解析、预览与下载工具。它支持通过视频页面链接解析媒体信息，也支持 B 站关键词搜索后选择目标视频进入解析流程。

当前版本基于 FastAPI 和原生前端实现，解析器支持 `you-get`、`yt-dlp` 和 `lux`，默认使用 `you-get`。

## 功能特性

- 视频链接解析：输入公开视频页面 URL，解析标题、封面、描述、字幕和可下载格式。
- B 站关键词搜索：搜索结果展示后，可选择解析器并进入现有解析流程。
- 在线预览：解析后自动选择更适合快速缓冲的低码率预览流。
- 格式选择：视频分辨率和音频音质按高到低排序，默认选中最高质量。
- 视频下载：分离音视频流时，通过浏览器端 `FFmpeg.wasm` 合并。
- 音频下载：可独立选择音频流下载。
- Cookie 会话：支持上传 Cookie 文件并在服务端短期复用，便于解析需要登录态的网站。
- 多解析器：支持手动切换 `you-get`、`yt-dlp`、`lux`。

## 项目结构

```text
.
├── mediaseek_web/
│   ├── backend.py          # FastAPI 后端服务
│   ├── index.html          # Web 页面结构
│   ├── styles.css          # 页面样式
│   ├── src/main.js         # 前端交互、预览、下载和 FFmpeg.wasm 合并逻辑
│   ├── requirements.txt    # Python 依赖
│   └── package.json        # 启动脚本
└── .monkeycode/specs/      # 需求与设计文档
```

## 环境要求

- Python 3.11+
- Node.js 18+
- Go 1.20+，用于安装 `lux`
- 可访问外网的运行环境

## 安装依赖

```bash
# 安装 Python 依赖
pip3 install --break-system-packages -r mediaseek_web/requirements.txt

# 安装 lux 解析器
go install github.com/iawia002/lux@latest
```

`yt-dlp` 和 `you-get` 已在 `requirements.txt` 中声明，会随 Python 依赖安装。

## 启动服务

```bash
cd mediaseek_web
python3 backend.py
```

也可以使用 npm 脚本：

```bash
cd mediaseek_web
npm run dev
```

服务启动后访问：

```text
http://localhost:5000
```

## 使用说明

1. 打开页面后，选择解析器。默认解析器为 `you-get`。
2. 可通过关键词搜索 B 站视频，点击搜索结果后确认解析器。
3. 也可直接粘贴视频页面 URL，点击“开始解析”。
4. 需要登录态的网站，先上传 Cookie 文件，再点击“加载 Cookie 会话”。
5. 解析完成后选择视频格式和音频格式。
6. 点击“下载视频”或“下载音频”。

## Cookie 文件支持

不同解析器支持的 Cookie 文件格式如下：

| 解析器 | cookies.txt | Firefox cookies.sqlite |
| --- | --- | --- |
| you-get | 否 | 是 |
| yt-dlp | 是 | 是 |
| lux | 是 | 是 |

Cookie 会话默认保留 6 小时。Cookie 文件用于解析请求和搜索请求，适用于 B 站等需要登录态或容易触发风控的网站。

## API 概览

- `GET /api/health`：服务健康检查和解析器可用性。
- `GET /api/cookie/status`：查看当前 Cookie 会话状态。
- `POST /api/cookie/load`：加载 Cookie 文件到服务端会话。
- `POST /api/cookie/clear`：清除服务端 Cookie 会话。
- `POST /api/search`：B 站关键词搜索。
- `POST /api/parse`：解析视频页面 URL。
- `POST /api/download-url`：生成短期有效下载地址。
- `GET /api/stream/{token}`：后端代理流式转发媒体资源。

## 注意事项

- 本项目仅用于学习和个人内容备份场景，请遵守目标网站服务条款和当地法律法规。
- 当前 Web 版无法自动读取本机浏览器 Cookie，需要手动导出并上传。
- 分离音视频流合并使用浏览器端 `FFmpeg.wasm`，大文件合并耗时取决于浏览器性能和网络速度。
- 当前环境没有系统级 `ffmpeg`，服务端默认不执行媒体合并。

## 许可证

当前仓库尚未声明许可证。发布或分发前建议补充明确的开源许可证。
