"""Validation for the versioned, spectra-free SBD subset produced in the browser."""
from __future__ import annotations

import json
import math
from pathlib import Path
import struct
from typing import Any

import numpy as np

EXTRACT_FORMAT = "sbd-extract"
EXTRACT_VERSION = 1
MAX_EXTRACT_BYTES = 128 * 1024 * 1024
PACKAGE_MAGIC = b"SPBSBD01"
NUMERIC_DTYPES = {name: np.dtype(code) for name, code in {
    "int8": "i1", "uint8": "u1", "int16": "<i2", "uint16": "<u2",
    "int32": "<i4", "uint32": "<u4", "int64": "<i8", "uint64": "<u8",
    "float32": "<f4", "float64": "<f8",
}.items()}


def materialize_sbd_package(package: Path, destination: Path) -> None:
    """Decode a bounded browser package into the existing HDF5 reader's input."""
    import h5py

    if package.stat().st_size > MAX_EXTRACT_BYTES:
        raise ValueError("SBD 精简数据包超过 128 MiB 限制")
    content = package.read_bytes()
    if len(content) < 12 or content[:8] != PACKAGE_MAGIC:
        raise ValueError("不是有效的 SpatialBridge SBD 精简数据包")
    metadata_size = struct.unpack_from("<I", content, 8)[0]
    if not 0 < metadata_size <= 4 * 1024 * 1024 or 12 + metadata_size > len(content):
        raise ValueError("SBD 精简数据包目录长度无效")
    metadata = json.loads(content[12:12 + metadata_size])
    if metadata.get("format") != EXTRACT_FORMAT or metadata.get("version") != EXTRACT_VERSION:
        raise ValueError("不支持的 SpatialBridge SBD 数据包版本")
    groups, datasets = metadata.get("groups", []), metadata.get("datasets", [])
    if not isinstance(groups, list) or not isinstance(datasets, list) or len(groups) + len(datasets) > 4096:
        raise ValueError("SBD 精简数据包对象数量无效")
    body = memoryview(content)[12 + metadata_size:]

    def valid_path(value: Any) -> str:
        if not isinstance(value, str) or len(value) > 4096 or "\x00" in value or any(part in {"", ".", ".."} for part in value.split("/")) and value != "":
            raise ValueError("SBD 数据包路径无效")
        roots = ("Registrations/0", "MeasurementRasterIndices", "SpectraGroup/Normalizations", "OpticalImages")
        if value not in {"", "Registrations", "SpectraGroup"} and not any(value == root or value.startswith(root + "/") for root in roots):
            raise ValueError("SBD 数据包包含不支持的字段")
        return value

    def shape_of(item: dict) -> tuple[int, ...]:
        shape = item.get("shape")
        if not isinstance(shape, list) or len(shape) > 8 or any(type(size) is not int or not 0 <= size <= MAX_EXTRACT_BYTES for size in shape):
            raise ValueError("SBD 数组形状无效")
        if math.prod(shape) > MAX_EXTRACT_BYTES:
            raise ValueError("SBD 数组过大")
        return tuple(shape)

    def text_or_attribute(item: dict):
        shape = shape_of(item)
        values = item.get("values")
        if not isinstance(values, list) or len(values) != math.prod(shape) or any(not isinstance(value, str) for value in values):
            raise ValueError("SBD 属性或文本数组长度错误")
        if item.get("dtype") == "string":
            return np.asarray(values, dtype=h5py.string_dtype("utf-8")).reshape(shape)
        dtype = NUMERIC_DTYPES.get(item.get("dtype"))
        if dtype is None:
            raise ValueError("SBD 属性类型不支持")
        return np.asarray(values, dtype=dtype).reshape(shape)

    def write_attributes(target, items: Any) -> None:
        if not isinstance(items, list) or len(items) > 1024:
            raise ValueError("SBD 属性列表无效")
        seen = set()
        for item in items:
            name = item.get("name")
            if not isinstance(name, str) or not name or len(name) > 4096 or "\x00" in name or name in seen:
                raise ValueError("SBD 属性名称无效")
            seen.add(name)
            target.attrs[name] = text_or_attribute(item)

    seen_paths = set()
    consumed = 0
    try:
        with h5py.File(destination, "w") as handle:
            for item in groups:
                path = valid_path(item.get("path"))
                if path in seen_paths:
                    raise ValueError("SBD 数据包包含重复对象")
                seen_paths.add(path)
                write_attributes(handle.require_group(path) if path else handle, item.get("attrs", []))
            for item in datasets:
                path = valid_path(item.get("path"))
                if not path or path in seen_paths or path in {"Registrations", "SpectraGroup"}:
                    raise ValueError("SBD 数据包包含重复或无效数据集")
                seen_paths.add(path)
                shape = shape_of(item)
                dtype = NUMERIC_DTYPES.get(item.get("dtype"))
                if item.get("dtype") == "string":
                    array = text_or_attribute(item)
                else:
                    length, offset = item.get("length"), item.get("offset")
                    if dtype is None or type(length) is not int or type(offset) is not int or offset != consumed or length != math.prod(shape) * dtype.itemsize or length > len(body) - consumed:
                        raise ValueError("SBD 数值数组大小或偏移错误")
                    array = np.frombuffer(body[offset:offset + length], dtype=dtype).reshape(shape)
                    consumed += length
                dataset = handle.create_dataset(path, data=array)
                write_attributes(dataset, item.get("attrs", []))
            if consumed != len(body):
                raise ValueError("SBD 数据包包含未声明的数据")
            handle.attrs["spatialbridge_format"] = EXTRACT_FORMAT
            handle.attrs["spatialbridge_version"] = EXTRACT_VERSION
            source = metadata.get("source", {})
            handle.attrs["source_name"] = str(source.get("name", ""))
            handle.attrs["source_size"] = str(source.get("size", ""))
            validate_sbd_extract(handle)
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


