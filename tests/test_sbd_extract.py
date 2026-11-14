import io
import json
import struct

import h5py
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from spatialbridge.app import create_app
from spatialbridge.integration import _extract_embedded_board, _read_sbd
from spatialbridge.sbd import PACKAGE_MAGIC, materialize_sbd_package, validate_sbd_extract


@pytest.fixture
def extract(tmp_path):
    path = tmp_path / "sample.spatialbridge.sbd"
    image = io.BytesIO()
    Image.new("RGB", (32, 16), (30, 50, 70)).save(image, "PNG")
    with h5py.File(path, "w") as handle:
        handle.attrs["spatialbridge_format"] = "sbd-extract"
        handle.attrs["spatialbridge_version"] = 1
        handle.attrs["nSpots"] = "3"
        handle.create_dataset("Registrations/0/Coordinates", data=np.array([[0, 20, 40], [0, 0, 0], [0, 0, 0]], dtype="float32"))
        handle.create_dataset("Registrations/0/OriginalCoordinates", data=np.array([[0, 1, 2], [0, 0, 0]], dtype="uint64"))
        handle.create_dataset("Registrations/0/SpotSizes", data=np.full((3, 3), 20, dtype="float32"))
        handle.create_dataset("MeasurementRasterIndices", data=np.zeros((1, 3), dtype="int32"))
        normalization = handle.create_group("SpectraGroup/Normalizations/tic")
        normalization.attrs["name"] = "TIC"
        normalization.create_dataset("Values", data=np.array([10, 20, 30], dtype="float32"))
        optical = handle.create_group("OpticalImages/board")
        optical.attrs["name"] = "board"
        optical.create_dataset("ImageData", data=np.frombuffer(image.getvalue(), dtype="uint8"))
        optical.create_dataset("World2Px", data=np.eye(4))
    return path


def test_extract_retains_the_existing_sbd_reader_contract(extract, tmp_path):
    with h5py.File(extract) as handle:
        validate_sbd_extract(handle)
    board, matrix = _extract_embedded_board(extract, tmp_path / "cache")
    assert Image.open(board).size == (32, 16)
    np.testing.assert_array_equal(matrix, np.eye(3))
    parsed = _read_sbd(extract, (32, 16))
    np.testing.assert_array_equal(parsed["original"], [[0, 0], [1, 0], [2, 0]])
    np.testing.assert_array_equal(parsed["values"][0]["array"], [10, 20, 30])
    assert parsed["values"][0]["label"] == "TIC"


@pytest.mark.parametrize("fault", ["version", "coordinates", "raster", "normalization", "spectra", "board"])
def test_invalid_extract_is_rejected(extract, fault):
    with h5py.File(extract, "r+") as handle:
        if fault == "version":
            handle.attrs["spatialbridge_version"] = 2
        elif fault == "coordinates":
            del handle["Registrations/0/Coordinates"]
        elif fault == "raster":
            del handle["MeasurementRasterIndices"]
            handle.create_dataset("MeasurementRasterIndices", data=[0])
        elif fault == "normalization":
            del handle["SpectraGroup/Normalizations/tic/Values"]
            handle.create_dataset("SpectraGroup/Normalizations/tic/Values", data=[1])
        elif fault == "spectra":
            handle.create_dataset("SpectraGroup/intensities", data=[123])
        else:
            del handle["OpticalImages"]
        with pytest.raises(ValueError):
            validate_sbd_extract(handle)


def test_full_sbd_remains_accepted_without_extract_marker(tmp_path):
    with h5py.File(tmp_path / "original.sbd", "w") as handle:
        handle.create_dataset("SpectraGroup/intensities", data=[123])
        validate_sbd_extract(handle)


def test_upload_checks_extract_version_before_starting_processing(extract, tmp_path):
    with h5py.File(extract, "r+") as handle:
        handle.attrs["spatialbridge_version"] = 99
    image = io.BytesIO()
    Image.new("L", (4, 4)).save(image, "PNG")
    contents = {"pre": image.getvalue(), "after": image.getvalue(), "sbd": extract.read_bytes()}
    with TestClient(create_app(tmp_path / "data")) as client:
        upload = client.post("/api/uploads", json={"files": [
            {"role": role, "filename": "sample.sbd" if role == "sbd" else f"{role}.png", "size": len(content)}
            for role, content in contents.items()
        ]}).json()
        for item in upload["files"]:
            response = client.put(f'/api/uploads/{upload["id"]}/files/{item["id"]}/chunks/0', content=contents[item["role"]])
            assert response.status_code == 200
        response = client.post(f'/api/uploads/{upload["id"]}/complete')
        assert response.status_code == 400
        assert "版本" in response.json()["detail"]
        assert client.get("/api/projects").json() == []


