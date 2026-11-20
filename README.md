<p align="center">
  <img src="frontend/public/spatialbridge-logo.png" alt="SpatialBridge logo" width="96" />
</p>

<h1 align="center">SpatialBridge</h1>

<p align="center">
  <strong>见微，知质。</strong> · <em>Bridge sight and spectrum.</em>
</p>

<p align="center">
  采集前/采集后显微图与 MALDI 空间数据的自动配准、点位查询与质谱读取工具
</p>

<p align="center">
  <a href="https://github.com/SmartisanNaive/SpatialBridge/actions/workflows/ci.yml"><img src="https://github.com/SmartisanNaive/SpatialBridge/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/python-3.11%2B-3776AB.svg" alt="Python 3.11+" />
  <img src="https://img.shields.io/badge/Bun-1.4.4-14151A.svg" alt="Bun 1.4.4" />
</p>

<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

---

SpatialBridge 将显微图中的激光采样位置与 SCiLS SBD 点位对应起来。配准后，点击显微图网格即可读取该点的原始质心光谱；也可查看文件保存的平均光谱，或提取多个 m/z 窗口的逐点强度。来源文件只读，项目缓存和人工标注单独保存。

![SpatialBridge 单细胞 MALDI 信号配准流程](docs/images/workflow.png)

## 功能

- **自动配准**：用两个标志物内的八个方孔角点拟合采集前/后显微图单应变换；结合 SBD 板图、热图纹理与 `OriginalCoordinates` 检查跨模态坐标链。
- **灼烧坑晶格检测**：从清晰区域恢复规则晶格，用空间留出集比较仿射、二阶和三阶模型，并记录分区误差与有效映射范围。
- **大图浏览与点位查询**：OpenSeadragon 瓦片浏览、采集前/后与卷帘对比、网格点选择；点位详情展示坐标、raster、归一化因子和自动读取的完整单点光谱，支持翻页、强度排序与 CSV 下载。
- **SBD 质谱读取**：「光谱数据」自动使用项目的完整 SBD，支持已保存的平均光谱、按点 ID 查询、1–32 个目标的 ppm/Da 窗口提取、sum/max 聚合、保存的区域及归一化因子选择。结果提供数值预览与完整 CSV。
- **PNG 热图叠加与人工标注**：配准已有热图图片、识别旋转和镜像，并将其颜色映射到点位；人工赋值点可导出 CSV。此图片叠加与 SBD 数值提取是不同功能。
- **完整文件上传与项目管理**：完整 SBD 通过 16 MiB 分片、SHA-256 校验、按需 gzip 与断点续传保留；PNG 可在本机无损优化。支持处理预览、历史项目和删除项目记录。
- **一体化运行**：一个应用进程在 8000 端口提供前端、API 与瓦片，也可通过 Docker Compose 部署。

![工作台前后卷帘对比](docs/images/workbench-swipe.png)

## 典型流程

1. 选择采集前 PNG、采集后 PNG，以及可选的完整 SBD 和已有热图 PNG。板图通常直接使用 SBD 内嵌图像，无需另传。
2. 等待配准和瓦片生成，在工作台检查前后叠加与晶格诊断。双 PNG 项目可独立浏览；SBD 查询需要相应数据，网格联动需要有效空间映射。
3. 在映射范围放大并点击单个网格点，右侧自动显示该 SBD 点位的完整光谱。缩略视图下第一次点击会先放大。
4. 打开「光谱数据」读取平均光谱或提取多个离子窗口；下载 CSV 后继续分析。当前尚未将提取通道直接绘制为多离子热图或叠加到显微图。

项目已有完整 SBD 时，文件路径编辑器默认隐藏。旧精简包或源文件不可用时，可关联运行后端的机器可访问的完整 SBD；也可主动点击「更换数据文件」。关联不会复制文件，需保持其路径可用。

## 快速开始

### 环境要求

