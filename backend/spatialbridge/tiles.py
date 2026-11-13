from __future__ import annotations

import json
import math
import os
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from io import BytesIO
from pathlib import Path
from typing import Any, Callable

import cv2
import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None
TILE = 256
PYRAMID_SCHEMA_VERSION = 1
TILE_WRITERS = max(1, min(8, os.cpu_count() or 1))


def _level_dimensions(width: int, height: int, max_level: int, level: int) -> tuple[int, int]:
    """Return the image dimensions for an OpenSeadragon-style pyramid level."""
    if level < 0 or level > max_level:
        raise ValueError(f"level must be between 0 and {max_level}")
    downsample = 2 ** (max_level - level)
    return math.ceil(width / downsample), math.ceil(height / downsample)


def _image_mode(image: Image.Image) -> str:
    # The microscopy inputs are grayscale. Keeping them as L avoids turning a
    # 631M-pixel image into a multi-gigabyte RGBA buffer while building tiles.
    return "L" if image.mode in {"1", "L", "I", "I;16", "F"} else "RGBA"


def _manifest_matches(manifest: dict[str, Any], width: int, height: int, source_sha256: str | None) -> bool:
    return (
        manifest.get("schema_version") == PYRAMID_SCHEMA_VERSION
        and manifest.get("width") == width
        and manifest.get("height") == height
        and manifest.get("tile_size") == TILE
        and (source_sha256 is None or manifest.get("source_sha256") == source_sha256)
    )


def build_tile_pyramid(source_path: Path, pyramid_dir: Path, source_sha256: str | None = None,
                       progress: Callable[[int, int], None] | None = None) -> dict[str, Any]:
    """Build a lossless, tiled image pyramid without modifying the source.

    Each level follows OpenSeadragon's convention: the highest level is at
    native resolution and each lower level is downsampled by a power of two.
    Tiles are stored as ``<level>/<x>/<y>.png``. The manifest is written last,
    so an interrupted build is never mistaken for a complete pyramid.
    """
    source_path = source_path.expanduser().resolve()
    pyramid_dir = pyramid_dir.expanduser().resolve()
    manifest_path = pyramid_dir / "manifest.json"

    with Image.open(source_path) as source_image:
        width, height = source_image.size
        mode = _image_mode(source_image)

    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text())
        except (OSError, ValueError):
            manifest = None
        if isinstance(manifest, dict) and _manifest_matches(manifest, width, height, source_sha256):
            return {"path": str(pyramid_dir), **manifest}

    pyramid_dir.mkdir(parents=True, exist_ok=True)
    max_level = math.ceil(math.log2(max(width, height)))
    levels = {
        str(level): {"width": _level_dimensions(width, height, max_level, level)[0],
                     "height": _level_dimensions(width, height, max_level, level)[1]}
        for level in range(max_level + 1)
    }
    manifest = {
        "schema_version": PYRAMID_SCHEMA_VERSION,
        "source_sha256": source_sha256,
        "width": width,
        "height": height,
        "tile_size": TILE,
        "max_level": max_level,
        "mode": mode,
        "levels": levels,
    }

    # Keeping one current level in memory limits the peak to roughly the
    # source pixels plus the next level while avoiding a full decode per tile.
    with Image.open(source_path) as opened:
        current = opened.convert(mode)
        total_levels = max_level + 1
        for completed, level in enumerate(range(max_level, -1, -1), start=1):
            level_width, level_height = _level_dimensions(width, height, max_level, level)
            if current.size != (level_width, level_height):
                current = current.resize((level_width, level_height), Image.Resampling.LANCZOS)
            level_dir = pyramid_dir / str(level)
            level_dir.mkdir(parents=True, exist_ok=True)
            tiles_x = math.ceil(level_width / TILE)
            tiles_y = math.ceil(level_height / TILE)
            for x in range(tiles_x):
                (level_dir / str(x)).mkdir(parents=True, exist_ok=True)
            current.load()
            level_image = current

            def write_tile(position: tuple[int, int], image: Image.Image = level_image, directory: Path = level_dir,
                           right: int = level_width, bottom: int = level_height) -> None:
                x, y = position
                left, top = x * TILE, y * TILE
                tile = image.crop((left, top, min(left + TILE, right), min(top + TILE, bottom)))
                tile.save(directory / str(x) / f"{y}.png", "PNG", compress_level=1)

            # PNG encoding releases the GIL, so tiles of one level are written
            # in parallel; the level image is only read while this runs.
            positions = [(x, y) for x in range(tiles_x) for y in range(tiles_y)]
            if len(positions) < 32:
                for position in positions:
                    write_tile(position)
            else:
                with ThreadPoolExecutor(max_workers=TILE_WRITERS, thread_name_prefix="spatialbridge-tiles") as writers:
                    for _ in writers.map(write_tile, positions, chunksize=1):
                        pass
            if progress:
                progress(completed, total_levels)
            if level:
                next_width, next_height = _level_dimensions(width, height, max_level, level - 1)
                current = current.resize((next_width, next_height), Image.Resampling.LANCZOS)

    temporary_manifest = pyramid_dir / ".manifest.json.tmp"
    temporary_manifest.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    temporary_manifest.replace(manifest_path)
    return {"path": str(pyramid_dir), **manifest}


