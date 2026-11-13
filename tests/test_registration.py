from io import BytesIO

import numpy as np
import pytest
from PIL import Image

from spatialbridge import registration
from spatialbridge.integration import _coordinate_chain_validation, _detect_burn_pits, _matrix_2d
from spatialbridge.registration import RegistrationError, find_inputs, similarity, transform_points
from spatialbridge.tiles import build_tile_pyramid, pyramid_tile, read_pyramid_region


def test_similarity_maps_landmarks_and_preserves_inverse():
    source = np.array([[0., 0.], [10., 0.]])
    target = np.array([[5., 2.], [5., 22.]])
    matrix = similarity(source, target)
    assert np.allclose(transform_points(matrix, source), target)
    assert np.allclose(transform_points(np.linalg.inv(matrix), target), source)


def test_similarity_rejects_degenerate_landmarks():
    with pytest.raises(RegistrationError, match="degenerate"):
        similarity(np.array([[1., 1.], [1., 1.]]), np.array([[0., 0.], [2., 0.]]))


def test_browser_preview_falls_back_when_sips_is_unavailable(tmp_path, monkeypatch):
    source = tmp_path / "source.png"
    Image.new("RGB", (100, 40), (128, 128, 128)).save(source)

    def missing_sips(*args, **kwargs):
        raise OSError("sips is not installed")

    monkeypatch.setattr(registration.subprocess, "run", missing_sips)
    preview, scale = registration.make_browser_preview(source, tmp_path / "cache")

    assert preview is not None
    assert scale == 1
    with Image.open(preview) as image:
        assert image.size == (100, 40)


def test_find_inputs_only_requires_the_two_microscopy_pngs(tmp_path):
    microscopy = tmp_path / "MALDI-显微图"
    microscopy.mkdir()
    Image.new("L", (12, 8)).save(microscopy / "pre-madle.png")
    Image.new("L", (12, 8)).save(microscopy / "after-madle.png")

    inputs = find_inputs(tmp_path)

    assert inputs["pre"].name == "pre-madle.png"
    assert inputs["after"].name == "after-madle.png"
    assert inputs["maldi_data"] is None
    assert inputs["board_files"] == []
    assert inputs["heatmaps"] == []


def test_find_inputs_prefers_an_uploaded_manifest_with_arbitrary_names(tmp_path):
    pre = tmp_path / "before-image.png"
    after = tmp_path / "after-image.png"
    board = tmp_path / "board-scan.tiff"
    heatmap = tmp_path / "signal.png"
    for path in (pre, after, board, heatmap):
        Image.new("L", (12, 8)).save(path)
    sbd = tmp_path / "measurement.sbd"
    sbd.write_bytes(b"placeholder")

    inputs = find_inputs(tmp_path, [
        {"role": "pre", "filename": pre.name, "path": str(pre)},
        {"role": "after", "filename": after.name, "path": str(after)},
        {"role": "sbd", "filename": sbd.name, "path": str(sbd)},
        {"role": "board", "filename": board.name, "path": str(board)},
        {"role": "heatmap", "filename": heatmap.name, "path": str(heatmap)},
    ])

    assert inputs["pre"] == pre
    assert inputs["after"] == after
    assert inputs["maldi_data"] == sbd
    assert inputs["board_files"] == [board]
    assert inputs["heatmaps"] == [heatmap]


def test_sbd_reference_matrix_parser_keeps_translation():
    matrix = _matrix_2d("1, 0, 0, 17\n0, -1, 0, 23\n0, 0, 1, 0\n0, 0, 0, 1")
    assert matrix is not None
    assert np.allclose(matrix, [[1, 0, 17], [0, -1, 23], [0, 0, 1]])


def test_coordinate_validation_keeps_xy_order_and_roundtrips():
    world = np.array([[0., 0.], [10., 5.], [20., 15.]])
    matrices = {
        "world_to_board": np.array([[2., 0., 3.], [0., 2., 20.], [0., 0., 1.]]),
        "board_to_heat": np.eye(3),
        "world_to_heat": np.array([[2., 0., 3.], [0., 2., 20.], [0., 0., 1.]]),
        "heat_to_pre": np.eye(3),
        "heat_to_after": np.eye(3),
        "world_to_pre": np.array([[2., 0., 3.], [0., 2., 20.], [0., 0., 1.]]),
        "world_to_after": np.array([[2., 0., 3.], [0., 2., 20.], [0., 0., 1.]]),
        "after_to_pre": np.eye(3),
    }
    result = _coordinate_chain_validation(world, np.array([0, 1, 1]), matrices,
                                          {"board": (100, 100), "heat": (100, 100),
                                           "pre": (100, 100), "after": (100, 100)})

    assert result["coordinate_convention"]["point_order"] == "xy"
    assert result["coordinate_convention"]["image_array_order"] == "yx"
    assert result["roundtrip_px"]["world_to_after"]["p95_px"] < 1e-8
    assert sum(item["after"]["inside_count"] for item in result["coverage_by_raster"]) == 3


