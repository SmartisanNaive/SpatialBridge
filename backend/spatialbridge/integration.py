from __future__ import annotations

from io import BytesIO
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
from PIL import Image

from .lattice import evaluate_coordinate_model, fit_optical_lattice
from .registration import (
    RegistrationError,
    _attribute_text,
    dimensions,
    downscaled,
    extract_heat_text,
    load_gray,
    marker_registration,
    sift_registration,
    transform_points,
)

Image.MAX_IMAGE_PIXELS = None


def _matrix_2d(value: Any) -> np.ndarray | None:
    """Convert an SBD 4x4/3x3 matrix attribute into a 2D homogeneous matrix."""
    if value is None:
        return None
    if isinstance(value, np.ndarray) and value.dtype.kind in {"S", "U", "O"}:
        value = value.reshape(-1)[0] if value.size else None
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        numbers = np.fromstring(value.replace(",", " "), sep=" ", dtype=float)
        if numbers.size == 16:
            value = numbers.reshape(4, 4)
        elif numbers.size == 9:
            value = numbers.reshape(3, 3)
        else:
            return None
    array = np.asarray(value, dtype=float)
    if array.size == 16:
        array = array.reshape(4, 4)
    elif array.size == 9:
        array = array.reshape(3, 3)
    else:
        return None
    if array.shape == (4, 4):
        return np.array([
            [array[0, 0], array[0, 1], array[0, 3]],
            [array[1, 0], array[1, 1], array[1, 3]],
            [0.0, 0.0, 1.0],
        ], dtype=float)
    if array.shape == (3, 3):
        return array.astype(float)
    return None


def _image_data_size(dataset: Any) -> tuple[int, int] | None:
    """Read the dimensions of an embedded PNG without retaining its pixels."""
    try:
        raw = np.asarray(dataset[...], dtype=np.int8).tobytes()
        with Image.open(BytesIO(raw)) as image:
            return image.size
    except Exception:
        return None


def _odd(value: float, minimum: int = 3) -> int:
    result = max(minimum, int(round(value)))
    return result if result % 2 else result + 1


def _stats(values: np.ndarray) -> dict[str, float]:
    finite = values[np.isfinite(values)]
    if finite.size == 0:
        return {"median_px": float("nan"), "p95_px": float("nan"), "p99_px": float("nan")}
    return {"median_px": float(np.median(finite)), "p95_px": float(np.quantile(finite, .95)),
            "p99_px": float(np.quantile(finite, .99))}


def _matrix_diagnostics(matrix: np.ndarray, name: str) -> dict[str, Any]:
    """Return the small set of transform-health values we expose in a report."""
    value = np.asarray(matrix, dtype=float)
    if value.shape != (3, 3) or not np.isfinite(value).all():
        raise RegistrationError(f"{name} 不是有限的 3x3 坐标变换")
    linear = value[:2, :2]
    determinant = float(np.linalg.det(linear))
    if not np.isfinite(determinant) or abs(determinant) < 1e-12:
        raise RegistrationError(f"{name} 的二维线性部分不可逆")
    return {"name": name, "determinant": determinant,
            "linear_condition": float(np.linalg.cond(linear)),
            "projective": bool(np.any(np.abs(value[2, :2]) > 1e-12))}


def _affine_consistency(original: np.ndarray, target: np.ndarray, raster: np.ndarray) -> dict[str, Any]:
    """Check that the board/heat chain agrees with SBD OriginalCoordinates."""
    finite = np.isfinite(original).all(axis=1) & np.isfinite(target).all(axis=1)
    if int(finite.sum()) < 3:
        raise RegistrationError("SBD OriginalCoordinates contain too few finite points")
    design = np.c_[original[finite], np.ones(int(finite.sum()))]
    coefficients = np.linalg.lstsq(design, target[finite], rcond=None)[0].T
    predicted = np.c_[original[finite], np.ones(int(finite.sum()))] @ coefficients.T
    residual = np.linalg.norm(predicted - target[finite], axis=1)
    result: dict[str, Any] = {"global": _stats(residual), "by_raster": [],
                              "fit_matrix": np.vstack([coefficients, [0.0, 0.0, 1.0]]).tolist(),
                              "coordinate_order": "xy"}
    for raster_id in np.unique(raster[finite]):
        selected = raster[finite] == raster_id
        result["by_raster"].append({"id": int(raster_id), "spot_count": int(selected.sum()),
                                    **_stats(residual[selected])})
    return result


def _coordinate_coverage(points: np.ndarray, image_dimensions: tuple[int, int]) -> dict[str, Any]:
    values = np.asarray(points, dtype=float)
    finite = np.isfinite(values).all(axis=1)
    inside = finite & (values[:, 0] >= 0) & (values[:, 1] >= 0) & \
        (values[:, 0] < image_dimensions[0]) & (values[:, 1] < image_dimensions[1])
    count = int(len(values))
    return {"spot_count": count, "finite_count": int(finite.sum()), "inside_count": int(inside.sum()),
            "inside_fraction": float(inside.sum() / count) if count else 0.0}


def _roundtrip_validation(matrix: np.ndarray, points: np.ndarray) -> dict[str, Any]:
    values = np.asarray(points, dtype=float)
    finite = np.isfinite(values).all(axis=1)
    if not finite.any():
        return {"valid_count": 0, **_stats(np.empty(0, dtype=float))}
    inverse = np.linalg.inv(np.asarray(matrix, dtype=float))
    forward = transform_points(matrix, values[finite])
    roundtrip = transform_points(inverse, forward)
    valid = np.isfinite(forward).all(axis=1) & np.isfinite(roundtrip).all(axis=1)
    errors = np.linalg.norm(roundtrip[valid] - values[finite][valid], axis=1)
    return {"valid_count": int(valid.sum()), **_stats(errors)}


def _coordinate_chain_validation(world: np.ndarray, raster: np.ndarray,
                                 matrices: dict[str, np.ndarray],
                                 image_dimensions: dict[str, tuple[int, int]],
                                 coordinate_model: dict[str, Any] | None = None) -> dict[str, Any]:
    """Validate matrix direction, invertibility and image-space round trips.

    IMS MicroLink's explicit x/y-vs-y/x handling is reflected here: all
    persisted points are ``[x, y]`` and image arrays remain indexed
    ``image[y, x]``.  Every matrix is composed as a column-vector
    homogeneous transform, and the report records the convention so clients
    do not have to infer it from a rendered overlay.
    """
    convention = {
        "point_order": "xy",
        "image_array_order": "yx",
        "homogeneous": "column vector [x, y, 1] with p' = M p",
        "pixel_origin": "top-left; coordinates are pixel-center continuous coordinates",
        "sbd_original_coordinates": "raster acquisition-grid indices; not PNG pixel coordinates",
    }
    diagnostics = {name: _matrix_diagnostics(matrix, name) for name, matrix in matrices.items()}
    roundtrips: dict[str, Any] = {}
    for name in ("world_to_board", "world_to_heat", "world_to_pre", "world_to_after"):
        if name in matrices:
            roundtrips[name] = _roundtrip_validation(matrices[name], world)
    if "after_to_pre" in matrices:
        # This transform is image-space rather than world-space; validate it
        # on the after-image samples supplied by the caller.
        roundtrips["after_to_pre"] = _roundtrip_validation(matrices["after_to_pre"],
                                                            transform_points(matrices["world_to_after"], world))

    legacy_world_to_pre = transform_points(matrices["world_to_pre"], world)
    legacy_world_to_after = transform_points(matrices["world_to_after"], world)
    world_to_after = legacy_world_to_after
    world_to_pre = legacy_world_to_pre
    model_validation: dict[str, Any] | None = None
    if coordinate_model is not None:
        model_after = evaluate_coordinate_model(coordinate_model, world, enforce_domain=True)
        model_pre = transform_points(matrices["after_to_pre"], model_after)
        model_valid = np.isfinite(model_after).all(axis=1) & np.isfinite(model_pre).all(axis=1)
        world_to_after = model_after
        world_to_pre = model_pre
        legacy_valid = np.isfinite(legacy_world_to_after).all(axis=1) & model_valid
        model_delta = np.linalg.norm(legacy_world_to_after[legacy_valid] - model_after[legacy_valid], axis=1)
        model_validation = {
            "model_type": coordinate_model.get("model_type"),
            "calibration_version": coordinate_model.get("calibration_version"),
            "valid_count": int(model_valid.sum()),
            "outside_domain_count": int((~model_valid).sum()),
            "legacy_affine_approximation_delta_px": _stats(model_delta),
            "authoritative": True,
            "roundtrip_note": "平滑模型无逐点逆变换；矩阵 roundtrip 仅用于兼容字段健康检查",
        }
    pre_from_after = transform_points(matrices["after_to_pre"], world_to_after)
    chain_error = np.linalg.norm(world_to_pre - pre_from_after, axis=1)
    coverage_by_raster = []
    for raster_id in np.unique(raster):
        selected = raster == raster_id
        coverage_by_raster.append({
            "id": int(raster_id),
            "pre": _coordinate_coverage(world_to_pre[selected], image_dimensions["pre"]),
            "after": _coordinate_coverage(world_to_after[selected], image_dimensions["after"]),
        })
    result = {"coordinate_convention": convention, "matrix_diagnostics": diagnostics,
            "roundtrip_px": roundtrips, "world_chain_pre_vs_after_px": _stats(chain_error),
            "coverage_by_raster": coverage_by_raster}
    if model_validation is not None:
        result["coordinate_model_validation"] = model_validation
    return result


def _extract_embedded_board(path: Path, cache_dir: Path) -> tuple[Path, np.ndarray] | None:
    """Save the board image stored inside the SBD and return it with its matrix.

    SCiLS keeps a reduced copy of the registered board scan in the SBD together
    with ``World2Px`` for that copy's pixels, so the coordinate chain can be
    built without uploading the original board TIFF.
    """
    try:
        import h5py  # type: ignore
    except ImportError:
        return None
    with h5py.File(path, "r") as handle:
        for key in handle.get("OpticalImages", {}):
            candidate = handle["OpticalImages"][key]
            if "overview" in (_attribute_text(candidate.attrs, "name") or "").lower():
                continue
            if "ImageData" not in candidate or "World2Px" not in candidate:
                continue
            matrix = _matrix_2d(candidate["World2Px"][...])
            if matrix is None:
                continue
            data = np.asarray(candidate["ImageData"][...]).tobytes()
            try:
                with Image.open(BytesIO(data)) as image:
                    image.load()
                    cache_dir.mkdir(parents=True, exist_ok=True)
                    destination = cache_dir / "sbd-embedded-board.png"
                    image.convert("RGB").save(destination, "PNG", compress_level=1)
            except (OSError, ValueError):
                continue
            return destination, matrix
    return None