@lru_cache(maxsize=32)
def _read_pyramid_manifest(pyramid_path: str) -> dict[str, Any]:
    return json.loads((Path(pyramid_path) / "manifest.json").read_text(encoding="utf-8"))


@lru_cache(maxsize=512)
def _read_pyramid_tile(tile_path: str) -> np.ndarray:
    """Read and retain a small source tile; never retain a full source image."""
    with Image.open(tile_path) as tile:
        return np.asarray(tile.convert("RGBA"), dtype=np.uint8).copy()


def read_pyramid_region(pyramid_path: Path, level: int, box: tuple[int, int, int, int]) -> np.ndarray:
    """Stitch only the requested source region from the pyramid's small tiles."""
    manifest = _read_pyramid_manifest(str(pyramid_path))
    level_info = manifest["levels"].get(str(level))
    if not level_info:
        raise ValueError(f"Pyramid level {level} is unavailable")
    level_width, level_height = int(level_info["width"]), int(level_info["height"])
    left, top, right, bottom = box
    left, top = max(0, left), max(0, top)
    right, bottom = min(level_width, right), min(level_height, bottom)
    if right <= left or bottom <= top:
        return np.zeros((1, 1, 4), dtype=np.uint8)

    result = np.zeros((bottom - top, right - left, 4), dtype=np.uint8)
    first_x, last_x = left // TILE, (right - 1) // TILE
    first_y, last_y = top // TILE, (bottom - 1) // TILE
    for tile_x in range(first_x, last_x + 1):
        for tile_y in range(first_y, last_y + 1):
            tile_path = pyramid_path / str(level) / str(tile_x) / f"{tile_y}.png"
            if not tile_path.is_file():
                continue
            tile = _read_pyramid_tile(str(tile_path))
            tile_left, tile_top = tile_x * TILE, tile_y * TILE
            source_left = max(left, tile_left)
            source_top = max(top, tile_top)
            source_right = min(right, tile_left + tile.shape[1])
            source_bottom = min(bottom, tile_top + tile.shape[0])
            if source_right <= source_left or source_bottom <= source_top:
                continue
            result[source_top - top:source_bottom - top, source_left - left:source_right - left] = \
                tile[source_top - tile_top:source_bottom - tile_top, source_left - tile_left:source_right - tile_left]
    return result


def _transform_scale(matrix: list[list[float]] | np.ndarray) -> float:
    linear = np.asarray(matrix, dtype=float)[:2, :2]
    determinant = float(np.linalg.det(linear))
    return math.sqrt(abs(determinant)) if math.isfinite(determinant) and abs(determinant) > 1e-12 else 1.0


