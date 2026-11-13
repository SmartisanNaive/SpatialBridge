import cv2
import numpy as np
import pytest

from spatialbridge.heatmap import HeatmapRegistrationError, match_heatmap, sample_spot_colours


def textured_reference():
    rng = np.random.default_rng(42)
    image = np.full((640, 900, 3), 100, np.uint8)
    for _ in range(1400):
        x, y = int(rng.integers(8, 892)), int(rng.integers(8, 632))
        value = int(rng.integers(15, 245))
        cv2.circle(image, (x, y), int(rng.integers(2, 9)), (value, value, value), -1)
    return image


@pytest.mark.parametrize("turns,mirror", [(0, False), (1, False), (2, True), (3, True)])
def test_match_heatmap_handles_rotation_and_mirror(turns, mirror):
    reference = textured_reference()
    source = np.ascontiguousarray(np.rot90(reference, turns))
    if mirror:
        source = cv2.flip(source, 1)
    result = match_heatmap(source, reference)
    aligned = cv2.warpPerspective(source, result["matrix"], (reference.shape[1], reference.shape[0]))
    assert np.mean(np.abs(aligned.astype(float) - reference.astype(float))) < 4
    assert result["error_p95_px"] < 1
    assert result["inliers"] >= 30
    assert result["mirrored"] == mirror


def test_match_heatmap_rejects_missing_texture():
    with pytest.raises(HeatmapRegistrationError):
        match_heatmap(np.zeros((400, 600, 3), np.uint8), textured_reference())


def test_spot_sampling_returns_image_colours_without_inventing_intensity():
    image = np.full((12, 12, 3), [85, 5, 70], np.uint8)  # BGR, purple signal
    image[1, 1] = [128, 128, 128]  # board background
    image[2, 2] = [0, 0, 255]  # red border
    colors, valid = sample_spot_colours(image, np.eye(3), np.eye(3),
                                        np.array([8, 1, 2, 20]), np.array([8, 1, 2, 3]),
                                        np.ones(4, dtype=bool))
    assert valid.tolist() == [True, False, False, False]
    assert colors[0].tolist() == [70, 5, 85]


def test_antialiased_red_border_is_not_used_as_heatmap_signal():
    image = np.full((16, 24, 3), [85, 5, 70], np.uint8)
    image[3, :] = [51, 51, 153]  # solid red ROI outline
    image[4, :] = [67, 27, 113]  # red-purple antialiased border
    colors, valid = sample_spot_colours(image, np.eye(3), np.eye(3),
                                        np.array([10, 10, 10]), np.array([3, 4, 8]),
                                        np.ones(3, dtype=bool))
    assert valid.tolist() == [False, False, True]
    assert colors[2].tolist() == [70, 5, 85]
