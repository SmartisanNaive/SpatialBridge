from __future__ import annotations

import json
import shutil
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


class Store:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.data_dir / "spatialbridge.sqlite", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self.db.execute("""CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY, created_at TEXT NOT NULL, source_dir TEXT NOT NULL,
          status TEXT NOT NULL, payload TEXT NOT NULL)""")
        self._ensure_column("projects", "project_name", "TEXT")
        self._ensure_column("projects", "import_type", "TEXT NOT NULL DEFAULT 'directory'")
        self._ensure_column("projects", "upload_id", "TEXT")
        self.db.execute("""CREATE TABLE IF NOT EXISTS uploads (
          id TEXT PRIMARY KEY, created_at TEXT NOT NULL, project_name TEXT,
          status TEXT NOT NULL, completed_project_id TEXT, manifest TEXT,
          error TEXT)""")
        self._ensure_column("uploads", "error", "TEXT")
        self.db.execute("""CREATE TABLE IF NOT EXISTS upload_files (
          id TEXT PRIMARY KEY, upload_id TEXT NOT NULL, role TEXT NOT NULL,
          filename TEXT NOT NULL, size INTEGER NOT NULL, chunk_size INTEGER NOT NULL,
          total_chunks INTEGER NOT NULL, final_path TEXT, full_sha256 TEXT,
          UNIQUE(upload_id, id))""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS upload_chunks (
          upload_id TEXT NOT NULL, file_id TEXT NOT NULL, chunk_index INTEGER NOT NULL,
          size INTEGER NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL,
          PRIMARY KEY(upload_id, file_id, chunk_index))""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS saved_views (
          project_id TEXT PRIMARY KEY, viewport TEXT NOT NULL, updated_at TEXT NOT NULL)""")
        # A process restart cannot resume the in-memory worker. Mark those
        # records explicitly so the UI can offer a retry instead of polling
        # forever.
        self.db.execute(
            "UPDATE projects SET status='failed', payload=? WHERE status IN ('queued', 'running')",
            (json.dumps({"error": "处理进程在上次会话中断，请重试。", "progress": {"stage": "已中断"}}),),
        )
        self.db.execute(
            "UPDATE uploads SET status='failed', error=? WHERE status='assembling'",
            ("服务重启时文件合并中断。请重新提交完成操作，已上传分片会保留。",),
        )
        self.db.commit()
        self.cleanup_completed_upload_chunks()

    def _ensure_column(self, table: str, column: str, definition: str) -> None:
        columns = {row[1] for row in self.db.execute(f"PRAGMA table_info({table})").fetchall()}
        if column not in columns:
            self.db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    def check_health(self) -> bool:
        """Confirm the database and persistent data directory are usable."""
        probe = self.data_dir / f".health-{uuid.uuid4().hex}"
        try:
            with self._lock:
                self.db.execute("SELECT 1").fetchone()
            with probe.open("xb"):
                pass
            probe.unlink()
            return True
        except (OSError, sqlite3.Error):
            try:
                probe.unlink(missing_ok=True)
            except OSError:
                pass
            return False

    def close(self) -> None:
        with self._lock:
            self.db.close()

    @staticmethod
    def _project_from_row(row: sqlite3.Row) -> dict[str, Any]:
        payload = json.loads(row["payload"] or "{}")
        result = {"id": row["id"], "created_at": row["created_at"], "source_dir": row["source_dir"],
                  "status": row["status"], **payload}
        if "project_name" in row.keys() and row["project_name"]:
            result["project_name"] = row["project_name"]
        if "import_type" in row.keys():
            result["import_type"] = row["import_type"] or "directory"
        if "upload_id" in row.keys() and row["upload_id"]:
            result["upload_id"] = row["upload_id"]
        return result

    def create_project(self, project_id: str, source_dir: str, project_name: str | None = None,
                       import_type: str = "directory", upload_id: str | None = None) -> None:
        with self._lock:
            self.db.execute("""INSERT INTO projects
              (id, created_at, source_dir, status, payload, project_name, import_type, upload_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)""", (
                project_id, datetime.now(timezone.utc).isoformat(), source_dir, "queued", "{}",
                project_name, import_type, upload_id))
            self.db.commit()

    def find_active_by_source(self, source_dir: str) -> dict[str, Any] | None:
        """Return the newest in-flight project for a normalized source path."""
        with self._lock:
            row = self.db.execute(
                "SELECT * FROM projects WHERE source_dir=? AND status IN ('queued', 'running') "
                "ORDER BY created_at DESC LIMIT 1",
                (source_dir,),
            ).fetchone()
        if row is None:
            return None
        return self._project_from_row(row)

    def get_or_create_active(self, project_id: str, source_dir: str, project_name: str | None = None,
                             import_type: str = "directory", upload_id: str | None = None) -> tuple[dict[str, Any], bool]:
        """Atomically reuse an in-flight source or create a new project."""
        with self._lock:
            self.db.execute("BEGIN IMMEDIATE")
            row = self.db.execute(
                "SELECT * FROM projects WHERE source_dir=? AND status IN ('queued', 'running') "
                "ORDER BY created_at DESC LIMIT 1",
                (source_dir,),
            ).fetchone()
            if row is not None:
                self.db.commit()
                return (self._project_from_row(row), True)
            created_at = datetime.now(timezone.utc).isoformat()
            self.db.execute("""INSERT INTO projects
              (id, created_at, source_dir, status, payload, project_name, import_type, upload_id)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)""", (
                project_id, created_at, source_dir, "queued", "{}", project_name, import_type, upload_id))
            self.db.commit()
        result = {"id": project_id, "created_at": created_at, "source_dir": source_dir, "status": "queued",
                  "import_type": import_type}
        if project_name:
            result["project_name"] = project_name
        if upload_id:
            result["upload_id"] = upload_id
        return (result, False)

    def update_project(self, project_id: str, status: str, payload: dict[str, Any]) -> None:
        with self._lock:
            self.db.execute("UPDATE projects SET status=?, payload=? WHERE id=?", (status, json.dumps(payload), project_id))
            self.db.commit()

    def get_project(self, project_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
        if row is None:
            return None
        return self._project_from_row(row)

    def list_projects(self) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.db.execute("SELECT * FROM projects ORDER BY created_at DESC").fetchall()
        return [self._project_from_row(r) for r in rows]

    def create_upload(self, upload_id: str, project_name: str | None, files: list[dict[str, Any]]) -> dict[str, Any]:
        created_at = datetime.now(timezone.utc).isoformat()
        with self._lock:
            self.db.execute("""INSERT INTO uploads
              (id, created_at, project_name, status, completed_project_id, manifest, error)
              VALUES (?, ?, ?, 'pending', NULL, NULL, NULL)""",
                            (upload_id, created_at, project_name))
            for item in files:
                self.db.execute("""INSERT INTO upload_files
                  (id, upload_id, role, filename, size, chunk_size, total_chunks)
                  VALUES (?, ?, ?, ?, ?, ?, ?)""", (
                    item["id"], upload_id, item["role"], item["filename"], int(item["size"]),
                    int(item["chunk_size"]), int(item["total_chunks"])))
            self.db.commit()
        return self.get_upload(upload_id)  # type: ignore[return-value]

    def get_upload(self, upload_id: str) -> dict[str, Any] | None:
        with self._lock:
            upload = self.db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if upload is None:
                return None
            files = self.db.execute("SELECT * FROM upload_files WHERE upload_id=? ORDER BY rowid", (upload_id,)).fetchall()
            result_files: list[dict[str, Any]] = []
            for file_row in files:
                chunks = self.db.execute(
                    "SELECT chunk_index, size, sha256, path FROM upload_chunks WHERE upload_id=? AND file_id=? ORDER BY chunk_index",
                    (upload_id, file_row["id"]),
                ).fetchall()
                result_files.append({**dict(file_row), "chunks": [dict(chunk) for chunk in chunks]})
        return {**dict(upload), "files": result_files,
                "manifest": json.loads(upload["manifest"]) if upload["manifest"] else None}

    def mark_upload_assembling(self, upload_id: str) -> bool:
        """Claim an upload for assembly, including retry after a restart."""
        with self._lock:
            cursor = self.db.execute(
                "UPDATE uploads SET status='assembling', error=NULL "
                "WHERE id=? AND status IN ('pending', 'failed')",
                (upload_id,),
            )
            self.db.commit()
            return cursor.rowcount == 1

    def fail_upload_assembly(self, upload_id: str, error: str) -> None:
        with self._lock:
            self.db.execute("UPDATE uploads SET status='failed', error=? WHERE id=? AND status='assembling'",
                            (error, upload_id))
            self.db.commit()

    def record_chunk(self, upload_id: str, file_id: str, chunk_index: int, size: int,
                     sha256: str, path: str) -> None:
        with self._lock:
            self.db.execute("""INSERT INTO upload_chunks
              (upload_id, file_id, chunk_index, size, sha256, path) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(upload_id, file_id, chunk_index) DO UPDATE SET
              size=excluded.size, sha256=excluded.sha256, path=excluded.path""",
              (upload_id, file_id, int(chunk_index), int(size), sha256, path))
            self.db.commit()

    def finalize_upload(self, upload_id: str, project_id: str, source_dir: str,
                        manifest: list[dict[str, Any]]) -> tuple[dict[str, Any], bool]:
        with self._lock:
            self.db.execute("BEGIN IMMEDIATE")
            upload = self.db.execute("SELECT * FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if upload is None:
                self.db.rollback()
                raise KeyError(upload_id)
            if upload["completed_project_id"]:
                self.db.commit()
                existing = self.db.execute("SELECT * FROM projects WHERE id=?", (upload["completed_project_id"],)).fetchone()
                if existing is None:
                    raise RuntimeError("Upload references a missing project")
                return self._project_from_row(existing), True
            created_at = datetime.now(timezone.utc).isoformat()
            project_name = upload["project_name"]
            self.db.execute("""INSERT INTO projects
              (id, created_at, source_dir, status, payload, project_name, import_type, upload_id)
              VALUES (?, ?, ?, 'queued', '{}', ?, 'upload', ?)""",
              (project_id, created_at, source_dir, project_name, upload_id))
            self.db.executemany("UPDATE upload_files SET final_path=?, full_sha256=? WHERE upload_id=? AND id=?",
                                [(item["path"], item.get("sha256"), upload_id, item["file_id"])
                                 for item in manifest])
            self.db.execute("UPDATE uploads SET status='completed', completed_project_id=?, manifest=? WHERE id=?",
                            (project_id, json.dumps(manifest), upload_id))
            self.db.execute("DELETE FROM upload_chunks WHERE upload_id=?", (upload_id,))
            self.db.commit()
        result = {"id": project_id, "created_at": created_at, "source_dir": source_dir,
                  "status": "queued", "import_type": "upload", "upload_id": upload_id}
        if project_name:
            result["project_name"] = project_name
        return result, False

    def cleanup_completed_upload_chunks(self) -> None:
        """Remove chunk directories left behind by a crash after finalization."""
        with self._lock:
            upload_ids = [row[0] for row in self.db.execute(
                "SELECT id FROM uploads WHERE status='completed'"
            ).fetchall()]
            if upload_ids:
                self.db.execute("DELETE FROM upload_chunks WHERE upload_id IN "
                                "(SELECT id FROM uploads WHERE status='completed')")
                self.db.commit()
        for upload_id in upload_ids:
            shutil.rmtree(self.data_dir / "uploads" / upload_id / "chunks", ignore_errors=True)

    def cancel_upload(self, upload_id: str) -> bool:
        with self._lock:
            row = self.db.execute("SELECT status FROM uploads WHERE id=?", (upload_id,)).fetchone()
            if row is None:
                return False
            if row["status"] in {"completed", "assembling"}:
                raise ValueError(f"{row['status']} upload cannot be cancelled")
            self.db.execute("DELETE FROM upload_chunks WHERE upload_id=?", (upload_id,))
            self.db.execute("DELETE FROM upload_files WHERE upload_id=?", (upload_id,))
            self.db.execute("DELETE FROM uploads WHERE id=?", (upload_id,))
            self.db.commit()
        return True

    def save_view(self, project_id: str, viewport: dict[str, Any]) -> None:
        with self._lock:
            self.db.execute("""INSERT INTO saved_views VALUES (?, ?, ?) ON CONFLICT(project_id)
              DO UPDATE SET viewport=excluded.viewport, updated_at=excluded.updated_at""",
              (project_id, json.dumps(viewport), datetime.now(timezone.utc).isoformat()))
            self.db.commit()

    def get_view(self, project_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.db.execute("SELECT viewport FROM saved_views WHERE project_id=?", (project_id,)).fetchone()
        if not row:
            return None
        value = json.loads(row[0])
        # Older installations stored the viewport directly. Keep the public
        # response stable while allowing the new settings envelope.
        if isinstance(value, dict) and "viewport" in value:
            return value
        return {"version": 1, "viewport": value, "settings": {}}