def package_from_fixture(path):
    groups, datasets, blocks = [], [], []
    offset = 0
    with h5py.File(path) as handle:
        def attributes(item):
            result = []
            for name, value in item.attrs.items():
                array = np.asarray(value)
                strings = array.dtype.kind in "OUS"
                result.append({"name": name, "dtype": "string" if strings else array.dtype.name,
                               "shape": list(array.shape), "values": [str(v) for v in array.reshape(-1)]})
            return result

        groups.append({"path": "", "attrs": attributes(handle)})
        def visit(name, item):
            nonlocal offset
            if isinstance(item, h5py.Group):
                groups.append({"path": name, "attrs": attributes(item)})
            else:
                data = item[...].tobytes()
                datasets.append({"path": name, "dtype": item.dtype.name, "shape": list(item.shape),
                                 "offset": offset, "length": len(data), "attrs": attributes(item)})
                blocks.append(data)
                offset += len(data)
        handle.visititems(visit)
    return {"format": "sbd-extract", "version": 1, "source": {"name": "原始.sbd", "size": 5_809_336_884},
            "groups": groups, "datasets": datasets}, b"".join(blocks)


def encode_package(metadata, body):
    raw = json.dumps(metadata, ensure_ascii=False).encode()
    return PACKAGE_MAGIC + struct.pack("<I", len(raw)) + raw + body


def test_browser_package_preserves_uint64_and_existing_reader(extract, tmp_path):
    with h5py.File(extract, "r+") as handle:
        handle["Registrations/0/OriginalCoordinates"][0, 2] = 2**53 + 1
    metadata, body = package_from_fixture(extract)
    packet = tmp_path / "browser.sbdx"
    packet.write_bytes(encode_package(metadata, body))
    restored = tmp_path / "restored.sbd"
    materialize_sbd_package(packet, restored)
    before, after = _read_sbd(extract, (32, 16)), _read_sbd(restored, (32, 16))
    for key in ["world", "original", "spot_sizes", "world_to_board", "raster"]:
        np.testing.assert_array_equal(before[key], after[key], strict=True)
    with h5py.File(restored) as handle:
        assert handle["Registrations/0/OriginalCoordinates"][0, 2] == 2**53 + 1
        assert handle.attrs["source_name"] == "原始.sbd"
        validate_sbd_extract(handle)


@pytest.mark.parametrize("fault", ["offset", "length", "truncated", "trailing", "version", "raw-spectra", "shape"])
def test_corrupt_browser_package_is_rejected_and_output_removed(extract, tmp_path, fault):
    metadata, body = package_from_fixture(extract)
    if fault == "offset":
        metadata["datasets"][0]["offset"] = 1
    elif fault == "length":
        metadata["datasets"][0]["length"] += 1
    elif fault == "truncated":
        body = body[:-1]
    elif fault == "trailing":
        body += b"unexpected spectra"
    elif fault == "version":
        metadata["version"] = 2
    elif fault == "raw-spectra":
        metadata["datasets"][0]["path"] = "SpectraGroup/intensities"
    else:
        metadata["datasets"][0]["shape"] = [2**40]
    packet = tmp_path / "corrupt.sbdx"
    packet.write_bytes(encode_package(metadata, body))
    output = tmp_path / "output.sbd"
    with pytest.raises(ValueError):
        materialize_sbd_package(packet, output)
    assert not output.exists()


def test_uploaded_browser_package_becomes_a_small_sbd(extract, tmp_path, monkeypatch):
    metadata, body = package_from_fixture(extract)
    image = io.BytesIO()
    Image.new("L", (4, 4)).save(image, "PNG")
    contents = {"pre": image.getvalue(), "after": image.getvalue(), "sbd": encode_package(metadata, body)}
    monkeypatch.setattr("spatialbridge.app.build_project", lambda *args: {"sources": []})
    data = tmp_path / "data"
    with TestClient(create_app(data)) as client:
        upload = client.post("/api/uploads", json={"files": [
            {"role": role, "filename": "sample.sbdx" if role == "sbd" else f"{role}.png", "size": len(content)}
            for role, content in contents.items()
        ]}).json()
        for item in upload["files"]:
            assert client.put(f'/api/uploads/{upload["id"]}/files/{item["id"]}/chunks/0', content=contents[item["role"]]).status_code == 200
        response = client.post(f'/api/uploads/{upload["id"]}/complete')
        assert response.status_code == 202
    assert not list(data.rglob("*.sbdx"))
    restored = list(data.rglob("*.sbd"))
    assert len(restored) == 1
    with h5py.File(restored[0]) as handle:
        validate_sbd_extract(handle)
        assert "intensities" not in handle["SpectraGroup"]
