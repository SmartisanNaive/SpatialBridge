from __future__ import annotations

import hashlib
import json
import math
import re
import subprocess
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
from PIL import Image

from .models import Registration, Source, serialize
from .tiles import build_tile_pyramid

Image.MAX_IMAGE_PIXELS = None
HEAT_PATTERN = re.compile(r"([0-9]+(?:\.[0-9]+)?)")


class RegistrationError(RuntimeError):
    pass


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def dimensions(path: Path) -> tuple[int, int]:
    with Image.open(path) as image:
        return image.size


def make_browser_preview(source: Path, cache_dir: Path) -> tuple[str | None, float | None]:
    """Build a durable low-zoom source pyramid base without modifying the source image.

    ``sips`` is fast on macOS, but the project also runs on Linux and CI. Keep
    a Pillow fallback so low-zoom browsing does not decode the huge original
    PNG for every tile request.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    destination = cache_dir / f"{file_hash(source)[:16]}-max4096.png"
    if not destination.exists():
        try:
            subprocess.run(["sips", "-Z", "4096", str(source), "--out", str(destination)], check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        except (OSError, subprocess.CalledProcessError):
            try:
                with Image.open(source) as image:
                    downscaled(image, 4096, "RGBA")[0].save(destination, "PNG", optimize=True)
            except (OSError, ValueError):
                return None, None
    try:
        original_width, _ = dimensions(source)
        preview_width, _ = dimensions(destination)
        return str(destination), preview_width / original_width
    except OSError:
        return None, None


def find_inputs(source_dir: Path, input_manifest: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    """Locate registration inputs.

    Directory imports retain the original convention. Upload imports carry a
    server-created manifest so arbitrary client filenames never need to be
    renamed and cannot affect how a file is located.
    """
    if input_manifest:
        by_role: dict[str, list[Path]] = {}
        for item in input_manifest:
            path = Path(str(item.get("path", ""))).expanduser()
            if not path.is_absolute():
                path = source_dir / path
            if not path.is_file():
                raise RegistrationError(f"Uploaded source file is missing: {item.get('filename', path.name)}")
            by_role.setdefault(str(item.get("role", "")), []).append(path)
        pre_files, after_files = by_role.get("pre", []), by_role.get("after", [])
        if len(pre_files) != 1 or len(after_files) != 1:
            raise RegistrationError("Uploaded inputs must contain exactly one pre and one after PNG")
        return {
            "pre": pre_files[0],
            "after": after_files[0],
            "maldi_data": by_role.get("sbd", [None])[0],
            "board_files": by_role.get("board", []),
            "heatmaps": by_role.get("heatmap", []),
        }
    micro = source_dir / "MALDI-显微图"
    pre = micro / "pre-madle.png"
    after = micro / "after-madle.png"
    data_dir = source_dir / "MALDI-数据"
    maldi_files = sorted(data_dir.glob("*.sbd"))
    board_dir = source_dir / "MALDI-板图"
    board_files = sorted([*board_dir.glob("*.tif"), *board_dir.glob("*.tiff")])
    heatmap_dir = source_dir / "MALDI-hotmap"
    heatmaps = sorted(heatmap_dir.glob("*.png"))
    missing = [str(p) for p in [pre, after] if not p.is_file()]
    if missing:
        raise RegistrationError("Expected pre-madle.png and after-madle.png: " + ", ".join(missing))
    # Board scans and heat maps are optional. When present, the integration
    # stage uses them to validate the SBD-to-microscopy coordinate chain;
    # missing optional inputs must not prevent the two-image viewer from
    # opening.
    return {"pre": pre, "after": after, "maldi_data": maldi_files[0] if maldi_files else None,
            "board_files": board_files, "heatmaps": heatmaps}


def _attribute_text(attributes: Any, key: str) -> str | None:
    value = attributes.get(key)
    if value is None:
        return None
    if isinstance(value, np.ndarray):
        if value.size == 0:
            return None
        value = value.reshape(-1)[0]
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def inspect_maldi_data(path: Path | None) -> dict[str, Any]:
    """Read only the small SBD index/normalization arrays used by the UI.

    The raw spectra blobs are intentionally not loaded. Manual annotations
    remain user-entered and are stored separately from the read-only SBD.
    """
    if path is None:
        return {"available": False, "reason": "未找到 MALDI-数据/*.sbd"}
    result: dict[str, Any] = {
        "available": True,
        "path": str(path.resolve()),
        "filename": path.name,
        "format": "sbd",
        "spot_count": None,
        "raster_count": None,
        "rasters": [],
        "value_fields": [],
    }
    try:
        import h5py  # type: ignore

        with h5py.File(path, "r") as handle:
            root_spots = _attribute_text(handle.attrs, "nSpots")
            coordinates = handle.get("Registrations/0/OriginalCoordinates")
            raster_indices = handle.get("MeasurementRasterIndices")
            spot_count = int(root_spots) if root_spots and root_spots.isdigit() else None
            if coordinates is not None and raster_indices is not None:
                original = np.asarray(coordinates[...], dtype=np.int64)
                raster = np.asarray(raster_indices[...], dtype=np.int32).reshape(-1)
                spot_count = int(original.shape[1])
                raster_summaries = []
                for raster_id in np.unique(raster):
                    indices = np.flatnonzero(raster == raster_id)
                    if indices.size == 0:
                        continue
                    raster_summaries.append({
                        "id": int(raster_id),
                        "spot_count": int(indices.size),
                        "x_min": int(original[0, indices].min()),
                        "x_max": int(original[0, indices].max()),
                        "y_min": int(original[1, indices].min()),
                        "y_max": int(original[1, indices].max()),
                    })
                result["rasters"] = raster_summaries
                result["raster_count"] = len(raster_summaries)

            result["spot_count"] = spot_count
            normalizations = handle.get("SpectraGroup/Normalizations")
            if normalizations is not None:
                for normalization_id, group in normalizations.items():
                    values = group.get("Values")
                    if values is None:
                        continue
                    array = np.asarray(values[...], dtype=np.float64)
                    finite = array[np.isfinite(array)]
                    if finite.size == 0:
                        continue
                    result["value_fields"].append({
                        "key": str(normalization_id),
                        "label": _attribute_text(group.attrs, "name") or str(normalization_id),
                        "count": int(finite.size),
                        "min": float(finite.min()),
                        "max": float(finite.max()),
                        "mean": float(finite.mean()),
                    })
    except Exception as error:
        result["available"] = False
        result["reason"] = f"读取 SBD 索引失败：{error}"
    return result


@lru_cache(maxsize=6)
def _load_gray_cached(path: str, modified_ns: int, size: int, max_width: int) -> tuple[np.ndarray, float]:
    with Image.open(path) as image:
        image = image.convert("L")
        scale = min(1.0, max_width / image.width)
        if scale < 1:
            image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
        pixels = np.asarray(image)
    pixels.flags.writeable = False
    return pixels, scale


def load_gray(path: Path, max_width: int = 8000) -> tuple[np.ndarray, float]:
    """Return a read-only downscaled grayscale copy of an image.

    One import decodes each microscopy PNG at the same width several times;
    decoding a multi-gigapixel file dominates the run, so identical requests
    are served from a small cache keyed by the file's identity.
    """
    stat = path.stat()
    return _load_gray_cached(str(path), stat.st_mtime_ns, stat.st_size, int(max_width))


def downscaled(image: Image.Image, max_width: int, mode: str) -> tuple[Image.Image, float]:
    """Resize to at most ``max_width`` and convert to ``mode``.

    Grayscale sources are resized before conversion: the pixels are the same
    as converting first, without holding a full-resolution colour copy.
    """
    scale = min(1.0, max_width / image.width)
    size = (round(image.width * scale), round(image.height * scale))
    if image.mode == "L":
        return (image.resize(size, Image.Resampling.LANCZOS) if scale < 1 else image).convert(mode), scale
    converted = image.convert(mode)
    return (converted.resize(size, Image.Resampling.LANCZOS) if scale < 1 else converted), scale


def order_quad(points: np.ndarray) -> np.ndarray:
    centre = points.mean(axis=0)
    ordered = points[np.argsort(np.arctan2(points[:, 1] - centre[1], points[:, 0] - centre[0]))]
    # Make the cyclic ordering deterministic.  The first vertex is the one
    # nearest the top-left of the marker; the winding is kept unchanged.
    start = int(np.argmin(ordered[:, 0] + ordered[:, 1]))
    return np.roll(ordered, -start, axis=0)


def detect_markers(image: np.ndarray) -> list[dict[str, Any]]:
    """Detect a square hole enclosed by a round outer contour in either polarity."""
    blurred = cv2.GaussianBlur(image, (5, 5), 0)
    candidates: list[dict[str, Any]] = []
    for threshold in range(35, 221, 15):
        for polarity in (cv2.THRESH_BINARY, cv2.THRESH_BINARY_INV):
            _, binary = cv2.threshold(blurred, threshold, 255, polarity)
            contours, hierarchy = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)
            if hierarchy is None:
                continue
            for index, contour in enumerate(contours):
                area = cv2.contourArea(contour)
                x, y, width, height = cv2.boundingRect(contour)
                parent_index = hierarchy[0, index, 3]
                if parent_index < 0 or area < 200 or not 0.65 < width / height < 1.4:
                    continue
                quad = cv2.approxPolyDP(contour, 0.035 * cv2.arcLength(contour, True), True)
                if len(quad) != 4 or not cv2.isContourConvex(quad):
                    continue
                outer = contours[parent_index]
                outer_area = cv2.contourArea(outer)
                perimeter = cv2.arcLength(outer, True)
                circularity = 4 * math.pi * outer_area / max(perimeter * perimeter, 1)
                area_ratio = outer_area / area
                if not (3 < area_ratio < 12 and circularity > 0.65):
                    continue
                moments = cv2.moments(contour)
                if not moments["m00"]:
                    continue
                centre = np.array([moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]])
                candidates.append({"score": circularity, "centre": centre, "corners": quad.reshape(4, 2).astype(float),
                                   "area_ratio": float(area_ratio), "threshold": threshold})
    candidates.sort(key=lambda item: item["score"], reverse=True)
    unique: list[dict[str, Any]] = []
    for item in candidates:
        if all(np.linalg.norm(item["centre"] - seen["centre"]) > 50 for seen in unique):
            unique.append(item)
    return unique


def select_two_markers(markers: list[dict[str, Any]], name: str) -> list[dict[str, Any]]:
    if len(markers) < 2:
        raise RegistrationError(f"{name}: fewer than two complete circle-square markers were detected")
    # The microscopy and heat-map image each contain their two widest-separated valid markers.
    best = max(((a, b) for i, a in enumerate(markers) for b in markers[i + 1:]),
               key=lambda pair: np.linalg.norm(pair[0]["centre"] - pair[1]["centre"]))
    return sorted(best, key=lambda m: m["centre"][0])


def similarity(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    if source.shape != target.shape or source.shape[0] < 2:
        raise RegistrationError("Similarity fit needs at least two matching landmarks")
    source_c, target_c = source.mean(axis=0), target.mean(axis=0)
    x, y = source - source_c, target - target_c
    denom = float((x * x).sum())
    if denom < 1e-8:
        raise RegistrationError("Marker centres are degenerate")
    a = float((x * y).sum() / denom)
    b = float((x[:, 0] * y[:, 1] - x[:, 1] * y[:, 0]).sum() / denom)
    linear = np.array([[a, -b], [b, a]])
    translation = target_c - linear @ source_c
    return np.array([[linear[0, 0], linear[0, 1], translation[0]],
                     [linear[1, 0], linear[1, 1], translation[1]], [0.0, 0.0, 1.0]])


def transform_points(matrix: np.ndarray, points: np.ndarray) -> np.ndarray:
    """Apply an ``xy`` homogeneous transform to an ``N x 2`` point array.

    The image arrays used by OpenCV are indexed as ``image[y, x]`` while all
    persisted SpatialBridge points are ``[x, y]``.  Keeping this conversion in
    one small function mirrors IMS MicroLink's explicit ``xy``/``yx`` matrix
    variants and prevents accidental transposition when composing the SBD
    coordinate chain.
    """
    array = np.asarray(matrix, dtype=float)
    if array.shape != (3, 3) or not np.isfinite(array).all():
        raise RegistrationError("Coordinate transform must be a finite 3x3 matrix")
    values = np.asarray(points, dtype=float)
    if values.ndim != 2 or values.shape[1] != 2:
        raise RegistrationError("Points must have shape N x 2 in xy order")
    if values.shape[0] == 0:
        return values.astype(float, copy=True)
    homogeneous = np.c_[values, np.ones(len(values))]
    output = homogeneous @ array.T
    denominator = output[:, 2:3]
    with np.errstate(divide="ignore", invalid="ignore"):
        transformed = output[:, :2] / denominator
    transformed[np.abs(denominator[:, 0]) < 1e-12] = np.nan
    return transformed


def scaled_matrix(matrix: np.ndarray, source_scale: float, target_scale: float) -> np.ndarray:
    return np.diag([1 / target_scale, 1 / target_scale, 1]) @ matrix @ np.diag([source_scale, source_scale, 1])


def marker_registration(source: Path, target: Path, label: str, *,
                        source_marker_pair: list[dict[str, Any]] | None = None,
                        allow_reflection: bool = False) -> Registration:
    source_image, source_scale = load_gray(source)
    target_image, target_scale = load_gray(target)
    source_markers = (sorted(source_marker_pair, key=lambda marker: marker["centre"][0])
                      if source_marker_pair is not None
                      else select_two_markers(detect_markers(source_image), source.name))
    target_markers = select_two_markers(detect_markers(target_image), target.name)
    source_corners = [order_quad(np.asarray(marker["corners"], dtype=float)) for marker in source_markers]

    # A transform fitted only to the two marker centres is under-constrained:
    # it cannot see shear, keystone distortion, or the small scale difference
    # between the two ends of a very wide microscopy scan.  Fit the eight
    # square-hole corners instead.  The detector does not guarantee the first
    # vertex or winding direction, so enumerate the finite cyclic/reversed
    # correspondences and retain the candidate with the smallest reprojection
    # error.  This follows SpaceM's grid/landmark idea while keeping the
    # transform explicit in xy homogeneous coordinates as in IMS MicroLink.
    source_points = np.concatenate(source_corners, axis=0).astype(np.float32)
    source_centres = np.array([marker["centre"] for marker in source_markers], dtype=float)
    fit_candidates: list[tuple[float, float, float, int, np.ndarray, np.ndarray, np.ndarray,
                              list[dict[str, Any]]]] = []
    for pairing_index, pairing in enumerate((target_markers, list(reversed(target_markers)))):
        target_corners = [order_quad(np.asarray(marker["corners"], dtype=float)) for marker in pairing]
        centre_target = np.array([marker["centre"] for marker in pairing], dtype=float)
        for reverse in (False, True):
            variants = []
            for corners in target_corners:
                base = corners[::-1] if reverse else corners
                variants.append([np.roll(base, shift, axis=0) for shift in range(4)])
            for first_shift in range(4):
                for second_shift in range(4):
                    target_points = np.concatenate(
                        [variants[0][first_shift], variants[1][second_shift]], axis=0,
                    ).astype(np.float32)
                    candidate_matrix, _ = cv2.findHomography(source_points, target_points, 0)
                    if candidate_matrix is None or candidate_matrix.shape != (3, 3):
                        continue
                    candidate_matrix = np.asarray(candidate_matrix, dtype=float)
                    if not np.isfinite(candidate_matrix).all() or abs(candidate_matrix[2, 2]) < 1e-12:
                        continue
                    candidate_matrix /= candidate_matrix[2, 2]
                    predicted = transform_points(candidate_matrix, source_points.astype(float))
                    if not np.isfinite(predicted).all():
                        continue
                    errors = np.linalg.norm(predicted - target_points, axis=1)
                    transformed_centres = transform_points(candidate_matrix, source_centres)
                    centre_error = np.linalg.norm(transformed_centres - centre_target, axis=1)

                    # Reject a folded or mirrored solution.  A positive local
                    # Jacobian at both anchors keeps a left-to-right scan
                    # left-to-right even when a reversed corner permutation
                    # happens to have a lower raw reprojection error.
                    orientation_determinants = []
                    for centre in source_centres:
                        anchor = transform_points(candidate_matrix, centre[None, :])[0]
                        x_step = transform_points(candidate_matrix, (centre + [1.0, 0.0])[None, :])[0] - anchor
                        y_step = transform_points(candidate_matrix, (centre + [0.0, 1.0])[None, :])[0] - anchor
                        orientation_determinants.append(float(x_step[0] * y_step[1] - x_step[1] * y_step[0]))
                    if not (all(value > 0 for value in orientation_determinants) or
                            (allow_reflection and all(value < 0 for value in orientation_determinants))):
                        continue
                    fit_candidates.append((float(np.median(errors)), float(np.quantile(errors, .95)),
                                           float(np.mean(centre_error)), pairing_index,
                                           candidate_matrix, errors, centre_error, pairing))
    if not fit_candidates:
        raise RegistrationError(f"{label}: unable to fit a homography from marker square corners")
    # Prefer the physically expected left-to-left/right-to-right pairing when
    # it has a valid orientation-preserving solution.  Reversed pairing is a
    # fallback for an explicitly mirrored scan, rather than a result that can
    # win just because a reflected square permutation fits a few pixels better.
    direct_candidates = [item for item in fit_candidates if item[3] == 0]
    eligible = fit_candidates if allow_reflection else (direct_candidates or fit_candidates)
    _, _, _, _, matrix_small, residual, centre_errors, selected_pairing = min(
        eligible, key=lambda item: (item[0], item[1], item[2]),
    )
    matrix = scaled_matrix(matrix_small, source_scale, target_scale)
    source_w, source_h = dimensions(source)
    mapped = transform_points(matrix, np.array([[0, 0], [source_w, 0], [source_w, source_h], [0, source_h]], dtype=float))
    metric = {"marker_count": 2, "centre_rmse_px": float(np.sqrt(np.mean(centre_errors ** 2)) / target_scale),
              "corner_median_px": float(np.median(residual) / target_scale), "corner_p95_px": float(np.quantile(residual, .95) / target_scale),
              "threshold": "regional", "validation": "eight square-hole corners fitted and reprojection-checked",
              "fit_points": 8, "pairing": "left-to-left/right-to-right" if selected_pairing is target_markers else "left-to-right/right-to-left",
              "coordinate_order": "xy"}
    return Registration(label, matrix.tolist(), "passed", "two-marker homography", metric,
                        [float(mapped[:, 0].min()), float(mapped[:, 1].min()), float(mapped[:, 0].max()), float(mapped[:, 1].max())])


def sift_registration(source: Path, target: Path) -> dict[str, Any]:
    """Auxiliary board/heat proof, restricted to image texture rather than legends."""
    first, first_scale = load_gray(source, 5000)
    second, second_scale = load_gray(target, 5000)
    sift = cv2.SIFT_create(nfeatures=16000)
    keys_a, desc_a = sift.detectAndCompute(first, None)
    keys_b, desc_b = sift.detectAndCompute(second, None)
    if desc_a is None or desc_b is None:
        raise RegistrationError("No SIFT descriptors found for board auxiliary alignment")
    matches = cv2.BFMatcher().knnMatch(desc_a, desc_b, k=2)
    good = [m for m, n in matches if m.distance < .70 * n.distance]
    if len(good) < 12:
        raise RegistrationError("Too few independent board/heat texture matches")
    src = np.float32([keys_a[m.queryIdx].pt for m in good])
    dst = np.float32([keys_b[m.trainIdx].pt for m in good])
    homography, mask = cv2.findHomography(src, dst, cv2.RANSAC, 2.0)
    if homography is None or mask is None or int(mask.sum()) < 12:
        raise RegistrationError("Board/heat RANSAC did not find a stable transform")
    valid = mask.ravel().astype(bool)
    predicted = cv2.perspectiveTransform(src[:, None, :], homography)[:, 0, :]
    error = np.linalg.norm(predicted - dst, axis=1)[valid] / second_scale
    return {"matches": len(good), "inliers": int(valid.sum()), "inlier_ratio": float(valid.mean()),
            "median_reprojection_px": float(np.median(error)), "p95_reprojection_px": float(np.quantile(error, .95)),
            "matrix": scaled_matrix(homography, first_scale, second_scale).tolist()}


def extract_heat_text(path: Path) -> str | None:
    # Keep OCR optional. The file name and raw image remain the authoritative saved provenance.
    try:
        import pytesseract  # type: ignore
        with Image.open(path) as image:
            # The in-image m/z label is at the lower right, before the colour bar.
            crop = image.crop((int(image.width * .70), int(image.height * .90), image.width, image.height)).convert("L")
            crop = crop.resize((crop.width * 4, crop.height * 4), Image.Resampling.BICUBIC)
            result = pytesseract.image_to_string(crop, config="--psm 6")
            match = re.search(r"([0-9]{3}(?:\.?[0-9]{3,5}))\s*m/z", result.replace("\\", " "), flags=re.IGNORECASE)
            if not match:
                return None
            value = match.group(1)
            return value if "." in value else f"{value[:3]}.{value[3:]}"
    except Exception:
        return None


def heat_layout_check(paths: list[Path]) -> dict[str, Any]:
    if len(paths) < 2:
        return {"same_layout": True, "reason": "one heat-map"}
    arrays = []
    for path in paths:
        with Image.open(path) as image:
            arrays.append(np.asarray(image.convert("RGB").crop((0, 0, image.width, int(image.height * .4)))))
    base = arrays[0]
    comparisons = [float(np.mean(np.all(base == item, axis=2))) if item.shape == base.shape else 0.0 for item in arrays[1:]]
    return {"same_layout": all(value > .995 for value in comparisons), "top_optical_pixel_identity": comparisons,
            "reason": "upper optical background compared; colored signal, legend, and labels excluded"}


def write_validation_artifacts(project_dir: Path, pre: Path, after: Path,
                               after_matrix: list[list[float]]) -> list[str]:
    """Save compact, reproducible inspection overlays separate from the read-only sources."""
    artifact_dir = project_dir / "validation"
    artifact_dir.mkdir(parents=True, exist_ok=True)
    with Image.open(pre) as image:
        pre_image, pre_scale = downscaled(image, 1800, "L")
        preview_size = pre_image.size
        pre_preview = np.asarray(pre_image)

    def warped(path: Path, matrix: list[list[float]]) -> np.ndarray:
        with Image.open(path) as image:
            source, source_scale = downscaled(image, 1800, "RGBA")
            source_preview = np.asarray(source)
        preview_matrix = np.diag([pre_scale, pre_scale, 1]) @ np.asarray(matrix) @ np.diag([1 / source_scale, 1 / source_scale, 1])
        return cv2.warpPerspective(source_preview, preview_matrix, preview_size, flags=cv2.INTER_AREA,
                                   borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))

    overlay = warped(after, after_matrix)
    base = cv2.cvtColor(pre_preview, cv2.COLOR_GRAY2RGBA)
    alpha = overlay[:, :, 3:4].astype(float) / 255
    composite = (base * (1 - alpha * .45) + overlay * alpha * .45).astype(np.uint8)
    destination = artifact_dir / "pre_after_overlay.png"
    Image.fromarray(composite).save(destination)
    return [str(destination.relative_to(project_dir))]


def build_project(source_dir: Path, project_dir: Path, progress: Callable[[str], None] | None = None,
                  input_manifest: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    def update(stage: str) -> None:
        if progress:
            progress(stage)

    update("扫描来源文件")
    files = find_inputs(source_dir, input_manifest)
    project_dir.mkdir(parents=True, exist_ok=True)
    pre, after = files["pre"], files["after"]
    maldi_path = files.get("maldi_data")
    assert isinstance(pre, Path) and isinstance(after, Path)
    source_objects: list[Source] = []
    update("生成多级图像瓦片")
    for key, role, path in [("pre", "microscopy_pre", pre), ("after", "microscopy_after", after)]:
        width, height = dimensions(path)
        source_sha256 = file_hash(path)
        preview_path, preview_scale = make_browser_preview(path, project_dir / "cache")
        pyramid = build_tile_pyramid(
            path,
            project_dir / "pyramids" / f"{key}-{source_sha256[:16]}",
            source_sha256,
            progress=lambda completed, total, label=key: update(f"生成 {label} 高清瓦片（{completed}/{total}）"),
        )
        source_objects.append(Source(key, role, str(path.resolve()), width, height, source_sha256, path.name,
                                     preview_path=("project://" + Path(preview_path).resolve().relative_to(project_dir.resolve()).as_posix()) if preview_path else None,
                                     preview_scale=preview_scale,
                                     tile_pyramid_path="project://" + Path(pyramid["path"]).resolve().relative_to(project_dir.resolve()).as_posix(),
                                     tile_pyramid_max_level=int(pyramid["max_level"])))
    update("检测锚点并计算配准")
    pre_identity = Registration("pre", np.eye(3).tolist(), "passed", "reference identity", {"threshold": "regional"},
                                [0, 0, dimensions(pre)[0], dimensions(pre)[1]])
    after_to_pre = marker_registration(after, pre, "after")
    registrations = [pre_identity, after_to_pre]
    update("读取 MALDI 数据索引")
    maldi_data = inspect_maldi_data(maldi_path if isinstance(maldi_path, Path) else None)
    update("生成验证叠加图")
    artifacts = write_validation_artifacts(project_dir, pre, after, after_to_pre.matrix)
    update("建立 SBD 与显微图坐标对应关系")
    from .integration import build_spatial_mapping

    try:
        spatial_mapping, pit_artifact = build_spatial_mapping(
            project_dir, pre, after, maldi_path if isinstance(maldi_path, Path) else None,
            [item for item in files.get("board_files", []) if isinstance(item, Path)],
            [item for item in files.get("heatmaps", []) if isinstance(item, Path)],
            after_to_pre.matrix, progress=update,
        )
    except Exception as error:
        # Optional integration must not make the basic two-image viewer
        # unusable. Preserve the failure in the report for review.
        spatial_mapping, pit_artifact = {"available": False, "status": "unavailable",
                                         "reason": f"建立 SBD 坐标链失败：{error}",
                                         "mapped_spot_count": 0, "candidate_count": 0,
                                         "detected_pit_count": 0}, None
    if pit_artifact:
        if isinstance(pit_artifact, list):
            artifacts.extend(pit_artifact)
        else:
            artifacts.append(pit_artifact)
    if spatial_mapping.get("available"):
        primary_raster = int(spatial_mapping.get("primary_raster", 0))
        calibration_version = spatial_mapping.get("calibration_version", "旧版")
        if spatial_mapping.get("status") == "calibrated" and spatial_mapping.get("coordinate_model"):
            model = spatial_mapping["coordinate_model"]
            model_text = f"全幅光学网格已按 {model.get('model_type')} degree {model.get('degree')} 拟合，校准版本 {calibration_version}。"
        else:
            model_text = "矩阵坐标链可回算，但全幅图像身份/几何验证未通过，当前结果需复核。"
        limitations = [f"SBD raster {primary_raster} 的坐标链已通过板图→热图→显微图和 OriginalCoordinates 一致性验证。",
                       "其他 raster 若位于当前显微 PNG 覆盖范围外会保持未映射，不强行投影。",
                       model_text,
                       "灼烧坑检测先从全幅清晰方坑恢复相邻行列，再用 SpaceM 的尺度化局部响应确认节点；模糊区域保留网格候选，不逐点改写 20 μm 方框。",
                       "自动值来自所选 SBD normalization 字段；人工赋值单独保存，不会改写原始 SBD。"]
    else:
        limitations = ["当前没有建立 SBD→显微图坐标链，自动灼烧坑检测和自动取值不可用。",
                       "当前为区域级前后图像对齐，不承诺细胞尺度精度。",
                       "灼烧坑上的数值由用户人工录入，单独保存，不会改写原始 SBD。"]
    limitations.append("导入时读取 SBD 坐标和 normalization 数值，不加载完整原始光谱。")
    report = {"schema_version": 7, "common_coordinate_layer": "pre", "sources": [serialize(item) for item in source_objects],
              "registrations": [serialize(item) for item in registrations], "maldi_data": maldi_data,
              "spatial_mapping": spatial_mapping,
              "validation_artifacts": artifacts,
              "limitations": limitations}
    (project_dir / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False))
    return report
