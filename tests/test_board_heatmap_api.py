import io

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image

from spatialbridge import app as app_module
from spatialbridge.storage import Store
from spatialbridge.heatmap import crop_board_reference


def test_board_crop_excludes_other_regions_and_preserves_coordinate_frame():
    board = np.zeros((600, 1200, 3), dtype=np.uint8)
    board[120, 300] = [30, 140, 60]
    matrix = np.array([[1., 0., 200.], [0., 1., 100.], [0., 0., 1.]])
    image, cropped_matrix = crop_board_reference(
        board, matrix, np.array([100., 300., 900.]), np.array([20., 80., 400.]),
        np.array([True, True, False]),
    )
    assert image.shape == (188, 328, 3)
    point = cropped_matrix @ np.array([100., 20., 1.])
    assert np.allclose(point, [64., 64., 1.])
    assert image[int(point[1]), int(point[0])].tolist() == [30, 140, 60]


def test_heatmap_upload_uses_sbd_board_and_its_coordinate_frame(tmp_path, monkeypatch):
    data_dir = tmp_path / "data"
    project_dir = data_dir / "projects" / "board-project"
    project_dir.mkdir(parents=True)
    board = project_dir / "board.png"
    Image.new("RGB", (24, 24), (130, 130, 130)).save(board)
    np.savez_compressed(project_dir / "spots.npz", spot_id=np.arange(12), raster=np.zeros(12, dtype=int),
                        world_x=np.arange(12) + 2, world_y=np.full(12, 3), mapped=np.ones(12, dtype=bool))
    world_to_board = [[1, 0, 4], [0, 1, 0], [0, 0, 1]]
    store = Store(data_dir)
    store.create_project("board-project", "data://uploads/u1", "Board import", "upload", "u1")
    store.update_project("board-project", "ready", {"report": {"spatial_mapping": {
        "available": True, "alignment_reference": "sbd_board", "spot_cache": "spots.npz", "primary_raster": 0,
        "heatmap": {}, "board": {"path": "project://board.png"},
        "matrices": {"world_to_board": world_to_board, "world_to_heat": (np.eye(3) * 100).tolist()},
    }}})
    store.close()
    calls = []

    def match(source, reference):
        assert reference[0, 0].tolist() == [130, 130, 130]
        calls.append(True)
        return {"matrix": np.array([[1., 0., 2.], [0., 1., 0.], [0., 0., 1.]]),
                "mirrored": False, "rotation_degrees": 0, "inliers": 100,
                "error_p95_px": .1, "coverage": .8}

    monkeypatch.setattr(app_module, "match_heatmap", match)
    pixels = np.zeros((24, 24, 3), dtype=np.uint8)
    pixels[:] = [20, 100, 60]
    pixels[:, :, 1] += np.arange(24, dtype=np.uint8)
    output = io.BytesIO()
    Image.fromarray(pixels).save(output, "PNG")
    with TestClient(app_module.create_app(data_dir)) as client:
        result = client.post("/api/projects/board-project/heatmap", data={"label": "Ion map"},
                             files={"file": ("ion.png", output.getvalue(), "image/png")})
        assert result.status_code == 200, result.text
        assert result.json()["sampled_spots"] == 12
        assert result.json()["mapped_spots"] == 12
        assert client.get("/api/projects/board-project/heatmap").json()["label"] == "Ion map"
        colors = client.get("/api/projects/board-project/heatmap/colors?raster=0")
        assert colors.status_code == 200
        assert colors.json()["items"][0] == [0, 20, 104, 60]
        assert len(calls) == 1


def test_heatmap_upload_still_requires_sbd_mapping(tmp_path):
    data_dir = tmp_path / "data"
    store = Store(data_dir)
    store.create_project("unmapped", "data://uploads/u1", "Unmapped", "upload", "u1")
    store.update_project("unmapped", "ready", {"report": {"spatial_mapping": {
        "available": False, "board": {"path": "project://board.png"},
        "matrices": {"world_to_board": np.eye(3).tolist()},
    }}})
    store.close()
    with TestClient(app_module.create_app(data_dir)) as client:
        result = client.post("/api/projects/unmapped/heatmap",
                             files={"file": ("ion.png", b"unused", "image/png")})
        assert result.status_code == 400
        assert "SBD" in result.json()["detail"]