def test_burn_pit_detector_confirms_bright_square_candidates(tmp_path):
    image = Image.new("L", (240, 180), 20)
    pixels = image.load()
    for centre_x, centre_y in [(60, 60), (170, 120)]:
        for y in range(centre_y - 6, centre_y + 7):
            for x in range(centre_x - 6, centre_x + 7):
                pixels[x, y] = 230
    source = tmp_path / "after.png"
    image.save(source)
    result = _detect_burn_pits(
        source,
        np.array([[60., 60.], [170., 120.]]),
        np.array([0, 0], dtype=np.int32),
        np.array([[10., 10.], [10., 10.]], dtype=np.float32),
        np.array([[2., 0., 0.], [0., 2., 0.], [0., 0., 1.]]),
    )
    assert result["candidate_count"] == 2
    assert result["detected_count"] >= 1
    assert result["primary_raster"] == 0
    assert np.allclose(result["spot_size_world"], [10., 10.])
    assert np.allclose(result["spot_size_after_px"], [20., 20.])
    assert np.allclose(result["spot_vectors_after_px"], [[20., 0.], [0., 20.]])
    assert result["response_kernel"]["search_radius_small"] < result["expected_grid_pitch_px"] / 2
    assert np.isfinite(result["scores"]).all()


def test_burn_pit_detector_rejects_flat_image(tmp_path):
    source = tmp_path / "flat.png"
    Image.new("L", (120, 80), 80).save(source)

    result = _detect_burn_pits(
        source,
        np.array([[20., 20.], [60., 40.]]),
        np.array([0, 0], dtype=np.int32),
        np.array([[10., 10.], [10., 10.]], dtype=np.float32),
        np.eye(3),
    )

    assert result["detected_count"] == 0
    assert result["threshold"] == 2.0


def test_tile_pyramid_builds_levels_and_renders_registered_tile(tmp_path):
    source = tmp_path / "source.png"
    image = Image.new("L", (300, 140))
    for y in range(image.height):
        for x in range(image.width):
            image.putpixel((x, y), (x + y) % 256)
    image.save(source)

    pyramid = build_tile_pyramid(source, tmp_path / "pyramid", "test-sha")

    assert pyramid["max_level"] == 9
    assert (tmp_path / "pyramid" / "manifest.json").is_file()
    assert (tmp_path / "pyramid" / "9" / "0" / "0.png").is_file()
    region = read_pyramid_region(tmp_path / "pyramid", 9, (10, 20, 30, 40))
    assert region.shape == (20, 20, 4)
    assert int(region[0, 0, 0]) == 30

    rendered = pyramid_tile(tmp_path / "pyramid", np.eye(3).tolist(), (300, 140), 9, 0, 0)
    with Image.open(BytesIO(rendered)) as tile:
        assert tile.size == (256, 256)
        assert tile.mode == "RGBA"


def test_board_image_embedded_in_sbd_is_extracted_with_its_matrix(tmp_path):
    h5py = pytest.importorskip("h5py")
    from spatialbridge.integration import _extract_embedded_board

    buffer = BytesIO()
    Image.new("RGB", (40, 20), (10, 120, 200)).save(buffer, "PNG")
    matrix = np.array([[2.0, 0.0, 0.0, 5.0], [0.0, -2.0, 0.0, 7.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]])
    sbd = tmp_path / "sample.sbd"
    with h5py.File(sbd, "w") as handle:
        overview = handle.create_group("OpticalImages/a-overview")
        overview.attrs["name"] = b"Overview Image"
        overview["ImageData"] = np.frombuffer(buffer.getvalue(), dtype=np.int8)
        overview["World2Px"] = np.eye(4)
        board = handle.create_group("OpticalImages/b-board")
        board.attrs["name"] = b"20260825-0000_multires"
        board["ImageData"] = np.frombuffer(buffer.getvalue(), dtype=np.int8)
        board["World2Px"] = matrix

    extracted = _extract_embedded_board(sbd, tmp_path / "cache")

    assert extracted is not None
    path, world_to_board = extracted
    with Image.open(path) as image:
        assert image.size == (40, 20)
    assert np.allclose(world_to_board, [[2.0, 0.0, 5.0], [0.0, -2.0, 7.0], [0.0, 0.0, 1.0]])

    with h5py.File(tmp_path / "empty.sbd", "w") as handle:
        handle.create_group("OpticalImages")
    assert _extract_embedded_board(tmp_path / "empty.sbd", tmp_path / "cache") is None
