import gzip
import hashlib
import io
import sqlite3
import threading
import time
from pathlib import Path

from PIL import Image
import pytest
from spatialbridge import app as spatialbridge_app

from spatialbridge.storage import Store
from fastapi.testclient import TestClient
from spatialbridge.app import create_app


def test_store_reuses_one_active_project_for_a_source(tmp_path):
    store = Store(tmp_path)
    first, reused_first = store.get_or_create_active("first", str(tmp_path / "source"))
    second, reused_second = store.get_or_create_active("second", str(tmp_path / "source"))

    assert reused_first is False
    assert reused_second is True
    assert first["id"] == second["id"] == "first"
    assert store.list_projects()[0]["source_dir"] == str(tmp_path / "source")


def test_saved_view_envelope_keeps_settings_and_old_values_are_readable(tmp_path):
    store = Store(tmp_path)
    project, _ = store.get_or_create_active("first", str(tmp_path / "source"))
    store.save_view(project["id"], {
        "version": 2,
        "viewport": {"x": 1, "y": 2, "zoom": 3},
        "settings": {"mode": "compare"},
    })
    assert store.get_view(project["id"]) == {
        "version": 2,
        "viewport": {"x": 1, "y": 2, "zoom": 3},
        "settings": {"mode": "compare"},
    }



def test_store_marks_interrupted_work_as_failed_on_restart(tmp_path):
    first = Store(tmp_path)
    first.create_project("queued", str(tmp_path / "source"))
    restarted = Store(tmp_path)

    project = restarted.get_project("queued")
    assert project is not None
    assert project["status"] == "failed"
    assert "中断" in project["error"]


def test_upload_assembly_recovers_after_restart_and_preserves_uploaded_chunks(tmp_path):
    first = Store(tmp_path)
    first.create_upload("upload-1", None, [{
        "id": "file-1", "role": "pre", "filename": "before.png", "size": 1,
        "chunk_size": 16 * 1024 * 1024, "total_chunks": 1,
    }])
    chunk = tmp_path / "uploads" / "upload-1" / "chunks" / "file-1" / "0"
    chunk.parent.mkdir(parents=True)
    chunk.write_bytes(b"x")
    first.record_chunk("upload-1", "file-1", 0, 1, hashlib.sha256(b"x").hexdigest(), str(chunk))
    assert first.mark_upload_assembling("upload-1") is True

    restarted = Store(tmp_path)
    upload = restarted.get_upload("upload-1")
    assert upload is not None
    assert upload["status"] == "failed"
    assert "服务重启" in upload["error"]
    assert [item["chunk_index"] for item in upload["files"][0]["chunks"]] == [0]
    assert chunk.read_bytes() == b"x"
    assert restarted.mark_upload_assembling("upload-1") is True


def test_assembling_upload_cannot_be_cancelled_while_files_are_being_merged(tmp_path):
    store = Store(tmp_path)
    store.create_upload("upload-1", None, [{
        "id": "file-1", "role": "pre", "filename": "before.png", "size": 1,
        "chunk_size": 16 * 1024 * 1024, "total_chunks": 1,
    }])
    assert store.mark_upload_assembling("upload-1") is True

    with pytest.raises(ValueError, match="assembling"):
        store.cancel_upload("upload-1")

    assert store.get_upload("upload-1")["status"] == "assembling"


def test_health_endpoint_reports_database_and_data_directory_state(tmp_path, monkeypatch):
    client = TestClient(create_app(tmp_path))
    assert client.get("/api/health").json() == {"status": "ok"}

    monkeypatch.setattr(Store, "check_health", lambda _self: False)
    assert TestClient(create_app(tmp_path / "unhealthy")).get("/api/health").status_code == 503


def test_built_frontend_serves_assets_and_spa_fallback_without_hiding_api_404s(tmp_path):
    frontend = tmp_path / "frontend"
    (frontend / "assets").mkdir(parents=True)
    (frontend / "index.html").write_text("<html>SpatialBridge</html>")
    (frontend / "assets" / "app.js").write_text("window.app = true;")
    client = TestClient(create_app(tmp_path / "data", frontend))

    assert client.get("/").text == "<html>SpatialBridge</html>"
    assert client.get("/assets/app.js").text == "window.app = true;"
    assert client.get("/workspace/project-1").text == "<html>SpatialBridge</html>"
    assert client.get("/api/does-not-exist").status_code == 404