def _read_sbd(path: Path, board_dimensions: tuple[int, int]) -> dict[str, Any]:
    try:
        import h5py  # type: ignore
    except ImportError as error:
        raise RegistrationError(f"读取 SBD 需要 h5py：{error}") from error

    with h5py.File(path, "r") as handle:
        coordinates_dataset = handle.get("Registrations/0/Coordinates")
        original_dataset = handle.get("Registrations/0/OriginalCoordinates")
        raster_dataset = handle.get("MeasurementRasterIndices")
        if coordinates_dataset is None or original_dataset is None or raster_dataset is None:
            raise RegistrationError("SBD 缺少 Coordinates、OriginalCoordinates 或 MeasurementRasterIndices")
        coordinates = np.asarray(coordinates_dataset[...], dtype=np.float64)
        original = np.asarray(original_dataset[...], dtype=np.float64)
        if coordinates.ndim != 2 or coordinates.shape[0] < 2:
            raise RegistrationError("SBD Coordinates 不是可用的二维坐标数组")
        if original.ndim != 2 or original.shape[0] < 2:
            raise RegistrationError("SBD OriginalCoordinates 不是可用的二维坐标数组")
        world = coordinates[:2].T
        original_points = original[:2].T
        raster = np.asarray(raster_dataset[...], dtype=np.int32).reshape(-1)
        spot_count = len(world)
        if len(original_points) != spot_count or len(raster) != spot_count:
            raise RegistrationError("SBD 坐标数组长度不一致")

        # Keep the acquisition-grid transforms as provenance.  They are not
        # needed to load spectra, but make the distinction between SBD
        # OriginalCoordinates (raster pixel/grid indices) and SBD world
        # coordinates explicit in the report.
        raster_transforms: dict[str, list[list[float]]] = {}
        raster_pixel_to_world: dict[str, list[list[float]]] = {}
        raster_group = handle.get("Registrations/0/Rasters")
        if raster_group is not None:
            for raster_id, raster_item in raster_group.items():
                pixel_to_world = raster_item.get("PixelToWorld")
                if pixel_to_world is None:
                    continue
                matrix = np.asarray(pixel_to_world[...], dtype=np.float64)
                if matrix.shape != (4, 4) or not np.isfinite(matrix).all():
                    continue
                key = str(raster_id)
                raster_transforms[key] = matrix.tolist()
                matrix_2d = _matrix_2d(matrix)
                if matrix_2d is not None:
                    raster_pixel_to_world[key] = matrix_2d.tolist()

        optical_group = None
        for key in handle.get("OpticalImages", {}):
            candidate = handle["OpticalImages"][key]
            name = (_attribute_text(candidate.attrs, "name") or "").lower()
            if "overview" in name:
                continue
            if "Reference/world2Px" in candidate.attrs or "World2Px" in candidate:
                optical_group = candidate
                break
        if optical_group is None:
            raise RegistrationError("SBD 中没有可用的 MALDI 光学图坐标变换")

        reference_text = _attribute_text(optical_group.attrs, "Reference/world2Px")
        world_to_board = _matrix_2d(reference_text)
        matrix_source = "Reference/world2Px"
        reference_width = _attribute_text(optical_group.attrs, "Reference/WidthPixels")
        reference_height = _attribute_text(optical_group.attrs, "Reference/HeightPixels")
        embedded_size = _image_data_size(optical_group["ImageData"]) if "ImageData" in optical_group else None
        if world_to_board is None:
            world_to_board = _matrix_2d(optical_group["World2Px"][...])
            matrix_source = "World2Px"
            # Placeholder optical images can store a half-resolution PNG. Bring
            # the embedded-pixel matrix back to the selected board file pixels.
            if embedded_size and embedded_size[0] and embedded_size[1]:
                sx = board_dimensions[0] / embedded_size[0]
                sy = board_dimensions[1] / embedded_size[1]
                world_to_board = np.diag([sx, sy, 1.0]) @ world_to_board
        if world_to_board is None:
            raise RegistrationError("无法解析 SBD World2Px 矩阵")

        spot_sizes_dataset = handle.get("Registrations/0/SpotSizes")
        spot_sizes = np.asarray(spot_sizes_dataset[...], dtype=np.float32)[:2].T if spot_sizes_dataset is not None else np.empty((spot_count, 2), dtype=np.float32)
        values: list[dict[str, Any]] = []
        normalizations = handle.get("SpectraGroup/Normalizations")
        if normalizations is not None:
            for normalization_id, group in normalizations.items():
                values_dataset = group.get("Values")
                if values_dataset is None:
                    continue
                array = np.asarray(values_dataset[...], dtype=np.float32).reshape(-1)
                if len(array) != spot_count:
                    continue
                values.append({"key": str(normalization_id),
                               "label": _attribute_text(group.attrs, "name") or str(normalization_id),
                               "array": array})

        return {
            "spot_id": np.arange(spot_count, dtype=np.int64),
            "world": world,
            "original": original_points,
            "raster": raster,
            "spot_sizes": spot_sizes,
            "values": values,
            "raster_transforms": raster_transforms,
            "raster_pixel_to_world": raster_pixel_to_world,
            "coordinate_convention": {
                "point_order": "xy",
                "image_array_order": "yx",
                "homogeneous": "column vector [x, y, 1] with p' = M p",
                "sbd_original_coordinates": "raster acquisition-grid indices; not PNG pixel coordinates",
            },
            "world_to_board": world_to_board,
            "world_to_board_source": matrix_source,
            "optical_name": _attribute_text(optical_group.attrs, "name"),
            "reference_path": _attribute_text(optical_group.attrs, "Reference/ReferencePath"),
            "reference_width": int(reference_width) if reference_width and reference_width.isdigit() else None,
            "reference_height": int(reference_height) if reference_height and reference_height.isdigit() else None,
            "embedded_size": embedded_size,
        }


