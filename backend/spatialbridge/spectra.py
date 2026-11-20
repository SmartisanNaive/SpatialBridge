"""Read-only, on-demand access to SCiLS centroid SBD spectra.

SBD keeps independent spectrum-major and mass-bin-major sparse representations.
The latter selects global-axis bins, not the more precise per-spot centroid m/z.
No vendor SDK, reference checkout, or whole-file read is required.
"""
from __future__ import annotations

import math
from pathlib import Path
import struct
from typing import Any
import zlib

import h5py
import numpy as np

AXIS_PATH = "SamplePositions/GlobalMassAxis/SamplePositions"
IMAGE_FIELDS = ("imageSpotOffsets", "imageIntensityOffsets", "compressedImageSpots", "imageIntensities")
SPOT_FIELDS = ("mzOffsets", "intensityOffsets", "compressedMz", "intensities")
MAX_WINDOW_BINS = 4096
MAX_AXIS_POINTS = 5_000_000


class SpectraUnavailable(ValueError):
    pass


def text(value: Any) -> str:
    if value is None:
        return ""
    value = np.asarray(value).reshape(-1)
    if not value.size:
        return ""
    item = value[0]
    return item.decode("utf-8", errors="replace") if isinstance(item, bytes) else str(item)


def _inflate(block: bytes, limit: int) -> tuple[bytes, bytes]:
    """Bound expansion, and preserve the mass codec's trailer after zlib EOF."""
    decoder = zlib.decompressobj()
    try:
        data = decoder.decompress(block, limit + 1)
    except zlib.error as error:
        raise ValueError("SBD 压缩索引损坏") from error
    if len(data) > limit or not decoder.eof or decoder.unconsumed_tail:
        raise ValueError("SBD 压缩索引长度无效或数据不完整")
    return data, decoder.unused_data


def _unshuffle(data: bytes, count: int, width: int) -> np.ndarray:
    if not 1 <= width <= 8 or len(data) != count * width:
        raise ValueError("SBD 索引字节宽度或长度无效")
    planes = np.frombuffer(data, dtype=np.uint8).reshape(width, count)
    delta = np.zeros(count, dtype=np.uint64)
    for byte in range(width):
        delta |= planes[byte].astype(np.uint64) << (byte * 8)
    indices = np.cumsum(delta, dtype=np.uint64)
    if count > 1 and np.any(indices[1:] < indices[:-1]):
        raise ValueError("SBD 索引累计溢出")
    return indices


def decode_spots(block: bytes, count: int, spot_count: int) -> np.ndarray:
    if not 0 < count <= spot_count:
        raise ValueError("SBD 空间强度数量无效")
    data, trailer = _inflate(block, count * 8)
    width, remainder = divmod(len(data), count)
    # SCiLS appends the width byte outside the zlib stream. Some writers
    # omit it; in either case the payload independently determines the width.
    if remainder or not 1 <= width <= 8 or trailer not in (b"", bytes([width])):
        raise ValueError("SBD 空间索引长度或尾部字节宽度无效")
    indices = _unshuffle(data, count, width)
    if indices[-1] >= spot_count or np.any(indices[1:] <= indices[:-1]):
        raise ValueError("SBD 空间索引越界或重复")
    return indices.astype(np.int64)


def decode_masses(block: bytes, count: int) -> np.ndarray:
    if not 0 < count <= MAX_AXIS_POINTS:
        raise ValueError("SBD 单点光谱长度无效")
    data, trailer = _inflate(block, count * 8)
    if len(trailer) != 17:
        raise ValueError("SBD 单点质量索引缺少有效的还原参数")
    width, scale, origin = struct.unpack("<Bdd", trailer)
    if not math.isfinite(scale) or scale <= 0 or not math.isfinite(origin) or origin <= 0:
        raise ValueError("SBD 单点质量索引还原参数无效")
    delta = _unshuffle(data, count, width)
    mz = origin + delta.astype(np.float64) / scale
    if not np.all(np.isfinite(mz)) or np.any(mz[1:] < mz[:-1]):
        raise ValueError("SBD 单点质量轴无效")
    return mz


