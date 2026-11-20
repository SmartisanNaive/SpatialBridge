# SBD 质谱读取

工作台顶部的「光谱数据」面板支持读取 SCiLS Lab 的 Peaks 质心 SBD：查看数据概要、读取保存的平均光谱、查询任意点位的完整 m/z–强度光谱，以及批量提取质量窗口内的离子强度。页面预览部分数值，CSV 导出全部返回数据。这一步提供读取与提取功能，多离子热图绘制和显微图叠加尚未接入此面板。

## 使用

1. 新建项目时选择完整 `.sbd`，系统通过现有分片续传流程保留原文件，不再自动替换为不含光谱的坐标精简包。
2. 进入工作台，打开「光谱数据」。原项目引用完整 SBD 时可以直接读取。
3. 在显微图已配准的采样范围内，放大到单点网格后点击采样点，右侧「MALDI 采样点详情」会自动显示该点的完整光谱，可翻页、按强度排序并下载全部峰。连续点击不同点位时会取消旧读取，详情与光谱使用相同的 SBD 点位编号。缩略视图下第一次点击会先放大到可选单点的尺度。
4. 旧精简包项目可以填写后端所在机器上的完整 SBD 绝对路径，点击「关联文件」。本地关联不复制大文件；文件需要继续保存在该位置。关联之前会校验文件结构，并在旧源文件存在时比对原始坐标、raster 和文件 UUID，防止把另一份采集的强度赋给当前点位。
5. 单点编号从 **0** 开始。选择平均光谱时会显示关联的区域和归一化类型。
6. 离子提取支持 1–32 个逗号分隔的 m/z，容差单位 ppm 或 Da，以及窗口内求和或最大值。容差表示中心两侧各自的宽度。例如 726.5025 ± 5 ppm 对应约 [726.49886749, 726.50613251]。
7. 可选择文件保存的归一化因子及区域。CSV 中每行保留点位编号、原始网格 X/Y、raster 和各目标强度，避免不同 raster 的重叠坐标覆盖。

## 数值含义

- **单点光谱**：读取 spectrum-major 数据，得到更精确的质心 m/z 和配对强度。
- **空间离子信号**：读取 image-major 数据，选择全局质量轴上落入闭区间的分箱中心。不会自动替换为最近质量点；窗口未命中时各点强度为 0。
- 两种表示并不完全等价。SBD 对单点 m/z 使用定点量化，靠近分箱中点的峰可能对应相邻分箱，不能要求把解码后的精确 m/z 重新取最近分箱就能逐项恢复原空间索引。窄窗口分析尤其需要区分。
- 稀疏数据未记录的项填为 0；这不证明原始物理信号不存在。
- 归一化采用 `raw / Values[spot_id]`，非正因子输出 0。没有额外乘以 TargetValue，也没有做 median scaling。尚未与 SCiLS 导出结果逐点核对。
- 平均光谱直接读取文件保存的 Intensity 数组及其 RegionId/NormalizationId，不重新计算。
- 文件支持范围目前主要通过给定的 SCiLS Lab 12.01、Version 36 样本验证。其他版本若采用相同数据结构可以尝试读取，异常结构会报错；非 Peaks 光谱类型明确拒绝。

## 实现

本项目在 `backend/spatialbridge/spectra.py` 独立实现读取器，参考 imzy SCiLS reader 所揭示的格式结构；运行时无需 imzy 或其源代码目录，也无需 Bruker SDK。依赖使用项目已有的 h5py、NumPy 和 Python 标准库 zlib/struct。

读取器以只读方式打开 HDF5。每个请求持有自己的文件句柄，只缓存较小的质量轴及偏移表，按需读取压缩块，不将整个 5.4 GiB 文件载入内存。

| 用途 | HDF5 路径 |
| --- | --- |
| 全局质量轴 | `SamplePositions/GlobalMassAxis/SamplePositions` |
| 单点压缩 m/z | `SpectraGroup/compressedMz`、`mzOffsets` |
| 单点强度 | `SpectraGroup/intensities`、`intensityOffsets` |
| 空间点位压缩索引 | `SpectraGroup/compressedImageSpots`、`imageSpotOffsets` |
| 空间强度 | `SpectraGroup/imageIntensities`、`imageIntensityOffsets` |
| 平均光谱 | `MeanSpectra/<id>/Intensities` |
| 原始点位坐标 | `Registrations/0/OriginalCoordinates` |
| 区域与归一化 | `Regions/**/SpotList`、`SpectraGroup/Normalizations/<id>/Values` |

偏移表存储每段起点，最后一段以相应 payload 的总长度结尾。解压数据按字节平面组织，恢复小端无符号 delta 后累加。空间索引块在样本中还有一个 zlib 流外的字节宽度尾部；读取器验证它与推导宽度一致，也支持省略该尾部的块。单点 m/z 的 zlib 流后有 17 字节 `<Bdd` 参数：宽度、scale、初始质量值；还原公式为 `origin + cumsum(delta) / scale`。

读取时校验偏移单调性、数组形状、解压长度、索引唯一性和范围、质量轴与强度的有限性。单次提取限制为 32 个目标、合计 4,096 个质量分箱，避免误设超宽窗口。

## 接口

路径前缀：`/api/projects/{project_id}`。

| 方法 | 路径 | 参数 / 返回 |
| --- | --- | --- |
| GET | `/spectra` | 文件概要、能力状态、平均光谱/区域/归一化目录；缺少完整源时 `available: false` |
| POST | `/spectra/source` | `{"path":"/absolute/path/file.sbd"}`；验证后持久化本地源关联 |
| GET | `/spectra/mean?id=<id>` | 完整 `mz` 与 `intensities`，以及区域和归一化标识 |
| GET | `/spectra/spots/{spot_id}` | 完整单点质心 m/z 与配对强度 |
| POST | `/spectra/ions` | 多目标质量窗口；返回点位、原始网格坐标、raster、逐通道强度 |

离子请求示例：

```json
{
  "targets": [
    {"mz": 726.5025, "tolerance": 5, "unit": "ppm"},
    {"mz": 700, "tolerance": 0.01, "unit": "Da"}
  ],
  "aggregation": "sum",
  "normalization": null,
  "region": null
}
```

## 验证

合成文件测试覆盖 1–8 字节索引、质量参数尾部、异常/截断压缩流、末段偏移、空窗口、闭区间、ppm/Da、sum/max、区域筛选、归一化与接口错误处理。

真实样本的自动测试可用以下命令执行：

```bash
SPATIALBRIDGE_TEST_SBD='/absolute/path/OD2-OD0.005-2608252148.sbd' .venv/bin/python -m pytest tests/test_spectra.py -q
```

已确认该样本的点位 149125 包含 4,886 个峰，其中第 2763 个峰的精确 m/z 为 **726.5024230225748**，强度 **36,762**。空间全局分箱 **726.5016154578016** 包含 62,434 个非零强度，最大值同为 36,762，点位同为 149125，原始网格坐标为 (1619, 561)。

另抽取首点、末点及中间共 7 个点位的 22,268 个峰，与 image-major 数据交叉检查：22,261 个与最近全局分箱精确匹配；其余 7 个与相邻分箱精确匹配，均在量化精度内靠近分箱中点。未对全部 153,596 个单点光谱逐个扫描，也未与 SCiLS 软件导出结果逐点对照。
