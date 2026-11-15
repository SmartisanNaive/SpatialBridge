"""SBD optical-reference alignment must work without an ion heat map."""
import numpy as np
import pytest
from PIL import Image, ImageDraw

from spatialbridge.integration import _board_to_microscopy, build_spatial_mapping
from spatialbridge.registration import RegistrationError, transform_points


def make_board(path):
    image = Image.new("L", (1400, 800), 255)
    draw = ImageDraw.Draw(image)
    for x, y in [(100, 200), (700, 200), (100, 650), (1200, 650)]:
        draw.ellipse((x - 45, y - 45, x + 45, y + 45), fill=0)
        draw.rectangle((x - 15, y - 15, x + 15, y + 15), fill=255)
    image.save(path)
    return image


def test_board_alignment_selects_primary_region_instead_of_widest_marker_pair(tmp_path):
    board = tmp_path / "board.png"
    after = tmp_path / "after.png"
    make_board(board).crop((0, 0, 800, 400)).save(after)
    world = np.array([[x, y] for x in range(180, 640, 20) for y in range(170, 231, 20)], dtype=float)
    result = _board_to_microscopy(board, after, np.eye(3), world,
                                  np.zeros(len(world), dtype=int), np.array([[20., 20.]]))
    assert result.metric["primary_coverage"] == 1.0
    assert np.allclose(transform_points(np.asarray(result.matrix), world), world, atol=1)


def test_board_alignment_rejects_region_outside_microscopy(tmp_path):
    board = tmp_path / "board.png"
    after = tmp_path / "after.png"
    make_board(board).crop((0, 0, 800, 400)).save(after)
    world = np.array([[10000., 10000.], [10020., 10020.]])
    with pytest.raises(RegistrationError, match="可靠对应关系"):
        _board_to_microscopy(board, after, np.eye(3), world,
                            np.zeros(2, dtype=int), np.array([[20., 20.]]))


def test_three_file_import_checks_embedded_board_without_requiring_heatmap(tmp_path):
    h5py = pytest.importorskip("h5py")
    sbd = tmp_path / "sample.sbd"
    with h5py.File(sbd, "w") as handle:
        handle.create_group("OpticalImages")
    result, artifacts = build_spatial_mapping(tmp_path, tmp_path / "pre.png", tmp_path / "after.png",
                                              sbd, [], [], np.eye(3).tolist())
    assert not result["available"]
    assert "内嵌板图" in result["reason"]
    assert "热图" not in result["reason"]
    assert artifacts is None
