import io
import json

import numpy as np
from PIL import Image
from fastapi.testclient import TestClient

from spatialbridge import app as app_module
from spatialbridge.storage import Store


def png_bytes(color):
    output = io.BytesIO()
    Image.new("RGB", (24, 24), color).save(output, "PNG")
    return output.getvalue()


def test_demo_initializes_default_heatmap_and_preserves_manual_upload(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    demo = tmp_path / "参考数据"
    default = demo / app_module.DEMO_HEATMAP
    default.parent.mkdir(parents=True)
    default.write_bytes(png_bytes((70, 5, 85)))
    reference = demo / "reference.png"
    reference.write_bytes(png_bytes((130, 130, 130)))
    data_dir = tmp_path / "data"
    project_dir = data_dir / "projects" / "demo"
    project_dir.mkdir(parents=True)
    np.savez_compressed(project_dir / "spots.npz", spot_id=np.arange(12), raster=np.zeros(12, dtype=int),
                        world_x=np.arange(12) + 2, world_y=np.full(12, 3), mapped=np.ones(12, dtype=bool))
    store = Store(data_dir)
    store.create_project("demo", str(demo), "内置示例", "directory")
    store.update_project("demo", "ready", {"report": {"spatial_mapping": {
        "available": True, "spot_cache": "spots.npz", "primary_raster": 0,
        "heatmap": {"path": str(reference)}, "matrices": {"world_to_heat": np.eye(3).tolist()},
    }}})
    store.close()
    calls = []

    def match(_source, _reference):
        calls.append(True)
        return {"matrix": np.eye(3), "mirrored": False, "rotation_degrees": 0,
                "inliers": 100, "error_p95_px": .1, "coverage": .8}

    monkeypatch.setattr(app_module, "match_heatmap", match)
    with TestClient(app_module.create_app(data_dir)) as client:
        first = client.get("/api/projects/demo/heatmap")
        assert first.status_code == 200
        assert first.json()["label"] == "726.5025 m/z"
        assert first.json()["filename"] == "hotspot_726.5025-stitched.png"
        colors = client.get("/api/projects/demo/heatmap/colors?raster=0").json()["items"]
        assert len(colors) == 12
        assert colors[0] == [0, 70, 5, 85]
        assert len(calls) == 1
        # An earlier built-in default is replaced by the configured one.
        metadata_path = project_dir / "heatmap" / "active.json"
        earlier = json.loads(metadata_path.read_text())
        assert earlier["origin"] == "demo_default"
        metadata_path.write_text(json.dumps({**earlier, "filename": "hot.png", "label": "旧默认"}))
        assert client.get("/api/projects/demo/heatmap").json()["label"] == "726.5025 m/z"
        legacy = {key: value for key, value in earlier.items() if key != "origin"}
        metadata_path.write_text(json.dumps({**legacy, "filename": "hot.png", "label": "hot.png"}))
        assert client.get("/api/projects/demo/heatmap").json()["label"] == "726.5025 m/z"
        calls.clear()
        calls.append(True)
        manual = client.post("/api/projects/demo/heatmap", data={"label": "自选热图"},
                             files={"file": ("other.png", png_bytes((10, 50, 150)), "image/png")})
        assert manual.status_code == 200
        assert client.get("/api/projects/demo/heatmap").json()["label"] == "自选热图"
        assert len(calls) == 2
        metadata_path = project_dir / "heatmap" / "active.json"
        metadata = json.loads(metadata_path.read_text())
        metadata.pop("sampling_version")
        metadata_path.write_text(json.dumps(metadata))
        assert client.get("/api/projects/demo/heatmap/colors").status_code == 409
        refreshed = client.get("/api/projects/demo/heatmap").json()
        assert refreshed["label"] == "自选热图"
        assert refreshed["sampling_version"] == app_module.SAMPLING_VERSION
        assert len(calls) == 3
        assert client.get("/api/projects/demo/heatmap/colors").status_code == 200
        invalid = client.post("/api/projects/demo/heatmap", files={"file": ("bad.png", b"bad", "image/png")})
        assert invalid.status_code == 400
        assert client.get("/api/projects/demo/heatmap").json()["label"] == "自选热图"


def test_heatmap_supplied_with_the_project_is_shown_without_a_second_upload(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    data_dir = tmp_path / "data"
    project_dir = data_dir / "projects" / "uploaded"
    project_dir.mkdir(parents=True)
    reference = data_dir / "uploads" / "u1" / "files" / "f1" / "hotspot_563.5022.png"
    reference.parent.mkdir(parents=True)
    reference.write_bytes(png_bytes((20, 160, 90)))
    np.savez_compressed(project_dir / "spots.npz", spot_id=np.arange(12), raster=np.zeros(12, dtype=int),
                        world_x=np.arange(12) + 2, world_y=np.full(12, 3), mapped=np.ones(12, dtype=bool))
    store = Store(data_dir)
    store.create_project("uploaded", "data://uploads/u1", "上传项目", "upload", "u1")
    store.update_project("uploaded", "ready", {"report": {"spatial_mapping": {
        "available": True, "spot_cache": "spots.npz", "primary_raster": 0,
        "heatmap": {"path": "data://uploads/u1/files/f1/hotspot_563.5022.png",
                    "filename": "hotspot_563.5022.png", "mz": "563.5022"},
        "matrices": {"world_to_heat": np.eye(3).tolist()},
    }}})
    store.close()
    calls = []

    def match(_source, _reference):
        calls.append(True)
        return {"matrix": np.eye(3), "mirrored": False, "rotation_degrees": 0,
                "inliers": 100, "error_p95_px": .1, "coverage": .8}

    monkeypatch.setattr(app_module, "match_heatmap", match)
    with TestClient(app_module.create_app(data_dir)) as client:
        shown = client.get("/api/projects/uploaded/heatmap").json()
        assert shown["available"] is True
        assert shown["filename"] == "hotspot_563.5022.png" and shown["label"] == "563.5022 m/z"
        assert client.get("/api/projects/uploaded/heatmap/colors?raster=0").json()["items"][0] == [0, 20, 160, 90]
        assert client.get("/api/projects/uploaded/heatmap").json()["available"] is True
        assert len(calls) == 1
