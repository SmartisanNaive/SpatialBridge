from __future__ import annotations

import argparse
from pathlib import Path

import uvicorn

from .app import create_app
from .registration import build_project


def main() -> None:
    parser = argparse.ArgumentParser(prog="spatialbridge")
    commands = parser.add_subparsers(dest="command", required=True)
    serve = commands.add_parser("serve", help="Run the SpatialBridge web application")
    serve.add_argument("--data-dir", type=Path, default=Path("workspace-data"))
    serve.add_argument(
        "--frontend-dir", type=Path, default=Path("frontend/dist"),
        help="Built frontend directory (default: frontend/dist; run bun run --cwd frontend build first)",
    )
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    check = commands.add_parser("register", help="Run registration and save a report")
    check.add_argument("--source-dir", type=Path, required=True)
    check.add_argument("--output-dir", type=Path, default=Path("workspace-data/manual-check"))
    args = parser.parse_args()
    if args.command == "serve":
        uvicorn.run(create_app(args.data_dir, args.frontend_dir), host=args.host, port=args.port)
    else:
        report = build_project(args.source_dir.resolve(), args.output_dir.resolve())
        print(f"Registration report written to {args.output_dir / 'report.json'}")
        print("Layers:", ", ".join(item["key"] for item in report["sources"]))


if __name__ == "__main__":
    main()