def _local_maxima(response: np.ndarray, points: np.ndarray, scale: float, radius: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return the strongest response near each theoretical SBD grid node.

    The search window is deliberately circular and smaller than one grid
    spacing.  This is the important grid-matching guard: a response peak may
    refine a node, but it cannot hop across a neighbouring burn square.
    """
    radius = max(0, int(radius))
    offsets = np.array([(dx, dy) for dy in range(-radius, radius + 1)
                        for dx in range(-radius, radius + 1)
                        if dx * dx + dy * dy <= radius * radius], dtype=np.float32)
    values = np.asarray(response, dtype=np.float32)
    points_array = np.asarray(points, dtype=np.float32)
    if values.ndim != 2 or points_array.ndim != 2 or points_array.shape[1] != 2:
        raise RegistrationError("局部响应和候选点必须分别为二维图像与 N x 2 坐标")
    if not offsets.size or not len(points_array):
        return np.empty(0, dtype=np.float32), np.empty((0, 2), dtype=np.float32), np.empty(0, dtype=np.float32)
    scores: list[np.ndarray] = []
    best_offsets: list[np.ndarray] = []
    for start in range(0, len(points_array), 16000):
        chunk = points_array[start:start + 16000] * scale
        map_x = (chunk[:, 0, None] + offsets[:, 0]).astype(np.float32)
        map_y = (chunk[:, 1, None] + offsets[:, 1]).astype(np.float32)
        sampled = cv2.remap(values, map_x, map_y, cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_REPLICATE)
        winner = np.argmax(sampled, axis=1)
        row = np.arange(len(winner))
        scores.append(sampled[row, winner])
        best_offsets.append(offsets[winner])
    if not scores:
        return np.empty(0, dtype=np.float32), np.empty((0, 2), dtype=np.float32), np.empty(0, dtype=np.float32)
    score_array = np.concatenate(scores).astype(np.float32)
    offset_array = np.concatenate(best_offsets).astype(np.float32) / max(scale, 1e-9)
    return score_array, offset_array, np.linalg.norm(offset_array, axis=1).astype(np.float32)


def _spot_geometry(spot_sizes: np.ndarray, world_to_after: np.ndarray) -> tuple[np.ndarray, list[np.ndarray], float]:
    """Return the typical SBD footprint, its two image vectors and pitch.

    The vectors are deliberately derived from the SBD world transform rather
    than from independent optical peaks. Optical peaks refine one global
    lattice phase below; they must not change the physical 20 μm spacing
    differently for every spot.
    """
    size_values = np.asarray(spot_sizes, dtype=np.float32)
    finite_sizes = size_values[np.isfinite(size_values).all(axis=1) & (size_values > 0).all(axis=1)]
    typical_size = np.median(finite_sizes, axis=0) if finite_sizes.size else np.array([20.0, 20.0])
    linear = np.asarray(world_to_after, dtype=float)[:2, :2]
    vectors = [
        linear @ np.array([typical_size[0], 0.0]),
        linear @ np.array([0.0, typical_size[1]]),
    ]
    pitch = float(np.mean([np.linalg.norm(vector) for vector in vectors]))
    if not np.isfinite(pitch) or pitch < 3:
        pitch = 48.0
    return typical_size.astype(float), [np.asarray(vector, dtype=float) for vector in vectors], pitch


def _local_model_matrix(model: dict[str, Any] | None, reference_world: np.ndarray,
                        spot_size_world: np.ndarray, fallback: np.ndarray) -> np.ndarray:
    """Make an affine tangent for legacy detection windows only.

    The persisted coordinates remain the polynomial model.  The detector only
    needs a local scale to size its response kernel, so supplying its tangent
    avoids mixing a global affine approximation into the public footprints.
    """
    if model is None:
        return np.asarray(fallback, dtype=float)
    centre = evaluate_coordinate_model(model, np.asarray(reference_world, dtype=float).reshape(1, 2))[0]
    x_step = evaluate_coordinate_model(model, (np.asarray(reference_world, dtype=float) + [spot_size_world[0], 0]).reshape(1, 2))[0] - centre
    y_step = evaluate_coordinate_model(model, (np.asarray(reference_world, dtype=float) + [0, spot_size_world[1]]).reshape(1, 2))[0] - centre
    if not np.isfinite(np.r_[centre, x_step, y_step]).all():
        return np.asarray(fallback, dtype=float)
    linear = np.column_stack([x_step / max(float(spot_size_world[0]), 1e-9),
                              y_step / max(float(spot_size_world[1]), 1e-9)])
    matrix = np.array([[linear[0, 0], linear[0, 1], 0.0],
                       [linear[1, 0], linear[1, 1], 0.0],
                       [0.0, 0.0, 1.0]], dtype=float)
    matrix[:2, 2] = centre - matrix[:2, :2] @ np.asarray(reference_world, dtype=float)
    return matrix


def _prepare_burn_pit_response(after: Path, expected_grid_pitch_px: float) -> dict[str, Any]:
    """Build the scale-aware optical response once for phase fitting/detection."""
    image, scale = load_gray(after, max_width=14000)
    small_pitch = max(4.0, float(expected_grid_pitch_px) * scale)
    inner_kernel = _odd(small_pitch * .42)
    outer_kernel = max(inner_kernel + 2, _odd(small_pitch * .92))
    gray = image.astype(np.float32)
    inner = cv2.boxFilter(gray, cv2.CV_32F, (inner_kernel, inner_kernel), normalize=True)
    outer = cv2.boxFilter(gray, cv2.CV_32F, (outer_kernel, outer_kernel), normalize=True)
    return {"image": image, "scale": float(scale), "response": inner - outer,
            "inner_kernel": int(inner_kernel), "outer_kernel": int(outer_kernel)}


def _sample_response_field(field: np.ndarray, points: np.ndarray, scale: float) -> tuple[np.ndarray, np.ndarray]:
    """Sample a response field at raw-image coordinates without moving nodes."""
    values = np.asarray(points, dtype=np.float32)
    if values.ndim != 2 or values.shape[1] != 2:
        return np.empty(0, dtype=np.float32), np.empty(0, dtype=bool)
    x = np.rint(values[:, 0] * scale).astype(np.int64)
    y = np.rint(values[:, 1] * scale).astype(np.int64)
    valid = (x >= 0) & (y >= 0) & (x < field.shape[1]) & (y < field.shape[0])
    if not valid.any():
        return np.empty(0, dtype=np.float32), valid
    return np.asarray(field[y[valid], x[valid]], dtype=np.float32), valid


def _phase_score(field: np.ndarray, points: np.ndarray, scale: float, delta: np.ndarray) -> tuple[float, float]:
    """Score one global translation of a seed lattice."""
    sampled, valid = _sample_response_field(field, np.asarray(points) + np.asarray(delta), scale)
    fraction = float(valid.mean()) if valid.size else 0.0
    if sampled.size < 12 or fraction < .85:
        return float("nan"), fraction
    lower, upper = np.quantile(sampled, [.10, .90])
    trimmed = np.clip(sampled, lower, upper)
    return float(.75 * np.mean(trimmed) + .25 * np.median(sampled)), fraction


def _seed_windows(original: np.ndarray, raster: np.ndarray, after_points: np.ndarray,
                  primary_raster: int) -> list[dict[str, Any]]:
    """Pick small corner blocks from the SBD raster as clear-grid seeds."""
    original_values = np.asarray(original, dtype=float)
    raster_values = np.asarray(raster, dtype=np.int32).reshape(-1)
    points = np.asarray(after_points, dtype=float)
    base = (raster_values == int(primary_raster)) & np.isfinite(original_values).all(axis=1) & \
        np.isfinite(points).all(axis=1)
    if not base.any():
        return []
    unique_x = np.unique(original_values[base, 0])
    unique_y = np.unique(original_values[base, 1])
    if not unique_x.size or not unique_y.size:
        return []
    x_count = min(len(unique_x), max(8, min(24, int(round(len(unique_x) * .15)))))
    y_count = min(len(unique_y), max(32, min(160, int(round(len(unique_y) * .12)))))
    windows: list[dict[str, Any]] = []
    for x_name, x_values in (("x-min", unique_x[:x_count]), ("x-max", unique_x[-x_count:])):
        for y_name, y_values in (("y-min", unique_y[:y_count]), ("y-max", unique_y[-y_count:])):
            selected = base & np.isin(original_values[:, 0], x_values) & np.isin(original_values[:, 1], y_values)
            indices = np.flatnonzero(selected)
            if indices.size < 12:
                continue
            if indices.size > 1800:
                indices = indices[np.linspace(0, indices.size - 1, 1800).round().astype(np.int64)]
            seed_points = points[indices]
            windows.append({
                "name": f"{x_name},{y_name}",
                "points": seed_points.astype(np.float32),
                "spot_count": int(len(seed_points)),
                "image_bbox": [float(seed_points[:, 0].min()), float(seed_points[:, 1].min()),
                                float(seed_points[:, 0].max()), float(seed_points[:, 1].max())],
            })
    return windows


def _component_centres(image: np.ndarray, scale: float, bounds: tuple[int, int, int, int],
                       pitch: float, threshold: float, polarity: str) -> np.ndarray:
    """Find square-pit interior centres in one small clear-grid crop.

    This is intentionally a light-weight observation step rather than a
    general segmentation pipeline.  It only supplies the two lattice vectors
    and one edge anchor; SBD remains the source of the spot identities and
    footprint sizes.
    """
    width, height = image.shape[1], image.shape[0]
    raw_x0, raw_x1, raw_y0, raw_y1 = bounds
    x0 = max(0, min(width - 1, int(round(raw_x0 * scale))))
    x1 = max(x0 + 1, min(width, int(round(raw_x1 * scale))))
    y0 = max(0, min(height - 1, int(round(raw_y0 * scale))))
    y1 = max(y0 + 1, min(height, int(round(raw_y1 * scale))))
    region = np.asarray(image[y0:y1, x0:x1], dtype=np.uint8)
    if region.size == 0:
        return np.empty((0, 2), dtype=float)
    if polarity == "dark":
        binary = (region <= threshold).astype(np.uint8) * 255
    else:
        binary = (region >= threshold).astype(np.uint8) * 255
    count, _, stats, centres = cv2.connectedComponentsWithStats(binary, 8)
    if count <= 1:
        return np.empty((0, 2), dtype=float)
    stats = stats[1:]
    centres = centres[1:]
    small_pitch = max(3.0, float(pitch * scale))
    areas = stats[:, cv2.CC_STAT_AREA].astype(float)
    widths = stats[:, cv2.CC_STAT_WIDTH].astype(float)
    heights = stats[:, cv2.CC_STAT_HEIGHT].astype(float)
    aspect = widths / np.maximum(heights, 1.0)
    # Interior components are smaller than a full pitch and reasonably close
    # to square.  Boundary-touching components are usually tissue/background.
    good = (areas >= small_pitch * small_pitch * .12) & \
        (areas <= small_pitch * small_pitch * 2.8) & \
        (widths >= small_pitch * .25) & (heights >= small_pitch * .25) & \
        (widths <= small_pitch * 1.8) & (heights <= small_pitch * 1.8) & \
        (aspect > .35) & (aspect < 2.8) & \
        (stats[:, cv2.CC_STAT_LEFT] > 1) & (stats[:, cv2.CC_STAT_TOP] > 1) & \
        (stats[:, cv2.CC_STAT_LEFT] + widths < region.shape[1] - 1) & \
        (stats[:, cv2.CC_STAT_TOP] + heights < region.shape[0] - 1)
    if not good.any():
        return np.empty((0, 2), dtype=float)
    return centres[good].astype(float) / max(scale, 1e-9) + np.array([raw_x0, raw_y0], dtype=float)


def _nearest_lattice_vector(points: np.ndarray, pitch: float, direction: str) -> np.ndarray | None:
    """Estimate one lattice step from component-centre nearest neighbours."""
    values = np.asarray(points, dtype=float)
    if values.ndim != 2 or values.shape[1] != 2 or len(values) < 24:
        return None
    # Keep the observation bounded if a crop contains unusually many texture
    # fragments.  Spatial coverage matters more than retaining every fragment.
    if len(values) > 3600:
        values = values[np.linspace(0, len(values) - 1, 3600).round().astype(np.int64)]
    if direction == "horizontal":
        expected = np.array([pitch, 0.0], dtype=float)
    else:
        expected = np.array([0.0, pitch], dtype=float)
    candidates: list[np.ndarray] = []
    for point in values:
        delta = values - point
        if direction == "horizontal":
            valid = (delta[:, 0] > pitch * .52) & (delta[:, 0] < pitch * 1.48) & \
                (np.abs(delta[:, 1]) < pitch * .45)
        else:
            valid = (delta[:, 1] > pitch * .52) & (delta[:, 1] < pitch * 1.48) & \
                (np.abs(delta[:, 0]) < pitch * .45)
        if not valid.any():
            continue
        possible = delta[valid]
        errors = np.sum((possible - expected) ** 2, axis=1)
        candidates.append(possible[int(np.argmin(errors))])
    if len(candidates) < max(20, int(len(values) * .04)):
        return None
    vectors = np.asarray(candidates, dtype=float)
    median = np.median(vectors, axis=0)
    inliers = np.linalg.norm(vectors - median, axis=1) <= max(5.0, pitch * .22)
    if int(inliers.sum()) < max(16, int(len(vectors) * .35)):
        return None
    return np.median(vectors[inliers], axis=0)


def _lattice_support(points: np.ndarray, horizontal: np.ndarray, down: np.ndarray,
                     tolerance: float) -> np.ndarray:
    """Count nearby neighbours in the four expected lattice directions."""
    values = np.asarray(points, dtype=float)
    support = np.zeros(len(values), dtype=np.int8)
    if not len(values):
        return support
    targets = [horizontal, -horizontal, down, -down]
    # Chunking avoids a large N×N allocation while remaining much faster than
    # four nested Python loops for a dense clear seed.
    for start in range(0, len(values), 256):
        chunk = values[start:start + 256]
        delta = values[None, :, :] - chunk[:, None, :]
        for target in targets:
            distance = np.linalg.norm(delta - target[None, None, :], axis=2)
            support[start:start + len(chunk)] += (distance.min(axis=1) < tolerance).astype(np.int8)
    return support


def _clear_lattice_geometry(image: np.ndarray, scale: float, expected_pitch: float,
                            seed_bbox: list[float], original: np.ndarray, raster: np.ndarray,
                            after_points: np.ndarray, world: np.ndarray,
                            base_world_to_after: np.ndarray, primary_raster: int) -> dict[str, Any] | None:
    """Fit a single affine SBD lattice from the clear lower-right seed.

    The optical pattern is periodic, so response phase alone cannot tell a
    correct row from the same row plus an integer number of pitches.  The
    lower-right clear seed resolves that ambiguity by anchoring the first
    observed bottom row and rightmost column.  The resulting affine lattice is
    then applied globally; no spot is independently moved to a local peak.
    """
    original_values = np.asarray(original, dtype=float)
    raster_values = np.asarray(raster, dtype=np.int32).reshape(-1)
    points = np.asarray(after_points, dtype=float)
    world_values = np.asarray(world, dtype=float)
    primary = raster_values == int(primary_raster)
    finite = primary & np.isfinite(original_values).all(axis=1) & \
        np.isfinite(points).all(axis=1) & np.isfinite(world_values).all(axis=1)
    if int(finite.sum()) < 24:
        return None

    x_values = np.unique(original_values[finite, 0])
    y_values = np.unique(original_values[finite, 1])
    if not x_values.size or not y_values.size:
        return None
    # This is the SBD point at the bottom row/rightmost column that actually
    # exists in the sparse acquisition table, not an invented missing point.
    rightmost_y = float(y_values.max())
    anchor_indices = np.flatnonzero(finite & (original_values[:, 1] == rightmost_y))
    if not anchor_indices.size:
        return None
    anchor_x = float(original_values[anchor_indices, 0].min())
    anchor_original = np.array([anchor_x, rightmost_y], dtype=float)
    anchor_mask = finite & (original_values[:, 0] == anchor_x) & \
        (original_values[:, 1] == rightmost_y)
    if not anchor_mask.any():
        return None
    anchor_index = int(np.flatnonzero(anchor_mask)[0])

    # Expand around the SBD-predicted seed.  The vertical margin deliberately
    # spans several rows so a wrong integer phase cannot hide the clear edge.
    pitch_margin = max(expected_pitch, 8.0)
    x0 = int(np.floor(float(seed_bbox[0]) - pitch_margin * 8.0))
    x1 = int(np.ceil(float(seed_bbox[2]) + pitch_margin * 8.0))
    y0 = int(np.floor(float(seed_bbox[1]) - pitch_margin * 4.0))
    y1 = int(np.ceil(float(seed_bbox[3]) + pitch_margin * 18.0))
    x0 = max(0, x0)
    y0 = max(0, y0)
    x1 = min(image.shape[1] / max(scale, 1e-9), x1)
    y1 = min(image.shape[0] / max(scale, 1e-9), y1)
    if x1 - x0 < expected_pitch * 5 or y1 - y0 < expected_pitch * 5:
        return None

    region = image[int(round(y0 * scale)):int(round(y1 * scale)),
                   int(round(x0 * scale)):int(round(x1 * scale))]
    if region.size < 200:
        return None
    thresholds = np.percentile(region, [58.0, 62.0, 66.0])
    candidates: list[dict[str, Any]] = []
    for polarity in ("bright", "dark"):
        for threshold in thresholds:
            centres = _component_centres(image, scale, (x0, x1, y0, y1),
                                         expected_pitch, float(threshold), polarity)
            if len(centres) < 120:
                continue
            horizontal = _nearest_lattice_vector(centres, expected_pitch, "horizontal")
            down = _nearest_lattice_vector(centres, expected_pitch, "vertical")
            if horizontal is None or down is None:
                continue
            if np.linalg.det(np.column_stack([-down, horizontal])) == 0:
                continue
            support = _lattice_support(centres, horizontal, down, max(7.0, expected_pitch * .20))
            supported = support >= 2
            if int(supported.sum()) < 60:
                supported = np.ones(len(centres), dtype=bool)
            selected = centres[supported]
            lattice = np.column_stack([-down, horizontal])
            coordinates = (selected - selected.mean(axis=0)) @ np.linalg.inv(lattice).T
            row_coordinate = coordinates[:, 0]
            column_coordinate = coordinates[:, 1]
            # Do not use a global percentile for the bottom edge: a clear
            # seed may contain a partial row at the crop boundary, and that
            # can make the percentile select the previous row (an integer
            # phase error of exactly one SBD pitch).  First lock the rightmost
            # lattice column, then choose its lowest supported component. It
            # is the least ambiguous corner in the user's clear lower-right
            # seed and remains robust when the bottom row is only partially
            # visible.
            right_edge = column_coordinate >= np.percentile(column_coordinate, 97.0) - .65
            if int(right_edge.sum()) < 8:
                right_edge = column_coordinate >= float(column_coordinate.max()) - .8
            if int(right_edge.sum()) < 8:
                continue
            right_indices = np.flatnonzero(right_edge)
            br_index = int(right_indices[np.argmin(row_coordinate[right_indices])])
            br = selected[br_index]
            observed_pitch = float(np.mean([np.linalg.norm(horizontal), np.linalg.norm(down)]))
            if not np.isfinite(observed_pitch) or not .7 * expected_pitch < observed_pitch < 1.3 * expected_pitch:
                continue
            quality = float(supported.sum() / max(len(centres), 1))
            # Prefer the rightmost/bottommost regular clear row.  The crop is
            # intentionally bounded around the predicted seed, so this picks
            # the real edge rather than an arbitrary periodic alias.
            edge_score = float((br[0] - float(seed_bbox[2])) / pitch_margin +
                               .18 * (br[1] - float(seed_bbox[3])) / pitch_margin)
            candidates.append({"centres": centres, "horizontal": horizontal, "down": down,
                               "br": br, "support_ratio": quality, "edge_score": edge_score,
                               "polarity": polarity, "threshold": float(threshold),
                               "observed_pitch": observed_pitch, "supported_count": int(supported.sum())})
    if not candidates:
        return None

    selected = max(candidates, key=lambda item: item["edge_score"] + .35 * item["support_ratio"])
    horizontal = np.asarray(selected["horizontal"], dtype=float)
    down = np.asarray(selected["down"], dtype=float)
    # Component centroids are slightly contracted by thresholding/resizing.
    # Blend their measured pitch with the SBD 20 μm pitch so the full-width
    # grid does not accumulate a one-cell error at the opposite edge.
    lattice_pitch = float(.5 * (selected["observed_pitch"] + expected_pitch))
    horizontal *= lattice_pitch / max(np.linalg.norm(horizontal), 1e-9)
    down *= lattice_pitch / max(np.linalg.norm(down), 1e-9)
    lattice_vectors = np.column_stack([-down, horizontal]
                                       )  # columns: Original x step, Original y step
    anchor_after = np.asarray(selected["br"], dtype=float)
    translation = anchor_after - lattice_vectors @ anchor_original
    target_after = original_values @ lattice_vectors.T + translation

    finite_world = finite & np.isfinite(target_after).all(axis=1)
    if int(finite_world.sum()) < 24:
        return None
    design = np.c_[world_values[finite_world], np.ones(int(finite_world.sum()))]
    coefficients = np.linalg.lstsq(design, target_after[finite_world], rcond=None)[0].T
    target_world_to_after = np.vstack([coefficients, [0.0, 0.0, 1.0]])
    if not np.isfinite(target_world_to_after).all() or abs(float(np.linalg.det(target_world_to_after[:2, :2]))) < 1e-12:
        return None
    base_matrix = np.asarray(base_world_to_after, dtype=float)
    if base_matrix.shape != (3, 3) or not np.isfinite(base_matrix).all():
        return None
    correction = target_world_to_after @ np.linalg.inv(base_matrix)
    correction /= correction[2, 2]
    fitted = transform_points(target_world_to_after, world_values[finite_world])
    target_residual = np.linalg.norm(fitted - target_after[finite_world], axis=1)
    base_anchor = transform_points(base_matrix, world_values[anchor_index:anchor_index + 1])[0]
    anchor_shift = anchor_after - base_anchor
    return {
        "matrix": correction,
        "applied": True,
        "method": "clear lower-right lattice anchor (fixed affine SBD grid)",
        "seed_name": "x-min,y-max (右下清晰方坑区)",
        "polarity": selected["polarity"],
        "threshold": selected["threshold"],
        "seed_count": int(len(selected["centres"])),
        "supported_seed_count": int(selected["supported_count"]),
        "support_ratio": float(selected["support_ratio"]),
        "anchor_original": anchor_original.tolist(),
        "anchor_after_px": anchor_after.tolist(),
        "base_anchor_after_px": base_anchor.tolist(),
        "translation_after_px": anchor_shift.tolist(),
        "integer_phase_shift_after_px": [float(value) for value in anchor_shift],
        "lattice_vectors_after_px": lattice_vectors.T.tolist(),
        "expected_grid_pitch_px": lattice_pitch,
        "target_fit_residual_px": _stats(target_residual),
        "coordinate_order": "xy",
        "display_mode": "fixed_affine_lattice",
        "per_spot_movement": "disabled; one global affine lattice is applied",
        "response_role": "only confirms nodes; it does not re-index or move individual spots",
        "confidence": float(min(1.0, max(.0, .55 * selected["support_ratio"] +
                                          .45 * min(1.0, len(selected["centres"]) / 1800.0)))),
    }


def _estimate_lattice_phase(after: Path, original: np.ndarray, raster: np.ndarray,
                            after_points: np.ndarray, spot_sizes: np.ndarray,
                            world_to_after: np.ndarray, primary_raster: int,
                            world: np.ndarray) -> dict[str, Any]:
    """Refine one fixed SBD lattice from clear optical seed windows.

    SpaceM's useful distinction is retained here: first estimate a regular
    lattice from a clear area, then use it as the prior for ambiguous areas.
    The clear lower-right edge resolves the integer phase; the small response
    phase search remains a fallback for sources without a component-level
    clear seed.
    """
    typical_size, spot_vectors, expected_pitch = _spot_geometry(spot_sizes, world_to_after)
    prepared = _prepare_burn_pit_response(after, expected_pitch)
    field = np.asarray(prepared["response"], dtype=np.float32)
    scale = float(prepared["scale"])
    points = np.asarray(after_points, dtype=float)
    original_values = np.asarray(original, dtype=float)
    raster_values = np.asarray(raster, dtype=np.int32).reshape(-1)
    primary = raster_values == int(primary_raster)
    finite = primary & np.isfinite(points).all(axis=1) & np.isfinite(original_values).all(axis=1)

    # Fit image-space lattice vectors from acquisition indices. This is only a
    # local linear model for phase search; the persisted transform remains the
    # SBD homography and keeps its global projective geometry.
    if int(finite.sum()) >= 3:
        design = np.c_[original_values[finite], np.ones(int(finite.sum()))]
        coefficients = np.linalg.lstsq(design, points[finite], rcond=None)[0]
        lattice_vectors = coefficients[:2]
    else:
        lattice_vectors = np.asarray(spot_vectors, dtype=float)
    if not np.isfinite(lattice_vectors).all() or abs(float(np.linalg.det(lattice_vectors))) < 1e-6:
        return {"matrix": np.eye(3, dtype=float), "applied": False, "response_bundle": prepared,
                "method": "clear-lattice seed phase refinement", "reason": "无法从 SBD 索引建立非退化晶格",
                "seed_count": 0, "expected_grid_pitch_px": expected_pitch}

    windows = _seed_windows(original_values, raster_values, points, primary_raster)
    if not windows:
        return {"matrix": np.eye(3, dtype=float), "applied": False, "response_bundle": prepared,
                "method": "clear-lattice seed phase refinement", "reason": "没有足够的边缘种子点",
                "seed_count": 0, "expected_grid_pitch_px": expected_pitch,
                "lattice_vectors_after_px": lattice_vectors.tolist()}

    clear_seed = next((item for item in windows if item["name"] == "x-min,y-max"), windows[0])
    clear_geometry = _clear_lattice_geometry(
        np.asarray(prepared["image"], dtype=np.uint8), float(prepared["scale"]), expected_pitch,
        clear_seed["image_bbox"], original_values, raster_values, points, world,
        np.asarray(world_to_after, dtype=float), primary_raster,
    )
    if clear_geometry is not None:
        return {"response_bundle": prepared, **clear_geometry}

    fields = [("bright", field), ("dark", -field)]
    coarse_axis = np.linspace(-.48, .48, 25)
    candidates: list[dict[str, Any]] = []
    for polarity, candidate_field in fields:
        baseline = np.array([_phase_score(candidate_field, item["points"], scale, np.zeros(2))[0]
                             for item in windows], dtype=float)
        for u in coarse_axis:
            for v in coarse_axis:
                delta = u * lattice_vectors[0] + v * lattice_vectors[1]
                scores = np.array([_phase_score(candidate_field, item["points"], scale, delta)[0]
                                   for item in windows], dtype=float)
                valid = np.isfinite(scores) & np.isfinite(baseline)
                if int(valid.sum()) < max(2, int(np.ceil(len(windows) * .5))):
                    continue
                improvements = scores[valid] - baseline[valid]
                value = float(np.mean(improvements) + .35 * np.median(improvements) +
                              .10 * np.min(improvements))
                candidates.append({"value": value, "u": float(u), "v": float(v),
                                   "delta": delta.astype(float), "scores": scores,
                                   "baseline": baseline, "improvements": scores - baseline,
                                   "polarity": polarity, "field": candidate_field})
    if not candidates:
        return {"matrix": np.eye(3, dtype=float), "applied": False, "response_bundle": prepared,
                "method": "clear-lattice seed phase refinement", "reason": "清晰种子没有形成稳定相位峰",
                "seed_count": len(windows), "expected_grid_pitch_px": expected_pitch,
                "lattice_vectors_after_px": lattice_vectors.tolist()}

    best = max(candidates, key=lambda item: item["value"])
    half_step = float(coarse_axis[1] - coarse_axis[0])
    fine_u = np.linspace(max(-.5, best["u"] - half_step), min(.5, best["u"] + half_step), 17)
    fine_v = np.linspace(max(-.5, best["v"] - half_step), min(.5, best["v"] + half_step), 17)
    for u in fine_u:
        for v in fine_v:
            delta = u * lattice_vectors[0] + v * lattice_vectors[1]
            scores = np.array([_phase_score(best["field"], item["points"], scale, delta)[0]
                               for item in windows], dtype=float)
            valid = np.isfinite(scores) & np.isfinite(best["baseline"])
            if int(valid.sum()) < max(2, int(np.ceil(len(windows) * .5))):
                continue
            improvements = scores[valid] - best["baseline"][valid]
            value = float(np.mean(improvements) + .35 * np.median(improvements) +
                          .10 * np.min(improvements))
            if value > best["value"]:
                best = {**best, "value": value, "u": float(u), "v": float(v),
                        "delta": delta.astype(float), "scores": scores,
                        "improvements": scores - best["baseline"]}

    improvements = np.asarray(best["improvements"], dtype=float)
    valid_improvements = improvements[np.isfinite(improvements)]
    applied = valid_improvements.size >= max(2, int(np.ceil(len(windows) * .5))) and \
        best["value"] >= max(1.25, expected_pitch * .015) and \
        float(np.median(valid_improvements)) >= .15
    delta = np.asarray(best["delta"], dtype=float) if applied else np.zeros(2, dtype=float)
    matrix = np.array([[1.0, 0.0, delta[0]], [0.0, 1.0, delta[1]], [0.0, 0.0, 1.0]], dtype=float)
    score_before = float(np.nanmean(best["baseline"])) if np.isfinite(best["baseline"]).any() else None
    score_after = float(np.nanmean(best["scores"])) if np.isfinite(best["scores"]).any() else None
    metrics = {
        "method": "clear-lattice seed phase refinement (fixed global lattice)",
        "applied": bool(applied),
        "polarity": best["polarity"],
        "seed_count": len(windows),
        "seed_windows": [{key: value for key, value in item.items() if key != "points"} for item in windows],
        "lattice_vectors_after_px": lattice_vectors.tolist(),
        "expected_grid_pitch_px": float(expected_pitch),
        "phase_uv": [float(best["u"]), float(best["v"])],
        "translation_after_px": [float(delta[0]), float(delta[1])],
        "score_before": score_before,
        "score_after": score_after,
        "score_improvement": float(score_after - score_before) if score_before is not None and score_after is not None else None,
        "robust_seed_improvement": float(np.median(valid_improvements)) if valid_improvements.size else None,
        "confidence": float(min(1.0, max(0.0, best["value"] / max(expected_pitch * .15, 1e-9)))) if valid_improvements.size else 0.0,
        "coordinate_order": "xy",
        "per_spot_movement": "disabled; only one global phase matrix is applied",
    }
    return {"matrix": matrix, "applied": bool(applied), "response_bundle": prepared, **metrics}


def _detect_burn_pits(after: Path, after_points: np.ndarray, raster: np.ndarray,
                      spot_sizes: np.ndarray, world_to_after: np.ndarray,
                      primary_raster: int | None = None,
                      prepared_response: dict[str, Any] | None = None) -> dict[str, Any]:
    """Confirm SBD grid nodes against square-hole contrast in after-microscopy.

    This follows the useful part of SpaceM's workflow without importing its
    whole input stack: estimate a scale-aware local frequency/contrast
    response, detect a response maximum in a bounded neighbourhood, then
    retain the theoretical SBD grid node as the public coordinate.  The local
    maximum is stored separately as a diagnostic/refined image position.
    """
    typical_size, spot_vectors_after, expected_grid_pitch = _spot_geometry(spot_sizes, world_to_after)
    prepared = prepared_response or _prepare_burn_pit_response(after, expected_grid_pitch)
    image = np.asarray(prepared["image"])
    scale = float(prepared["scale"])
    response = np.asarray(prepared["response"], dtype=np.float32)
    inner_kernel = int(prepared["inner_kernel"])
    outer_kernel = int(prepared["outer_kernel"])
    original_width, original_height = dimensions(after)
    points = np.asarray(after_points, dtype=np.float32)
    raster_values = np.asarray(raster, dtype=np.int32).reshape(-1)
    if points.ndim != 2 or points.shape[1] != 2 or len(points) != len(raster_values):
        raise RegistrationError("灼烧坑检测的坐标与 raster 长度不一致")
    finite = np.isfinite(points).all(axis=1)
    in_image = finite & (points[:, 0] >= 0) & (points[:, 1] >= 0) & \
        (points[:, 0] < original_width) & (points[:, 1] < original_height)

    if primary_raster is None:
        visible_raster_ids = np.unique(raster_values[in_image])
        if visible_raster_ids.size:
            primary_raster = int(max(visible_raster_ids, key=lambda value: int(np.count_nonzero(
                in_image & (raster_values == value)))))
        elif raster_values.size:
            raster_ids, raster_counts = np.unique(raster_values, return_counts=True)
            primary_raster = int(raster_ids[int(np.argmax(raster_counts))])
        else:
            primary_raster = 0
    primary_raster = int(primary_raster)
    candidate_mask = in_image & (raster_values == primary_raster)
    candidate_indices = np.flatnonzero(candidate_mask)
    scores = np.full(len(after_points), np.nan, dtype=np.float32)
    offsets = np.full((len(after_points), 2), np.nan, dtype=np.float32)
    offset_distance = np.full(len(after_points), np.nan, dtype=np.float32)
    detected = np.zeros(len(after_points), dtype=bool)
    refined = points.copy().astype(np.float32)
    if candidate_indices.size == 0:
        return {"detected": detected, "scores": scores, "offsets": offsets, "offset_distance": offset_distance,
                "refined_after": refined, "threshold": None, "candidate_count": 0,
                "detected_count": 0, "image_scale": scale, "image_size": [original_width, original_height],
                "primary_raster": primary_raster, "polarity": "bright", "grid_matching": {
                    "method": "SBD theoretical grid nodes matched to bounded local response peaks",
                    "matched_count": 0, "accepted_count": 0, "unmatched_count": 0,
                }}

    spot_vectors_after_px = [np.asarray(vector, dtype=float) for vector in spot_vectors_after]
    spot_size_after_px = [float(np.linalg.norm(vector)) for vector in spot_vectors_after_px]
    # The inner/outer windows approximate SpaceM's scale-specific local
    # frequency response.  They are tied to grid spacing, not to the full
    # microscopy diameter, so adjacent squares remain separate.
    small_pitch = max(4.0, expected_grid_pitch * scale)
    search_radius = max(1, min(int(round(small_pitch * .48)), max(1, int(round(small_pitch / 2)) - 1)))
    gray = image.astype(np.float32)
    candidate_points = points[candidate_indices]
    candidate_scores, candidate_offsets, candidate_distances = _local_maxima(response, candidate_points, scale, search_radius)
    polarity = "bright"
    if candidate_scores.size and float(np.median(candidate_scores)) < 0:
        response = -response
        candidate_scores, candidate_offsets, candidate_distances = _local_maxima(
            response, candidate_points, scale, search_radius)
        polarity = "dark"
    scores[candidate_indices] = candidate_scores
    offsets[candidate_indices] = candidate_offsets
    offset_distance[candidate_indices] = candidate_distances
    finite_scores = candidate_scores[np.isfinite(candidate_scores)]
    gray_percentiles = np.percentile(gray, [1, 99]) if gray.size else np.array([0.0, 0.0])
    image_contrast = max(0.0, float(gray_percentiles[1] - gray_percentiles[0]))
    minimum_contrast = max(2.0, image_contrast * .04)
    threshold = None
    robust_lower = None
    score_median = None
    score_mad = None
    if finite_scores.size:
        score_median = float(np.median(finite_scores))
        score_mad = float(np.median(np.abs(finite_scores - score_median)))
        robust_lower = score_median - 3.0 * 1.4826 * score_mad
        threshold = float(max(minimum_contrast, robust_lower))
    match_tolerance = float(max(1.0, min(expected_grid_pitch * .48,
                                         search_radius / max(scale, 1e-9) + .5)))
    if threshold is not None:
        detected_candidates = (candidate_scores >= threshold) & (candidate_distances <= match_tolerance)
        detected[candidate_indices] = detected_candidates
        refined[candidate_indices] = candidate_points + candidate_offsets
    return {
        "detected": detected,
        "scores": scores,
        "offsets": offsets,
        "offset_distance": offset_distance,
        "refined_after": refined,
        "threshold": threshold,
        "candidate_count": int(candidate_indices.size),
        "detected_count": int(detected.sum()),
        "image_scale": float(scale),
        "image_size": [original_width, original_height],
        "primary_raster": primary_raster,
        "polarity": polarity,
        "response_kernel": {"inner": inner_kernel, "outer": outer_kernel, "search_radius_small": search_radius},
        "search_radius_px": float(search_radius / max(scale, 1e-9)),
        "spot_size_world": [float(value) for value in typical_size],
        "spot_size_after_px": spot_size_after_px,
        "spot_vectors_after_px": [vector.tolist() for vector in spot_vectors_after_px],
        "expected_spot_diameter_px": expected_grid_pitch,
        "expected_grid_pitch_px": expected_grid_pitch,
        "match_tolerance_px": match_tolerance,
        "threshold_method": "max(minimum image contrast, median - 3×1.4826×MAD)",
        "minimum_contrast": minimum_contrast,
        "robust_lower": robust_lower,
        "score_median": score_median,
        "score_mad": score_mad,
        "score_percentiles": {str(p): float(np.percentile(finite_scores, p)) for p in [1, 5, 10, 25, 50, 75, 90, 95, 99]} if finite_scores.size else {},
        "offset_percentiles_px": {str(p): float(np.percentile(candidate_distances, p)) for p in [50, 80, 95, 99]} if candidate_distances.size else {},
        "grid_matching": {
            "method": "SBD theoretical grid nodes matched to bounded local response peaks",
            "matched_count": int(finite_scores.size),
            "accepted_count": int(detected.sum()),
            "unmatched_count": int(candidate_indices.size - finite_scores.size),
            "public_coordinate": "theoretical SBD grid; response maximum stored in response_*",
        },
    }


def _write_pit_overlay(project_dir: Path, after: Path, points: np.ndarray, detected: np.ndarray,
                       spot_vectors_after_px: list[list[float]] | None = None,
                       world: np.ndarray | None = None,
                       coordinate_model: dict[str, Any] | None = None,
                       spot_size_world: np.ndarray | None = None) -> str:
    artifact_dir = project_dir / "validation"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(after) as image:
        preview, scale = downscaled(image, 1800, "RGB")
        rgb = np.asarray(preview)
    canvas = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    indices = np.flatnonzero(detected)
    if indices.size > 6000:
        indices = indices[np.linspace(0, indices.size - 1, 6000).astype(np.int64)]
    vectors = np.asarray(spot_vectors_after_px, dtype=float) if spot_vectors_after_px is not None else None
    valid_vectors = vectors is not None and vectors.shape == (2, 2) and np.isfinite(vectors).all()
    model_corners = None
    if coordinate_model is not None and world is not None and spot_size_world is not None and len(world) == len(points):
        size = np.asarray(spot_size_world, dtype=float)
        if size.shape == (2,) and np.isfinite(size).all() and (size > 0).all():
            offsets = np.array([[-size[0] / 2, -size[1] / 2], [size[0] / 2, -size[1] / 2],
                                [size[0] / 2, size[1] / 2], [-size[0] / 2, size[1] / 2]], dtype=float)
            model_corners = np.stack([evaluate_coordinate_model(coordinate_model, np.asarray(world) + offset)
                                      for offset in offsets], axis=1)
    for index in indices:
        x, y = points[index] * scale
        if 0 <= x < canvas.shape[1] and 0 <= y < canvas.shape[0]:
            if model_corners is not None and np.isfinite(model_corners[index]).all():
                corners = model_corners[index] * scale
                cv2.polylines(canvas, [np.round(corners).astype(np.int32)], True,
                              (70, 220, 155), 1, cv2.LINE_AA)
            elif valid_vectors:
                vector_x, vector_y = vectors * scale / 2.0
                centre = np.array([x, y], dtype=float)
                corners = np.array([
                    centre - vector_x - vector_y,
                    centre + vector_x - vector_y,
                    centre + vector_x + vector_y,
                    centre - vector_x + vector_y,
                ])
                cv2.polylines(canvas, [np.round(corners).astype(np.int32)], True,
                              (70, 220, 155), 1, cv2.LINE_AA)
            else:
                cv2.circle(canvas, (int(round(x)), int(round(y))), 1, (70, 220, 155), -1, cv2.LINE_AA)
    cv2.putText(canvas, f"SBD-confirmed burn pits: {int(detected.sum()):,} (sampled overlay)",
                (18, 30), cv2.FONT_HERSHEY_SIMPLEX, .65, (70, 240, 170), 2, cv2.LINE_AA)
    destination = artifact_dir / "after_burn_pits_overlay.jpg"
    Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)).save(destination, quality=88, optimize=True)
    return str(destination.relative_to(project_dir))


def _write_lattice_validation_artifacts(project_dir: Path, preview_image: np.ndarray, scale: float,
                                        points: np.ndarray, detected: np.ndarray, world: np.ndarray,
                                        coordinate_model: dict[str, Any], spot_size_world: np.ndarray,
                                        lattice: dict[str, Any]) -> list[str]:
    """Persist the candidate model and five fixed inspection regions.

    The JSON is the machine-readable regional report.  The montage is kept
    deliberately small so it can be opened from the browser without decoding
    the 74k-pixel source image again.
    """
    import json

    artifact_dir = project_dir / "validation"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    optical_validation = lattice.get("optical_validation") or {}
    validation_path = artifact_dir / "lattice_validation.json"
    validation_path.write_text(json.dumps({
        "calibration_version": coordinate_model.get("calibration_version"),
        "coordinate_model": coordinate_model,
        "direction_validation": lattice.get("direction_validation"),
        "outline_alignment": lattice.get("outline_alignment"),
        "topology": lattice.get("topology"),
        "optical_validation": optical_validation,
        "inspection_regions": ["top-left", "top-right", "bottom-left", "bottom-right", "center"],
        "source_note": "原始显微图只读；此文件记录候选叠加的模型与分区误差，不改写 SBD。",
    }, ensure_ascii=False, indent=2), encoding="utf-8")

    image = np.asarray(preview_image, dtype=np.uint8)
    if image.ndim != 2:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    base = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    detected_indices = np.flatnonzero(detected)
    if len(detected_indices) > 100000:
        detected_indices = detected_indices[np.linspace(0, len(detected_indices) - 1, 100000).astype(np.int64)]
    size = np.asarray(spot_size_world, dtype=float)
    offsets = np.array([[-size[0] / 2, -size[1] / 2], [size[0] / 2, -size[1] / 2],
                        [size[0] / 2, size[1] / 2], [-size[0] / 2, size[1] / 2]], dtype=float)
    corners = np.stack([evaluate_coordinate_model(coordinate_model, np.asarray(world) + offset)
                        for offset in offsets], axis=1) * float(scale)
    centres = np.asarray(points, dtype=float) * float(scale)
    valid_centres = np.isfinite(centres).all(axis=1)
    if valid_centres.any():
        x_min, y_min = centres[valid_centres].min(axis=0)
        x_max, y_max = centres[valid_centres].max(axis=0)
    else:
        x_min, y_min, x_max, y_max = 0.0, 0.0, float(image.shape[1]), float(image.shape[0])
    width = max(1.0, x_max - x_min)
    height = max(1.0, y_max - y_min)
    regions = [
        ("top-left", x_min, y_min, x_min + width * .28, y_min + height * .26),
        ("top-right", x_min + width * .72, y_min, x_max, y_min + height * .26),
        ("bottom-left", x_min, y_min + height * .74, x_min + width * .28, y_max),
        ("bottom-right", x_min + width * .72, y_min + height * .74, x_max, y_max),
        ("center", x_min + width * .36, y_min + height * .37, x_min + width * .64, y_min + height * .63),
    ]
    tiles: list[np.ndarray] = []
    labels: list[str] = []
    for name, left, top, right, bottom in regions:
        margin = max(12.0, min(right - left, bottom - top) * .08)
        left_i = max(0, int(np.floor(left - margin)))
        top_i = max(0, int(np.floor(top - margin)))
        right_i = min(base.shape[1], int(np.ceil(right + margin)))
        bottom_i = min(base.shape[0], int(np.ceil(bottom + margin)))
        crop = base[top_i:bottom_i, left_i:right_i].copy()
        if crop.size == 0:
            continue
        selected = detected_indices[(centres[detected_indices, 0] >= left_i) &
                                    (centres[detected_indices, 0] <= right_i) &
                                    (centres[detected_indices, 1] >= top_i) &
                                    (centres[detected_indices, 1] <= bottom_i)]
        for index in selected:
            if index >= len(corners) or not np.isfinite(corners[index]).all():
                continue
            polygon = np.round(corners[index] - [left_i, top_i]).astype(np.int32)
            cv2.polylines(crop, [polygon], True, (70, 220, 155), 1, cv2.LINE_AA)
        cv2.putText(crop, name, (10, 22), cv2.FONT_HERSHEY_SIMPLEX, .65, (70, 240, 170), 2, cv2.LINE_AA)
        tiles.append(crop)
        labels.append(name)
    if tiles:
        tile_width, tile_height = 560, 330
        montage = np.zeros((tile_height * 2, tile_width * 3, 3), dtype=np.uint8)
        for index, tile in enumerate(tiles):
            row, column = divmod(index, 3)
            resized = cv2.resize(tile, (tile_width, tile_height), interpolation=cv2.INTER_AREA)
            montage[row * tile_height:(row + 1) * tile_height,
                    column * tile_width:(column + 1) * tile_width] = resized
        montage_path = artifact_dir / "lattice_fixed_regions.jpg"
        Image.fromarray(cv2.cvtColor(montage, cv2.COLOR_BGR2RGB)).save(montage_path, quality=90, optimize=True)
        return [str(validation_path.relative_to(project_dir)), str(montage_path.relative_to(project_dir))]
    return [str(validation_path.relative_to(project_dir))]


def _unavailable(reason: str) -> dict[str, Any]:
    return {"available": False, "status": "unavailable", "reason": reason, "mapped_spot_count": 0,
            "detected_pit_count": 0, "candidate_count": 0}


def build_spatial_mapping(project_dir: Path, pre: Path, after: Path, maldi_path: Path | None,
                          board_candidates: list[Path], heatmaps: list[Path],
                          after_to_pre: list[list[float]],
                          progress: Callable[[str], None] | None = None) -> tuple[dict[str, Any], list[str] | None]:
    """Build and persist the SBD → board → heat-map → microscopy integration."""
    if maldi_path is None:
        return _unavailable("未找到 MALDI-数据/*.sbd"), None
    if not heatmaps:
        return _unavailable("没有可用的 PNG 热图"), None
    embedded_matrix: np.ndarray | None = None
    if not board_candidates:
        try:
            embedded = _extract_embedded_board(maldi_path, project_dir / "cache")
        except Exception as error:
            return _unavailable(f"读取 SBD 内嵌板图失败：{error}"), None
        if embedded is None:
            return _unavailable("SBD 中没有内嵌板图，也没有提供 TIFF/TIF 板图"), None
        board_candidates, embedded_matrix = [embedded[0]], embedded[1]

    try:
        import h5py  # type: ignore  # noqa: F401
        initial_board_dimensions = dimensions(board_candidates[0])
        sbd = _read_sbd(maldi_path, initial_board_dimensions)
        reference_name = Path((sbd.get("reference_path") or "").replace("\\", "/")).name
        board = next((item for item in board_candidates if item.name.lower() == reference_name.lower()), None)
        if board is None:
            board = next((item for item in board_candidates if "multires" in item.stem.lower()), board_candidates[0])
        board_dimensions = dimensions(board)
        # Re-read if the selected board differs from the first candidate used
        # for the embedded-matrix fallback.
        if board_dimensions != initial_board_dimensions:
            sbd = _read_sbd(maldi_path, board_dimensions)
        if embedded_matrix is not None:
            sbd["world_to_board"] = embedded_matrix
            sbd["world_to_board_source"] = "World2Px (SBD embedded image)"
    except Exception as error:
        return _unavailable(f"读取 SBD/板图失败：{error}"), None

    world_to_board = np.asarray(sbd["world_to_board"], dtype=float)
    original = sbd["original"]
    world = sbd["world"]
    raster = sbd["raster"]
    best: dict[str, Any] | None = None
    attempts: list[dict[str, Any]] = []
    for heatmap in heatmaps:
        try:
            if progress:
                progress(f"验证板图与热图对应关系：{heatmap.name}")
            board_heat = sift_registration(board, heatmap)
            world_to_heat = np.asarray(board_heat["matrix"], dtype=float) @ world_to_board
            heat_points = transform_points(world_to_heat, world)
            consistency = _affine_consistency(original, heat_points, raster)
            attempt = {"path": str(heatmap.resolve()), "filename": heatmap.name,
                       "board_to_heat": board_heat, "consistency": consistency}
            attempts.append(attempt)
            score = consistency["global"]["p95_px"]
            if best is None or score < best["consistency"]["global"]["p95_px"]:
                best = attempt
        except Exception as error:
            attempts.append({"path": str(heatmap.resolve()), "filename": heatmap.name, "error": str(error)})
    if best is None:
        return _unavailable("板图→热图没有通过 SBD OriginalCoordinates 一致性验证"), None

    heatmap = Path(best["path"])
    board_heat = best["board_to_heat"]
    world_to_heat = np.asarray(board_heat["matrix"], dtype=float) @ world_to_board
    if progress:
        progress("计算热图到采集前/采集后显微图变换")
    heat_to_pre = marker_registration(heatmap, pre, "heatmap_to_pre")
    # Keep an independent heatmap→after fit as a diagnostic, but do not use
    # it as a second competing coordinate chain.  The viewer's public frame
    # is pre-image pixels and the after layer is rendered through the single
    # after→pre registration.  Deriving heatmap→after through that same
    # relation makes every SBD point close exactly:
    #
    #   world → heat → pre
    #                  ↘ after → pre
    #
    # This avoids the large drift that appears when two noisy projective fits
    # are composed independently over a 74k-pixel-wide scan.
    heat_to_after_independent = marker_registration(heatmap, after, "heatmap_to_after")
    after_to_pre_matrix = np.asarray(after_to_pre, dtype=float)
    after_to_pre_inverse = np.linalg.inv(after_to_pre_matrix)
    base_heat_to_after = after_to_pre_inverse @ np.asarray(heat_to_pre.matrix, dtype=float)
    base_heat_to_after /= base_heat_to_after[2, 2]
    base_world_to_after = base_heat_to_after @ world_to_heat
    base_world_to_after /= base_world_to_after[2, 2]
    base_after_points = transform_points(base_world_to_after, world)
    primary_raster_hint = int(np.bincount(raster.astype(np.int64)).argmax()) if raster.size else 0
    typical_size, _, expected_pitch = _spot_geometry(sbd["spot_sizes"], base_world_to_after)
    if progress:
        progress("从全幅清晰弹坑恢复行列、方向和稀疏采集轮廓")
    prepared_response = _prepare_burn_pit_response(after, expected_pitch)
    lattice = fit_optical_lattice(
        np.asarray(prepared_response["image"], dtype=np.uint8), float(prepared_response["scale"]), expected_pitch,
        original, raster, world, base_world_to_after, primary_raster_hint, typical_size,
    )
    if lattice is None:
        # Keep the previous seed-phase result as a clearly marked compatibility
        # candidate for projects whose image has no recoverable connected grid.
        # It is never presented as full-width optical calibration.
        lattice = _estimate_lattice_phase(
            after, original, raster, base_after_points, sbd["spot_sizes"], base_world_to_after,
            primary_raster_hint, world,
        )
    else:
        lattice["response_bundle"] = prepared_response
        model = lattice.get("coordinate_model")
        if isinstance(model, dict):
            degree = int(model.get("degree", 1))
            model["calibration_version"] = f"sbd-optical-lattice-v2-degree{degree}"
            model["calibration_status"] = "calibrated_candidate"
    lattice_correction = np.asarray(lattice["matrix"], dtype=float)
    heat_to_after_matrix = lattice_correction @ base_heat_to_after
    heat_to_after_matrix /= heat_to_after_matrix[2, 2]
    world_to_after = lattice_correction @ base_world_to_after
    world_to_after /= world_to_after[2, 2]
    # Re-derive the common pre-image coordinates through the single
    # after→pre relation.  This keeps the browser boxes and registered after
    # tiles in exactly the same coordinate frame after the optical phase
    # refinement.
    world_to_pre = after_to_pre_matrix @ world_to_after
    world_to_pre /= world_to_pre[2, 2]
    heat_to_pre_matrix = after_to_pre_matrix @ heat_to_after_matrix
    heat_to_pre_matrix /= heat_to_pre_matrix[2, 2]
    pre_dimensions = dimensions(pre)
    after_dimensions = dimensions(after)
    coordinate_model = lattice.get("coordinate_model") if isinstance(lattice.get("coordinate_model"), dict) else None
    if coordinate_model is not None:
        after_points = np.asarray(lattice.get("coordinate_model_points"), dtype=float)
        if after_points.shape != (len(world), 2):
            after_points = evaluate_coordinate_model(coordinate_model, world, enforce_domain=True)
    else:
        after_points = transform_points(world_to_after, world)
    pre_points = transform_points(world_to_pre, world)
    if coordinate_model is not None:
        pre_points = transform_points(after_to_pre_matrix, after_points)
    coordinate_matrices = {
        "world_to_board": world_to_board,
        "board_to_heat": np.asarray(board_heat["matrix"], dtype=float),
        "world_to_heat": world_to_heat,
        "heat_to_pre": heat_to_pre_matrix,
        "heat_to_after": heat_to_after_matrix,
        "world_to_pre": world_to_pre,
        "world_to_after": world_to_after,
        "after_to_pre": after_to_pre_matrix,
    }
    coordinate_validation = _coordinate_chain_validation(
        world, raster, coordinate_matrices,
        {"board": board_dimensions, "heat": dimensions(heatmap), "pre": pre_dimensions, "after": after_dimensions},
        coordinate_model=coordinate_model,
    )
    mapped = np.isfinite(after_points).all(axis=1) & \
        (after_points[:, 0] >= 0) & (after_points[:, 1] >= 0) & \
        (after_points[:, 0] < after_dimensions[0]) & (after_points[:, 1] < after_dimensions[1]) & \
        np.isfinite(pre_points).all(axis=1) & (pre_points[:, 0] >= 0) & (pre_points[:, 1] >= 0) & \
        (pre_points[:, 0] < pre_dimensions[0]) & (pre_points[:, 1] < pre_dimensions[1])

    if progress:
        progress("用采集后显微图确认灼烧坑候选")
    finite_primary_world = (raster == primary_raster_hint) & np.isfinite(world).all(axis=1)
    reference_world = np.mean(world[finite_primary_world], axis=0) if finite_primary_world.any() else np.mean(world, axis=0)
    detection_matrix = _local_model_matrix(coordinate_model, reference_world, typical_size, world_to_after)
    detection = _detect_burn_pits(
        after, after_points, raster, sbd["spot_sizes"], detection_matrix,
        primary_raster=primary_raster_hint, prepared_response=lattice.get("response_bundle"),
    )
    detected = detection["detected"] & mapped
    primary_raster = int(detection.get("primary_raster", 0))
    refined_after = detection["refined_after"]
    refined_pre = pre_points.copy()
    refined_indices = np.flatnonzero(detected)
    if refined_indices.size:
        refined_pre[refined_indices] = transform_points(after_to_pre_matrix, refined_after[refined_indices])
    detected_count = int(detected.sum())
    cache_path = project_dir / "sbd-spots.npz"
    cache_arrays: dict[str, np.ndarray] = {
        "spot_id": sbd["spot_id"],
        "raster": raster.astype(np.int16),
        "world_x": world[:, 0].astype(np.float32),
        "world_y": world[:, 1].astype(np.float32),
        "original_x": sbd["original"][:, 0].astype(np.float32),
        "original_y": sbd["original"][:, 1].astype(np.float32),
        # Keep the public SBD positions on the calibrated coordinate grid.
        # The bounded local-response maximum is stored separately for visual
        # confirmation and diagnostics; it must not replace the SBD identity.
        "pre_x": pre_points[:, 0].astype(np.float32),
        "pre_y": pre_points[:, 1].astype(np.float32),
        "after_x": after_points[:, 0].astype(np.float32),
        "after_y": after_points[:, 1].astype(np.float32),
        "grid_pre_x": pre_points[:, 0].astype(np.float32),
        "grid_pre_y": pre_points[:, 1].astype(np.float32),
        "grid_after_x": after_points[:, 0].astype(np.float32),
        "grid_after_y": after_points[:, 1].astype(np.float32),
        "response_pre_x": refined_pre[:, 0].astype(np.float32),
        "response_pre_y": refined_pre[:, 1].astype(np.float32),
        "response_after_x": refined_after[:, 0].astype(np.float32),
        "response_after_y": refined_after[:, 1].astype(np.float32),
        "mapped": mapped.astype(np.uint8),
        "detected": detected.astype(np.uint8),
        "pit_score": np.nan_to_num(detection["scores"], nan=-1e9).astype(np.float32),
        "pit_offset_px": np.nan_to_num(detection["offset_distance"], nan=-1.0).astype(np.float32),
    }
    field_specs: list[dict[str, Any]] = []
    for index, field in enumerate(sbd["values"]):
        cache_arrays[f"value_{index}"] = field["array"].astype(np.float32)
        finite = field["array"][np.isfinite(field["array"])]
        field_specs.append({"key": field["key"], "label": field["label"], "index": index,
                            "count": int(finite.size), "min": float(finite.min()) if finite.size else None,
                            "max": float(finite.max()) if finite.size else None,
                            "mean": float(finite.mean()) if finite.size else None})
    project_dir.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache_path, **cache_arrays)
    # The validation artifact must show the same tiled SBD grid as the browser.
    # Response maxima remain diagnostic data and must not move the 20 μm footprints.
    pit_artifact = _write_pit_overlay(
        project_dir, after, after_points, detected, lattice.get("spot_vectors_after_px") or
        detection.get("spot_vectors_after_px"), world, coordinate_model, typical_size,
    )
    lattice_artifacts: list[str] = [pit_artifact]
    if coordinate_model is not None:
        lattice_artifacts.extend(_write_lattice_validation_artifacts(
            project_dir, np.asarray(lattice["response_bundle"]["image"], dtype=np.uint8),
            float(lattice["response_bundle"]["scale"]), after_points, detected, world,
            coordinate_model, typical_size, lattice,
        ))

    pit_detection_metrics = {key: value for key, value in detection.items()
                             if key not in {"detected", "scores", "offsets", "offset_distance", "refined_after"}}
    spot_size_world = np.asarray(detection.get("spot_size_world", typical_size), dtype=float)
    if spot_size_world.shape == (2,) and np.isfinite(spot_size_world).all() and (spot_size_world > 0).all():
        pre_linear = np.asarray(world_to_pre, dtype=float)[:2, :2]
        pit_detection_metrics["spot_size_pre_px"] = [
            float(np.linalg.norm(pre_linear @ np.array([spot_size_world[0], 0.0]))),
            float(np.linalg.norm(pre_linear @ np.array([0.0, spot_size_world[1]]))),
        ]
        pit_detection_metrics["spot_vectors_pre_px"] = [
            (pre_linear @ np.array([spot_size_world[0], 0.0])).astype(float).tolist(),
            (pre_linear @ np.array([0.0, spot_size_world[1]])).astype(float).tolist(),
        ]
    if coordinate_model is not None:
        after_vectors = np.asarray(lattice.get("spot_vectors_after_px", []), dtype=float)
        if after_vectors.shape == (2, 2):
            model_centre = evaluate_coordinate_model(coordinate_model, reference_world.reshape(1, 2))[0]
            pre_centre = transform_points(after_to_pre_matrix, model_centre.reshape(1, 2))[0]
            pre_vectors = np.array([
                transform_points(after_to_pre_matrix, (model_centre + vector).reshape(1, 2))[0] - pre_centre
                for vector in after_vectors
            ], dtype=float)
            if np.isfinite(pre_vectors).all():
                pit_detection_metrics["spot_size_pre_px"] = [
                    float(np.linalg.norm(pre_vectors[0])), float(np.linalg.norm(pre_vectors[1]))
                ]
                pit_detection_metrics["spot_vectors_pre_px"] = pre_vectors.tolist()
                pit_detection_metrics["footprint_mode"] = "coordinate model corners (shared vertices)"
    elif lattice.get("display_mode") == "fixed_affine_lattice":
        after_vectors = np.asarray(detection.get("spot_vectors_after_px", []), dtype=float)
        primary_points = after_points[(raster == primary_raster) & np.isfinite(after_points).all(axis=1)]
        if after_vectors.shape == (2, 2) and len(primary_points):
            reference_after = np.median(primary_points, axis=0)
            reference_pre = transform_points(after_to_pre_matrix, reference_after[None, :])[0]
            pre_vectors = np.array([
                transform_points(after_to_pre_matrix, (reference_after + vector)[None, :])[0] - reference_pre
                for vector in after_vectors
            ], dtype=float)
            if np.isfinite(pre_vectors).all():
                pit_detection_metrics["spot_size_pre_px"] = [
                    float(np.linalg.norm(pre_vectors[0])), float(np.linalg.norm(pre_vectors[1]))
                ]
                pit_detection_metrics["spot_vectors_pre_px"] = pre_vectors.tolist()
                pit_detection_metrics["footprint_mode"] = "fixed affine lattice (legacy fallback)"
    mapping_metrics = {
        "board_heat": {key: value for key, value in board_heat.items() if key != "matrix"},
        "sbd_original_consistency": best["consistency"],
        "world_chain_pre_vs_after_px": coordinate_validation["world_chain_pre_vs_after_px"],
        "heat_to_pre_markers": heat_to_pre.metric,
        "heat_to_after_markers": {**heat_to_after_independent.metric,
                                   "matrix_source": "after_to_pre_inverse × heat_to_pre",
                                   "independent_fit_for_diagnostic_only": True},
        "lattice_matching": {key: value for key, value in lattice.items()
                              if key not in {"matrix", "response_bundle", "field", "scores", "baseline", "improvements",
                                             "coordinate_model_points"}},
        "pit_detection": pit_detection_metrics,
    }
    optical_validation = lattice.get("optical_validation") or {}
    direction_validation = lattice.get("direction_validation") or {}
    geometry_passed = bool(coordinate_model is not None and optical_validation.get("passed") and
                           not (optical_validation.get("geometry") or {}).get("folding_rejected") and
                           not (optical_validation.get("geometry") or {}).get("boundary_rejected"))
    identity_passed = bool(direction_validation.get("resolved", False) and
                           (lattice.get("outline_alignment") or {}).get("overlap_fraction", 0) >= .97 and
                           (lattice.get("topology") or {}).get("cycle_conflicts", 1) == 0)
    status = "calibrated" if best["consistency"]["global"]["p95_px"] <= 1.0 and \
        coordinate_validation["world_chain_pre_vs_after_px"]["p95_px"] <= 1.0 and geometry_passed and identity_passed else "warning"
    calibration_version = coordinate_model.get("calibration_version") if coordinate_model else "legacy-seed-candidate"
    quality = (f"全幅网格方向与几何验证通过；统一 coordinate_model degree {coordinate_model.get('degree')} 已启用"
               if status == "calibrated" and coordinate_model else
               "坐标链可回算，但全幅图像身份/几何验证未通过，当前结果需复核")
    mapping = {
        "available": True,
        "status": status,
        "quality": quality,
        "calibration_version": calibration_version,
        "coordinate_model": coordinate_model,
        "direction_validation": direction_validation,
        "geometry_validation": optical_validation,
        "primary_raster": primary_raster,
        "coordinate_convention": coordinate_validation["coordinate_convention"],
        "coordinate_validation": coordinate_validation,
        "raster_transforms": sbd.get("raster_transforms", {}),
        "raster_pixel_to_world": sbd.get("raster_pixel_to_world", {}),
        "board": {"path": str(board.resolve()), "filename": board.name, "width": board_dimensions[0], "height": board_dimensions[1],
                  "origin": "sbd_embedded" if embedded_matrix is not None else "provided"},
        "heatmap": {"path": str(heatmap.resolve()), "filename": heatmap.name, "mz": extract_heat_text(heatmap)},
        "optical_reference": {"name": sbd.get("optical_name"), "reference_path": sbd.get("reference_path"),
                              "matrix_source": sbd.get("world_to_board_source"),
                              "reference_width": sbd.get("reference_width"), "reference_height": sbd.get("reference_height"),
                              "embedded_size": sbd.get("embedded_size")},
        "matrix_roles": {"world_to_after": "legacy affine approximation; use coordinate_model for current coordinates",
                         "world_to_pre": "legacy affine approximation; use coordinate_model then after_to_pre",
                         "heat_to_after": "legacy affine approximation for old clients"},
        "matrices": {"world_to_board": world_to_board.tolist(), "board_to_heat": board_heat["matrix"],
                     "world_to_heat": world_to_heat.tolist(),
                     "heat_to_pre": heat_to_pre_matrix.tolist(), "heat_to_after": heat_to_after_matrix.tolist(),
                     "world_to_pre": world_to_pre.tolist(), "world_to_after": world_to_after.tolist(),
                     "after_to_pre": after_to_pre_matrix.tolist()},
        "metrics": mapping_metrics,
        "spot_cache": cache_path.name,
        "spot_count": int(len(world)),
        "mapped_spot_count": int(mapped.sum()),
        "candidate_count": int(detection["candidate_count"]),
        "detected_pit_count": detected_count,
        "value_fields": field_specs,
        "heatmap_candidates": [{"filename": item["filename"], "path": item["path"],
                                 "sbd_original_consistency": item.get("consistency", {}).get("global"),
                                 "error": item.get("error")} for item in attempts],
    }
    return mapping, lattice_artifacts
