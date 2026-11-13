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