def test_project_identity_fields_survive_progress_updates(tmp_path):
    store = Store(tmp_path)
    store.create_project("upload-project", str(tmp_path / "upload"), "我的项目", "upload", "upload-1")
    store.update_project("upload-project", "running", {"stage": "处理中"})

    project = store.get_project("upload-project")
    assert project is not None
    assert project["project_name"] == "我的项目"
    assert project["import_type"] == "upload"
    assert project["upload_id"] == "upload-1"


def test_project_list_omits_reports_that_the_project_endpoint_still_serves(tmp_path):
    app = create_app(tmp_path)
    store = Store(tmp_path)
    store.create_project("listed", str(tmp_path / "source"), "列表项目")
    store.update_project("listed", "ready", {"report": {"sources": []}})
    store.close()
    client = TestClient(app)

    listed = client.get("/api/projects").json()
    assert [item["id"] for item in listed] == ["listed"]
    assert listed[0]["status"] == "ready" and listed[0]["project_name"] == "列表项目"
    assert "report" not in listed[0]
    assert client.get("/api/projects/listed").json()["report"] == {"sources": []}
    assert "source_dir" not in client.get("/api/demo").json()


def test_view_api_preserves_unknown_saved_fields(tmp_path):
    app = create_app(tmp_path)
    store = Store(tmp_path)
    project, _ = store.get_or_create_active("ready", str(tmp_path))
    store.update_project(project["id"], "ready", {"report": {}})
    client = TestClient(app)

    store.save_view(project["id"], {"version": 1, "viewport": {"x": 1, "manualPoints": [{"id": "keep"}]}, "settings": {}})
    response = client.put(f"/api/projects/{project['id']}/view", json={"viewport": {"x": 2}, "settings": {"mode": "single"}})

    assert response.status_code == 200
    saved = client.get(f"/api/projects/{project['id']}/view").json()
    assert saved["viewport"]["x"] == 2
    assert saved["viewport"]["manualPoints"] == [{"id": "keep"}]


def test_import_rejects_blank_source_directory(tmp_path):
    client = TestClient(create_app(tmp_path))

    response = client.post("/api/projects", json={"source_dir": "   "})

    assert response.status_code == 400


def test_gzip_chunks_are_stored_decompressed_and_bounded_by_the_declared_size(tmp_path):
    client = TestClient(create_app(tmp_path))
    content = b"spatialbridge " * 4096
    upload = client.post("/api/uploads", json={"files": [
        {"role": "pre", "filename": "pre.png", "size": len(content)},
        {"role": "after", "filename": "after.png", "size": len(content)},
    ]}).json()
    first, second = upload["files"]
    url = f"/api/uploads/{upload['id']}/files/{{}}/chunks/0"
    digest = hashlib.sha256(content).hexdigest()
    packed = gzip.compress(content)
    assert len(packed) < len(content) // 10

    def put(file_id: str, body: bytes, encoding: str = "gzip"):
        return client.put(url.format(file_id), content=body,
                          headers={"Content-Encoding": encoding, "X-Chunk-SHA256": digest})

    assert put(first["id"], packed, "br").status_code == 415
    assert put(first["id"], packed[:-12]).status_code == 400
    assert put(first["id"], b"not gzip at all").status_code == 400
    assert put(first["id"], gzip.compress(content + b"overflow")).status_code == 413
    assert put(first["id"], gzip.compress(b"\0" * (64 * 1024 * 1024))).status_code == 413

    accepted = put(first["id"], packed)
    assert accepted.status_code == 200
    assert accepted.json()["size"] == len(content) and accepted.json()["sha256"] == digest
    assert (tmp_path / "uploads" / upload["id"] / "chunks" / first["id"] / "0").read_bytes() == content
    # A retry may switch encodings; the stored original bytes decide.
    assert client.put(url.format(first["id"]), content=content).json()["duplicate"] is True
    assert client.put(url.format(second["id"]), content=content).status_code == 200
    assert put(second["id"], packed).json()["duplicate"] is True


