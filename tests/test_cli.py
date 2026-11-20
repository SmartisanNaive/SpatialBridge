from fastapi.testclient import TestClient

from spatialbridge import cli


def test_serve_defaults_to_frontend_and_api_on_one_port(tmp_path, monkeypatch):
    frontend = tmp_path / "frontend" / "dist"
    frontend.mkdir(parents=True)
    (frontend / "index.html").write_text("<html>SpatialBridge</html>")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("sys.argv", ["spatialbridge", "serve"])
    served = {}

    def run(app, *, host, port):
        served.update(host=host, port=port)
        with TestClient(app) as client:
            assert client.get("/").text == "<html>SpatialBridge</html>"
            assert client.get("/api/health").status_code == 200
            assert client.get("/api/missing").status_code == 404

    monkeypatch.setattr(cli.uvicorn, "run", run)
    cli.main()
    assert served == {"host": "127.0.0.1", "port": 8000}