直接使用发布镜像时，只需 Docker Engine 和 Docker Compose V2，见[容器部署](#容器部署推荐用于服务器)。以下依赖用于本地源码运行：

- Python 3.11+ 和 [uv](https://docs.astral.sh/uv/)
- [Bun](https://bun.sh/) 1.4.4（与 CI、Docker 构建保持一致，无需单独安装 Node.js）
- 可选：[libvips](https://www.libvips.org/)（配合 `--extra tiles` 加速大图处理）、[Tesseract](https://github.com/tesseract-ocr/tesseract)（读取热图上的 m/z 标签）

### 本地运行

从项目根目录执行：

```bash
uv sync --extra tiles --extra dev
bun install --cwd frontend --frozen-lockfile
bun run --cwd frontend build
.venv/bin/spatialbridge serve --data-dir ./workspace-data --frontend-dir frontend/dist --port 8000
```

开发、日常使用和部署统一打开 `http://127.0.0.1:8000`，前端、API、瓦片和下载由同一个进程提供。`serve` 默认读取 `frontend/dist`，上面的 `--frontend-dir` 用于显式指定该目录。修改前端后重新构建并刷新浏览器；修改后端代码后重启服务。详见[开发时更新代码](docs/deployment.md#24-开发时更新代码)。

如果项目根目录下有 `参考数据/` 示例目录，可点击「载入内置示例」体验完整流程。示例数据不随仓库发布。

> [!NOTE]
> uv 创建的 `.venv` 记录了绝对路径。移动或重命名项目目录后，删除 `.venv` 并重新执行 `uv sync --extra tiles --extra dev`；`frontend/node_modules` 同理用 `bun install --cwd frontend --frozen-lockfile` 重建。

### 命令行与测试

```bash
# 查看服务参数：--data-dir、--frontend-dir、--host、--port
.venv/bin/spatialbridge serve --help

# 对来源目录执行配准并输出报告
.venv/bin/spatialbridge register --source-dir ./参考数据 --output-dir ./workspace-data/manual-check

# 常规检查；真实 SBD 测试默认跳过
.venv/bin/python -m pytest -q
bun run --cwd frontend test
bun run --cwd frontend build
```

数据库、上传分片、报告和缓存写在 `--data-dir` 下。目录导入和本地关联仍依赖外部来源路径；迁移时需同时保留或重新关联来源文件。

### 容器部署（推荐用于服务器）

镜像 **`ghcr.io/smartisannaive/spatialbridge:latest`** 已公开发布，可匿名拉取，支持 Linux amd64/arm64，Docker 会自动选择匹配的架构。镜像包含前端、Python 后端及所需系统依赖，服务器无需安装 Python、Bun 或自行编译。

安装 Docker Engine 和 Compose V2 后，首次部署执行：

```bash
git clone https://github.com/SmartisanNaive/SpatialBridge.git
cd SpatialBridge
cp .env.example .env
sudo install -d -o 10001 -g 10001 -m 0770 /srv/spatialbridge/data
# 按需编辑 .env 中的镜像、监听地址、端口和数据目录
sudo docker compose pull
sudo docker compose up -d --no-build
sudo docker compose ps
curl -fsS http://127.0.0.1:8000/api/health
```

浏览器打开 `http://服务器IP:8000`。Compose 项目和容器均名为 `spatialbridge`，同一端口提供页面、API、瓦片和下载。运行数据保存在宿主机 `/srv/spatialbridge/data`，挂载到容器 `/data`；自定义目录时也需允许 UID/GID `10001:10001` 读写。数据目录应预留完整 SBD、上传合并临时空间与图像缓存的容量。

GitHub Actions 在 `main` 更新且前后端测试通过后自动发布镜像，**不会自动更新已运行的服务器**。等待 [CI](https://github.com/SmartisanNaive/SpatialBridge/actions/workflows/ci.yml) 的 `Container image` 成功后，在部署目录执行：

```bash
sudo docker compose pull
sudo docker compose up -d --no-build
```

默认 `latest` 跟随最新成功发布；需要固定版本或回退时，将 `.env` 中的 `SPATIALBRIDGE_IMAGE` 改为已发布的 `ghcr.io/smartisannaive/spatialbridge:sha-<完整提交 SHA>`，再执行上述命令。查看日志可用 `sudo docker compose logs --tail=100 -f spatialbridge`。

完整配置、健康检查、故障排查、版本回退、本地源码构建及备份恢复见[部署文档](docs/deployment.md#3-容器部署指南)。

## 文档

完整导航见 [docs/README.md](docs/README.md)。

| 文档 | 内容 |
| --- | --- |
| [SBD 质谱读取](docs/sbd-spectra-reader.md) | 使用方法、质量窗口语义、独立解码器、API 与已知样本验证 |
| [技术架构](docs/technical-architecture.md) | CV 配准、晶格模型、瓦片、上传与按需质谱读取的数据流 |
| [配准方法与输出](docs/algorithm.md) | 坐标约定、输出文件、工作台交互与 API |
| [部署与运维](docs/deployment.md) | 本地单进程运行、容器、容量规划、备份与验收 |
| [开发规范](docs/development-guide.md) | 模块分工、测试、内存与来源文件约束 |
| [贡献指南](CONTRIBUTING.md) | 贡献流程 |

## 项目结构

```text
.
├── backend/spatialbridge/   FastAPI：配准、晶格、热图、质谱、瓦片、存储、CLI
├── frontend/               React + Vite + OpenSeadragon 前端与 Bun 测试
├── tests/                  后端 pytest
├── docs/                   文档与配图
├── Dockerfile.api          前后端一体化镜像
├── compose.yaml            Docker Compose 服务定义
└── .env.example            部署配置模板
```

## 数值含义与局限

- 单点光谱保留更精确的质心 m/z；离子窗口按**全局质量轴分箱中心**筛选闭区间，不回退到最近质量点。窄窗口结果可能与按单点精确质心筛选不同。
- 稀疏项与未命中窗口填 0，不能据此断言物理信号不存在。保存的归一化采用 `raw / Values[spot_id]`，非正因子输出 0；未与 SCiLS 导出逐点确认等价。
- 点位详情中的 normalization 数值是因子，PNG 热图 RGB 是图片颜色；两者都不是该点的原始离子强度。
- 当前读取器主要用 SCiLS Lab 12.01、Version 36 的 Peaks 质心 SBD 验证。不支持完整 SCiLS 功能或所有版本/编码，非 Peaks 类型明确拒绝。当前提供数值与 CSV，尚无原生多离子热图渲染。
- 配准误差与晶格模型需结合项目报告和局部图像复核；标志物残差不代表全图或单细胞尺度的独立精度。板图纹理匹配也不能单独证明同次采集。
- 服务端为共享模式，没有账号、权限、用户数据隔离或内置 TLS。容器的既有验证与真实 Linux 部署验收范围见[部署文档](docs/deployment.md#本地容器验证记录已通过)。

## 致谢

- [SpaceM](https://github.com/alexandrovteam/SpaceM)：灼烧坑晶格检测思路
- [napari-imsmicrolink](https://github.com/nhpatterson/napari-imsmicrolink)：IMS 坐标矩阵方向约定
- [OpenSeadragon](https://openseadragon.github.io/)：大图瓦片浏览
- imzy SCiLS reader：SBD 格式结构参考；运行时不依赖 imzy 或 Bruker SDK

## 许可证

[MIT](LICENSE)