def test_upload_chunks_are_resumable_and_completion_is_idempotent(tmp_path):
    client = TestClient(create_app(tmp_path))
    image_path = tmp_path / "arbitrary-name.png"
    Image.new("RGB", (4, 4), (20, 40, 60)).save(image_path)
    content = image_path.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    response = client.post("/api/uploads", json={"project_name": "上传项目", "files": [
        {"role": "pre", "filename": "before.any-name.png", "size": len(content)},
        {"role": "after", "filename": "after.any-name.png", "size": len(content)},
    ]})
    assert response.status_code == 201
    upload = response.json()

    first = upload["files"][0]
    wrong = client.put(f"/api/uploads/{upload['id']}/files/{first['id']}/chunks/0", content=b"bad",
                       headers={"X-Chunk-SHA256": hashlib.sha256(b"bad").hexdigest()})
    assert wrong.status_code == 400
    assert client.get(f"/api/uploads/{upload['id']}").json()["files"][0]["uploaded_chunks"] == []

    for item in upload["files"]:
        uploaded = client.put(f"/api/uploads/{upload['id']}/files/{item['id']}/chunks/0", content=content,
                              headers={"X-Chunk-SHA256": digest})
        assert uploaded.status_code == 200
        duplicate = client.put(f"/api/uploads/{upload['id']}/files/{item['id']}/chunks/0", content=content,
                               headers={"X-Chunk-SHA256": digest})
        assert duplicate.status_code == 200
        assert duplicate.json()["duplicate"] is True

    completed = client.post(f"/api/uploads/{upload['id']}/complete")
    assert completed.status_code == 202
    project = completed.json()
    assert project["project_name"] == "上传项目"
    assert project["import_type"] == "upload"
    assert any((tmp_path / "uploads").joinpath(upload["id"], "files").rglob("before.any-name.png"))
    assert not (tmp_path / "uploads" / upload["id"] / "chunks").exists()
    repeated = client.post(f"/api/uploads/{upload['id']}/complete")
    assert repeated.status_code == 202
    assert repeated.json()["id"] == project["id"]
    assert repeated.json()["reused"] is True


def test_background_upload_assembly_is_idempotent_and_cleans_chunks(tmp_path, monkeypatch):
    built_projects = 0

    def build_project(_source_dir, _project_dir, progress, manifest):
        nonlocal built_projects
        built_projects += 1
        progress("处理完成")
        assert len(manifest) == 2
        return {"sources": []}

    monkeypatch.setattr(spatialbridge_app, "build_project", build_project)
    entered = threading.Event()
    release = threading.Event()
    original_replace = spatialbridge_app.os.replace

    def slow_replace(source, destination):
        if ".assembling-" in str(source):
            entered.set()
            assert release.wait(timeout=3)
        return original_replace(source, destination)

    monkeypatch.setattr(spatialbridge_app.os, "replace", slow_replace)
    app = create_app(tmp_path)
    with TestClient(app) as client:
        image = Image.new("RGB", (4, 4), (20, 40, 60))
        output = io.BytesIO()
        image.save(output, format="PNG")
        content = output.getvalue()
        upload = client.post("/api/uploads", json={"files": [
            {"role": "pre", "filename": "采集前.png", "size": len(content)},
            {"role": "after", "filename": "采集后.png", "size": len(content)},
        ]}).json()
        digest = hashlib.sha256(content).hexdigest()
        for item in upload["files"]:
            response = client.put(
                f"/api/uploads/{upload['id']}/files/{item['id']}/chunks/0",
                content=content, headers={"X-Chunk-SHA256": digest},
            )
            assert response.status_code == 200

        path = f"/api/uploads/{upload['id']}/complete?background=true"
        accepted = client.post(path)
        assert accepted.status_code == 202
        assert accepted.json()["status"] == "assembling"
        assert entered.wait(timeout=2)
        repeated = client.post(path)
        assert repeated.status_code == 202
        assert repeated.json()["id"] == upload["id"]
        assert repeated.json()["status"] == "assembling"
        release.set()

        for _ in range(300):
            current = client.get(f"/api/uploads/{upload['id']}").json()
            if current["status"] == "completed":
                break
            time.sleep(0.01)
        assert current["status"] == "completed"
        project_id = current["completed_project_id"]
        assert client.get(f"/api/projects/{project_id}").json()["status"] == "ready"
        repeated = client.post(path).json()
        assert repeated["id"] == project_id
        assert repeated["reused"] is True
        assert built_projects == 1
        assert not (tmp_path / "uploads" / upload["id"] / "chunks").exists()