class SBDReader:
    """One request owns one HDF5 handle; only selected blobs are read."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.handle: h5py.File | None = None

    def __enter__(self) -> SBDReader:
        self.handle = h5py.File(self.path, "r")
        try:
            f = self.handle
            if "spatialbridge_format" in f.attrs:
                raise SpectraUnavailable("此项目使用的是坐标精简包，请关联或重新上传完整 SBD 文件以读取质谱。")
            if AXIS_PATH not in f or "SpectraGroup" not in f:
                raise SpectraUnavailable("此 SBD 不包含可读取的全局质量轴和质谱数据。")
            kind = text(f.attrs.get("SpectraType"))
            if kind and kind != "Peaks":
                raise SpectraUnavailable(f"暂不支持此 SBD 光谱类型：{kind}；当前读取器支持 Peaks 质心光谱。")
            axis = f[AXIS_PATH]
            if axis.ndim != 1 or not 0 < axis.size <= MAX_AXIS_POINTS:
                raise ValueError("SBD 全局质量轴形状无效")
            self.axis = np.asarray(axis, dtype=np.float64)
            if not np.all(np.isfinite(self.axis)) or self.axis[0] <= 0 or np.any(np.diff(self.axis) <= 0):
                raise ValueError("SBD 全局质量轴必须为递增的有限正数")
            coords = f.get("Registrations/0/OriginalCoordinates")
            if coords is None or coords.ndim != 2 or coords.shape[0] != 2 or coords.shape[1] <= 0:
                raise ValueError("SBD 缺少有效的原始点位坐标")
            self.spot_count = coords.shape[1]
            self.group = f["SpectraGroup"]
            self.image_available = all(name in self.group for name in IMAGE_FIELDS)
            self.spot_available = all(name in self.group for name in SPOT_FIELDS)
            if not self.image_available and not self.spot_available and "MeanSpectra" not in f:
                raise SpectraUnavailable("SBD 不包含可读取的光谱或空间信号。")
            if self.image_available:
                self._validate_offsets("imageSpotOffsets", "compressedImageSpots", len(self.axis))
                self._validate_offsets("imageIntensityOffsets", "imageIntensities", len(self.axis))
            if self.spot_available:
                self._validate_offsets("mzOffsets", "compressedMz", self.spot_count)
                self._validate_offsets("intensityOffsets", "intensities", self.spot_count)
            return self
        except BaseException:
            self.handle.close()
            self.handle = None
            raise

    def __exit__(self, *_: Any) -> None:
        if self.handle is not None:
            self.handle.close()

    def _validate_offsets(self, name: str, values: str, count: int) -> None:
        dataset, payload = self.group[name], self.group[values]
        if dataset.ndim != 1 or dataset.shape[0] != count or dataset.dtype.kind not in "iu" or payload.ndim != 1:
            raise ValueError(f"SBD 索引形状无效：{name}")
        offsets = np.asarray(dataset)
        if int(offsets[0]) != 0 or np.any(offsets[1:] < offsets[:-1]) or int(offsets[-1]) > payload.size:
            raise ValueError(f"SBD 索引偏移无效：{name}")
        # These compact indices are safe to cache; the GB-sized payload is not.
        setattr(self, name, offsets)

    def _span(self, offsets: str, payload: str, index: int) -> tuple[int, int]:
        starts = getattr(self, offsets)
        start = int(starts[index])
        end = int(starts[index + 1]) if index + 1 < len(starts) else self.group[payload].size
        return start, end

    def _regions(self) -> dict[str, h5py.Group]:
        result: dict[str, h5py.Group] = {}
        root = self.handle.get("Regions")
        if root is not None:
            def collect(name: str, item: Any) -> None:
                if isinstance(item, h5py.Group) and "SpotList" in item:
                    result[name.rsplit("/", 1)[-1] if name else "Regions"] = item
            collect("", root)
            root.visititems(collect)
        return result

    def summary(self) -> dict:
        f = self.handle
        norms = f.get("SpectraGroup/Normalizations", {})
        means = f.get("MeanSpectra", {})
        return {
            "available": True, "filename": self.path.name,
            "spot_count": self.spot_count, "mz_count": len(self.axis),
            "mz_min": float(self.axis[0]), "mz_max": float(self.axis[-1]),
            "producer": text(f.attrs.get("Produced by")),
            "version": int(f["Version"][0]) if "Version" in f else None,
            "spot_spectra_available": self.spot_available, "ion_images_available": self.image_available,
            "normalizations": [{"id": key, "name": text(g.attrs.get("name")) or key} for key, g in norms.items() if "Values" in g],
            "mean_spectra": [{"id": key, "region_id": text(g["RegionId"][...]) if "RegionId" in g else "",
                              "normalization_id": text(g["NormalizationId"][...]) if "NormalizationId" in g else None}
                             for key, g in means.items() if "Intensities" in g],
            "regions": [{"id": key, "name": text(g.attrs.get("name")) or key, "spot_count": g["SpotList"].size}
                        for key, g in self._regions().items()],
            "window_semantics": "inclusive global mass-axis bins; per-spot centroid masses have higher precision",
            "normalization_semantics": "raw intensity divided by stored per-spot divisor; nonpositive divisors yield zero",
            "sparse_semantics": "unrecorded entries are filled with zero; this does not establish physical absence",
        }

    def mean_spectrum(self, spectrum_id: str) -> dict:
        means = self.handle.get("MeanSpectra", {})
        if spectrum_id not in means:
            raise ValueError("平均光谱不存在")
        group = means[spectrum_id]
        values = np.asarray(group["Intensities"], dtype=np.float64)
        if values.shape != self.axis.shape or not np.all(np.isfinite(values)):
            raise ValueError("SBD 平均光谱与质量轴不一致或包含无效强度")
        return {"mz": self.axis.tolist(), "intensities": values.tolist(),
                "region_id": text(group["RegionId"][...]) if "RegionId" in group else "",
                "normalization_id": text(group["NormalizationId"][...]) if "NormalizationId" in group else None}

    def spot_spectrum(self, spot_id: int) -> dict:
        if not self.spot_available:
            raise SpectraUnavailable("此 SBD 未保存可读取的单点光谱")
        if not 0 <= spot_id < self.spot_count:
            raise ValueError("点位编号超出 SBD 范围（编号从 0 开始）")
        start, end = self._span("intensityOffsets", "intensities", spot_id)
        if end - start > MAX_AXIS_POINTS:
            raise ValueError("SBD 单点光谱过大")
        values = np.asarray(self.group["intensities"][start:end], dtype=np.float64)
        a, b = self._span("mzOffsets", "compressedMz", spot_id)
        if b - a > (end - start) * 9 + 1024:
            raise ValueError("SBD 单点压缩块过大")
        masses = decode_masses(self.group["compressedMz"][a:b].tobytes(), end - start) if end > start else np.empty(0)
        if not np.all(np.isfinite(values)):
            raise ValueError("SBD 单点光谱包含无效强度")
        return {"spot_id": spot_id, "mz": masses.tolist(), "intensities": values.tolist()}

    def ion_signals(self, targets: list[dict], aggregation: str = "sum", normalization: str | None = None,
                    region: str | None = None) -> dict:
        if not self.image_available:
            raise SpectraUnavailable("此 SBD 未保存按质量分箱的空间信号")
        if not 1 <= len(targets) <= 32 or aggregation not in {"sum", "max"}:
            raise ValueError("请指定 1–32 个目标质量和有效聚合方式")
        windows = []
        for target in targets:
            mz, tolerance, unit = target["mz"], target["tolerance"], target["unit"]
            if not math.isfinite(mz) or mz <= 0 or not math.isfinite(tolerance) or tolerance < 0 or unit not in {"ppm", "Da"}:
                raise ValueError("目标 m/z、容差或单位无效")
            radius = mz * tolerance * 1e-6 if unit == "ppm" else tolerance
            lower, upper = mz - radius, mz + radius
            if not math.isfinite(lower) or not math.isfinite(upper):
                raise ValueError("质量窗口超出有效范围")
            a, b = int(np.searchsorted(self.axis, lower, side="left")), int(np.searchsorted(self.axis, upper, side="right"))
            windows.append((a, b, lower, upper))
        if sum(b - a for a, b, _, _ in windows) > MAX_WINDOW_BINS:
            raise ValueError(f"质量窗口合计超过 {MAX_WINDOW_BINS} 个质量分箱，请缩小容差或减少目标")
        selected = np.arange(self.spot_count)
        if region is not None:
            regions = self._regions()
            if region not in regions:
                raise ValueError("所选区域不存在")
            selected = np.asarray(regions[region]["SpotList"], dtype=np.int64).reshape(-1)
            if np.any(selected < 0) or np.any(selected >= self.spot_count) or len(np.unique(selected)) != len(selected):
                raise ValueError("SBD 区域点位列表无效")
        factors = None
        if normalization is not None:
            norms = self.handle.get("SpectraGroup/Normalizations", {})
            if normalization not in norms or "Values" not in norms[normalization]:
                raise ValueError("所选归一化字段不存在")
            factors = np.asarray(norms[normalization]["Values"], dtype=np.float64).reshape(-1)
            if len(factors) != self.spot_count or not np.all(np.isfinite(factors)):
                raise ValueError("SBD 归一化因子无效")
        channels = []
        for target, (a, b, lower, upper) in zip(targets, windows):
            signal = np.zeros(self.spot_count, dtype=np.float64)
            for index in range(a, b):
                start, end = self._span("imageIntensityOffsets", "imageIntensities", index)
                if start == end:
                    continue
                if end - start > self.spot_count:
                    raise ValueError("SBD 空间信号数量超过点位总数")
                x, y = self._span("imageSpotOffsets", "compressedImageSpots", index)
                if y - x > (end - start) * 9 + 1024:
                    raise ValueError("SBD 空间压缩块过大")
                spots = decode_spots(self.group["compressedImageSpots"][x:y].tobytes(), end - start, self.spot_count)
                values = np.asarray(self.group["imageIntensities"][start:end], dtype=np.float64)
                if not np.all(np.isfinite(values)) or np.any(values < 0):
                    raise ValueError("SBD 空间信号包含无效强度")
                if aggregation == "sum":
                    signal[spots] += values
                else:
                    signal[spots] = np.maximum(signal[spots], values)
            if factors is not None:
                np.divide(signal, factors, out=signal, where=factors > 0)
                signal[factors <= 0] = 0
            if not np.all(np.isfinite(signal)):
                raise ValueError("强度聚合或归一化结果超出数值范围")
            channels.append({**target, "mz_min": lower, "mz_max": upper, "bin_count": b - a,
                             "intensities": signal[selected].tolist()})
        coordinates = np.asarray(self.handle["Registrations/0/OriginalCoordinates"]).T
        if not np.all(np.isfinite(coordinates)):
            raise ValueError("SBD 点位坐标包含无效值")
        rasters = self.handle.get("MeasurementRasterIndices")
        rasters = np.asarray(rasters).reshape(-1) if rasters is not None else np.zeros(self.spot_count, dtype=int)
        if len(rasters) != self.spot_count:
            raise ValueError("SBD raster 数量与点位不一致")
        return {"spot_ids": selected.tolist(), "coordinates": coordinates[selected].tolist(),
                "rasters": rasters[selected].tolist(), "channels": channels,
                "normalization": normalization, "aggregation": aggregation, "region": region,
                "mass_axis": "global_bins", "missing_values": "filled_zero"}
