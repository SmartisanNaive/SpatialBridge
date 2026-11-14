<p align="center">
  <img src="frontend/public/spatialbridge-logo.png" alt="SpatialBridge logo" width="96" />
</p>

<h1 align="center">SpatialBridge</h1>

<p align="center">
  Automatic registration and linked viewing of pre/post-acquisition microscopy and MALDI spatial data
</p>

<p align="center">
  <a href="https://github.com/SmartisanNaive/SpatialBridge/actions/workflows/ci.yml"><img src="https://github.com/SmartisanNaive/SpatialBridge/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/python-3.11%2B-3776AB.svg" alt="Python 3.11+" />
  <img src="https://img.shields.io/badge/node-22%2B-339933.svg" alt="Node.js 22+" />
</p>

<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

---

SpatialBridge reads per-spot coordinates and normalization values from a SCiLS SBD file. Together with a MALDI heat map and two microscopy PNGs, it builds the coordinate chain `SBD world → slide image pixel → heat map pixel → microscopy PNG pixel` and confirms laser burn pits on the post-acquisition image. Source files are opened read-only. Project caches and manual annotations are stored separately.

![SpatialBridge single-cell MALDI signal registration workflow](docs/images/workflow.png)

## Features

- **Automatic registration**: texture matching between the slide image and heat map, plus an independent consistency check against SBD `OriginalCoordinates`.
- **Burn-pit lattice detection**: fits a regular lattice from clear regions and selects a smoothing model with a spatial hold-out set.
- **Large-image viewer**: OpenSeadragon tiles with pre, post and swipe comparison views; draws 100k+ spot footprints smoothly.
- **Spot lookup and annotation**: click any spot to see its SBD record and all normalization values; export manual points as CSV.
- **Heat map overlay**: detects heat map rotation and mirroring automatically, then colors each SBD spot.
- **Large uploads**: the browser extracts SBD coordinates, normalization values and optical images before uploading a compact package; 16 MiB chunks, SHA-256 verification, adaptive gzip, resumable transfers.
- **Single-container deployment**: Docker Compose on a Linux server, with data persisted on the host.

![Workbench swipe comparison](docs/images/workbench-swipe.png)

## Quick start

### Requirements

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Node.js 22+ and npm
- Optional: [libvips](https://www.libvips.org/) (faster large-image processing with `--extra tiles`) and [Tesseract](https://github.com/tesseract-ocr/tesseract) (reads the m/z label on heat maps)

### Run locally

```bash
# Backend (http://127.0.0.1:8000 by default)
uv sync --extra tiles --extra dev
uv run spatialbridge serve --data-dir ./workspace-data

# Frontend, in a second terminal (http://localhost:5173 by default)
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. On the project home page, select the pre-acquisition PNG, the post-acquisition PNG, and optionally the SBD file and a heat map. You don't need to upload the slide image, because the SBD embeds the slide image and coordinate matrices that SCiLS used for registration.

If a `参考数据/` sample directory exists in the project root, click "载入内置示例" (load built-in demo) to try the full workflow. Sample data is not distributed with the repository.

> [!NOTE]
> The `.venv` created by uv records absolute paths. After moving or renaming the project directory, delete `.venv` and run `uv sync --extra tiles --extra dev` again. Rebuild `frontend/node_modules` with `npm install` the same way.

### Command line

```bash
# Start the web service
uv run spatialbridge serve --data-dir ./workspace-data [--host 127.0.0.1] [--port 8000] [--frontend-dir frontend/dist]

# Register a source directory and write a report
uv run spatialbridge register --source-dir ./参考数据 --output-dir ./workspace-data/manual-check
```

The database, upload chunks, reports and caches all live under `--data-dir`. Nothing is written into the source directory.

### Server deployment

```bash
cp .env.example .env
sudo install -d -o 10001 -g 10001 -m 0770 /srv/spatialbridge/data
sudo docker compose up -d --build
```

See the [deployment guide](docs/deployment.md) (Chinese) for configuration, updates, backup and restore, and usage limits.

## Documentation

The detailed documents are currently in Chinese.

| Document | Contents |
| --- | --- |
| [docs/deployment.md](docs/deployment.md) | Linux deployment, configuration, operations, backup and restore, acceptance checklist |
| [docs/algorithm.md](docs/algorithm.md) | Coordinate chain, lattice detection, output files, workbench interaction, HTTP API |
| [CONTRIBUTING.md](CONTRIBUTING.md) | Development setup, tests, code layout, commit conventions |

## Project layout

```text
.
├── backend/spatialbridge/   FastAPI backend: registration, lattice, heat map, tiles, storage, CLI
├── frontend/                React + Vite + OpenSeadragon frontend
│   ├── src/                 Page components and pure logic modules
│   └── tests/               Frontend unit tests (node:test)
├── tests/                   Backend pytest suite
├── docs/                    Documentation and images
├── Dockerfile.api           Combined frontend + backend image
├── compose.yaml             Docker Compose service
└── .env.example             Deployment configuration template
```

## Limitations

- Heat map colors are sampled from the rendered image. They approximate the signal and are not raw m/z ion intensities.
- A slide-texture match alone does not prove that a heat map comes from the same acquisition. Check the sample provenance.
- The server runs in shared mode, with no accounts, permissions, per-user data isolation or built-in TLS.
- The container image has passed build, real two-PNG processing and persistence checks across container recreation on macOS Apple Container (Linux/ARM64). Acceptance on a real Linux server is still pending; see the [validation record and acceptance checklist](docs/deployment.md#本地容器验证记录).

## Acknowledgements

- [SpaceM](https://github.com/alexandrovteam/SpaceM): approach to burn-pit lattice detection
- [napari-imsmicrolink](https://github.com/nhpatterson/napari-imsmicrolink): IMS coordinate matrix orientation conventions
- [OpenSeadragon](https://openseadragon.github.io/): large-image tile viewer

## License

[MIT](LICENSE)