def _source_level_for_target(source_max_level: int, target_factor: int, transform_scale: float) -> tuple[int, int]:
    # `transform_scale` is target pixels per source pixel. Choose the coarsest
    # source level that still has at least the target pixel footprint, avoiding
    # needless full-resolution source reads at low zoom.
    desired_downsample = target_factor / max(transform_scale, 1e-9)
    if desired_downsample <= 1:
        return source_max_level, 1
    exponent = min(source_max_level, max(0, math.floor(math.log2(desired_downsample))))
    return source_max_level - exponent, 2 ** exponent


def pyramid_tile(pyramid_path: Path, matrix: list[list[float]], canvas: tuple[int, int], z: int, x: int, y: int) -> bytes:
    """Render a registered output tile using only small tiles from a source pyramid."""
    manifest = _read_pyramid_manifest(str(pyramid_path))
    source_width, source_height = int(manifest["width"]), int(manifest["height"])
    source_max_level = int(manifest["max_level"])
    tile_size = int(manifest.get("tile_size", TILE))
    if tile_size != TILE:
        raise ValueError(f"Unsupported pyramid tile size: {tile_size}")

    target_width, target_height = canvas
    target_max_level = math.ceil(math.log2(max(target_width, target_height)))
    factor = 2 ** max(0, target_max_level - z)
    origin = np.array([x * TILE * factor, y * TILE * factor], dtype=float)
    transform = np.asarray(matrix, dtype=float)
    inverse = np.linalg.inv(transform)
    corners = np.array([[origin[0], origin[1]], [origin[0] + TILE * factor, origin[1]],
                        [origin[0] + TILE * factor, origin[1] + TILE * factor],
                        [origin[0], origin[1] + TILE * factor]])
    source_corners = np.c_[corners, np.ones(4)] @ inverse.T
    source_corners = source_corners[:, :2] / source_corners[:, 2:3]
    transform_scale = _transform_scale(transform)
    source_level, downsample = _source_level_for_target(source_max_level, factor, transform_scale)

    # Add a small interpolation margin in original source pixels, then map the
    # requested region into the selected source pyramid level.
    margin = max(2, 2 * downsample)
    left = max(0, int(np.floor(source_corners[:, 0].min())) - margin)
    top = max(0, int(np.floor(source_corners[:, 1].min())) - margin)
    right = min(source_width, int(np.ceil(source_corners[:, 0].max())) + margin)
    bottom = min(source_height, int(np.ceil(source_corners[:, 1].max())) + margin)
    if right <= left or bottom <= top:
        return blank_tile()

    level_width, level_height = _level_dimensions(source_width, source_height, source_max_level, source_level)
    level_left = max(0, int(np.floor(left / downsample)))
    level_top = max(0, int(np.floor(top / downsample)))
    level_right = min(level_width, int(np.ceil(right / downsample)))
    level_bottom = min(level_height, int(np.ceil(bottom / downsample)))
    crop = read_pyramid_region(pyramid_path, source_level, (level_left, level_top, level_right, level_bottom))
    level_transform = transform @ np.diag([downsample, downsample, 1])
    output_transform = np.array([[1 / factor, 0, -origin[0] / factor],
                                 [0, 1 / factor, -origin[1] / factor], [0, 0, 1]], dtype=float) @ level_transform
    # ``crop`` starts at (level_left, level_top) in the source pyramid. Keep
    # the complete 3x3 matrix here: truncating a homography to 2x3 makes the
    # registered image and the projective SBD grid drift apart over a wide scan.
    crop_translation = np.array([[1.0, 0.0, level_left],
                                 [0.0, 1.0, level_top],
                                 [0.0, 0.0, 1.0]])
    local_transform = output_transform @ crop_translation
    warped = cv2.warpPerspective(crop, local_transform, (TILE, TILE), flags=cv2.INTER_AREA,
                                  borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    output = BytesIO()
    Image.fromarray(warped).save(output, "PNG")
    return output.getvalue()


def _open_image(path: str) -> Image.Image:
    # Pillow's PNG decoder has a mutable stream and cannot be shared by the
    # concurrent requests OpenSeadragon emits for adjacent tiles.
    return Image.open(path)


@lru_cache(maxsize=3)
def _open_vips(path: str):
    """Use libvips when installed: it decodes only the requested source region."""
    try:
        import pyvips  # type: ignore
        # OpenSeadragon asks for tiles in arbitrary order while panning/zooming.
        # `sequential` causes libvips to reject those out-of-order reads with HTTP 500.
        return pyvips.Image.new_from_file(path, access="random")
    except Exception:
        return None


def _region(path: str, left: int, top: int, right: int, bottom: int) -> np.ndarray:
    vips = _open_vips(path)
    if vips is not None:
        region = vips.crop(left, top, right - left, bottom - top)
        array = np.ndarray(buffer=region.write_to_memory(), dtype=np.uint8,
                           shape=(region.height, region.width, region.bands))
        if array.shape[2] == 1:
            return cv2.cvtColor(array[:, :, 0], cv2.COLOR_GRAY2RGBA)
        if array.shape[2] == 3:
            return cv2.cvtColor(array, cv2.COLOR_RGB2RGBA)
        return array[:, :, :4]
    # A functional fallback for development systems without the libvips shared library.
    with _open_image(path) as image:
        return np.asarray(image.crop((left, top, right, bottom)).convert("RGBA"))


def common_tile(source_path: str, matrix: list[list[float]], canvas: tuple[int, int], z: int, x: int, y: int,
                source_scale: float = 1.0) -> bytes:
    """Render one on-demand transparent tile in the pre-microscopy coordinate system."""
    width, height = canvas
    max_level = math.ceil(math.log2(max(width, height)))
    factor = 2 ** max(0, max_level - z)
    origin = np.array([x * TILE * factor, y * TILE * factor], dtype=float)
    # A cached preview is smaller than the original source. Convert its pixel
    # coordinates back to original coordinates before applying the registration.
    transform = np.asarray(matrix, dtype=float) @ np.diag([1 / source_scale, 1 / source_scale, 1])
    inverse = np.linalg.inv(transform)
    corners = np.array([[origin[0], origin[1]], [origin[0] + TILE * factor, origin[1]],
                        [origin[0] + TILE * factor, origin[1] + TILE * factor], [origin[0], origin[1] + TILE * factor]])
    source_corners = np.c_[corners, np.ones(4)] @ inverse.T
    source_corners = source_corners[:, :2] / source_corners[:, 2:3]
    with _open_image(source_path) as image:
        source_width, source_height = image.size
    left, top = np.floor(source_corners.min(axis=0)).astype(int)
    right, bottom = np.ceil(source_corners.max(axis=0)).astype(int)
    left, top = max(0, left - 2), max(0, top - 2)
    right, bottom = min(source_width, right + 2), min(source_height, bottom + 2)
    if right <= left or bottom <= top:
        return blank_tile()
    crop = _region(source_path, left, top, right, bottom)
    output_transform = np.array([[1 / factor, 0, -origin[0] / factor],
                                 [0, 1 / factor, -origin[1] / factor], [0, 0, 1]], dtype=float) @ transform
    # cv2 expects source-crop coordinates. Preserve the projective row so the
    # image follows the same transform used by the SBD footprint overlay.
    crop_translation = np.array([[1.0, 0.0, left],
                                 [0.0, 1.0, top],
                                 [0.0, 0.0, 1.0]])
    local_transform = output_transform @ crop_translation
    warped = cv2.warpPerspective(crop, local_transform, (TILE, TILE), flags=cv2.INTER_AREA,
                                  borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0, 0))
    output = BytesIO()
    Image.fromarray(warped).save(output, "PNG")
    return output.getvalue()


def blank_tile() -> bytes:
    output = BytesIO()
    Image.new("RGBA", (TILE, TILE), (0, 0, 0, 0)).save(output, "PNG")
    return output.getvalue()
