# SpatialBridge 开发规范与贡献指南

[← 返回文档索引](README.md) | [返回 README](../README.md) | [简要贡献指南](../CONTRIBUTING.md)

为了确保 SpatialBridge 项目的代码质量、算法精度、跨平台兼容性与长期可维护性，所有参与项目开发的贡献者与维护者均需遵守本规范。

前端统一使用 Bun 1.4.4 安装依赖、运行测试和构建，版本与 `frontend/package.json`、CI 及 Docker 构建阶段保持一致。依赖锁文件为 `frontend/bun.lock`；普通安装使用 `bun install --cwd frontend --frozen-lockfile`。增删依赖时从 `frontend` 目录执行 `bun add` / `bun remove`，同时提交 `package.json` 和 `bun.lock`。

`build` 和 `dev` 脚本显式运行 OpenSeadragon 图片资源复制步骤，再通过 Bun 执行工具；不要依赖 npm 的 `prebuild` / `predev` 自动钩子。

---

## 1. 架构设计与工程原则

### 1.1 纯逻辑与框架解耦原则
- **后端解耦**：
  - 核心算法（`registration.py`、`lattice.py`、`heatmap.py`、`tiles.py`、`integration.py`、`spectra.py`）**严禁**直接依赖 FastAPI 的 `Request`、`Response` 或 `HTTPException`。
  - 算法模块必须接受标准 Python / NumPy / Path 类型输入，返回纯数据字典或数据类，确保可以独立在 CLI（`spatialbridge register`）或单元测试中无头调用。
- **前端解耦**：
  - 核心流转与算法逻辑（如 `flow.ts`、`hash.ts`、`compress.ts`、`png-core.ts`、`sbd-package.ts`）**严禁**直接绑定 React Hook、Component 或浏览器 DOM API。
  - 纯逻辑模块需保持无状态或状态完全透明，使其可以在 Bun 环境下运行单元测试。

### 1.2 内存防护与只读安全原则
- **数据源只读保证**：
  - 用户的显微图原图、SBD 原始质谱文件必须以只读模式访问。
  - 任何分析产物、临时切片、缓存和数据库记录均只能写入 `--data-dir` 指定的目录，严禁向输入目录写入任何附带文件。
- **内存防膨胀规范**：
  - 显微原图尺寸可达 6 亿以上像素。在读取和构建金字塔时，**必须**严格保持单通道灰度（`L` 模式），严禁未降采样前直接调用 `convert("RGBA")`。
  - 特征匹配与配准阶段必须先通过 `load_gray(path, max_width=8000)` 下采样后再计算，禁止在全分辨率大图上直接运行轮廓树或 SIFT。
- **单图像任务队列规范**：
  - 后端图像密集计算必须走单线程排队队列（`processing_pool = ThreadPoolExecutor(max_workers=1)`），严禁在 API 请求线程中直接异步启动大图处理，防止多并发上传瞬间 OOM。

### 1.3 跨平台路径协议规范
- 数据目录管理的上传来源与生成文件使用相对协议格式：
  - `data://<relative_path>`：相对于持久化数据目录。
  - `project://<relative_path>`：相对于具体项目目录。
- 目录导入来源和 `spectra-source.json` 中关联的外部 SBD 可记录绝对路径；关联不复制文件。移动数据目录时需保留外部路径或重新关联，容器内需挂载对应来源。
- 代码及测试不得硬编码个人来源路径，默认测试不得依赖本机真实数据。

---

## 2. 代码风格与规范

### 2.1 Python 后端规范
- **语言版本**：Python 3.11+，采用现代类型注解（例如使用 `X | None` 代替 `Optional[X]`，使用原生 `list[dict]` 代替 `typing.List`）。
- **编码格式**：遵循 PEP 8，使用 UTF-8 编码，统一行尾符为 LF。
- **异常处理**：
  - 底层算法模块抛出明确的领域异常（如 `RegistrationError`、`ValueError`）；
  - 接口层（`app.py`）统一捕获并转换为规范的 HTTP 状态码（如 400 参数错误、404 未就绪、409 状态冲突、500 服务异常）。
- **资源释放**：所有文件句柄、HDF5 文件（`h5py.File`）、Pillow 图像必须使用 `with` 上下文管理器或在 `finally` 块中关闭。

### 2.2 TypeScript / 前端规范
- **类型安全**：开启 TypeScript 严格模式（`strict: true`），严禁滥用 `any`。复杂数据结构需在 `types.ts` 中显式定义。
- **组件分工**：
  - `ProjectHome`：负责文件校验、上传进度交互与项目创建。
  - `Workbench`：负责双视口、卷帘对比、图层混合与标尺交互。
  - `CanvasViewer`：封装 OpenSeadragon 视口监听与批量 Canvas 渲染。
  - `SpectraPanel`：自动检测项目完整 SBD，提供平均谱、按点查询、多目标离子数值和 CSV；只有源不可用或主动更换时显示路径编辑器。
  - `SpotSpectrum`：选中映射网格点后自动读取对应 SBD spot ID 的完整质心谱，提供分页、强度排序和 CSV；切点时取消旧请求，避免显示过期结果。
- **数值语义**：normalization 因子、PNG RGB 与原始离子强度必须区分；离子窗口按全局分箱筛选，不能悄悄改为最近分箱或精确质心筛选。当前没有原生多离子热图，扩展时不得把现有 PNG 图片叠加视为已完成数值渲染。
- **代码分割**：大图瓦片引擎（OpenSeadragon）与分析工作台必须采用动态 `import()` 懒加载，确保首页首屏加载轻量迅速。