def test_upload_rejects_path_names_and_cancel_removes_session(tmp_path):
    client = TestClient(create_app(tmp_path))
    response = client.post("/api/uploads", json={"files": [
        {"role": "pre", "filename": "../escape.png", "size": 1},
    ]})
    assert response.status_code == 400

    response = client.post("/api/uploads", json={"files": [
        {"role": "pre", "filename": "before.png", "size": 1},
    ]})
    assert response.status_code == 201
    upload_id = response.json()["id"]
    assert client.delete(f"/api/uploads/{upload_id}").status_code == 200
    assert client.get(f"/api/uploads/{upload_id}").status_code == 404


@pytest.mark.parametrize("legacy_chunks", [False, True])
def test_upload_resume_and_retry_after_data_directory_moves(tmp_path, monkeypatch, legacy_chunks):
    observed = []

    def build_project(source_dir, project_dir, progress, manifest):
        observed.append([item["path"] for item in manifest])
        assert all(Path(path).is_file() for path in observed[-1])
        return {"sources": [{"path": manifest[0]["path"]}]}

    monkeypatch.setattr(spatialbridge_app, "build_project", build_project)
    original = tmp_path / "original"
    moved = tmp_path / "moved"
    image = io.BytesIO()
    Image.new("RGB", (4, 4), "white").save(image, format="PNG")
    content = image.getvalue()
    with TestClient(create_app(original)) as client:
        upload = client.post("/api/uploads", json={"files": [
            {"role": "pre", "filename": "采集前.png", "size": len(content)},
            {"role": "after", "filename": "采集后.png", "size": len(content)},
        ]}).json()
        for item in upload["files"]:
            response = client.put(f'/api/uploads/{upload["id"]}/files/{item["id"]}/chunks/0', content=content)
            assert response.status_code == 200
    if legacy_chunks:
        with sqlite3.connect(original / "spatialbridge.sqlite") as db:
            for item in upload["files"]:
                old_path = original / "uploads" / upload["id"] / "chunks" / item["id"] / "0"
                db.execute("UPDATE upload_chunks SET path=? WHERE upload_id=? AND file_id=?",
                           (str(old_path), upload["id"], item["id"]))
    original.rename(moved)
    with TestClient(create_app(moved)) as client:
        completed = client.post(f'/api/uploads/{upload["id"]}/complete')
        assert completed.status_code == 202
        project = completed.json()
        assert project["source_dir"].startswith("data://uploads/")
        for _ in range(300):
            result = client.get(f'/api/projects/{project["id"]}').json()
            if result["status"] in {"ready", "failed"}:
                break
            time.sleep(0.01)
        assert result["status"] == "ready"
        assert result["report"]["sources"][0]["path"].startswith("data://uploads/")
    final = tmp_path / "final"
    moved.rename(final)
    with TestClient(create_app(final)) as client:
        retried = client.post(f'/api/projects/{project["id"]}/retry')
        assert retried.status_code == 202
    assert len(observed) == 2
    assert all(str(final) in path for path in observed[-1])


@pytest.mark.parametrize("preview_reference", ["project://cache/preview.png", "/old/location/projects/demo/cache/preview.png"])
def test_moved_project_can_render_its_cached_preview(tmp_path, preview_reference):
    data = tmp_path / "moved"
    preview = data / "projects" / "demo" / "cache" / "preview.png"
    preview.parent.mkdir(parents=True)
    Image.new("RGB", (32, 32), "red").save(preview)
    store = Store(data)
    store.create_project("demo", "/external/source")
    store.update_project("demo", "ready", {"report": {
        "sources": [{"key": "pre", "role": "microscopy_pre", "path": "/missing/source.png",
                     "width": 32, "height": 32, "preview_path": preview_reference, "preview_scale": 1.0}],
        "registrations": [{"source_key": "pre", "status": "passed", "matrix": [[1, 0, 0], [0, 1, 0], [0, 0, 1]]}],
    }})
    store.close()
    with TestClient(create_app(data)) as client:
        response = client.get("/api/projects/demo/layers/pre/tiles/0/0/0.png")
        assert response.status_code == 200
        assert response.headers["content-type"] == "image/png"