def validate_sbd_extract(handle: Any) -> None:
    """Leave full SBD files compatible; validate files claiming our subset format."""
    marker = handle.attrs.get("spatialbridge_format")
    if marker is None:
        return
    if isinstance(marker, bytes):
        marker = marker.decode("utf-8")
    if marker != EXTRACT_FORMAT or handle.attrs.get("spatialbridge_version") != EXTRACT_VERSION:
        raise ValueError("不支持的 SpatialBridge SBD 数据包版本")
    if handle.id.get_filesize() > MAX_EXTRACT_BYTES:
        raise ValueError("SBD 精简数据包超过 128 MiB 限制")
    if set(handle.keys()) - {"Registrations", "MeasurementRasterIndices", "SpectraGroup", "OpticalImages"}:
        raise ValueError("SBD 精简数据包包含不支持的数据组")
    if "SpectraGroup" in handle and set(handle["SpectraGroup"].keys()) - {"Normalizations"}:
        raise ValueError("SBD 精简数据包不应包含原始质谱")

    def dataset(path: str, dimensions: int | None = None):
        item = handle.get(path)
        if item is None or not hasattr(item, "shape") or item.dtype.kind not in "iuf":
            raise ValueError(f"SBD 精简数据包缺少有效数值数组：{path}")
        if dimensions is not None and len(item.shape) != dimensions:
            raise ValueError(f"SBD 数组维度错误：{path}")
        return item

    coordinates = dataset("Registrations/0/Coordinates", 2)
    original = dataset("Registrations/0/OriginalCoordinates", 2)
    count = coordinates.shape[1]
    if count <= 0 or coordinates.shape[0] not in {2, 3} or original.shape[0] != 2 or original.shape[1] != count:
        raise ValueError("SBD 点位坐标数量或维度不一致")
    raster = dataset("MeasurementRasterIndices")
    if len(raster.shape) not in {1, 2} or math.prod(raster.shape) != count:
        raise ValueError("SBD raster 数量与点位数量不一致")
    if "Registrations/0/SpotSizes" in handle:
        sizes = dataset("Registrations/0/SpotSizes", 2)
        if sizes.shape[0] not in {2, 3} or sizes.shape[1] != count:
            raise ValueError("SBD spot 尺寸数组与点位数量不一致")
    normalizations = handle.get("SpectraGroup/Normalizations")
    if normalizations is not None:
        for key in normalizations:
            values = dataset(f"SpectraGroup/Normalizations/{key}/Values")
            if math.prod(values.shape) != count:
                raise ValueError("SBD normalization 数量与点位数量不一致")
    optical = handle.get("OpticalImages")
    if optical is None or not any("ImageData" in item and "World2Px" in item for item in optical.values()):
        raise ValueError("SBD 精简数据包缺少内嵌板图或配准矩阵")