### 2.3 EditorConfig 统一设置
项目根目录维护有 [.editorconfig](../.editorconfig)，编辑器需遵循以下规则：
- 所有文件：`charset = utf-8`，`end_of_line = lf`，`insert_final_newline = true`，`trim_trailing_whitespace = true`。
- Python：`indent_size = 4`。
- TypeScript / JSON / YAML / Markdown：`indent_size = 2`。

---

## 3. 测试与质量门禁

在提交代码或发起 Pull Request 前，必须通过全部三大本地质量门禁。这也是 GitHub Actions CI 的硬性检查项。

### 3.1 门禁 1：后端 Pytest 单元测试
```bash
.venv/bin/python -m pytest -q
```
- **测试要求**：
  - 常规套件使用临时目录中的合成图像与 SBD，不依赖本机 `参考数据/`；测试数量随功能变化，以运行输出为准。
  - `tests/test_spectra.py` 覆盖压缩索引、精确质量参数尾部、末段偏移、闭区间、ppm/Da、sum/max、区域筛选、归一化、来源关联与接口错误。
  - 真实 SBD 测试只有显式设置环境变量才运行；未设置时应跳过，不影响普通 CI。

```bash
SPATIALBRIDGE_TEST_SBD='/absolute/path/OD2-OD0.005-2608252148.sbd' \
  .venv/bin/python -m pytest tests/test_spectra.py -q
```

该真实测试带有指定样本的已知峰断言，不是任意 SBD 的通用通过测试。峰值、抽样范围和 SCiLS 等价性边界见 [SBD 验证](sbd-spectra-reader.md#验证)。

### 3.2 门禁 2：前端纯逻辑与单元测试
```bash
bun run --cwd frontend test
```
- **测试要求**：
  - 使用 Bun 测试运行器（`bun test`），复用其兼容的 `node:test` 与 `node:assert` API；以当前输出为准，不固定测试数量。
  - 覆盖上传流转、自适应压缩、SHA-256 回退、PNG 扫描行无损验证、历史 SBD 包、指针手势、网格详情与国际化等纯逻辑。
  - 纯逻辑测试不能代替浏览器验收。修改选点/光谱交互时，检查点 ID 一致性、快速切点取消请求、分页/排序、CSV、缺少完整源和更换失败后的状态。

### 3.3 门禁 3：前端类型检查与生产打包
```bash
bun run --cwd frontend build
```
- **测试要求**：
  - 执行 `tsc -p tsconfig.json --noEmit` 进行全量类型检查，零警告、零报错。
  - 执行 `vite build` 验证打包产物无断链。

---

### 3.4 本地一体化验收

完成生产构建后，从项目根目录启动一个服务进程：

```bash
.venv/bin/spatialbridge serve --data-dir ./workspace-data --frontend-dir frontend/dist --port 8000
```

访问 `http://127.0.0.1:8000`，验证处理预览、配准图层、点位详情和光谱数值。新项目应保存完整 SBD，不经 `.sbdx` 自动替换。现有 PNG 热图图片配准和 SBD 离子提取分别验收；点位归一化因子不能作为原始离子强度验证依据。开发时也使用同一 8000 入口；前端改动后重新构建并刷新页面，后端改动后重启服务，见[部署文档](deployment.md#24-开发时更新代码)。

## 4. Git 提交与版本控制规范

### 4.1 分支管理策略
- `main` 分支为主干保护分支，用于发布稳定版本。
- 功能开发或 Bug 修复需创建功能分支：
  - 新功能：`feat/feature-name`
  - 问题修复：`fix/issue-description`
  - 文档更新：`docs/doc-topic`

### 4.2 Conventional Commits 提交规范
提交信息必须遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 规范，格式如下：
```text
<type>(<scope>): <subject>

[optional body]

[optional footer]
```

#### 常用 Type 类型
- `feat`：新增功能（如添加新型标志物检测、支持新的导出格式）。
- `fix`：修复问题（如修复长宽比边界条件、修复瓦片重试超时）。
- `docs`：文档调整（如补充算法解析、更新部署手册）。
- `perf`：性能优化（如优化下采样速度、降低前端重绘开销）。
- `refactor`：重构代码（在不改变外部行为的前提下调整内部结构）。
- `test`：测试用例（新增或重构测试代码）。
- `chore`：构建流程、依赖或辅助工具变更。

#### 优秀提交示例
```text
feat(cv): use 8-corner hole homography instead of 2-point similarity

Extract eight hole corners from two circle-square fiducials to solve
full 3x3 homography matrix. Improves reprojection RMSE on wide scans.
```

---

## 5. 安全红线与敏感数据隔离

1. **严禁将运行数据与测试数据提交至仓库**：
   - `workspace-data/`（运行时生成的数据库、切片与日志）。
   - `参考数据/`、`参考项目/`（GB 级别的真实显微图与客户质谱文件）。
   - `.env`（生产部署的环境变量与密码）。
2. **严防路径遍历漏洞**：
   - 接收上传文件名时，必须使用安全文件名剥离或 UUID 映射，**严禁**允许包含 `../`、绝对路径或隐藏字符的文件名写入存储系统。
3. **接口输入校验**：
   - 所有上传的分片必须执行大小匹配和 SHA-256 哈希校验；
   - 图像文件装配完成后必须使用 Pillow 的 `image.verify()` 校验合法性，防止恶意数据伪装引发崩溃。
