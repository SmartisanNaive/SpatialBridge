# 贡献指南

感谢你愿意改进 SpatialBridge。提交 issue 或 pull request 前，请先阅读以下说明。详细的工程规范、分层解耦原则与架构设计请参阅 [docs/development-guide.md](docs/development-guide.md)。

## 开发环境

```bash
uv sync --extra tiles --extra dev
bun install --cwd frontend --frozen-lockfile
bun run --cwd frontend build
.venv/bin/spatialbridge serve --data-dir ./workspace-data --port 8000
```

以上命令均从项目根目录执行。开发、日常使用和部署统一访问 `http://127.0.0.1:8000`，一个应用进程提供页面、API、瓦片和下载。`serve` 默认读取 `frontend/dist`，自定义构建目录可用 `--frontend-dir` 指定。

修改前端后执行 `bun run --cwd frontend build`，然后刷新浏览器；修改后端 Python 代码后重启应用服务。完整流程见[部署文档](docs/deployment.md#24-开发时更新代码)。

## 测试

提交前请确保以下命令全部通过，CI 也会运行同样的检查：

```bash
uv run pytest -q          # 后端测试

cd frontend
bun run test                  # 前端单元测试
bun run build             # TypeScript 类型检查 + Vite 生产构建
```

生产构建只做类型检查和 Vite 打包，不会在源码目录生成 TypeScript/Vite 编译文件。

## 代码结构

### 后端 `backend/spatialbridge/`

| 模块 | 职责 |
| --- | --- |
| `app.py` | FastAPI 应用、HTTP 接口、上传与后台处理队列 |
| `cli.py` | `spatialbridge serve` / `register` 命令行入口 |
| `registration.py` | 来源文件识别、SBD 读取、采集前后显微图配准 |
| `lattice.py` | 灼烧坑晶格拟合与模型选择 |
| `heatmap.py` | 热图识别、方向判定与颜色采样 |
| `integration.py` | SBD 坐标链与空间映射（`spatial_mapping`）、一致性诊断 |
| `tiles.py` | 图像瓦片金字塔 |
| `storage.py` | SQLite 存储与数据目录管理 |
| `models.py` | 来源与配准结果的数据类 |

### 前端 `frontend/src/`

- `main.tsx`：入口和路由。
- `components/`：首页 `ProjectHome`、处理中/失败页 `StatusScreens`、工作台 `Workbench`、画布 `CanvasViewer`。工作台和 OpenSeadragon 在打开项目时才加载。
- `types.ts`、`api.ts`、`utils.ts`：共享类型、请求封装和坐标工具。
- `flow.ts`、`hash.ts`、`pointerGesture.ts`、`compress.ts`：不依赖 DOM 的纯逻辑，对应测试在 `frontend/tests/`。

## 本地数据

以下目录被 `.gitignore` 排除，请勿提交：

- `workspace-data/`：运行数据（数据库、项目缓存、日志）。
- `参考数据/`：本机示例数据，“载入内置示例”会读取它。
- `参考项目/`、`参考资料/`：本机第三方参考实现和资料，不参与构建。

测试不能依赖这些目录，需要的样例数据请在测试中用 `tmp_path` 生成。

## 提交规范

提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 格式，例如：

```text
feat: build the coordinate chain from the board image embedded in the SBD
fix(frontend): retry dropped tile requests
docs: describe the deployment acceptance checklist
```

常用类型：`feat`、`fix`、`docs`、`refactor`、`test`、`chore`。每个提交只做一件事。

## Pull Request

1. 从 `main` 新建分支。
2. 修改代码并补充测试。
3. 确认上面的测试命令全部通过。
4. 在 PR 描述中说明改动内容、原因和验证方式；涉及界面的改动请附截图。
