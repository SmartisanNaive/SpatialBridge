from __future__ import annotations

import asyncio
import csv
import errno
import hashlib
import io
import os
import logging
import math
import threading
import json
import re
import shutil
import uuid
import zlib
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
import cv2
import numpy as np
from PIL import Image
from pydantic import BaseModel, Field

from .heatmap import SAMPLING_VERSION, HeatmapRegistrationError, crop_board_reference, match_heatmap, sample_spot_colours
from .lattice import evaluate_coordinate_model
from .registration import build_project, find_inputs, make_browser_preview, make_quick_preview_thumbnail
from .storage import Store
from .sbd import materialize_sbd_package, validate_sbd_extract
from .tiles import blank_tile, build_tile_pyramid, common_tile, pyramid_tile

logger = logging.getLogger(__name__)


class ImportRequest(BaseModel):
    source_dir: str


class UploadFileRequest(BaseModel):
    role: str
    filename: str
    size: int


class UploadCreateRequest(BaseModel):
    project_name: str | None = None
    files: list[UploadFileRequest]


class ViewRequest(BaseModel):
    viewport: dict
    settings: dict[str, Any] = Field(default_factory=dict)
    version: int = 2


# Heat map shown for the built-in demo project, relative to the demo data.
DEMO_HEATMAP = Path("1112-热图") / "hotspot_726.5025-stitched.png"
DEMO_HEATMAP_LABEL = "726.5025 m/z"


