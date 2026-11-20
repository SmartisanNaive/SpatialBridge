<p align="center">
  <img src="frontend/public/spatialbridge-logo.png" alt="SpatialBridge logo" width="96" />
</p>

<h1 align="center">SpatialBridge</h1>

<p align="center">
  <strong>Bridge sight and spectrum.</strong>
</p>

<p align="center">
  Automatic registration, spot lookup and spectrum reading for pre/post-acquisition microscopy and MALDI spatial data
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

SpatialBridge links laser sampling positions in microscopy images to SCiLS SBD spots. After registration, click a mapped grid point to read its raw centroid spectrum, inspect saved mean spectra, or extract per-spot intensities for multiple m/z windows. Source files are read-only; project caches and manual annotations are stored separately.

![SpatialBridge single-cell MALDI signal registration workflow](docs/images/workflow.png)

## Features

- **Automatic registration**: fits a pre/post microscopy homography from eight square-hole corners inside two fiducials; uses the SBD slide image, heat map texture and `OriginalCoordinates` to check the cross-modal coordinate chain.
- **Burn-pit lattice detection**: recovers a regular lattice from clear regions, compares affine, degree-2 and degree-3 models using a spatial hold-out set, and records regional errors and the valid mapping domain.
- **Large-image viewing and spot lookup**: OpenSeadragon tiles, pre/post and swipe views, and grid-point selection. Spot details include coordinates, raster, normalization factors and an automatically loaded full spot spectrum with pagination, intensity sorting and CSV download.
- **SBD spectrum reading**: the spectral data panel automatically uses the project's full SBD. It reads saved mean spectra and spots by ID, and extracts 1–32 targets with ppm/Da windows, sum/max aggregation, saved regions and normalization factors. Results include numeric previews and complete CSV exports.
- **PNG heat map overlay and annotation**: registers existing heat map images, detects rotation/mirroring, and maps image colors onto spots. Manual points can be exported as CSV. This image overlay is a separate feature from SBD numeric extraction.
- **Full-file uploads and project management**: preserves the full SBD through 16 MiB chunks, SHA-256 verification, adaptive gzip and resumable transfers; PNGs can be losslessly optimized locally. Includes processing previews, project history and project-record deletion.
- **Integrated serving**: one application process serves the frontend, API and tiles on port 8000; Docker Compose deployment is also available.

![Workbench swipe comparison](docs/images/workbench-swipe.png)

## Typical workflow

1. Select the pre-acquisition PNG, post-acquisition PNG, and optionally a full SBD and existing heat map PNG. The slide image normally comes from the SBD and needs no separate upload.
2. Wait for registration and tile generation, then inspect pre/post alignment and lattice diagnostics. Two-PNG projects support image viewing independently; SBD queries require the corresponding data, and linked grid selection requires a valid spatial mapping.
3. Zoom into the mapped area and click an individual grid point. Its full SBD spectrum loads automatically in the inspector. At overview scale, the first click zooms in.
4. Open the spectral data panel to read mean spectra or extract multiple ion windows; download CSV for further analysis. Extracted channels are not yet rendered directly as multi-ion heat maps or microscopy overlays.

When a full SBD is available, the file-path editor stays hidden. Legacy compact-package projects or missing sources can be linked to a full SBD accessible to the backend machine; use “Change data file” to change a working source. Linking does not copy the file, so its path must remain accessible.

## Quick start

### Requirements

- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- Node.js 22+ and npm
- Optional: [libvips](https://www.libvips.org/) (faster large-image processing with `--extra tiles`) and [Tesseract](https://github.com/tesseract-ocr/tesseract) (reads m/z labels on heat maps)

### Run locally

Run from the repository root:

```bash
uv sync --extra tiles --extra dev
npm --prefix frontend install
npm --prefix frontend run build
.venv/bin/spatialbridge serve --data-dir ./workspace-data --frontend-dir frontend/dist --port 8000
```

Open `http://127.0.0.1:8000`. The same process serves the frontend and API; rebuild the frontend and restart the service after frontend changes. Developers needing hot reload can optionally run a separate Vite service; see the [development/deployment instructions](docs/deployment.md#24-可选vite-开发服务) (Chinese).

If a `参考数据/` sample directory exists in the repository root, click “载入内置示例” (load built-in demo) to try the full workflow. Sample data is not distributed with the repository.

> [!NOTE]
> uv's `.venv` records absolute paths. After moving or renaming the project directory, delete `.venv` and run `uv sync --extra tiles --extra dev` again. Rebuild `frontend/node_modules` with `npm --prefix frontend install` as needed.

### Command line and tests

```bash
# Service options: --data-dir, --frontend-dir, --host, --port
.venv/bin/spatialbridge serve --help

# Register a source directory and write a report
.venv/bin/spatialbridge register --source-dir ./参考数据 --output-dir ./workspace-data/manual-check

# Routine checks; real-SBD testing is skipped by default
.venv/bin/python -m pytest -q
npm --prefix frontend test
npm --prefix frontend run build
```

The database, upload chunks, reports and caches live under `--data-dir`. Directory imports and locally linked SBDs still depend on external source paths; preserve or relink those files when migrating.

### Server deployment

```bash
cp .env.example .env
sudo install -d -o 10001 -g 10001 -m 0770 /srv/spatialbridge/data
sudo docker compose up -d --build
```

See the [deployment guide](docs/deployment.md) (Chinese) for configuration, full-SBD storage planning, updates and backup/restore.

## Documentation

See [docs/README.md](docs/README.md) for the full index. Detailed guides are in Chinese.

| Document | Contents |
| --- | --- |
| [SBD spectrum reading](docs/sbd-spectra-reader.md) | Usage, window semantics, independent decoder, API and known-sample validation |
| [Technical architecture](docs/technical-architecture.md) | CV registration, lattice models, tiles, uploads and on-demand spectrum reading |
| [Registration and outputs](docs/algorithm.md) | Coordinate conventions, output files, workbench interactions and API |
| [Deployment and operations](docs/deployment.md) | Local single-process serving, containers, capacity planning, backup and acceptance |
| [Development guide](docs/development-guide.md) | Module responsibilities, testing, memory and source-file constraints |
| [Contributing](CONTRIBUTING.md) | Contribution workflow |

## Project layout

```text
.
├── backend/spatialbridge/   FastAPI: registration, lattice, heat map, spectra, tiles, storage, CLI
├── frontend/               React + Vite + OpenSeadragon frontend and node:test tests
├── tests/                  Backend pytest suite
├── docs/                   Documentation and images
├── Dockerfile.api          Combined frontend + backend image
├── compose.yaml            Docker Compose service
└── .env.example            Deployment configuration template
```

## Value semantics and limitations

- Spot spectra retain more precise centroid m/z values; ion windows select **global mass-axis bin centers** within inclusive bounds, without choosing a nearest bin. Narrow windows can differ from filtering precise spot centroids.
- Sparse entries and windows without matching bins are filled with zero, which does not establish physical absence. Saved normalization uses `raw / Values[spot_id]`; nonpositive factors produce zero. Equivalence to SCiLS exports has not been verified spot by spot.
- Normalization values in spot details are factors, and PNG heat map RGB values are image colors. Neither is that spot's raw ion intensity.
- The reader has mainly been verified against a SCiLS Lab 12.01, Version 36 Peaks centroid SBD. It does not provide full SCiLS parity or support every version/encoding; non-Peaks types are explicitly rejected. Numeric results and CSV are available; native multi-ion heat map rendering is not yet implemented.
- Review project reports and local image alignment when assessing registration. Fiducial residuals do not establish independent whole-image or single-cell accuracy. A slide-texture match alone cannot prove common acquisition provenance.
- The server runs in shared mode, with no accounts, permissions, per-user isolation or built-in TLS. See the [deployment guide](docs/deployment.md#本地容器验证记录已通过) for the scope of existing container checks and pending Linux deployment acceptance.

## Acknowledgements

- [SpaceM](https://github.com/alexandrovteam/SpaceM): approach to burn-pit lattice detection
- [napari-imsmicrolink](https://github.com/nhpatterson/napari-imsmicrolink): IMS coordinate matrix orientation conventions
- [OpenSeadragon](https://openseadragon.github.io/): large-image tile viewer
- imzy SCiLS reader: SBD format reference; no runtime dependency on imzy or the Bruker SDK

## License

[MIT](LICENSE)
