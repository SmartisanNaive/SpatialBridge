"""Optical grid recovery and versioned MALDI coordinate models.

The microscopy image is used to recover topology and geometry, while the SBD
``OriginalCoordinates`` array remains the authority for spot identity and
physical footprint.  This module contains the small part of SpaceM's workflow
that is useful here: scale-aware pit candidates, lattice neighbour links, and
an acquisition-outline check.
"""

from collections import deque
from typing import Any

import cv2
import numpy as np


TERMS_BY_DEGREE: dict[int, list[str]] = {
    1: ["1", "x", "y"],
    2: ["1", "x", "y", "x2", "xy", "y2"],
    3: ["1", "x", "y", "x2", "xy", "y2", "x3", "x2y", "xy2", "y3"],
}


def _stats(values: np.ndarray) -> dict[str, float]:
    finite = np.asarray(values, dtype=float)
    finite = finite[np.isfinite(finite)]
    if not finite.size:
        return {"median_px": float("nan"), "p95_px": float("nan"), "p99_px": float("nan")}
    return {"median_px": float(np.median(finite)), "p95_px": float(np.percentile(finite, 95)),
            "p99_px": float(np.percentile(finite, 99))}


def trace_lattice(points: np.ndarray, pitch: float) -> tuple[np.ndarray, np.ndarray, dict[str, Any]]:
    """Connect near-axis neighbours, allowing one or two missing nodes.

    Integer coordinates are arbitrary until :func:`match_outline` aligns them
    to the SBD raster.  Contradictory cycles are counted and never silently
    re-indexed.
    """
    values = np.asarray(points, dtype=np.float32)
    if values.ndim != 2 or values.shape[1] != 2 or len(values) < 24:
        return values[:0], np.empty((0, 2), dtype=np.int32), {"component_count": 0, "connected_count": 0,
                                                               "cycle_conflicts": 0}
    cv2.setRNGSeed(0)
    tree = cv2.flann_Index(values, dict(algorithm=1, trees=4))
    edges: list[tuple[float, int, int, int, int]] = []
    # u is row (up is negative image y), v is column (right is positive x).
    for vector, step in (([pitch, 0.0], (0, 1)), ([0.0, pitch], (-1, 0))):
        for distance in (1, 2, 3):
            targets = values + np.asarray(vector, np.float32) * distance
            neighbours, errors = tree.knnSearch(targets, 1, params={"checks": 48})
            tolerance = pitch * (0.20 if distance == 1 else 0.17)
            for index in np.flatnonzero(errors[:, 0] < tolerance * tolerance):
                edges.append((float(errors[index, 0]), int(index), int(neighbours[index, 0]),
                              step[0] * distance, step[1] * distance))
    edges.sort()
    adjacent: list[list[tuple[int, int, int]]] = [[] for _ in values]
    for _, first, second, row_step, column_step in edges:
        adjacent[first].append((second, row_step, column_step))
        adjacent[second].append((first, -row_step, -column_step))

    seen = np.zeros(len(values), dtype=bool)
    indices = np.zeros((len(values), 2), dtype=np.int32)
    groups: list[tuple[list[int], int]] = []
    for start in np.argsort(values[:, 0])[::-1]:
        if seen[start]:
            continue
        queue: deque[int] = deque([int(start)])
        seen[start] = True
        group: list[int] = []
        conflicts = 0
        while queue:
            current = queue.popleft()
            group.append(current)
            for neighbour, row_step, column_step in adjacent[current]:
                expected = indices[current] + (row_step, column_step)
                if not seen[neighbour]:
                    indices[neighbour] = expected
                    seen[neighbour] = True
                    queue.append(neighbour)
                elif np.any(indices[neighbour] != expected):
                    conflicts += 1
        groups.append((group, conflicts))
    group, conflicts = max(groups, key=lambda item: len(item[0]))
    selected = np.asarray(group, dtype=np.int64)
    return values[selected].astype(float), indices[selected], {
        "component_count": int(len(values)),
        "connected_count": int(len(selected)),
        "cycle_conflicts": int(conflicts // 2),
        "missing_link_tolerance_steps": 2,
    }


def match_outline(indices: np.ndarray, original: np.ndarray) -> dict[str, Any] | None:
    """Align the recovered lattice to the complete sparse SBD outline."""
    original_values = np.asarray(original, dtype=np.int32)
    lattice_values = np.asarray(indices, dtype=np.int32)
    if original_values.ndim != 2 or lattice_values.ndim != 2 or not len(original_values) or not len(lattice_values):
        return None
    origin = original_values.min(axis=0)
    shape = original_values.max(axis=0) - origin + 1
    if np.prod(shape.astype(np.int64)) > 5_000_000:
        return None
    mask = np.zeros(tuple(shape.tolist()), np.float32)
    mask[tuple((original_values - origin).T)] = 1
    hypotheses: list[dict[str, Any]] = []
    for signs in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
        oriented = lattice_values * np.asarray(signs, dtype=np.int32)
        minimum = oriented.min(axis=0)
        observed_shape = oriented.max(axis=0) - minimum + 1
        if np.prod(observed_shape.astype(np.int64)) > 5_000_000:
            continue
        observed = np.zeros(tuple(observed_shape.tolist()), np.float32)
        observed[tuple((oriented - minimum).T)] = 1
        padding = np.maximum(15, shape - observed_shape + 15)
        observed = np.pad(observed, tuple((int(p), int(p)) for p in padding))
        scores = cv2.matchTemplate(observed, mask, cv2.TM_CCORR)
        best_position = np.array(np.unravel_index(int(scores.argmax()), scores.shape))
        offset = origin - (best_position - padding + minimum)
        hypotheses.append({"signs": list(signs), "offset": offset.astype(int).tolist(),
                           "overlap": int(round(float(scores[tuple(best_position)])))})
    if not hypotheses:
        return None
    hypotheses.sort(key=lambda item: item["overlap"], reverse=True)
    best = hypotheses[0]
    second_overlap = hypotheses[1]["overlap"] if len(hypotheses) > 1 else 0
    unique_count = len(np.unique(lattice_values, axis=0))
    margin = int(best["overlap"] - second_overlap)
    return {**best,
            "hypotheses": hypotheses,
            "overlap_fraction": float(best["overlap"] / max(unique_count, 1)),
            "orientation_margin_nodes": margin,
            "orientation_resolved": bool(margin >= max(8, unique_count * .0005)),
            "sparse_outline_preserved": True}


def _polynomial_design(values: np.ndarray, degree: int, center: np.ndarray,
                      scale: np.ndarray) -> np.ndarray:
    normalized = (np.asarray(values, dtype=float) - center) / scale
    x, y = normalized[:, 0], normalized[:, 1]
    columns = {
        "1": np.ones(len(normalized)), "x": x, "y": y,
        "x2": x * x, "xy": x * y, "y2": y * y,
        "x3": x * x * x, "x2y": x * x * y, "xy2": x * y * y, "y3": y * y * y,
    }
    return np.column_stack([columns[name] for name in TERMS_BY_DEGREE[degree]])


def evaluate_coordinate_model(model: dict[str, Any], points: np.ndarray,
                              enforce_domain: bool = False) -> np.ndarray:
    """Evaluate a JSON-compatible coordinate model for N×2 ``[x, y]`` points."""
    values = np.asarray(points, dtype=float)
    if values.ndim == 1:
        values = values.reshape(1, 2)
    output = np.full((len(values), 2), np.nan, dtype=float)
    if values.ndim != 2 or values.shape[1] != 2:
        return output
    normalization = model.get("normalization") or {}
    center = np.asarray(normalization.get("center", [0.0, 0.0]), dtype=float)
    scale = np.maximum(np.asarray(normalization.get("scale", [1.0, 1.0]), dtype=float), 1e-9)
    degree = int(model.get("degree", 1))
    coefficients = np.asarray(model.get("coefficients", []), dtype=float)
    if degree not in TERMS_BY_DEGREE or coefficients.shape != (len(TERMS_BY_DEGREE[degree]), 2):
        return output
    finite = np.isfinite(values).all(axis=1)
    valid = finite.copy()
    if enforce_domain:
        domain = (model.get("valid_domain") or {}).get("world")
        if domain and len(domain) == 4:
            valid &= (values[:, 0] >= float(domain[0])) & (values[:, 0] <= float(domain[2])) & \
                (values[:, 1] >= float(domain[1])) & (values[:, 1] <= float(domain[3]))
    if valid.any():
        output[valid] = _polynomial_design(values[valid], degree, center, scale) @ coefficients
    return output


def _fit_polynomial(inputs: np.ndarray, outputs: np.ndarray, degree: int,
                    train: np.ndarray, pitch: float) -> tuple[dict[str, Any], np.ndarray, np.ndarray]:
    center = np.mean(inputs[train], axis=0)
    scale = np.ptp(inputs[train], axis=0) / 2
    scale = np.maximum(scale, np.std(inputs[train], axis=0) * 2)
    scale = np.maximum(scale, 1e-6)
    design = _polynomial_design(inputs, degree, center, scale)
    train_indices = np.flatnonzero(train)
    weights = np.ones(len(train_indices), dtype=float)
    coefficients = np.zeros((design.shape[1], 2), dtype=float)
    for _ in range(6):
        coefficients = np.linalg.lstsq(design[train_indices] * weights[:, None],
                                       outputs[train_indices] * weights[:, None], rcond=None)[0]
        residual = np.linalg.norm(design[train_indices] @ coefficients - outputs[train_indices], axis=1)
        cutoff = max(pitch * .22, float(np.percentile(residual, 70)) * 1.15, 1.0)
        weights = np.minimum(1.0, cutoff / np.maximum(residual, 1e-6))
    return {
        "schema_version": 1,
        "model_type": "normalized_polynomial",
        "source": "world",
        "target": "after",
        "coordinate_order": "xy",
        "degree": int(degree),
        "term_order": TERMS_BY_DEGREE[degree],
        "normalization": {"center": center.astype(float).tolist(), "scale": scale.astype(float).tolist()},
        "coefficients": coefficients.astype(float).tolist(),
    }, coefficients, design


def _linear_model_matrix(model: dict[str, Any]) -> np.ndarray:
    """Convert a normalized degree-one model into an xy homogeneous matrix."""
    coefficients = np.asarray(model["coefficients"], dtype=float)
    center = np.asarray(model["normalization"]["center"], dtype=float)
    scale = np.asarray(model["normalization"]["scale"], dtype=float)
    linear = coefficients[1:3].T / scale[np.newaxis, :]
    offset = coefficients[0] - linear @ center
    return np.vstack((np.column_stack((linear, offset)), [0.0, 0.0, 1.0]))


def _regional_errors(residual: np.ndarray, inputs: np.ndarray, bins: int = 8) -> list[dict[str, Any]]:
    if not len(residual):
        return []
    y = inputs[:, 1]
    edges = np.linspace(float(y.min()), float(y.max()) + 1e-9, bins + 1)
    result: list[dict[str, Any]] = []
    for index in range(bins):
        selected = (y >= edges[index]) & ((y < edges[index + 1]) if index < bins - 1 else (y <= edges[index + 1]))
        if not selected.any():
            continue
        result.append({"index": index, "input_bbox": [float(inputs[selected, 0].min()), float(y[selected].min()),
                                                         float(inputs[selected, 0].max()), float(y[selected].max())],
                      "count": int(selected.sum()), **_stats(residual[selected])})
    return result


def _segments_intersect(first: np.ndarray, second: np.ndarray, third: np.ndarray, fourth: np.ndarray) -> bool:
    def orientation(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> float:
        first = b - a
        second = c - a
        return float(first[0] * second[1] - first[1] * second[0])

    def on_segment(a: np.ndarray, b: np.ndarray, c: np.ndarray) -> bool:
        return min(a[0], c[0]) - 1e-6 <= b[0] <= max(a[0], c[0]) + 1e-6 and \
            min(a[1], c[1]) - 1e-6 <= b[1] <= max(a[1], c[1]) + 1e-6

    values = [orientation(first, second, third), orientation(first, second, fourth),
              orientation(third, fourth, first), orientation(third, fourth, second)]
    crossing = ((values[0] > 1e-6 and values[1] < -1e-6) or (values[0] < -1e-6 and values[1] > 1e-6)) and \
        ((values[2] > 1e-6 and values[3] < -1e-6) or (values[2] < -1e-6 and values[3] > 1e-6))
    if crossing:
        return True
    return any(abs(value) <= 1e-6 and on_segment(a, b, c) for value, a, b, c in (
        (values[0], first, third, second), (values[1], first, fourth, second),
        (values[2], third, first, fourth), (values[3], third, second, fourth)))


def _model_health(model: dict[str, Any], domain: np.ndarray, pitch: float) -> dict[str, Any]:
    minimum = np.asarray(domain[:2], dtype=float)
    maximum = np.asarray(domain[2:], dtype=float)
    axis_x = np.linspace(minimum[0], maximum[0], 17)
    axis_y = np.linspace(minimum[1], maximum[1], 17)
    grid = np.array(np.meshgrid(axis_x, axis_y), dtype=float).reshape(2, -1).T
    step = max(0.1, float(np.min(np.maximum(maximum - minimum, 1.0))) * .0002)
    base = evaluate_coordinate_model(model, grid)
    dx = evaluate_coordinate_model(model, grid + [step, 0])
    dy = evaluate_coordinate_model(model, grid + [0, step])
    derivatives = np.stack([(dx - base) / step, (dy - base) / step], axis=2)
    determinants = np.linalg.det(derivatives)
    finite = np.isfinite(determinants)
    threshold = max(1e-5, (pitch / 20.0) ** 2 * .15)
    signs = np.sign(determinants[finite])
    same_orientation = bool(len(signs) and np.all(signs == signs[0]))

    side = np.concatenate([
        np.c_[np.linspace(minimum[0], maximum[0], 25), np.full(25, minimum[1])],
        np.c_[np.full(24, maximum[0]), np.linspace(minimum[1], maximum[1], 25)[1:]],
        np.c_[np.linspace(maximum[0], minimum[0], 25)[1:], np.full(24, maximum[1])],
        np.c_[np.full(24, minimum[0]), np.linspace(maximum[1], minimum[1], 25)[1:]],
    ])
    mapped_side = evaluate_coordinate_model(model, side)
    boundary_self_intersection = False
    if np.isfinite(mapped_side).all():
        for first in range(len(mapped_side) - 1):
            for second in range(first + 2, len(mapped_side) - 1):
                if first == 0 and second == len(mapped_side) - 2:
                    continue
                if _segments_intersect(mapped_side[first], mapped_side[first + 1],
                                       mapped_side[second], mapped_side[second + 1]):
                    boundary_self_intersection = True
                    break
            if boundary_self_intersection:
                break
    return {
        "finite_jacobian": bool(finite.all()),
        "orientation_preserved": same_orientation,
        "jacobian_min_abs": float(np.min(np.abs(determinants[finite]))) if finite.any() else 0.0,
        "jacobian_max_abs": float(np.max(np.abs(determinants[finite]))) if finite.any() else 0.0,
        "jacobian_threshold": float(threshold),
        "folding_rejected": bool((not finite.all()) or (not same_orientation) or
                                  (finite.any() and np.min(np.abs(determinants[finite])) < threshold)),
        "boundary_self_intersection": bool(boundary_self_intersection),
        "boundary_rejected": bool(boundary_self_intersection or not np.isfinite(mapped_side).all()),
    }


def _holdout_mask(indexed: np.ndarray) -> np.ndarray:
    values = np.asarray(indexed, dtype=float)
    extent = np.maximum(np.ptp(values, axis=0), 1.0)
    blocks = np.floor((values - values.min(axis=0)) /
                      np.maximum(extent / [5.0, 12.0], 1.0)).astype(np.int32)
    holdout = (blocks[:, 0] + 3 * blocks[:, 1]) % 5 == 0
    if holdout.sum() < len(values) * .12 or holdout.sum() > len(values) * .30:
        holdout = (np.arange(len(values)) % 5) == 0
    return holdout


def _serializable_model(model: dict[str, Any], domain: np.ndarray, pitch: float,
                        health: dict[str, Any], spot_size_world: np.ndarray | None) -> dict[str, Any]:
    values = dict(model)
    domain_corners = np.array([[domain[0], domain[1]], [domain[2], domain[1]],
                               [domain[2], domain[3]], [domain[0], domain[3]]], dtype=float)
    target_corners = evaluate_coordinate_model(values, domain_corners)
    values["valid_domain"] = {
        "world": [float(domain[0]), float(domain[1]), float(domain[2]), float(domain[3])],
        "after": [float(target_corners[:, 0].min()), float(target_corners[:, 1].min()),
                  float(target_corners[:, 0].max()), float(target_corners[:, 1].max())] if np.isfinite(target_corners).all() else None,
        "coordinate_order": "xy",
        "outside_behavior": "not_mapped; no smooth extrapolation",
    }
    if spot_size_world is not None and np.isfinite(spot_size_world).all():
        half = np.asarray(spot_size_world, dtype=float) / 2
        values["footprint_domain"] = {
            "world": [float(domain[0] - half[0]), float(domain[1] - half[1]),
                      float(domain[2] + half[0]), float(domain[3] + half[1])],
            "reason": "20 μm footprint corners may touch the calibrated boundary",
        }
    values["grid_geometry"] = {
        "spot_size_um": [float(value) for value in spot_size_world] if spot_size_world is not None else [20.0, 20.0],
        "physical_spacing_um": [20.0, 20.0],
        "expected_image_pitch_px": float(pitch),
    }
    values["health"] = health
    return values


def fit_optical_lattice(image: np.ndarray, scale: float, pitch: float,
                        original: np.ndarray, raster: np.ndarray, world: np.ndarray,
                        base_matrix: np.ndarray, primary_raster: int,
                        spot_size_world: np.ndarray | None = None) -> dict[str, Any] | None:
    """Recover the full grid and choose a validated global coordinate model."""
    raster_values = np.asarray(raster, dtype=np.int32).reshape(-1)
    original_values = np.asarray(original, dtype=float)
    world_values = np.asarray(world, dtype=float)
    primary = raster_values == int(primary_raster)
    original_primary = original_values[primary]
    world_primary = world_values[primary]
    if len(original_primary) < 120 or not np.isfinite(original_primary).all() or not np.isfinite(world_primary).all():
        return None
    small_pitch = max(3.0, float(pitch) * float(scale))
    kernel = max(3, int(round(small_pitch * 2.1)) | 1)
    gray = np.asarray(image, dtype=np.float32)
    if gray.ndim != 2:
        return None
    background = cv2.boxFilter(gray, -1, (kernel, kernel))
    binary = ((gray - background) > 5).astype(np.uint8)
    count, _, stats, centres = cv2.connectedComponentsWithStats(binary, 8)
    if count <= 1:
        return None
    stats, centres = stats[1:], centres[1:]
    area, width, height = stats[:, 4], stats[:, 2], stats[:, 3]
    keep = (area > small_pitch ** 2 * .10) & (area < small_pitch ** 2 * .80) & \
        (width > small_pitch * .25) & (width < small_pitch * 1.3) & \
        (height > small_pitch * .25) & (height < small_pitch * 1.3) & \
        (width / np.maximum(height, 1) > .5) & (width / np.maximum(height, 1) < 2)
    optical_points, optical_indices, topology = trace_lattice(centres[keep] / max(scale, 1e-9), pitch)
    minimum_nodes = max(120, int(len(original_primary) * .25))
    if len(optical_points) < minimum_nodes or topology.get("cycle_conflicts", 1):
        return None
    alignment = match_outline(optical_indices, original_primary)
    if alignment is None or alignment["overlap_fraction"] < .97 or not alignment["orientation_resolved"]:
        return None
    indexed = optical_indices * np.asarray(alignment["signs"], dtype=float) + np.asarray(alignment["offset"], dtype=float)
    original_lookup: dict[tuple[int, int], int] = {}
    for index, value in enumerate(np.rint(original_primary).astype(np.int64)):
        original_lookup.setdefault((int(value[0]), int(value[1])), index)
    matched_optical: list[int] = []
    matched_sbd: list[int] = []
    for optical_index, index_value in enumerate(np.rint(indexed).astype(np.int64)):
        sbd_index = original_lookup.get((int(index_value[0]), int(index_value[1])))
        if sbd_index is not None:
            matched_optical.append(optical_index)
            matched_sbd.append(sbd_index)
    if len(matched_sbd) < minimum_nodes:
        return None
    matched_optical_indices = np.asarray(matched_optical, dtype=np.int64)
    matched_sbd_indices = np.asarray(matched_sbd, dtype=np.int64)
    matched_points = optical_points[matched_optical_indices]
    matched_indexed = indexed[matched_optical_indices]
    matched_world = world_primary[matched_sbd_indices]
    holdout = _holdout_mask(matched_indexed)
    if holdout.sum() < 24 or (~holdout).sum() < 24:
        return None
    domain = np.array([matched_world[:, 0].min(), matched_world[:, 1].min(),
                       matched_world[:, 0].max(), matched_world[:, 1].max()], dtype=float)

    candidate_results: list[dict[str, Any]] = []
    for degree in (1, 2, 3):
        validation_model, validation_coefficients, validation_design = _fit_polynomial(
            matched_world, matched_points, degree, ~holdout, float(pitch))
        predicted = validation_design @ validation_coefficients
        residual = np.linalg.norm(predicted - matched_points, axis=1)
        holdout_residual = residual[holdout]
        region = _regional_errors(holdout_residual, matched_indexed[holdout])
        health = _model_health(validation_model, domain, pitch)
        candidate_results.append({"degree": degree, "model": validation_model,
                                  "validation": {
                                      **_stats(holdout_residual), "holdout_count": int(holdout.sum()),
                                      "train_count": int((~holdout).sum()), "regional": region,
                                      "max_regional_p95_px": float(max((item["p95_px"] for item in region), default=float("nan"))),
                                  }, "health": health})
    passing = [item for item in candidate_results if item["validation"]["p95_px"] <= pitch * .25 and
               item["validation"]["median_px"] <= pitch * .12 and
               item["validation"]["max_regional_p95_px"] <= pitch * .35 and
               not item["health"]["folding_rejected"] and not item["health"]["boundary_rejected"]]
    selected = passing[0] if passing else None
    if selected is None:
        return None
    # A higher degree is admitted only when the plan's 15% improvement is real
    # and no validation region worsens by more than 10%.
    for candidate in candidate_results:
        if candidate["degree"] <= selected["degree"] or candidate not in passing:
            continue
        current = selected["validation"]
        regional_current = {item["index"]: item["p95_px"] for item in current["regional"]}
        regional_candidate = {item["index"]: item["p95_px"] for item in candidate["validation"]["regional"]}
        region_ok = all(regional_candidate.get(index, value) <= value * 1.10 + 1e-6
                        for index, value in regional_current.items())
        if candidate["validation"]["p95_px"] <= current["p95_px"] * .85 and region_ok:
            selected = candidate

    selected_degree = int(selected["degree"])
    final_model, final_coefficients, final_design = _fit_polynomial(
        matched_world, matched_points, selected_degree, np.ones(len(matched_world), dtype=bool), float(pitch))
    final_predicted = final_design @ final_coefficients
    final_residual = np.linalg.norm(final_predicted - matched_points, axis=1)
    final_health = _model_health(final_model, domain, pitch)
    coordinate_model = _serializable_model(final_model, domain, pitch, final_health, spot_size_world)
    all_after = evaluate_coordinate_model(coordinate_model, world_values, enforce_domain=True)

    # Legacy matrix fields are an affine approximation only.  They are kept so
    # older projects/clients can open, but the coordinate_model is authoritative.
    affine_model, _, _ = _fit_polynomial(
        matched_world, matched_points, 1, np.ones(len(matched_world), dtype=bool), float(pitch))
    affine_matrix = _linear_model_matrix(affine_model)
    original_model, _, _ = _fit_polynomial(
        matched_world, matched_indexed, 1, np.ones(len(matched_world), dtype=bool), float(pitch))
    world_to_original = _linear_model_matrix(original_model)
    base = np.asarray(base_matrix, dtype=float)
    if base.shape != (3, 3) or not np.isfinite(base).all() or abs(np.linalg.det(base[:2, :2])) < 1e-12:
        return None
    correction = affine_matrix @ np.linalg.inv(base)
    correction /= correction[2, 2]

    reference_world = np.mean(matched_world, axis=0)
    if spot_size_world is None or not np.isfinite(spot_size_world).all():
        spot_size_world = np.array([20.0, 20.0], dtype=float)
    centre_after = evaluate_coordinate_model(coordinate_model, reference_world[None, :])[0]
    vector_x = evaluate_coordinate_model(coordinate_model, (reference_world + [spot_size_world[0], 0])[None, :])[0] - centre_after
    vector_y = evaluate_coordinate_model(coordinate_model, (reference_world + [0, spot_size_world[1]])[None, :])[0] - centre_after
    final_validation = {
        "selected_degree": selected_degree,
        "passed": True,
        "holdout_fraction": float(holdout.mean()),
        "matched_count": int(len(matched_world)),
        "holdout_count": int(holdout.sum()),
        "selection_rule": "lowest passing degree; higher degree requires p95 improvement >=15% and regional p95 no worse than 10%",
        "candidates": [{"degree": int(item["degree"]), "validation": item["validation"], "health": item["health"]}
                       for item in candidate_results],
        "final_fit": {**_stats(final_residual), "regional": _regional_errors(final_residual, matched_indexed)},
        "geometry": final_health,
    }
    topology = {**topology, "matched_count": int(len(matched_world)),
                "unmatched_optical_count": int(len(optical_points) - len(matched_world)),
                "sbd_primary_count": int(len(original_primary))}
    return {
        "matrix": correction,
        "applied": True,
        "method": "connected optical lattice + sparse SBD outline + validated normalized polynomial",
        "display_mode": "smooth_global_lattice",
        "seed_name": "全幅清晰弹坑；从右下边界开始按相邻关系传播行列",
        "topology": topology,
        "outline_alignment": alignment,
        "optical_validation": final_validation,
        "lattice_vectors_after_px": [vector_x.astype(float).tolist(), vector_y.astype(float).tolist()],
        "spot_vectors_after_px": [vector_x.astype(float).tolist(), vector_y.astype(float).tolist()],
        "expected_grid_pitch_px": float(np.mean([np.linalg.norm(vector_x), np.linalg.norm(vector_y)])),
        "original_to_after": affine_matrix.tolist(),
        "world_to_original": world_to_original.tolist(),
        "coordinate_model": coordinate_model,
        "coordinate_model_points": all_after,
        "direction_validation": {
            "resolved": bool(alignment["orientation_resolved"]),
            "signs": alignment["signs"],
            "integer_offset": alignment["offset"],
            "margin_nodes": alignment["orientation_margin_nodes"],
            "evidence": "SBD sparse staircase outline matched against full optical lattice",
        },
        "per_spot_movement": "disabled; centres and all 20 μm footprint corners use one coordinate model",
        "response_role": "only confirms nodes; it does not re-index or move individual SBD spots",
        "coordinate_order": "xy",
    }
