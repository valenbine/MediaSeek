# Requirements Document

## Introduction

本项目是一款名为 `MediaSeek`、中文名为 `寻音觅影` 的 Web 音视频解析、预览、搜索与下载服务。一期目标是继承 `VnaSeek` 的现有前端风格与可复用逻辑，在此基础上扩展关键词搜索、手动 Cookie 管理、解析器切换、清晰度与码率选择，以及更完整的预览和下载工作流。

## Glossary

- **System**: 本次交付的 Web 下载服务。
- **Source URL**: 用户输入的视频页面链接。
- **Keyword Search**: 用户通过关键词查询视频候选结果。
- **Cookie Profile**: 用户手动上传并临时使用的 Cookie 文件。
- **Parser Engine**: 用户可选择的解析引擎，包括 `yt-dlp`、`lux` 和 `you-get`。
- **Parse Result**: 系统从解析器获得的视频元信息、格式列表和下载信息。
- **Preview**: 用户在页面内对目标媒体进行在线播放验证。
- **Mux**: 使用 FFmpeg 合并分离的视频流与音频流。

## Requirements

### Requirement 1

**User Story:** AS 普通用户, I want to 输入视频链接进行解析与下载, so that 我可以直接获取目标内容。

#### Acceptance Criteria

1. WHEN 用户提交一个合法的 `http` 或 `https` 视频页面链接, THE System SHALL 调用解析器获取视频元信息与可用格式。
2. IF 链接格式无效, THE System SHALL 返回可理解的输入错误提示。
3. WHEN 用户未主动切换解析器, THE System SHALL 默认使用 `you-get` 发起解析。
4. WHEN 用户选择指定解析器, THE System SHALL 使用用户所选解析器发起解析。
5. IF 当前解析器失败, THE System SHALL 返回明确错误并允许用户切换到其他解析器重新解析。
6. WHEN 解析完成, THE System SHALL 展示标题、封面、时长、站点来源和可选格式。

### Requirement 2

**User Story:** AS 普通用户, I want to 通过关键词搜索视频, so that 我可以在不知道完整链接时完成下载。

#### Acceptance Criteria

1. WHEN 用户输入关键词并发起搜索, THE System SHALL 返回候选视频列表。
2. WHEN 候选视频列表返回, THE System SHALL 展示标题、封面、时长、来源站点和目标链接。
3. WHEN 用户选择某个候选结果, THE System SHALL 将该结果的目标链接送入解析流程。
4. IF 搜索服务当前不支持某个站点, THE System SHALL 给出明确说明并允许用户改用链接解析。

### Requirement 3

**User Story:** AS 需要登录态资源的用户, I want to 手动加载 Cookie, so that 我可以解析受登录态影响的内容。

#### Acceptance Criteria

1. WHEN 用户上传 `cookies.txt` 或 `cookies.sqlite`, THE System SHALL 在当前会话中临时使用该 Cookie 文件。
2. WHEN 解析任务结束, THE System SHALL 清理临时 Cookie 文件。
3. IF Cookie 文件格式错误、为空或超过大小限制, THE System SHALL 返回明确的校验错误。
4. WHILE Cookie 文件处于可用状态, THE System SHALL 在界面中展示当前已加载的 Cookie 文件信息。

### Requirement 4

**User Story:** AS 普通用户, I want to 在下载前播放预览, so that 我可以确认内容和画质。

#### Acceptance Criteria

1. WHEN 解析结果包含可播放媒体流, THE System SHALL 支持在页面内启动预览。
2. WHEN 视频与音频来自分离流, THE System SHALL 为预览生成带声音的视频播放结果。
3. WHEN 用户选择仅音频下载, THE System SHALL 支持音频预览或提供可播放的音频流。
4. IF 预览任务执行失败, THE System SHALL 返回可理解的失败原因。

### Requirement 5

**User Story:** AS 普通用户, I want to 选择不同分辨率和码率的音视频格式, so that 我可以按需求下载。

#### Acceptance Criteria

1. WHEN 解析结果返回格式列表, THE System SHALL 分别展示视频格式和音频格式。
2. WHEN 展示格式列表, THE System SHALL 标注分辨率、编码、码率、文件大小或估算大小。
3. WHEN 用户切换格式, THE System SHALL 即时更新可执行的预览与下载动作。
4. IF 某个视频格式缺少独立音频流, THE System SHALL 给出合适的下载或合并提示。

### Requirement 6

**User Story:** AS 普通用户, I want to 下载可直接播放的视频文件, so that 我可以在本地正常使用。

#### Acceptance Criteria

1. WHEN 用户下载包含独立视频流和独立音频流的视频, THE System SHALL 使用 FFmpeg 完成音视频合并。
2. WHEN 用户下载纯音频, THE System SHALL 直接输出音频文件。
3. WHEN 后端生成下载地址, THE System SHALL 提供短期有效的代理流地址或直连地址。
4. WHILE 下载或合并任务执行中, THE System SHALL 锁定冲突的媒体操作入口。

### Requirement 7

**User Story:** AS 产品维护者, I want to 继承现有项目的 UI 风格和可复用逻辑, so that 一期版本可以快速落地。

#### Acceptance Criteria

1. WHEN 一期 Web 版本开始开发, THE System SHALL 复用 `VnaSeek` 的现有前端视觉风格。
2. WHEN 基线项目已有可复用的解析、预览、下载逻辑, THE System SHALL 优先复用现有实现。
3. WHEN 新功能进入代码库, THE System SHALL 保持原有交互风格与页面结构的一致性。

### Requirement 8

**User Story:** AS 普通用户, I want to 自主选择解析引擎, so that 我可以根据站点兼容性切换不同工具。

#### Acceptance Criteria

1. WHEN 用户进入解析界面, THE System SHALL 展示 `yt-dlp`、`lux` 和 `you-get` 三个可选解析器。
2. WHEN 页面首次加载, THE System SHALL 默认选中 `you-get`。
3. WHEN 用户切换解析器, THE System SHALL 在后续搜索或解析请求中带上当前选择。
4. WHEN 某解析器当前能力不支持关键词搜索, THE System SHALL 给出清晰的兼容性提示。
