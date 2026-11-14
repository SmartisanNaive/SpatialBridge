# 配准方法与输出

[← 返回 README](../README.md)

## 坐标链

SpatialBridge 读取 SBD 的逐点坐标和 normalization 值，建立 `SBD world → 板图像素 → 热图像素 → 显微 PNG 像素` 变换。板图不需要上传：SBD 内嵌了 SCiLS 配准用的板图及其坐标矩阵，坐标链直接使用它；目录导入时若存在 `MALDI-板图`，仍优先使用原始板图。

坐标链先用板图与热图的纹理匹配，再用 SBD `OriginalCoordinates` 做独立一致性检查。同时记录 raster 的 `PixelToWorld`、矩阵可逆性、坐标回算误差和各 raster 的显微图覆盖率，并按 IMS MicroLink 的显式 `xy`/`yx` 约定固定矩阵方向。当前参考数据 raster 0 的一致性 p95 小于 1 px，并映射到采集后显微 PNG。未落在有效校准域内的 raster 保持未映射。

## 灼烧坑晶格检测

灼烧坑检测借鉴 [SpaceM](https://github.com/alexandrovteam/SpaceM) 的“清晰区域先拟合规则晶格”思路：

1. 从右下等清晰区域恢复整幅相邻行列。
2. 用 SBD 的非对称稀疏采集轮廓校验镜像方向与整数偏移。
3. 比较仿射、二阶和三阶归一化平滑模型，以空间分块留出集选择最低阶合格模型。

当前参考数据选择 `sbd-optical-lattice-v2-degree2`。局部频带/对比响应只负责确认节点，不会逐点移动或重新编号。

`coordinate_model` 是当前权威坐标，旧 `matrices` 字段仅作为兼容近似。公开点位保留 SBD 理论网格坐标，20 × 20 μm 方框四角由同一模型生成，因此相邻方框共享边界。

## 热图

上传项目时提供的热图会在首次打开工作台时自动配准并显示。也可在工作台上传其他包含同一板图纹理的 PNG，系统自动识别旋转和镜像、验证匹配后，按 SBD 点位显示图片颜色。热图图片右下角的 m/z 标签会尝试用 Tesseract OCR 读取（可选，未安装时跳过）。

需要注意：

- 热图颜色是渲染图片的近似采样，不是原始 m/z 离子强度；底色、边框或缺失区域不提供数值。
- 板图纹理匹配不能单独证明热图与项目来自同一次采集，仍需核对样本来源。

## 浏览器本地提取 SBD

网页选择 SBD 后，在专用 Web Worker 中用固定版本 `h5wasm 0.10.3` 和 WORKERFS 挂载本地 `File`。读取通过 `Blob.slice` 按文件偏移进行，不将完整输入复制到 WASM 内存；每次底层读取上限为 4 MiB。仅遍历以下子树：

- `Registrations/0`：坐标、OriginalCoordinates、spot 尺寸和 raster 变换。
- `MeasurementRasterIndices`：逐点 raster 编号。
- `SpectraGroup/Normalizations`：normalization 数组及名称等属性。
- `OpticalImages`：内嵌板图和配准信息。

输出为版本化 `.sbdx` 精简包，包含 `SPBSBD01` 魔数、4 字节小端 JSON 目录长度、UTF-8 目录和连续的数值数组原始字节。目录记录来源文件名和大小、路径、形状、类型、属性以及数组偏移；64 位整数通过二进制保存，避免 JavaScript Number 精度丢失。对象和属性按固定顺序遍历，不写入当前时间；文件名包含内容 SHA-256 前缀，刷新后重选相同文件可重建同一包并续传。

服务端校验包版本、允许路径、数组类型/长度/偏移和点位一致性，然后生成小型 `.sbd` HDF5 输入，复用已有配准代码；成功后移除传输包和上传分片。保留的精简输入足以重新处理当前功能，但不包含原始质谱，不能代替原 SBD 做任意 m/z 光谱分析。原始 SBD 留在用户电脑，目录导入和 API 完整 SBD 上传仍兼容。

当前提取上限为 128 MiB；支持标准小端整数、float32/float64 和文本字段，以及 HDF5 内建过滤器。遇到引用/复合类型、外部虚拟数据、超过 32 MiB 的单个 chunk 或未支持的插件过滤器，会明确报错，不回退上传完整 SBD。旧版完整 SBD 上传会话需先在页面取消，再开始新流程。

2026-11-14 的 Chromium 实测：5,809,336,884 字节 SBD 只读取 27,482,183 字节，输出 27,460,560 字节精简包，访问偏移超过 4 GiB；观测到的 WASM 线性内存为 23,199,744 字节（不含 JS 和浏览器内存）。后端还原后，全部解析数组、元数据、板图和矩阵与原文件一致；真实热图完整配准成功，映射 102,908 个点。刷新重选后复用原上传会话，并跳过已上传的精简包首片。尚未完成 Firefox/Safari 及第三方过滤器文件验收。

## 项目输出文件

处理结果保存在 `<data-dir>/projects/<id>/`：

| 文件 | 内容 |
| --- | --- |
| `report.json` | 两张显微图的来源 SHA-256、前后图像变换、锚点误差、SBD 索引摘要和 `spatial_mapping` |
| `sbd-spots.npz` | 每个 SBD 点的 world/original/pre/after 坐标、normalization 值和灼烧坑检测结果 |
| `validation/after_burn_pits_overlay.jpg` | 全幅候选叠加 |
| `validation/lattice_fixed_regions.jpg` | 五个固定区域放大复核 |
| `validation/lattice_validation.json` | 方向、留出集和分区误差报告 |
| `validation/pre_after_overlay.png` | 前后叠加预览 |

导入项目时会在项目缓存目录生成无损的多级 256×256 图像瓦片金字塔。浏览时后端只读取需要的源瓦片，完成配准后的结果瓦片还会落盘缓存。`--extra tiles` 可安装 pyvips 作为大图处理加速选项，浏览本身不依赖 libvips。

代码和配置只使用相对路径。唯一会出现绝对路径的位置是运行数据：目录导入项目在数据库和 `report.json` 中记录来源文件的原始位置。

## 工作台交互

- 采集前、采集后和前后卷帘三种视图共享同一视野。
- 画布按 SBD 坐标显示全部映射网格 spot 方框：浅色是理论网格候选，绿色是已被图像响应确认的节点。两者固定在同一套平铺网格上，响应峰偏移只作为诊断。方框尺寸来自 SBD `SpotSizes`（20 × 20 μm），前端用 `coordinate_model` 逐角点评估，避免宽图上的整行偏移、局部扭曲或溢出。
- 远景按屏幕密度抽样，放大后只绘制视口内的方框，并用批量 canvas 路径降低十万级点位重绘开销。
- 点击任意方框，侧栏显示对应 SBD spot、raster、OriginalCoordinates、world/显微坐标、检测响应、校准版本和全部 normalization 值。点击优先命中实际 20 μm 足迹。
- 在采集后视图点击“新增赋值点”，再点击灼烧坑，即可从最近的 SBD 点自动取值，仍可手动改写。人工赋值点以公共坐标（采集前 PNG 像素）保存，原始 SBD 保持只读。
- “保存视野”单独写入服务端恢复点，切换图层或模式不会改写它；浏览器另用项目级会话保存当前视野和观察设置。
- 点击和拖动分开处理：指针移动超过 5 个 CSS 像素后，本次释放不会选择点位或新增赋值点。指针在画布外释放、取消、窗口失焦和多指操作都会结束或抑制当前手势。已有人工点可用 Enter 或空格键编辑。

## HTTP API

所有接口都在 `/api` 下，由 `backend/spatialbridge/app.py` 定义。常用接口：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `GET /api/projects` | 项目列表 |
| `POST /api/uploads` → `PUT …/chunks/{i}` → `POST …/complete` | 分片上传并创建项目 |
| `POST /api/projects` | 从服务器本地目录导入项目 |
| `GET /api/projects/{id}/report` | 处理报告 |
| `GET /api/projects/{id}/spots` | 分页/抽样点 |
| `GET /api/projects/{id}/spots/overlay` | 画布所需的全部点、四类坐标及确认状态 |
| `GET /api/projects/{id}/spots/nearest` | 20 μm 足迹命中和最近 SBD 点 |
| `GET /api/projects/{id}/burn-pits.csv` | 导出带校准版本的自动确认结果 |
| `GET /api/projects/{id}/manual-points.csv` | 导出人工赋值点 |
| `GET /api/projects/{id}/layers/{layer}/tiles/{z}/{x}/{y}.png` | 图像瓦片 |