def create_app(data_dir: Path, frontend_dir: Path | None = None) -> FastAPI:
    data_dir = data_dir.expanduser().resolve()
    store = Store(data_dir)
    processing_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="spatialbridge-worker")
    assembly_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="spatialbridge-upload")
    background_tasks: set[asyncio.Task[None]] = set()
    upload_locks: dict[str, asyncio.Lock] = {}
    preview_lock = threading.Lock()
    heatmap_lock = threading.Lock()
    pyramid_lock = threading.Lock()
    spot_arrays_lock = threading.Lock()
    spot_arrays_cache: dict[str, tuple[int, dict[str, np.ndarray]]] = {}
    rendered_tile_locks: dict[str, threading.Lock] = {}
    rendered_tile_locks_guard = threading.Lock()
    # Bump when the registered tile renderer changes.  v3 preserves the full
    # homography instead of serving the old affine-only tile cache.
    rendered_tile_cache_version = "v3"
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        pending: set[asyncio.Task[None]] = set()
        deadline = asyncio.get_running_loop().time() + 55
        while tasks := {task for task in background_tasks if not task.done()}:
            remaining = deadline - asyncio.get_running_loop().time()
            if remaining <= 0:
                pending = tasks
                break
            _, pending = await asyncio.wait(tasks, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
            if pending and len(pending) == len(tasks):
                break
        if pending:
            for task in pending:
                task.cancel()
            processing_pool.shutdown(wait=False, cancel_futures=True)
            assembly_pool.shutdown(wait=False, cancel_futures=True)
            logger.warning("Stopping with %d background task(s) still running", len(pending))
        else:
            processing_pool.shutdown(wait=True, cancel_futures=True)
            assembly_pool.shutdown(wait=True, cancel_futures=True)
        store.close()

    app = FastAPI(title="SpatialBridge", version="0.1.0", lifespan=lifespan)
    app.add_middleware(CORSMiddleware, allow_origin_regex=r"https?://(localhost|127\.0\.0\.1):\d+$", allow_methods=["*"], allow_headers=["*"])

    def schedule(coroutine: Any) -> None:
        task = asyncio.create_task(coroutine)
        background_tasks.add(task)
        task.add_done_callback(background_tasks.discard)

    def upload_assembly_error(error: OSError) -> str:
        if error.errno == errno.ENOSPC:
            return "服务器磁盘空间不足，已上传分片已保留；清理磁盘后可重新提交。"
        return "文件合并失败，请重试。"

    def demo_source_dir() -> Path | None:
        candidates = [
            Path.cwd() / "参考数据",
            Path(__file__).resolve().parents[2] / "参考数据",
            data_dir.parent / "参考数据",
        ]
        return next((candidate.resolve() for candidate in candidates if candidate.is_dir()), None)

    def rooted_path(root: Path, relative: str) -> Path:
        path = Path(relative)
        if path.is_absolute() or ".." in path.parts:
            raise ValueError("Invalid stored relative path")
        result = (root / path).resolve()
        if not result.is_relative_to(root.resolve()):
            raise ValueError("Stored path escapes its root")
        return result

    def data_reference(path: Path) -> str:
        return "data://" + path.resolve().relative_to(data_dir).as_posix()

    def project_reference(project_id: str, path: Path) -> str:
        root = data_dir / "projects" / project_id
        return "project://" + path.resolve().relative_to(root.resolve()).as_posix()

    def resolve_project_file(value: str, project_id: str | None = None) -> Path:
        if value.startswith("data://"):
            return rooted_path(data_dir, value[len("data://"):])
        if value.startswith("project://"):
            if not project_id:
                raise ValueError("Project path requires a project ID")
            return rooted_path(data_dir / "projects" / project_id, value[len("project://"):])
        path = Path(value).expanduser()
        if path.is_absolute():
            # Old reports used absolute paths for generated project caches.
            # Rebase only paths that include this exact project ID and a known
            # generated directory; external source paths are never guessed.
            parts = path.parts
            if project_id:
                for index in range(len(parts) - 2):
                    if parts[index:index + 2] == ("projects", project_id) and parts[index + 2] in {"cache", "pyramids"}:
                        candidate = rooted_path(data_dir / "projects" / project_id, Path(*parts[index + 2:]).as_posix())
                        if candidate.exists():
                            return candidate
                project = store.get_project(project_id)
                upload_id = project.get("upload_id") if project else None
                if upload_id:
                    for index in range(len(parts) - 2):
                        if parts[index:index + 3] == ("uploads", upload_id, "files"):
                            candidate = rooted_path(data_dir / "uploads" / upload_id, Path(*parts[index + 2:]).as_posix())
                            if candidate.exists():
                                return candidate
            return path
        candidates = [(data_dir.parent / path).resolve(), (data_dir / path).resolve(), (Path.cwd() / path).resolve()]
        return next((candidate for candidate in candidates if candidate.exists()), candidates[0])

    def upload_file_path(upload_id: str, item: dict) -> Path:
        # Upload locations are determined by server-issued IDs and the stored
        # filename, including for records written before paths were relative.
        root = data_dir / "uploads" / upload_id
        return rooted_path(root, f'files/{item["file_id"]}/{item["filename"]}')

    def portable_report(report: dict) -> dict:
        # Only application-owned paths are rewritten; external inputs and SBD
        # provenance retain their original meaning.
        def convert(value: Any) -> Any:
            if isinstance(value, dict):
                return {key: convert(item) if key in {"path", "preview_path", "tile_pyramid_path"} or isinstance(item, (dict, list)) else item
                        for key, item in value.items()}
            if isinstance(value, list):
                return [convert(item) for item in value]
            if isinstance(value, str):
                path = Path(value)
                if path.is_absolute() and path.resolve().is_relative_to(data_dir):
                    return data_reference(path)
            return value
        return convert(report)

    def ensure_tile_pyramid(project_id: str, source: dict, report: dict) -> Path:
        """Backfill pyramids for projects created before the tile-pyramid upgrade."""
        existing = source.get("tile_pyramid_path")
        if existing:
            existing_path = resolve_project_file(existing, project_id)
            if (existing_path / "manifest.json").is_file():
                return existing_path
        source_path = resolve_project_file(source["path"], project_id)
        source_sha256 = source.get("sha256")
        suffix = str(source_sha256)[:16] if source_sha256 else "legacy"
        pyramid_dir = data_dir / "projects" / project_id / "pyramids" / f'{source["key"]}-{suffix}'
        with pyramid_lock:
            existing = source.get("tile_pyramid_path")
            if existing:
                existing_path = resolve_project_file(existing, project_id)
                if (existing_path / "manifest.json").is_file():
                    return existing_path
            pyramid = build_tile_pyramid(source_path, pyramid_dir, source_sha256)
            source["tile_pyramid_path"] = project_reference(project_id, Path(pyramid["path"]))
            source["tile_pyramid_max_level"] = int(pyramid["max_level"])
            source.setdefault("tile_size", int(pyramid["tile_size"]))
            report["schema_version"] = max(int(report.get("schema_version", 1)), 2)
            store.update_project(project_id, "ready", {"report": report})
            try:
                (data_dir / "projects" / project_id / "report.json").write_text(
                    json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
                )
            except OSError:
                logger.exception("Could not persist upgraded report: %s", project_id)
            return Path(pyramid["path"])

    def rendered_tile_lock(cache_path: Path) -> threading.Lock:
        key = str(cache_path)
        with rendered_tile_locks_guard:
            return rendered_tile_locks.setdefault(key, threading.Lock())

    def rendered_tile_path(project_id: str, layer: str, z: int, x: int, y: int) -> Path:
        return (data_dir / "projects" / project_id / f"rendered-tiles-{rendered_tile_cache_version}" /
                layer / str(z) / str(x) / f"{y}.png")

    async def work(project_id: str, source_dir: Path, upload_id: str | None = None) -> None:
        try:
            project_dir = data_dir / "projects" / project_id
            def progress(stage: str) -> None:
                progress_data: dict[str, Any] = {"stage": stage}
                match = re.search(r"[\(（](\d+)\s*/\s*(\d+)[\)）]", stage)
                if match:
                    progress_data.update({"completed": int(match.group(1)), "total": int(match.group(2))})
                store.update_project(project_id, "running", {"stage": stage, "progress": progress_data})

            def execute() -> dict[str, Any]:
                # The queued state remains visible until the single worker
                # actually accepts this job.
                store.update_project(project_id, "running", {
                    "stage": "准备处理来源数据",
                    "progress": {"stage": "准备处理来源数据"},
                })
                manifest = None
                if upload_id:
                    upload = store.get_upload(upload_id)
                    if not upload or upload.get("status") != "completed" or not upload.get("manifest"):
                        raise RuntimeError("上传来源清单不可用，请重新上传文件")
                    manifest = [{**item, "path": str(upload_file_path(upload_id, item))} for item in upload["manifest"]]
                report = portable_report(build_project(source_dir, project_dir, progress, manifest))
                project_dir.mkdir(parents=True, exist_ok=True)
                (project_dir / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
                return report

            report = await asyncio.get_running_loop().run_in_executor(
                processing_pool, execute
            )
            store.update_project(project_id, "ready", {"report": report, "progress": {"stage": "已完成", "completed": 1, "total": 1}})
        except Exception as error:
            logger.exception("Project processing failed: %s", project_id)
            store.update_project(project_id, "failed", {"error": str(error), "progress": {"stage": "处理失败"}})

    async def finish_upload_assembly(upload_id: str, upload: dict[str, Any]) -> None:
        try:
            manifest = await asyncio.get_running_loop().run_in_executor(
                assembly_pool, assemble_upload, upload_id, upload
            )
            source_dir = data_dir / "uploads" / upload_id
            project_id = uuid.uuid4().hex[:12]
            project, reused = store.finalize_upload(upload_id, project_id, data_reference(source_dir), manifest)
            store.cleanup_completed_upload_chunks()
            if not reused:
                schedule(work(project_id, source_dir, upload_id))
        except HTTPException as error:
            store.fail_upload_assembly(upload_id, str(error.detail))
            logger.info("Upload assembly failed for %s: %s", upload_id, error.detail)
        except Exception as error:
            store.fail_upload_assembly(
                upload_id,
                upload_assembly_error(error) if isinstance(error, OSError) else "文件合并失败，请重试。",
            )
            logger.exception("Upload assembly failed for %s", upload_id)

    @app.get("/api/projects")
    def projects() -> list[dict]:
        # The list drives the home page and its polling; full reports are
        # served per project by GET /api/projects/{id}.
        return [{key: value for key, value in item.items() if key != "report"} for item in store.list_projects()]

    @app.get("/api/health")
    def health() -> dict[str, str]:
        if not store.check_health():
            raise HTTPException(503, "数据库或数据目录不可用")
        return {"status": "ok"}

    @app.get("/api/demo")
    def demo() -> dict[str, object]:
        source_dir = demo_source_dir()
        return {"available": source_dir is not None, "label": "项目内置示例数据"}

    @app.post("/api/projects", status_code=202)
    async def import_project(request: ImportRequest) -> dict:
        if not request.source_dir.strip():
            raise HTTPException(400, "The source directory is required")
        source_dir = Path(request.source_dir).expanduser().resolve()
        if not source_dir.is_dir():
            raise HTTPException(400, "The source directory does not exist")
        project_id = uuid.uuid4().hex[:12]
        project, reused = store.get_or_create_active(project_id, str(source_dir), source_dir.name)
        if not reused:
            schedule(work(project_id, source_dir))
        return {**project, "reused": reused}

    def upload_public(upload: dict[str, Any]) -> dict[str, Any]:
        files = []
        for item in upload.get("files", []):
            chunks = item.get("chunks", [])
            files.append({
                "id": item["id"], "role": item["role"], "filename": item["filename"],
                "size": item["size"], "chunk_size": item["chunk_size"],
                "total_chunks": item["total_chunks"],
                "uploaded_chunks": [int(chunk["chunk_index"]) for chunk in chunks],
                "chunks": [{"index": int(chunk["chunk_index"]), "size": int(chunk["size"]),
                            "sha256": chunk["sha256"]} for chunk in chunks],
                "uploaded_size": sum(int(chunk["size"]) for chunk in chunks),
            })
        return {"id": upload["id"], "created_at": upload["created_at"],
                "project_name": upload.get("project_name"), "status": upload["status"],
                "completed_project_id": upload.get("completed_project_id"),
                "error": upload.get("error"), "files": files}

    def validate_upload_specs(request: UploadCreateRequest) -> list[dict[str, Any]]:
        allowed_roles = {"pre", "after", "sbd", "board", "heatmap"}
        extension_rules = {
            "pre": {".png"}, "after": {".png"}, "sbd": {".sbd", ".sbdx"},
            "board": {".tif", ".tiff"}, "heatmap": {".png"},
        }
        counts: dict[str, int] = {}
        result: list[dict[str, Any]] = []
        for spec in request.files:
            filename = spec.filename
            if not filename or filename in {".", ".."} or "/" in filename or "\\" in filename or "\x00" in filename:
                raise HTTPException(400, "文件名不能包含路径或控制字符")
            role = spec.role.strip().lower()
            if role not in allowed_roles:
                raise HTTPException(400, f"不支持的文件用途：{spec.role}")
            if spec.size <= 0:
                raise HTTPException(400, f"文件不能为空：{filename}")
            suffix = Path(filename).suffix.lower()
            if suffix not in extension_rules[role]:
                raise HTTPException(400, f"{role} 文件格式不正确：{filename}")
            counts[role] = counts.get(role, 0) + 1
            if role in {"pre", "after", "sbd"} and counts[role] > 1:
                raise HTTPException(400, f"{role} 文件只能上传一个")
            result.append({"id": uuid.uuid4().hex, "role": role, "filename": filename,
                           "size": int(spec.size), "chunk_size": 16 * 1024 * 1024,
                           "total_chunks": math.ceil(spec.size / (16 * 1024 * 1024))})
        return result

    @app.post("/api/uploads", status_code=201)
    async def create_upload(request: UploadCreateRequest) -> dict:
        files = validate_upload_specs(request)
        if not files:
            raise HTTPException(400, "至少选择一个文件")
        project_name = (request.project_name or "").strip() or None
        if project_name and len(project_name) > 200:
            raise HTTPException(400, "项目名称不能超过 200 个字符")
        upload_id = uuid.uuid4().hex
        upload_dir = data_dir / "uploads" / upload_id
        try:
            (upload_dir / "chunks").mkdir(parents=True, exist_ok=False)
            (upload_dir / "files").mkdir(parents=True, exist_ok=False)
            upload = store.create_upload(upload_id, project_name, files)
        except Exception:
            shutil.rmtree(upload_dir, ignore_errors=True)
            raise
        return upload_public(upload)

    @app.get("/api/uploads/{upload_id}")
    def get_upload(upload_id: str) -> dict:
        upload = store.get_upload(upload_id)
        if not upload:
            raise HTTPException(404, "上传会话不存在")
        return upload_public(upload)

    @app.put("/api/uploads/{upload_id}/files/{file_id}/chunks/{chunk_index}")
    async def upload_chunk(upload_id: str, file_id: str, chunk_index: int, request: Request) -> dict:
        upload = store.get_upload(upload_id)
        if not upload:
            raise HTTPException(404, "上传会话不存在")
        if upload.get("status") != "pending":
            raise HTTPException(409, "上传会话已经完成或取消")
        file_item = next((item for item in upload["files"] if item["id"] == file_id), None)
        if file_item is None:
            raise HTTPException(404, "上传文件不存在")
        if chunk_index < 0 or chunk_index >= int(file_item["total_chunks"]):
            raise HTTPException(400, "分片序号超出范围")
        expected_size = min(int(file_item["chunk_size"]), int(file_item["size"]) - chunk_index * int(file_item["chunk_size"]))
        supplied_hash = (request.headers.get("x-chunk-sha256") or request.headers.get("x-chunk-sha") or
                         request.headers.get("x-content-sha256") or "").strip().lower()
        encoding = (request.headers.get("content-encoding") or "identity").strip().lower()
        if encoding not in {"identity", "gzip"}:
            raise HTTPException(415, "不支持的分片压缩方式")
        compressed = encoding == "gzip"
        lock = upload_locks.setdefault(upload_id, asyncio.Lock())
        async with lock:
            upload = store.get_upload(upload_id)
            if not upload:
                raise HTTPException(404, "上传会话不存在")
            if upload.get("status") != "pending":
                raise HTTPException(409, "上传会话已经完成或取消")
            file_item = next((item for item in upload["files"] if item["id"] == file_id), None)
            if file_item is None:
                raise HTTPException(404, "上传文件不存在")
            existing = next((chunk for chunk in file_item["chunks"] if int(chunk["chunk_index"]) == chunk_index), None)
            chunk_dir = data_dir / "uploads" / upload_id / "chunks" / file_id
            chunk_dir.mkdir(parents=True, exist_ok=True)
            temp_path = chunk_dir / f".{chunk_index}.tmp-{uuid.uuid4().hex}"
            final_path = chunk_dir / str(chunk_index)
            digest = hashlib.sha256()
            received = 0
            # Chunks may arrive gzip-compressed for transport. Size and
            # SHA-256 always describe the original bytes, which are what is
            # stored; decompression is bounded by the declared chunk size.
            inflater = zlib.decompressobj(zlib.MAX_WBITS | 16) if compressed else None
            try:
                with temp_path.open("wb") as handle:
                    def accept(data: bytes) -> None:
                        nonlocal received
                        received += len(data)
                        if received > expected_size:
                            raise HTTPException(413, "分片大小超过声明值")
                        digest.update(data)
                        handle.write(data)

                    async for block in request.stream():
                        if inflater is None:
                            accept(block)
                            continue
                        try:
                            pending = block
                            while pending:
                                accept(inflater.decompress(pending, max(1, expected_size - received + 1)))
                                pending = inflater.unconsumed_tail
                        except zlib.error as error:
                            raise HTTPException(400, "分片压缩数据无法解压") from error
                    if inflater is not None and not inflater.eof:
                        raise HTTPException(400, "分片压缩数据不完整")
                actual_hash = digest.hexdigest()
                if received != expected_size:
                    raise HTTPException(400, f"分片大小错误：需要 {expected_size} 字节，收到 {received} 字节")
                if supplied_hash and supplied_hash != actual_hash:
                    raise HTTPException(400, "分片 SHA-256 校验失败")
                if existing:
                    if int(existing["size"]) != received or existing["sha256"] != actual_hash:
                        raise HTTPException(409, "相同分片已存在但内容摘要不一致")
                    if final_path.is_file() and hashlib.sha256(final_path.read_bytes()).hexdigest() == actual_hash:
                        return {"uploaded": True, "duplicate": True, "index": chunk_index,
                                "size": expected_size, "sha256": actual_hash}
                os.replace(temp_path, final_path)
                store.record_chunk(upload_id, file_id, chunk_index, received, actual_hash, data_reference(final_path))
            finally:
                temp_path.unlink(missing_ok=True)
        return {"uploaded": True, "duplicate": False, "index": chunk_index,
                "size": received, "sha256": actual_hash}

    def assemble_upload(upload_id: str, upload: dict[str, Any]) -> list[dict[str, Any]]:
        upload_dir = data_dir / "uploads" / upload_id
        manifest: list[dict[str, Any]] = []
        for item in upload["files"]:
            chunks = {int(chunk["chunk_index"]): chunk for chunk in item["chunks"]}
            expected_count = int(item["total_chunks"])
            missing: list[int] = []
            if len(chunks) != expected_count:
                for index in range(expected_count):
                    if index not in chunks:
                        missing.append(index)
                        if len(missing) >= 8:
                            break
            if missing:
                raise HTTPException(400, f"文件 {item['filename']} 仍缺少分片：{missing[:8]}")
            # The directory is server-generated; the original filename is
            # kept only as the leaf so reports and integration matching retain
            # user-facing names without allowing a client path to choose the
            # storage location.
            destination = upload_dir / "files" / item["id"] / item["filename"]
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_name(f".{destination.name}.assembling-{uuid.uuid4().hex}")
            digest = hashlib.sha256()
            total = 0
            try:
                with temporary.open("wb") as output:
                    for index in range(expected_count):
                        chunk_path = rooted_path(upload_dir, f'chunks/{item["id"]}/{index}')
                        if not chunk_path.is_file():
                            raise HTTPException(400, f"文件 {item['filename']} 的分片文件不存在")
                        chunk_digest = hashlib.sha256()
                        chunk_size = 0
                        with chunk_path.open("rb") as source:
                            while block := source.read(1024 * 1024):
                                output.write(block)
                                digest.update(block)
                                chunk_digest.update(block)
                                chunk_size += len(block)
                                total += len(block)
                        if chunk_size != int(chunks[index]["size"]) or chunk_digest.hexdigest() != chunks[index]["sha256"]:
                            raise HTTPException(400, f"文件 {item['filename']} 的分片校验失败")
                if total != int(item["size"]):
                    raise HTTPException(400, f"文件大小校验失败：{item['filename']}")
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
            if item["role"] in {"pre", "after", "board", "heatmap"}:
                try:
                    from PIL import Image
                    with Image.open(destination) as image:
                        image.verify()
                except Exception as error:
                    raise HTTPException(400, f"无法读取图像文件 {item['filename']}：{error}") from error
            elif item["role"] == "sbd":
                try:
                    import h5py
                    if destination.suffix.lower() == ".sbdx":
                        compact = destination.with_suffix(".sbd")
                        temporary_compact = compact.with_name(f".{compact.name}.{uuid.uuid4().hex}.tmp")
                        try:
                            materialize_sbd_package(destination, temporary_compact)
                            os.replace(temporary_compact, compact)
                        finally:
                            temporary_compact.unlink(missing_ok=True)
                        destination.unlink()
                        destination = compact
                        total = destination.stat().st_size
                        digest = hashlib.sha256(destination.read_bytes())
                    with h5py.File(destination, "r") as handle:
                        validate_sbd_extract(handle)
                except Exception as error:
                    if isinstance(error, OSError) and error.errno == errno.ENOSPC:
                        raise
                    raise HTTPException(400, f"无法读取 SBD 文件 {item['filename']}：{error}") from error
            manifest.append({"file_id": item["id"], "role": item["role"], "filename": destination.name,
                             "path": data_reference(destination), "size": total, "sha256": digest.hexdigest()})
        return manifest

    @app.post("/api/uploads/{upload_id}/complete", status_code=202)
    async def complete_upload(upload_id: str, background: bool = False) -> dict:
        lock = upload_locks.setdefault(upload_id, asyncio.Lock())
        async with lock:
            upload = store.get_upload(upload_id)
            if not upload:
                raise HTTPException(404, "上传会话不存在")
            if upload.get("completed_project_id"):
                project = store.get_project(upload["completed_project_id"])
                if project:
                    return {**project, "reused": True}
            roles = [item["role"] for item in upload["files"]]
            if roles.count("pre") != 1 or roles.count("after") != 1:
                raise HTTPException(400, "必须上传一张采集前 PNG 和一张采集后 PNG")
            if background:
                if upload.get("status") == "assembling":
                    return upload_public(upload)
                if upload.get("status") not in {"pending", "failed"}:
                    raise HTTPException(409, "上传会话已经完成或取消")
                if not store.mark_upload_assembling(upload_id):
                    return upload_public(store.get_upload(upload_id) or upload)
                claimed_upload = store.get_upload(upload_id)
                if claimed_upload is None:
                    raise HTTPException(404, "上传会话不存在")
                schedule(finish_upload_assembly(upload_id, claimed_upload))
                return upload_public(claimed_upload)
            if upload.get("status") != "pending":
                raise HTTPException(409, "上传会话已经完成或取消")
            try:
                manifest = await asyncio.get_running_loop().run_in_executor(
                    assembly_pool, assemble_upload, upload_id, upload
                )
            except HTTPException:
                raise
            except OSError as error:
                message = upload_assembly_error(error)
                status = 507 if error.errno == errno.ENOSPC else 500
                raise HTTPException(status, message) from error
            source_dir = data_dir / "uploads" / upload_id
            project_id = uuid.uuid4().hex[:12]
            project, reused = store.finalize_upload(upload_id, project_id, data_reference(source_dir), manifest)
            if not reused:
                store.cleanup_completed_upload_chunks()
                schedule(work(project_id, source_dir, upload_id))
            return {**project, "reused": reused}

    @app.delete("/api/uploads/{upload_id}")
    async def cancel_upload(upload_id: str) -> dict:
        lock = upload_locks.setdefault(upload_id, asyncio.Lock())
        async with lock:
            upload = store.get_upload(upload_id)
            if not upload:
                raise HTTPException(404, "上传会话不存在")
            try:
                store.cancel_upload(upload_id)
            except ValueError as error:
                raise HTTPException(409, str(error)) from error
            shutil.rmtree(data_dir / "uploads" / upload_id, ignore_errors=True)
        upload_locks.pop(upload_id, None)
        return {"cancelled": True}

    @app.post("/api/demo", status_code=202)
    async def import_demo() -> dict:
        source_dir = demo_source_dir()
        if source_dir is None:
            raise HTTPException(404, "内置示例数据不可用")
        project_id = uuid.uuid4().hex[:12]
        project, reused = store.get_or_create_active(project_id, str(source_dir), "内置示例", "directory")
        if not reused:
            schedule(work(project_id, source_dir))
        return {**project, "reused": reused}

    @app.post("/api/projects/{project_id}/retry", status_code=202)
    async def retry_project(project_id: str) -> dict:
        previous = store.get_project(project_id)
        if not previous:
            raise HTTPException(404, "Project not found")
        if previous["status"] in {"queued", "running"}:
            return {**previous, "reused": True}
        upload_id = previous.get("upload_id")
        source_dir = (data_dir / "uploads" / upload_id).resolve() if upload_id else Path(previous["source_dir"]).expanduser().resolve()
        if not source_dir.is_dir():
            raise HTTPException(400, "项目来源已不存在")
        if upload_id:
            upload = store.get_upload(upload_id)
            if not upload or upload.get("status") != "completed":
                raise HTTPException(400, "上传来源不可用")
            if any(not upload_file_path(upload_id, item).is_file() for item in (upload.get("manifest") or [])):
                raise HTTPException(400, "上传来源文件已不存在，请重新上传")
        new_id = uuid.uuid4().hex[:12]
        stored_source = data_reference(source_dir) if upload_id else str(source_dir)
        project, reused = store.get_or_create_active(new_id, stored_source, previous.get("project_name"),
                                                     previous.get("import_type", "directory"), upload_id)
        if not reused:
            schedule(work(new_id, source_dir, upload_id))
        return {**project, "reused": reused}

    @app.get("/api/projects/{project_id}")
    def project(project_id: str) -> dict:
        result = store.get_project(project_id)
        if not result:
            raise HTTPException(404, "Project not found")
        return result

    @app.get("/api/projects/{project_id}/report")
    def report(project_id: str) -> dict:
        result = store.get_project(project_id)
        if not result or result["status"] != "ready":
            raise HTTPException(404, "Registration report not available")
        return result["report"]

    @app.put("/api/projects/{project_id}/view")
    def save_view(project_id: str, request: ViewRequest) -> dict:
        if not store.get_project(project_id):
            raise HTTPException(404, "Project not found")
        existing = store.get_view(project_id) or {}
        previous_viewport = existing.get("viewport", {}) if isinstance(existing, dict) else {}
        previous_settings = existing.get("settings", {}) if isinstance(existing, dict) else {}
        merged_viewport = {**previous_viewport, **request.viewport} if isinstance(previous_viewport, dict) else request.viewport
        merged_settings = {**previous_settings, **request.settings} if isinstance(previous_settings, dict) else request.settings
        preserved = existing if isinstance(existing, dict) else {}
        store.save_view(project_id, {**preserved, "version": request.version, "viewport": merged_viewport, "settings": merged_settings})
        return {"saved": True, "version": request.version}

    @app.get("/api/projects/{project_id}/view")
    def get_view(project_id: str) -> dict:
        if not store.get_project(project_id):
            raise HTTPException(404, "Project not found")
        saved = store.get_view(project_id)
        if not saved:
            return {"viewport": None, "settings": {}, "version": 2}
        return saved

    def spot_cache(project_id: str, project: dict) -> Path:
        mapping = (project.get("report") or {}).get("spatial_mapping") or {}
        cache_name = mapping.get("spot_cache")
        if not cache_name:
            raise HTTPException(404, "SBD 坐标缓存不可用；请重新导入包含 SBD、板图和坐标来源的目录")
        project_dir = (data_dir / "projects" / project_id).resolve()
        cache_path = (project_dir / str(cache_name)).resolve()
        if project_dir not in cache_path.parents or not cache_path.is_file():
            raise HTTPException(404, "SBD 坐标缓存文件不存在")
        return cache_path

    def load_spot_arrays(cache_path: Path) -> dict[str, np.ndarray]:
        # NpzFile lazily decompresses a member. Materialize each member once;
        # otherwise a large CSV export would decompress every column per row.
        cache_key = str(cache_path)
        stamp = cache_path.stat().st_mtime_ns
        cached = spot_arrays_cache.get(cache_key)
        if cached is not None and cached[0] == stamp:
            return cached[1]
        with spot_arrays_lock:
            cached = spot_arrays_cache.get(cache_key)
            if cached is not None and cached[0] == stamp:
                return cached[1]
            with np.load(cache_path, allow_pickle=False) as loaded:
                values = {key: loaded[key] for key in loaded.files}
            spot_arrays_cache[cache_key] = (stamp, values)
            return values

    def heatmap_metadata(project_id: str) -> dict:
        path = data_dir / "projects" / project_id / "heatmap" / "active.json"
        if not path.is_file():
            return {"available": False}
        try:
            metadata = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(metadata, dict) or not re.fullmatch(r"[0-9a-f]{64}", metadata.get("sha256", "")):
                return {"available": False}
            return metadata
        except (OSError, ValueError):
            return {"available": False}

    def prepare_heatmap(project_id: str, project: dict, contents: bytes | bytearray,
                        filename: str, label: str, origin: str = "manual") -> dict:
        report = project.get("report") or {}
        mapping = report.get("spatial_mapping") or {}
        reference = (mapping.get("heatmap") or {}).get("path")
        use_board = not reference
        matrices = mapping.get("matrices") or {}
        world_to_reference = np.asarray(matrices.get("world_to_heat"), dtype=float)
        if not reference:
            # Three-file imports align SBD directly through its optical board.
            # Match new ion heat maps to that same board and sample in its frame.
            reference = (mapping.get("board") or {}).get("path")
            world_to_reference = np.asarray(matrices.get("world_to_board"), dtype=float)
        if not mapping.get("available") or not reference or world_to_reference.shape != (3, 3):
            raise HTTPException(400, "此项目缺少可用的参考图像或 SBD 坐标映射")
        reference_path = resolve_project_file(reference, project_id)
        if not reference_path.is_file():
            raise HTTPException(400, "参考图像文件不可用，请先重新导入项目来源")
        def process() -> dict:
            try:
                with Image.open(io.BytesIO(contents)) as image:
                    if image.format != "PNG" or image.width * image.height > 75_000_000:
                        raise HeatmapRegistrationError("请选择不超过 7500 万像素的 PNG 热图")
                    image.verify()
                source = cv2.imdecode(np.frombuffer(contents, dtype=np.uint8), cv2.IMREAD_COLOR)
                reference_image = cv2.imread(str(reference_path), cv2.IMREAD_COLOR)
                if source is None or reference_image is None:
                    raise HeatmapRegistrationError("无法读取热图或项目参考热图")
                arrays = load_spot_arrays(spot_cache(project_id, project))
                primary = int(mapping.get("primary_raster", 0))
                sampling_matrix = world_to_reference
                if use_board:
                    selected = (arrays["raster"] == primary) & arrays["mapped"].astype(bool)
                    reference_image, sampling_matrix = crop_board_reference(
                        reference_image, sampling_matrix, arrays["world_x"], arrays["world_y"], selected,
                    )
                result = match_heatmap(source, reference_image)
                colors, valid = sample_spot_colours(source, sampling_matrix, result["matrix"],
                                                     arrays["world_x"], arrays["world_y"], arrays["mapped"])
                primary_total = int(np.count_nonzero((arrays["raster"] == primary) & arrays["mapped"].astype(bool)))
                primary_valid = int(np.count_nonzero((arrays["raster"] == primary) & valid))
                if primary_total == 0 or primary_valid < max(10, primary_total * .3):
                    raise HeatmapRegistrationError("热图匹配后有效颜色覆盖不足，请核对采集区域")
                digest = hashlib.sha256(contents).hexdigest()
                directory = data_dir / "projects" / project_id / "heatmap"
                directory.mkdir(parents=True, exist_ok=True)
                metadata = {"available": True, "sha256": digest, "sampling_version": SAMPLING_VERSION, "filename": filename,
                            "label": label.strip() or filename, "mirrored": result["mirrored"],
                            "rotation_degrees": result["rotation_degrees"], "inliers": result["inliers"],
                            "error_p95_px": float(result["error_p95_px"]), "coverage": result["coverage"],
                            "sampled_spots": primary_valid, "mapped_spots": primary_total,
                            "origin": origin,
                            "warning": "颜色采样来自渲染图片，不代表原始离子强度；板图匹配不证明热图与项目来自同一次采集。"}
                token = uuid.uuid4().hex
                image_temp = directory / f".{token}.png"
                array_temp = directory / f".{token}.npz"
                meta_temp = directory / f".{token}.json"
                try:
                    image_temp.write_bytes(contents)
                    with array_temp.open("wb") as handle:
                        np.savez_compressed(handle, spot_id=arrays["spot_id"], raster=arrays["raster"],
                                            colors=colors, valid=valid)
                    meta_temp.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
                    os.replace(image_temp, directory / f"{digest}.png")
                    os.replace(array_temp, directory / f"{digest}.npz")
                    os.replace(meta_temp, directory / "active.json")
                finally:
                    for temp in (image_temp, array_temp, meta_temp):
                        temp.unlink(missing_ok=True)
                return metadata
            except HeatmapRegistrationError:
                raise
            except (OSError, ValueError, cv2.error) as error:
                raise HeatmapRegistrationError(f"热图处理失败：{error}") from error

        return process()

    @app.get("/api/projects/{project_id}/heatmap")
    def get_heatmap(project_id: str) -> dict:
        project = store.get_project(project_id)
        if not project or project["status"] != "ready":
            raise HTTPException(404, "项目不存在或尚未处理完成")
        metadata = heatmap_metadata(project_id)
        if metadata.get("available") and metadata.get("sampling_version") != SAMPLING_VERSION:
            try:
                with heatmap_lock:
                    metadata = heatmap_metadata(project_id)
                    if metadata.get("available") and metadata.get("sampling_version") != SAMPLING_VERSION:
                        image_path = data_dir / "projects" / project_id / "heatmap" / f'{metadata["sha256"]}.png'
                        contents = image_path.read_bytes()
                        if hashlib.sha256(contents).hexdigest() != metadata["sha256"]:
                            raise HeatmapRegistrationError("已保存的热图文件校验失败")
                        metadata = prepare_heatmap(project_id, project, contents,
                                                   metadata.get("filename", "heatmap.png"), metadata.get("label", ""))
            except (HeatmapRegistrationError, HTTPException, OSError) as error:
                logger.warning("Heatmap cache update failed for %s: %s", project_id, error)
                return {"available": False, "warning": "热图缓存更新失败，请检查参考数据并重新上传热图。"}
        source_dir = demo_source_dir()
        default_image = source_dir / DEMO_HEATMAP if source_dir else None
        is_demo = (source_dir is not None and project.get("project_name") == "内置示例" and
                   Path(project.get("source_dir", "")).expanduser().resolve() == source_dir)
        def needs_default(current: dict) -> bool:
            # A heat map the user added is kept; an earlier built-in default
            # is replaced when the configured default image changes.
            if not current.get("available"):
                return True
            if current.get("filename") == DEMO_HEATMAP.name:
                return False
            # Records written before origins were tracked: the previous
            # built-in default was stored under its file name, hot.png.
            return current.get("origin") == "demo_default" or (
                "origin" not in current and current.get("filename") == "hot.png")

        if is_demo and default_image and default_image.is_file() and needs_default(metadata):
            try:
                with heatmap_lock:
                    metadata = heatmap_metadata(project_id)
                    if needs_default(metadata):
                        metadata = prepare_heatmap(project_id, project, default_image.read_bytes(), default_image.name,
                                                   DEMO_HEATMAP_LABEL, "demo_default")
            except (HeatmapRegistrationError, HTTPException, OSError) as error:
                logger.warning("Default heatmap could not be prepared for %s: %s", project_id, error)
                return {"available": False, "warning": "内置热图自动配准失败，请检查示例数据。"}
        if not metadata.get("available") and not is_demo:
            # A project may be calibrated directly through the SBD board.
            # Its uploaded ion maps then live in the manifest, not mapping.heatmap.
            mapping = (project.get("report") or {}).get("spatial_mapping") or {}
            reference = mapping.get("heatmap") or {}
            candidates = [reference] if reference.get("path") else []
            upload_id = project.get("upload_id")
            if upload_id and not candidates:
                upload = store.get_upload(upload_id)
                candidates = [{**item, "path": str(upload_file_path(upload_id, item))}
                              for item in (upload or {}).get("manifest") or [] if item.get("role") == "heatmap"]
            if candidates and not mapping.get("available"):
                return {"available": False, "warning": "热图已上传，但 SBD 与显微图的坐标对应关系尚不可用。"}
            for candidate in candidates:
                try:
                    reference_path = resolve_project_file(candidate["path"], project_id)
                    with heatmap_lock:
                        metadata = heatmap_metadata(project_id)
                        if not metadata.get("available"):
                            filename = candidate.get("filename") or reference_path.name
                            mz = candidate.get("mz")
                            metadata = prepare_heatmap(project_id, project, reference_path.read_bytes(), filename,
                                                       f"{mz} m/z" if mz else filename, "project")
                    return metadata
                except (HeatmapRegistrationError, HTTPException, OSError, ValueError) as error:
                    logger.warning("Project heatmap could not be prepared for %s (%s): %s",
                                   project_id, candidate.get("filename"), error)
            if candidates:
                return {"available": False, "warning": "热图已上传，但自动配准失败，请检查热图与采集区域是否对应。"}
        return metadata

    @app.post("/api/projects/{project_id}/heatmap")
    async def add_heatmap(project_id: str, file: UploadFile = File(...), label: str = Form("")) -> dict:
        project = store.get_project(project_id)
        if not project or project["status"] != "ready":
            raise HTTPException(404, "项目不存在或尚未处理完成")
        if len(label) > 160:
            raise HTTPException(400, "热图名称不能超过 160 个字符")
        contents = bytearray()
        try:
            while block := await file.read(1024 * 1024):
                contents.extend(block)
                if len(contents) > 40 * 1024 * 1024:
                    raise HTTPException(413, "热图文件不能超过 40 MiB")
        finally:
            await file.close()
        filename = Path((file.filename or "heatmap.png").replace("\\", "/")).name[:200]
        try:
            def locked_process() -> dict:
                with heatmap_lock:
                    return prepare_heatmap(project_id, project, contents, filename, label)
            return await asyncio.to_thread(locked_process)
        except HeatmapRegistrationError as error:
            raise HTTPException(400, str(error)) from error

    @app.get("/api/projects/{project_id}/heatmap/colors")
    def heatmap_colors(project_id: str, raster: int | None = None) -> dict:
        project = store.get_project(project_id)
        if not project or project["status"] != "ready":
            raise HTTPException(404, "项目不存在或尚未处理完成")
        metadata = heatmap_metadata(project_id)
        if not metadata.get("available"):
            return {"items": []}
        if metadata.get("sampling_version") != SAMPLING_VERSION:
            raise HTTPException(409, "热图缓存需要更新，请刷新页面")
        path = data_dir / "projects" / project_id / "heatmap" / f'{metadata["sha256"]}.npz'
        if not path.is_file():
            raise HTTPException(404, "热图颜色缓存不可用，请重新导入")
        with np.load(path, allow_pickle=False) as data:
            valid = data["valid"].astype(bool)
            if raster is not None:
                valid &= data["raster"] == raster
            spot_ids = data["spot_id"]
            colors = data["colors"]
        items = np.column_stack((spot_ids[valid], colors[valid])).tolist()
        return Response(json.dumps({"items": items}, separators=(",", ":")), media_type="application/json")

    def canonical_coordinates(report: dict, data: dict[str, np.ndarray], layer: str) -> tuple[np.ndarray, np.ndarray]:
        """Return SBD positions on the calibrated public coordinate grid.

        Older caches stored the local image-response maximum in ``pre_x`` /
        ``after_x``.  Prefer explicit grid coordinates, then reconstruct them
        from the persisted world transform so those projects also render on
        the true SBD grid without requiring a re-import.
        """
        grid_x_key, grid_y_key = f"grid_{layer}_x", f"grid_{layer}_y"
        if grid_x_key in data and grid_y_key in data:
            return data[grid_x_key], data[grid_y_key]
        mapping = report.get("spatial_mapping") or {}
        coordinate_model = mapping.get("coordinate_model")
        if isinstance(coordinate_model, dict) and "world_x" in data and "world_y" in data:
            world = np.c_[data["world_x"], data["world_y"]]
            after = evaluate_coordinate_model(coordinate_model, world, enforce_domain=True)
            if layer == "after":
                return after[:, 0].astype(np.float32), after[:, 1].astype(np.float32)
            after_to_pre = np.asarray((mapping.get("matrices") or {}).get("after_to_pre"), dtype=np.float64)
            if after_to_pre.shape == (3, 3) and np.isfinite(after_to_pre).all():
                mapped = np.c_[after, np.ones(len(after))] @ after_to_pre.T
                with np.errstate(divide="ignore", invalid="ignore"):
                    pre = mapped[:, :2] / mapped[:, 2:3]
                return pre[:, 0].astype(np.float32), pre[:, 1].astype(np.float32)
        matrix_value = (mapping.get("matrices") or {}).get(f"world_to_{layer}")
        if matrix_value is not None and "world_x" in data and "world_y" in data:
            matrix = np.asarray(matrix_value, dtype=np.float64)
            world = np.c_[data["world_x"], data["world_y"], np.ones(len(data["world_x"]))]
            mapped = world @ matrix.T
            denominator = mapped[:, 2:3]
            with np.errstate(divide="ignore", invalid="ignore"):
                points = mapped[:, :2] / denominator
            return points[:, 0].astype(np.float32), points[:, 1].astype(np.float32)
        return data[f"{layer}_x"], data[f"{layer}_y"]

    def spot_fields(report: dict) -> list[dict]:
        mapping = report.get("spatial_mapping") or {}
        return mapping.get("value_fields") or (report.get("maldi_data") or {}).get("value_fields") or []

    def spot_field(report: dict, requested: str | None) -> tuple[dict | None, int | None]:
        fields = spot_fields(report)
        if not fields:
            return None, None
        for index, field in enumerate(fields):
            if requested and requested in {field.get("key"), field.get("label")}:
                return field, int(field.get("index", index))
        return fields[0], int(fields[0].get("index", 0))

    def spot_payload(data: Any, index: int, field: dict | None, field_index: int | None,
                     pre_coordinates: tuple[np.ndarray, np.ndarray] | None = None,
                     after_coordinates: tuple[np.ndarray, np.ndarray] | None = None,
                     value_fields: list[dict] | None = None,
                     calibration_version: str | None = None) -> dict:
        def number(key: str, fallback: float | None = None) -> float | None:
            value = float(data[key][index])
            if key == "pit_score" and value < -1e8:
                return fallback
            if key == "pit_offset_px" and value < 0:
                return fallback
            return value if np.isfinite(value) else fallback

        pre_x_values, pre_y_values = pre_coordinates or (data["pre_x"], data["pre_y"])
        after_x_values, after_y_values = after_coordinates or (data["after_x"], data["after_y"])

        payload = {
            "spot_id": int(data["spot_id"][index]),
            "raster": int(data["raster"][index]),
            "x": float(pre_x_values[index]) if np.isfinite(pre_x_values[index]) else None,
            "y": float(pre_y_values[index]) if np.isfinite(pre_y_values[index]) else None,
            "pre_x": float(pre_x_values[index]) if np.isfinite(pre_x_values[index]) else None,
            "pre_y": float(pre_y_values[index]) if np.isfinite(pre_y_values[index]) else None,
            "after_x": float(after_x_values[index]) if np.isfinite(after_x_values[index]) else None,
            "after_y": float(after_y_values[index]) if np.isfinite(after_y_values[index]) else None,
            "original_x": number("original_x"),
            "original_y": number("original_y"),
            "world_x": number("world_x"),
            "world_y": number("world_y"),
            "mapped": bool(data["mapped"][index]),
            "detected": bool(data["detected"][index]),
            "calibration_version": calibration_version,
            "pit_score": number("pit_score"),
            "pit_offset_px": number("pit_offset_px"),
            "value": None,
            "field_key": field.get("key") if field else None,
            "field_label": field.get("label") if field else None,
            "normalizations": [],
        }
        for position, value_field in enumerate(value_fields or []):
            value_index = int(value_field.get("index", position) or position)
            value_key = f"value_{value_index}"
            if value_key not in data:
                continue
            value = float(data[value_key][index])
            payload["normalizations"].append({
                "key": value_field.get("key", value_key),
                "label": value_field.get("label", value_field.get("key", value_key)),
                "value": value if np.isfinite(value) else None,
            })
        if field_index is not None:
            value_key = f"value_{field_index}"
            if value_key in data:
                value = float(data[value_key][index])
                payload["value"] = value if np.isfinite(value) else None
        return payload

    @app.get("/api/projects/{project_id}/spots/overlay")
    def spot_overlay(project_id: str, raster: int | None = None, detected: bool | None = None,
                     mapped: bool | None = True) -> dict:
        """Return every mapped SBD grid point and its image-confirmation state.

        The paginated ``/spots`` endpoint is intentionally bounded for tables
        and exports.  It must not be reused for the canvas overlay: sampling
        that endpoint creates a regular checkerboard of missing dots on a
        dense SBD grid.  The browser can draw the complete compact grid and
        distinguish confirmed points from unconfirmed candidates.
        """
        project = store.get_project(project_id)
        if not project or project["status"] != "ready":
            raise HTTPException(404, "Project not ready")
        report = project["report"]
        mapping = report.get("spatial_mapping") or {}
        cache_path = spot_cache(project_id, project)
        data = load_spot_arrays(cache_path)
        pre_coordinates = canonical_coordinates(report, data, "pre")
        after_coordinates = canonical_coordinates(report, data, "after")
        calibration_version = mapping.get("calibration_version")
        # The overlay is a tiled SBD acquisition grid.  A detected optical
        # response is evidence about that node, not permission to move its
        # 20 μm footprint.  Moving each confirmed node to its local maximum
        # makes background texture scatter the grid and can visually spill
        # across the boundary of the actual acquisition area; response_*
        # remains available in the cache and in the detail/diagnostic fields.
        display_coordinates = pre_coordinates
        mask = np.ones(len(data["spot_id"]), dtype=bool)
        if raster is not None:
            mask &= data["raster"] == int(raster)
        if detected is not None:
            mask &= data["detected"].astype(bool) == bool(detected)
        if mapped is not None:
            mask &= data["mapped"].astype(bool) == bool(mapped)
        mask &= np.isfinite(display_coordinates[0]) & np.isfinite(display_coordinates[1])
        indices = np.flatnonzero(mask)
        items = [{"spot_id": int(data["spot_id"][index]), "raster": int(data["raster"][index]),
                  "x": float(display_coordinates[0][index]), "y": float(display_coordinates[1][index]),
                  "pre_x": float(pre_coordinates[0][index]), "pre_y": float(pre_coordinates[1][index]),
                  "after_x": float(after_coordinates[0][index]) if np.isfinite(after_coordinates[0][index]) else None,
                  "after_y": float(after_coordinates[1][index]) if np.isfinite(after_coordinates[1][index]) else None,
                  "original_x": float(data["original_x"][index]) if np.isfinite(data["original_x"][index]) else None,
                  "original_y": float(data["original_y"][index]) if np.isfinite(data["original_y"][index]) else None,
                  "world_x": float(data["world_x"][index]) if np.isfinite(data["world_x"][index]) else None,
                  "world_y": float(data["world_y"][index]) if np.isfinite(data["world_y"][index]) else None,
                  "mapped": bool(data["mapped"][index]),
                  "detected": bool(data["detected"][index]),
                  "calibration_version": calibration_version} for index in indices]
        return {"items": items, "total": int(indices.size),
                "detected_total": int(data["detected"][indices].astype(bool).sum()),
                "returned": len(items), "sampled": False,
                "primary_raster": mapping.get("primary_raster"),
                "calibration_version": calibration_version,
                "coordinate_source": "coordinate_model centers; optical response peaks are confirmation diagnostics only"}

    @app.get("/api/projects/{project_id}/spots/nearest")
    def nearest_spot(project_id: str, x: float, y: float, field: str | None = None,
                     layer: str = "after", max_distance: float = 90.0,
                     detected_only: bool = True) -> dict:
        project = store.get_project(project_id)
        if not project or project["status"] != "ready":
            raise HTTPException(404, "Project not ready")
        report = project["report"]
        cache_path = spot_cache(project_id, project)
        field_spec, field_index = spot_field(report, field)
        data = load_spot_arrays(cache_path)
        pre_coordinates = canonical_coordinates(report, data, "pre")
        after_coordinates = canonical_coordinates(report, data, "after")
        calibration_version = (report.get("spatial_mapping") or {}).get("calibration_version")
        coordinates = np.c_[pre_coordinates[0], pre_coordinates[1]].astype(np.float64)
        # Clicks resolve against the same theoretical grid that is drawn on
        # canvas.  The bounded response peak is retained as a quality signal,
        # but using it as the primary click coordinate would make neighbouring
        # boxes compete whenever image texture is stronger than the pit.
        match_coordinates = coordinates
        valid = np.isfinite(coordinates).all(axis=1) & np.isfinite(match_coordinates).all(axis=1)
        # The canvas uses the common pre-image coordinate system for both
        # layers, so a click should only resolve to points that are actually
        # visible in that registered image, regardless of the selected layer.
        valid &= data["mapped"].astype(bool)
        if detected_only:
            valid &= data["detected"].astype(bool)
        indices = np.flatnonzero(valid)
        if indices.size == 0:
            return {"found": False, "reason": "没有可用的 SBD 点位" if not detected_only else "没有可用的已确认灼烧坑"}
        click = np.array([float(x), float(y)], dtype=float)
        centre_distance = np.linalg.norm(match_coordinates[indices] - click, axis=1)
        order = np.argsort(centre_distance)[:min(32, len(indices))]
        candidate_indices = indices[order]
        candidate_centres = match_coordinates[candidate_indices]
        model = (report.get("spatial_mapping") or {}).get("coordinate_model")
        spot_size = np.asarray(((report.get("spatial_mapping") or {}).get("metrics") or {}).get("pit_detection", {}).get("spot_size_world", [20.0, 20.0]), dtype=float)
        after_to_pre = np.asarray(((report.get("spatial_mapping") or {}).get("matrices") or {}).get("after_to_pre"), dtype=float)
        vectors = np.asarray((((report.get("spatial_mapping") or {}).get("metrics") or {}).get("pit_detection", {}).get("spot_vectors_pre_px") or []), dtype=float)

        def polygon_for(index: int) -> np.ndarray | None:
            if isinstance(model, dict) and spot_size.shape == (2,) and np.isfinite(spot_size).all() and \
                    after_to_pre.shape == (3, 3) and np.isfinite(after_to_pre).all():
                world_point = np.array([data["world_x"][index], data["world_y"][index]], dtype=float)
                offsets = np.array([[-spot_size[0] / 2, -spot_size[1] / 2], [spot_size[0] / 2, -spot_size[1] / 2],
                                    [spot_size[0] / 2, spot_size[1] / 2], [-spot_size[0] / 2, spot_size[1] / 2]])
                after_corners = evaluate_coordinate_model(model, world_point + offsets)
                mapped = np.c_[after_corners, np.ones(len(after_corners))] @ after_to_pre.T
                with np.errstate(divide="ignore", invalid="ignore"):
                    corners = mapped[:, :2] / mapped[:, 2:3]
                return corners if np.isfinite(corners).all() else None
            if vectors.shape == (2, 2) and np.isfinite(vectors).all():
                centre = match_coordinates[index]
                vector_x, vector_y = vectors / 2.0
                return np.array([centre - vector_x - vector_y, centre + vector_x - vector_y,
                                 centre + vector_x + vector_y, centre - vector_x + vector_y])
            return None

        def segment_distance(point: np.ndarray, first: np.ndarray, second: np.ndarray) -> float:
            direction = second - first
            length_squared = float(direction @ direction)
            if length_squared <= 1e-12:
                return float(np.linalg.norm(point - first))
            fraction = float(np.clip((point - first) @ direction / length_squared, 0.0, 1.0))
            return float(np.linalg.norm(point - (first + fraction * direction)))

        def polygon_hit(polygon: np.ndarray | None) -> tuple[bool, float]:
            if polygon is None:
                return False, float("inf")
            edges = np.roll(polygon, -1, axis=0) - polygon
            cross = edges[:, 0] * (click[1] - polygon[:, 1]) - edges[:, 1] * (click[0] - polygon[:, 0])
            inside = bool(np.all(cross >= -1e-6) or np.all(cross <= 1e-6))
            boundary = min(segment_distance(click, polygon[i], polygon[(i + 1) % len(polygon)])
                           for i in range(len(polygon)))
            return inside, 0.0 if inside else boundary

        hits: list[tuple[int, bool, float, float]] = []
        for index, centre in zip(candidate_indices, candidate_centres):
            inside, footprint_distance = polygon_hit(polygon_for(int(index)))
            hits.append((int(index), inside, footprint_distance, float(np.linalg.norm(centre - click))))
        hit_candidates = [item for item in hits if item[1]]
        if hit_candidates:
            winner, _, footprint_distance, nearest_distance = min(hit_candidates, key=lambda item: item[3])
            footprint_hit = True
        else:
            winner, _, footprint_distance, nearest_distance = min(hits, key=lambda item: item[3])
            footprint_hit = False
        limit = max(1.0, min(float(max_distance), 500.0))
        if not footprint_hit and nearest_distance > limit:
            return {"found": False, "nearest_distance_px": nearest_distance,
                    "reason": "点击位置附近没有已确认的 SBD 灼烧坑"}
        payload = spot_payload(data, winner, field_spec, field_index, pre_coordinates, after_coordinates,
                               spot_fields(report), calibration_version)
        payload["found"] = True
        payload["distance_px"] = nearest_distance
        payload["footprint_distance_px"] = float(footprint_distance)
        payload["footprint_hit"] = footprint_hit
        payload["hit_mode"] = "20 μm footprint polygon" if footprint_hit else "nearest 20 μm footprint center"
        return payload

    @app.get("/api/projects/{project_id}/spots")
    def spots(project_id: str, raster: int | None = None, detected: bool | None = None,
              mapped: bool | None = None, min_x: float | None = None, max_x: float | None = None,
              min_y: float | None = None, max_y: float | None = None,
              limit: int = 12000, field: str | None = None) -> dict:
        project = store.get_project(project_id)
        if not project or project["status"] != "ready":
            raise HTTPException(404, "Project not ready")
        report = project["report"]
        cache_path = spot_cache(project_id, project)
        field_spec, field_index = spot_field(report, field)
        data = load_spot_arrays(cache_path)
        pre_coordinates = canonical_coordinates(report, data, "pre")
        after_coordinates = canonical_coordinates(report, data, "after")
        calibration_version = (report.get("spatial_mapping") or {}).get("calibration_version")
        mask = np.ones(len(data["spot_id"]), dtype=bool)
        if raster is not None:
            mask &= data["raster"] == int(raster)
        if detected is not None:
            mask &= data["detected"].astype(bool) == bool(detected)
        if mapped is not None:
            mask &= data["mapped"].astype(bool) == bool(mapped)
        x_values, y_values = pre_coordinates
        if min_x is not None:
            mask &= x_values >= float(min_x)
        if max_x is not None:
            mask &= x_values <= float(max_x)
        if min_y is not None:
            mask &= y_values >= float(min_y)
        if max_y is not None:
            mask &= y_values <= float(max_y)
        indices = np.flatnonzero(mask)
        total = int(indices.size)
        safe_limit = max(1, min(int(limit), 30000))
        sampled = total > safe_limit
        if sampled:
            indices = indices[np.linspace(0, total - 1, safe_limit).round().astype(np.int64)]
        items = [spot_payload(data, int(index), field_spec, field_index, pre_coordinates, after_coordinates,
                              spot_fields(report), calibration_version) for index in indices]
        return {"items": items, "total": total, "returned": len(items), "sampled": sampled,
                "field": field_spec, "calibration_version": calibration_version}

    @app.get("/api/projects/{project_id}/burn-pits.csv")
    def burn_pits_csv(project_id: str, field: str | None = None) -> Response:
        project = store.get_project(project_id)
        if not project or project["status"] != "ready":
            raise HTTPException(404, "Project not ready")
        report = project["report"]
        cache_path = spot_cache(project_id, project)
        field_spec, field_index = spot_field(report, field)
        data = load_spot_arrays(cache_path)
        pre_coordinates = canonical_coordinates(report, data, "pre")
        after_coordinates = canonical_coordinates(report, data, "after")
        calibration_version = (report.get("spatial_mapping") or {}).get("calibration_version")
        indices = np.flatnonzero(data["detected"].astype(bool))
        output = io.StringIO(newline="")
        fieldnames = ["spot_id", "raster", "pre_x", "pre_y", "after_x", "after_y",
                      "world_x", "world_y",
                      "original_x", "original_y", "detected", "pit_score", "pit_offset_px",
                      "field_key", "field_label", "value", "calibration_version"]
        writer = csv.DictWriter(output, fieldnames=fieldnames, lineterminator="\n")
        writer.writeheader()
        for index in indices:
            item = spot_payload(data, int(index), field_spec, field_index, pre_coordinates, after_coordinates,
                                spot_fields(report), calibration_version)
            writer.writerow({key: item.get(key, "") if item.get(key, "") is not None else "" for key in fieldnames})
        return Response("\ufeff" + output.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{project_id}-burn-pits.csv"'})

    @app.get("/api/projects/{project_id}/manual-points.csv")
    def manual_points_csv(project_id: str) -> Response:
        if not store.get_project(project_id):
            raise HTTPException(404, "Project not found")
        saved_view = store.get_view(project_id) or {}
        saved_viewport = saved_view.get("viewport", saved_view) if isinstance(saved_view, dict) else {}
        points = saved_viewport.get("manualPoints", []) if isinstance(saved_viewport, dict) else []
        # Very early envelopes kept manual points at the top level. Preserve
        # those records when exporting after an upgrade as well.
        if not points and isinstance(saved_view, dict):
            points = saved_view.get("manualPoints", [])
        output = io.StringIO(newline="")
        writer = csv.DictWriter(output, fieldnames=["id", "x", "y", "value", "note", "sbd_spot_id", "raster",
                                                    "field_key", "match_distance_px", "pit_score", "auto_detected"],
                                lineterminator="\n")
        writer.writeheader()
        for point in points if isinstance(points, list) else []:
            if not isinstance(point, dict):
                continue
            writer.writerow({key: point.get(key, "") for key in writer.fieldnames})
        return Response("\ufeff" + output.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{project_id}-manual-points.csv"'})

    @app.get("/api/projects/{project_id}/layers/{layer}/tiles/{z}/{x}/{y}.png")
    def tile(project_id: str, layer: str, z: int, x: int, y: int) -> Response:
        project = store.get_project(project_id)
        if not project or project["status"] != "ready":
            raise HTTPException(404, "Project not ready")
        report = project["report"]
        source = next((item for item in report["sources"] if item["key"] == layer), None)
        registration = next((item for item in report["registrations"] if item["source_key"] == layer), None)
        if not source or not registration or registration["status"] != "passed":
            raise HTTPException(404, "Layer unavailable")
        pre = next(item for item in report["sources"] if item["key"] == "pre")
        try:
            max_level = math.ceil(math.log2(max(pre["width"], pre["height"])))
            pyramid_path = None
            if source.get("tile_pyramid_path"):
                candidate = resolve_project_file(source["tile_pyramid_path"], project_id)
                if (candidate / "manifest.json").is_file():
                    pyramid_path = candidate
            # Legacy reports are upgraded on demand when the user reaches the
            # native-resolution level. Lower levels keep their old fast preview
            # behavior while the one-time pyramid build is in progress.
            if pyramid_path is None and z >= max_level:
                pyramid_path = ensure_tile_pyramid(project_id, source, report)
            if pyramid_path is not None:
                cache_path = rendered_tile_path(project_id, layer, z, x, y)
                lock = rendered_tile_lock(cache_path)
                with lock:
                    if not cache_path.is_file():
                        data = pyramid_tile(pyramid_path, registration["matrix"],
                                            (pre["width"], pre["height"]), z, x, y)
                        cache_path.parent.mkdir(parents=True, exist_ok=True)
                        temporary_path = cache_path.with_name(f".{cache_path.name}.{threading.get_ident()}.tmp")
                        temporary_path.write_bytes(data)
                        os.replace(temporary_path, cache_path)
                return FileResponse(cache_path, media_type="image/png",
                                    headers={"Cache-Control": "private, max-age=86400"})
            # Older projects were created before persistent low-zoom previews.
            # Build one once, on demand, so they recover without re-importing.
            preview_exists = bool(source.get("preview_path") and resolve_project_file(source["preview_path"], project_id).is_file())
            if source["role"].startswith("microscopy") and not preview_exists and z <= max_level - 4:
                with preview_lock:
                    preview_path, preview_scale = make_browser_preview(resolve_project_file(source["path"], project_id), data_dir / "projects" / project_id / "cache")
                    source["preview_path"] = project_reference(project_id, Path(preview_path)) if preview_path else None
                    source["preview_scale"] = preview_scale
                    store.update_project(project_id, "ready", {"report": report})
            # The 4096px cached overview is sharp through normal demo zoom
            # levels and prevents concurrent full-PNG decoder failures.
            use_preview = source.get("preview_path") and source.get("preview_scale") and z <= max_level - 1
            tile_path = resolve_project_file(source["preview_path"], project_id) if use_preview else resolve_project_file(source["path"], project_id)
            source_scale = float(source["preview_scale"]) if use_preview else 1.0
            data = common_tile(tile_path, registration["matrix"], (pre["width"], pre["height"]), z, x, y, source_scale)
        except Exception:
            logger.exception("Tile render failed: project=%s layer=%s z=%s x=%s y=%s", project_id, layer, z, x, y)
            return Response(blank_tile(), status_code=500, media_type="image/png", headers={"X-SpatialBridge-Tile": "fallback-blank"})
        return Response(data, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})

    @app.get("/api/projects/{project_id}/validation/{artifact:path}")
    def validation_artifact(project_id: str, artifact: str) -> FileResponse:
        project = store.get_project(project_id)
        if not project or project["status"] != "ready":
            raise HTTPException(404, "Project not ready")
        project_dir = (data_dir / "projects" / project_id).resolve()
        artifact_path = (project_dir / "validation" / artifact).resolve()
        if project_dir not in artifact_path.parents or not artifact_path.is_file():
            raise HTTPException(404, "Validation artifact not found")
        return FileResponse(artifact_path)

    @app.get("/api/projects/{project_id}/thumbnail")
    @app.get("/api/projects/{project_id}/preview/{layer}")
    def preview_layer(project_id: str, layer: str = "pre", thumb: bool = False) -> FileResponse:
        project = store.get_project(project_id)
        if not project or project.get("status") not in {"ready", "processing", "running", "queued", "imported"}:
            raise HTTPException(404, "Project not ready or not found")
        project_dir = (data_dir / "projects" / project_id).resolve()
        cache_dir = project_dir / "cache"
        cache_dir.mkdir(parents=True, exist_ok=True)
        is_loading = project.get("status") in {"running", "queued", "processing"} or thumb

        report = project.get("report") or {}
        sources = report.get("sources") or []
        source = next((item for item in sources if item.get("key") == layer), None)
        if not source and layer != "pre":
            source = next((item for item in sources if item.get("key") == "pre"), None)

        # For loading-screen preview, serve a deeply compressed lightweight thumbnail (under 50KB)
        if is_loading:
            target_source_path = None
            if source:
                target_source_path = resolve_project_file(source["path"], project_id)
            else:
                source_dir = Path(project["source_dir"]) if project.get("source_dir") else None
                manifest = None
                if project.get("upload_id"):
                    upload = store.get_upload(project["upload_id"])
                    if upload and upload.get("manifest"):
                        manifest = [{**item, "path": str(upload_file_path(project["upload_id"], item))} for item in upload["manifest"]]
                if source_dir or manifest:
                    try:
                        inputs = find_inputs(source_dir or data_dir, manifest)
                        target_key = layer if layer in {"pre", "after"} else "pre"
                        target_source_path = inputs.get(target_key) or inputs.get("pre")
                    except Exception:
                        pass
            if target_source_path and Path(target_source_path).is_file():
                with preview_lock:
                    thumb_path, _ = make_quick_preview_thumbnail(Path(target_source_path), cache_dir, max_size=640)
                    if thumb_path and Path(thumb_path).is_file():
                        return FileResponse(Path(thumb_path), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})

        if source:
            if source.get("preview_path"):
                preview_file = resolve_project_file(source["preview_path"], project_id)
                if preview_file.is_file():
                    return FileResponse(preview_file, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})
            source_path = resolve_project_file(source["path"], project_id)
            if source_path.is_file():
                with preview_lock:
                    preview_path, preview_scale = make_browser_preview(source_path, cache_dir)
                    if preview_path and Path(preview_path).is_file():
                        source["preview_path"] = project_reference(project_id, Path(preview_path))
                        source["preview_scale"] = preview_scale
                        try:
                            store.update_project(project_id, project.get("status", "ready"), {"report": report})
                        except Exception:
                            pass
                        return FileResponse(Path(preview_path), media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})
                return FileResponse(source_path, media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})

        # Fallback when report is not yet generated (e.g. during processing or queuing)
        source_dir = Path(project["source_dir"]) if project.get("source_dir") else None
        manifest = None
        if project.get("upload_id"):
            upload = store.get_upload(project["upload_id"])
            if upload and upload.get("manifest"):
                manifest = [{**item, "path": str(upload_file_path(project["upload_id"], item))} for item in upload["manifest"]]
        if source_dir or manifest:
            try:
                inputs = find_inputs(source_dir or data_dir, manifest)
                target_key = layer if layer in {"pre", "after"} else "pre"
                target_path = inputs.get(target_key) or inputs.get("pre")
                if target_path and Path(target_path).is_file():
                    with preview_lock:
                        thumb_path, _ = make_quick_preview_thumbnail(Path(target_path), cache_dir, max_size=640)
                        if thumb_path and Path(thumb_path).is_file():
                            return FileResponse(Path(thumb_path), media_type="image/jpeg", headers={"Cache-Control": "private, max-age=86400"})
                        preview_path, _ = make_browser_preview(Path(target_path), cache_dir)
                        if preview_path and Path(preview_path).is_file():
                            return FileResponse(Path(preview_path), media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})
                    return FileResponse(Path(target_path), media_type="image/png", headers={"Cache-Control": "private, max-age=86400"})
            except Exception:
                pass
        raise HTTPException(404, "Requested preview layer not found")

    if frontend_dir is not None:
        frontend_root = frontend_dir.expanduser().resolve()
        index_path = frontend_root / "index.html"
        if not index_path.is_file():
            raise RuntimeError(f"Frontend build is missing its index: {index_path}")

        @app.get("/{asset_path:path}", include_in_schema=False)
        def frontend_asset(asset_path: str) -> FileResponse:
            if asset_path == "api" or asset_path.startswith("api/"):
                raise HTTPException(404, "API endpoint not found")
            candidate = (frontend_root / asset_path).resolve()
            try:
                candidate.relative_to(frontend_root)
            except ValueError as error:
                raise HTTPException(404, "Asset not found") from error
            if candidate.is_file():
                cache_control = "no-cache" if candidate.name == "index.html" else "public, max-age=3600"
                return FileResponse(candidate, headers={"Cache-Control": cache_control})
            return FileResponse(index_path, headers={"Cache-Control": "no-cache"})

    return app
