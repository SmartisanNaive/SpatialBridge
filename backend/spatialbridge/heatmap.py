"""Register rendered MALDI heat maps and sample their displayed spot colours.

The PNG is a visualisation, not the underlying m/z intensity matrix.  Colour
samples must therefore never be presented as quantitative ion measurements.
"""
from __future__ import annotations

import math
from typing import Any

import cv2
import numpy as np


SAMPLING_VERSION = 2


class HeatmapRegistrationError(ValueError):
    pass


def _resize_for_matching(image: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    height, width = image.shape[:2]
    factor = min(1.0, 2048 / max(width, height))
    size = (max(1, round(width * factor)), max(1, round(height * factor)))
    resized = cv2.resize(image, size, interpolation=cv2.INTER_AREA) if size != (width, height) else image
    return resized, np.diag([size[0] / width, size[1] / height, 1.0])


def _texture_features(sift: Any, image: np.ndarray) -> tuple[Any, Any]:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    # The heat rectangle and colour bar differ by m/z. Match the shared,
    # comparatively low-saturation board texture instead.
    mask = np.where(hsv[:, :, 1] < 90, 255, 0).astype(np.uint8)
    return sift.detectAndCompute(gray, mask)


def match_heatmap(source: np.ndarray, reference: np.ndarray) -> dict[str, Any]:
    """Find the source→reference homography, allowing rotations and reflections.

    SIFT descriptors are rotation invariant; trying the original and a mirror
    covers both orientation parities without needing the user to rotate a file.
    Reject sparse or localised evidence rather than displaying a guessed match.
    """
    if source is None or reference is None or source.ndim != 3 or reference.ndim != 3:
        raise HeatmapRegistrationError("无法读取热图或参考图像")
    small_source, source_scale = _resize_for_matching(source)
    small_reference, reference_scale = _resize_for_matching(reference)
    sift = cv2.SIFT_create(nfeatures=9000)
    reference_points, reference_descriptors = _texture_features(sift, small_reference)
    if reference_descriptors is None or len(reference_points) < 30:
        raise HeatmapRegistrationError("参考热图缺少足够的板图纹理")
    candidates: list[dict[str, Any]] = []
    for flip in (False, True):
        trial = cv2.flip(small_source, 1) if flip else small_source
        source_points, source_descriptors = _texture_features(sift, trial)
        if source_descriptors is None or len(source_points) < 30:
            continue
        pairs = cv2.BFMatcher().knnMatch(source_descriptors, reference_descriptors, k=2)
        matches = [pair[0] for pair in pairs if len(pair) == 2 and pair[0].distance < 0.70 * pair[1].distance]
        if len(matches) < 30:
            continue
        source_xy = np.float32([source_points[item.queryIdx].pt for item in matches])
        reference_xy = np.float32([reference_points[item.trainIdx].pt for item in matches])
        matrix, inlier_mask = cv2.findHomography(source_xy, reference_xy, cv2.RANSAC, 2.0)
        if matrix is None or inlier_mask is None or not np.isfinite(matrix).all():
            continue
        keep = inlier_mask.ravel().astype(bool)
        count = int(keep.sum())
        if count < 30 or count / len(matches) < .45:
            continue
        predicted = cv2.perspectiveTransform(source_xy[keep, None, :], matrix)[:, 0, :]
        error = np.linalg.norm(predicted - reference_xy[keep], axis=1)
        p95 = float(np.percentile(error, 95))
        span = np.ptp(reference_xy[keep], axis=0) / np.array([small_reference.shape[1], small_reference.shape[0]])
        hull = cv2.convexHull(reference_xy[keep].reshape(-1, 1, 2))
        coverage = float(cv2.contourArea(hull) / (small_reference.shape[0] * small_reference.shape[1]))
        if p95 > 2.0 or span[0] < .4 or span[1] < .3 or coverage < .08:
            continue
        reflection = np.array([[-1.0, 0.0, trial.shape[1] - 1], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]) if flip else np.eye(3)
        full_matrix = np.linalg.inv(reference_scale) @ matrix @ reflection @ source_scale
        if abs(full_matrix[2, 2]) < 1e-12:
            continue
        full_matrix /= full_matrix[2, 2]
        if not np.isfinite(full_matrix).all() or abs(np.linalg.det(full_matrix)) < 1e-12:
            continue
        candidates.append({"matrix": full_matrix, "inliers": count, "matches": len(matches),
                           "error_p95_px": p95 / min(reference_scale[0, 0], reference_scale[1, 1]),
                           "coverage": coverage, "span": span.tolist()})
    if not candidates:
        raise HeatmapRegistrationError("无法可靠匹配板图纹理；请检查热图与项目是否来自同一次采集")
    candidates.sort(key=lambda item: item["inliers"], reverse=True)
    best = candidates[0]
    if len(candidates) > 1 and candidates[1]["inliers"] >= best["inliers"] * .8:
        corners = np.float32([[0, 0], [source.shape[1] - 1, 0], [0, source.shape[0] - 1],
                              [source.shape[1] - 1, source.shape[0] - 1]]).reshape(-1, 1, 2)
        first = cv2.perspectiveTransform(corners, best["matrix"])
        second = cv2.perspectiveTransform(corners, candidates[1]["matrix"])
        if np.median(np.linalg.norm(first - second, axis=2)) > 5:
            raise HeatmapRegistrationError("热图方向存在歧义，无法可靠自动匹配")
    # Local orientation at the image centre, including the projective term.
    cx, cy = source.shape[1] / 2, source.shape[0] / 2
    probe = np.float32([[cx, cy], [cx + 1, cy], [cx, cy + 1]]).reshape(-1, 1, 2)
    mapped = cv2.perspectiveTransform(probe, best["matrix"])[:, 0, :]
    jacobian = np.column_stack((mapped[1] - mapped[0], mapped[2] - mapped[0]))
    mirrored = bool(np.linalg.det(jacobian) < 0)
    oriented = jacobian @ np.diag([-1, 1]) if mirrored else jacobian
    rotation = math.degrees(math.atan2(float(oriented[1, 0]), float(oriented[0, 0]))) % 360
    best.update({"mirrored": mirrored, "rotation_degrees": round(rotation, 1)})
    return best


def sample_spot_colours(image: np.ndarray, world_to_reference: np.ndarray, source_to_reference: np.ndarray,
                        world_x: np.ndarray, world_y: np.ndarray, mapped: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Sample rendered RGB at registered SBD centres; do not infer intensity."""
    if world_to_reference.shape != (3, 3) or not np.isfinite(world_to_reference).all():
        raise HeatmapRegistrationError("项目没有有效的参考热图坐标变换")
    try:
        world_to_source = np.linalg.inv(source_to_reference) @ world_to_reference
    except np.linalg.LinAlgError as error:
        raise HeatmapRegistrationError("热图坐标变换不可逆") from error
    world = np.column_stack((world_x, world_y, np.ones(len(world_x))))
    transformed = world @ world_to_source.T
    with np.errstate(divide="ignore", invalid="ignore"):
        xy = transformed[:, :2] / transformed[:, 2:3]
    valid = (np.asarray(mapped, dtype=bool) & np.isfinite(xy).all(axis=1) &
             (xy[:, 0] >= 0) & (xy[:, 1] >= 0) &
             (xy[:, 0] < image.shape[1]) & (xy[:, 1] < image.shape[0]))
    colors = np.zeros((len(world_x), 3), dtype=np.uint8)
    indices = np.flatnonzero(valid)
    if indices.size:
        x = np.floor(xy[indices, 0]).astype(int)
        y = np.floor(xy[indices, 1]).astype(int)
        pixels = image[y, x]
        hsv_image = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
        hsv = hsv_image[y, x]
        # ROI outlines can be blended with neighbouring heatmap pixels. Mask
        # their immediate neighbourhood too, so antialiased red/purple pixels
        # cannot masquerade as signal. Do not fill from another grid cell:
        # adjacent spots in these screenshots are only a few pixels apart.
        red = (((hsv_image[:, :, 0] < 8) | (hsv_image[:, :, 0] > 172)) &
               (hsv_image[:, :, 1] >= 70)).astype(np.uint8)
        border_neighbourhood = cv2.dilate(red, np.ones((5, 5), np.uint8))
        is_signal = ((hsv[:, 1] >= 70) & (hsv[:, 0] >= 8) & (hsv[:, 0] <= 172) &
                     (border_neighbourhood[y, x] == 0))
        valid[indices[~is_signal]] = False
        colors[indices[is_signal]] = pixels[is_signal, ::-1]
    return colors, valid
