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

## 完整 SBD 上传与按需读取

当前网页直接上传完整 `.sbd`，不会自动转换为坐标精简包。原文件通过 16 MiB 分片、SHA-256 校验、按需 gzip 与断点续传流程保存，配准阶段读取坐标、normalization 和板图；光谱阶段由 `spectra.py` 按需读取选定压缩块，不将整个文件载入内存。

历史 `.sbdx` 包及其还原的精简 HDF5 仍保留兼容支持。它们只有坐标、raster、归一化因子和光学图像，没有完整光谱。旧项目可关联后端机器可访问的完整 SBD，验证点数并在旧源可用时比对坐标、raster 和 UUID，再持久化关联。关联文件不会复制进数据目录，迁移或备份时需另行处理。

完整 SBD 支持保存的平均光谱、精确单点质心谱与多目标离子提取。离子窗口按全局分箱中心选择闭区间，支持 1–32 个目标、合计最多 4,096 个分箱、ppm/Da、sum/max、区域筛选及 `raw / Values[spot_id]`。这些数值与 normalization 因子及 PNG 的 RGB 颜色不同；当前结果以表格和 CSV 提供，尚无原生多离子热图。完整格式与科学解释见 [SBD 质谱读取](sbd-spectra-reader.md)。

## 浏览器本地无损优化 PNG

采集前、采集后和热图 PNG 在创建上传会话前逐个检查。专用 Worker 使用浏览器原生 `DecompressionStream('deflate')` / `CompressionStream('deflate')` 流式重压连续 IDAT 数据，保持解压后的扫描行字节完全一致；不使用 Canvas、不缩放、不改变位深、调色板、透明度或坐标。所有非 IDAT 块（包括颜色配置、文本和其他元数据）逐字节保留，输出 IDAT 重新计算 CRC。

原生压缩 API 不能指定更高压缩级别，因此根据 zlib 级别提示保守跳过默认/高强度压缩输入，避免重复处理已经压缩的巨幅 PNG。这是跳过策略，不代表对压缩最优性的证明。仅当输出至少减少 3% 且节省至少 1 KiB 时使用新文件；不支持原生 API、格式异常、重压无收益或超出本地限制时仍上传原图。解压数据累计上限为 1 GiB，压缩数据缓存上限为 128 MiB；这两个限制不是浏览器进程总内存上限。本地过程可取消，用户原文件不变。

输出使用固定 1 MiB IDAT 边界和内容 SHA-256 文件名。相同浏览器中刷新重选可重新生成并匹配上传会话，已完成图片不会重传；原生 Deflate 的字节输出可能随浏览器实现/版本变化，内容哈希会防止将不同压缩结果混为一个文件。旧会话若使用原 PNG，则保留原字节续传。PNG 分片不再额外 gzip，减少无收益的浏览器压缩和后端解压。

2026-11-14 的 Chromium 实测：独立低压缩 PNG 从 1,049,788 字节降至 268,987 字节，刷新续传未新建会话、未重传已完成图片；后端用 Pillow 解码，全部像素、尺寸及所有非 IDAT 块与原文件一致。8/16 位和 Adam7 扫描行保真另有自动测试。现有两张 73953×8538 显微 PNG 已是高压缩输入，约 10–14 ms 检查后直接复用原文件；默认 Deflate 重压反而增加约 4.8% / 9.8%，不采用。图片变小可减少网络、存储与合并开销，配准和瓦片生成仍由服务器执行。

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

上传数据与项目缓存使用 `data://`、`project://` 相对引用。目录导入及本地完整 SBD 关联记录外部来源路径；这些文件不随数据目录自动迁移。完整 SBD 的关联信息保存在项目下的 `spectra-source.json`。

## 工作台交互

- 采集前、采集后和前后卷帘三种视图共享同一视野。
- 画布按 SBD 坐标显示全部映射网格 spot 方框：浅色是理论网格候选，绿色是已被图像响应确认的节点。两者固定在同一套平铺网格上，响应峰偏移只作为诊断。方框尺寸来自 SBD `SpotSizes`（20 × 20 μm），前端用 `coordinate_model` 逐角点评估，避免宽图上的整行偏移、局部扭曲或溢出。
- 远景按屏幕密度抽样，放大后只绘制视口内的方框，并用批量 canvas 路径降低十万级点位重绘开销。
- 放大后点击方框，侧栏显示对应 SBD spot ID、raster、OriginalCoordinates、world/显微坐标、校准与 normalization 因子详情，并自动读取该点完整质心光谱。光谱支持分页、强度排序与全部峰 CSV；详情标题以 spot ID 标识点位。缩略视图下第一次点击先放大，点位选择优先命中实际足迹。
- 在采集后视图点击“新增赋值点”，再点击灼烧坑，即可从最近的 SBD 点自动取值，仍可手动改写。人工赋值点以公共坐标（采集前 PNG 像素）保存，原始 SBD 保持只读；赋值来源字段与原始离子强度应分别解释。
- 浏览器按项目保留当前标签页会话的视野与观察设置，切换图层或模式保持连续浏览。
- 「光谱数据」面板默认使用项目完整 SBD；仅在源不可用或主动点击「更换数据文件」时显示路径编辑器。平均光谱和多目标离子数值可下载完整 CSV。
- 历史项目支持删除记录；处理期间可检查图像预览，最终配准质量仍需复核诊断输出。
- 点击和拖动分开处理：指针移动超过 5 个 CSS 像素后，本次释放不会选择点位或新增赋值点。指针在画布外释放、取消、窗口失焦和多指操作都会结束或抑制当前手势。已有人工点可用 Enter 或空格键编辑。

## HTTP API

所有接口都在 `/api` 下，由 `backend/spatialbridge/app.py` 定义。常用接口：

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/health` | 健康检查 |
| `GET /api/projects` | 项目列表 |
| `POST /api/uploads` → `PUT …/chunks/{i}` → `POST …/complete` | 分片上传并创建项目 |
| `POST /api/projects` | 从服务器本地目录导入项目 |
| `DELETE /api/projects/{id}` | 删除项目记录 |
| `GET /api/projects/{id}/spectra` | 完整 SBD 可用状态和光谱目录 |
| `POST /api/projects/{id}/spectra/source` | 校验并关联完整 SBD |
| `GET /api/projects/{id}/spectra/mean?id=…` | 已保存的平均光谱 |
| `GET /api/projects/{id}/spectra/spots/{spot_id}` | 精确单点质心光谱 |
| `POST /api/projects/{id}/spectra/ions` | 全局分箱多目标离子强度；参数见 [SBD 文档](sbd-spectra-reader.md#接口) |
| `GET /api/projects/{id}/report` | 处理报告 |
| `GET /api/projects/{id}/spots` | 分页/抽样点 |
| `GET /api/projects/{id}/spots/overlay` | 画布所需的全部点、四类坐标及确认状态 |
| `GET /api/projects/{id}/spots/nearest` | 20 μm 足迹命中和最近 SBD 点 |
| `GET /api/projects/{id}/burn-pits.csv` | 导出带校准版本的自动确认结果 |
| `GET /api/projects/{id}/manual-points.csv` | 导出人工赋值点 |
| `GET /api/projects/{id}/layers/{layer}/tiles/{z}/{x}/{y}.png` | 图像瓦片 |
