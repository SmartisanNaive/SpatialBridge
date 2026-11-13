from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any


@dataclass
class Source:
    key: str
    role: str
    path: str
    width: int
    height: int
    sha256: str
    label: str
    filename_parameter: str | None = None
    image_parameter: str | None = None
    preview_path: str | None = None
    preview_scale: float | None = None
    tile_pyramid_path: str | None = None
    tile_pyramid_max_level: int | None = None
    tile_size: int = 256


@dataclass
class Registration:
    source_key: str
    matrix: list[list[float]]
    status: str
    method: str
    metric: dict[str, Any]
    coverage: list[float]


def project_path(data_dir: Path, project_id: str) -> Path:
    return data_dir / "projects" / project_id


def serialize(value: Source | Registration) -> dict[str, Any]:
    return asdict(value)
