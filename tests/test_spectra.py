import os
from pathlib import Path
import struct
import zlib

import h5py
import numpy as np
import pytest
from fastapi.testclient import TestClient

from spatialbridge.app import create_app
from spatialbridge.spectra import SBDReader, SpectraUnavailable, decode_masses, decode_spots
from spatialbridge.storage import Store


def encode_indices(indices, width):
    previous = 0
    words = []
    for index in indices:
        words.append(int(index - previous).to_bytes(width, "little"))
        previous = index
    return zlib.compress(bytes(word[byte] for byte in range(width) for word in words))


def encode_masses(masses):
    if not masses:
        return b""
    origin, scale = masses[0], 500000.0
    indices = [round((mass - origin) * scale) for mass in masses]
    deltas = np.diff([0, *indices])
    width = max(1, (int(max(deltas)).bit_length() + 7) // 8)
    return encode_indices(indices, width) + struct.pack("<Bdd", width, scale, origin)


def packed(group, offsets_name, payload_name, arrays, dtype):
    offsets = [0]
    for values in arrays[:-1]:
        offsets.append(offsets[-1] + len(values))
    group[offsets_name] = np.array(offsets, dtype=np.uint64)
    group[payload_name] = np.concatenate([np.asarray(list(values), dtype=dtype) for values in arrays])


@pytest.fixture
def sbd(tmp_path):
    path = tmp_path / "test.sbd"
    with h5py.File(path, "w") as f:
        f.attrs["SpectraType"] = [b"Peaks"]
        f.attrs["uuid"] = [b"fixture-id"]
        f["Version"] = [36]
        f["SamplePositions/GlobalMassAxis/SamplePositions"] = [100., 101., 102., 103.]
        f["Registrations/0/OriginalCoordinates"] = [[0, 1, 0, 1], [0, 0, 1, 1]]
        f["MeasurementRasterIndices"] = [[0, 0, 1, 1]]
        g = f.create_group("SpectraGroup")
        packed(g, "imageSpotOffsets", "compressedImageSpots", [encode_indices([0, 2], 1), encode_indices([1, 2], 1), b"", encode_indices([3], 1)], np.uint8)
        packed(g, "imageIntensityOffsets", "imageIntensities", [[10, 30], [20, 5], [], [40]], np.float32)
        packed(g, "mzOffsets", "compressedMz", [encode_masses([100.000002]), encode_masses([101.000004]), encode_masses([100.000004, 101.000004]), encode_masses([103.000002])], np.uint8)
        packed(g, "intensityOffsets", "intensities", [[10], [20], [30, 5], [40]], np.float32)
        g["Normalizations/tic/Values"] = [1, 2, 0, 4]
        g["Normalizations/tic"].attrs["name"] = [b"Total Ion Count"]
        f["MeanSpectra/raw/Intensities"] = [10., 20., 0., 40.]
        f["MeanSpectra/raw/RegionId"] = [b"Regions"]
        f["Regions/SpotList"] = [0, 1, 2, 3]
        f["Regions/sub/SpotList"] = [2, 3]
        f["Regions/sub"].attrs["name"] = [b"02"]
    return path


@pytest.mark.parametrize("width", [1, 2, 3, 4, 5, 6, 7, 8])
def test_spatial_codec_all_widths(width):
    maximum = min(2 ** (width * 8) - 1, 100000)
    indices = [0, maximum, maximum + 2]
    assert decode_spots(encode_indices(indices, width), 3, maximum + 3).tolist() == indices
    assert decode_spots(encode_indices(indices, width) + bytes([width]), 3, maximum + 3).tolist() == indices


def test_mass_codec_preserves_precision_and_trailer():
    masses = [327.9886870225748, 328.9936910225748, 726.5024230225748]
    np.testing.assert_allclose(decode_masses(encode_masses(masses), 3), masses, rtol=0, atol=1e-10)
    with pytest.raises(ValueError, match="还原参数"):
        decode_masses(encode_masses(masses)[:-1], 3)
    with pytest.raises(ValueError):
        decode_masses(encode_masses(masses), 2)


def test_codec_rejects_corruption_duplicates_and_overflow():
    for block in [b"broken", zlib.compress(b"\0" * 10000), encode_indices([0, 2], 1) + b"trailing", encode_indices([0, 0], 1), encode_indices([0, 9], 1)]:
        with pytest.raises(ValueError):
            decode_spots(block, 2, 4)
    block = zlib.compress((2 ** 64 - 1).to_bytes(8, "little")[:1] * 2 + b"\xff\x00" * 7)
    with pytest.raises(ValueError):
        decode_spots(block, 2, 10)


def test_summary_mean_precise_spot_and_last_offsets(sbd):
    with SBDReader(sbd) as reader:
        info = reader.summary()
        assert info["available"] and info["spot_spectra_available"]
        assert info["spot_count"] == 4 and info["mz_count"] == 4
        assert info["normalizations"] == [{"id": "tic", "name": "Total Ion Count"}]
        assert reader.mean_spectrum("raw")["intensities"] == [10, 20, 0, 40]
        spot = reader.spot_spectrum(2)
        np.testing.assert_allclose(spot["mz"], [100.000004, 101.000004])
        assert spot["intensities"] == [30, 5]
        assert reader.spot_spectrum(3)["intensities"] == [40]
        for invalid in [-1, 4]:
            with pytest.raises(ValueError):
                reader.spot_spectrum(invalid)


def test_inclusive_multi_ion_sum_max_ppm_empty_and_region(sbd):
    with SBDReader(sbd) as reader:
        result = reader.ion_signals([{"mz": 100, "tolerance": 1, "unit": "Da"}, {"mz": 103, "tolerance": 5, "unit": "ppm"}])
        assert result["channels"][0]["intensities"] == [10, 20, 35, 0]
        assert result["channels"][0]["bin_count"] == 2
        assert result["channels"][1]["intensities"] == [0, 0, 0, 40]
        assert result["rasters"] == [0, 0, 1, 1]
        assert result["coordinates"] == [[0, 0], [1, 0], [0, 1], [1, 1]]
        maximum = reader.ion_signals([{"mz": 101, "tolerance": 1, "unit": "Da"}], aggregation="max")
        assert maximum["channels"][0]["intensities"] == [10, 20, 30, 0]
        normalized = reader.ion_signals([{"mz": 101.5, "tolerance": 2, "unit": "Da"}], normalization="tic")
        assert normalized["channels"][0]["intensities"] == [10, 10, 0, 10]
        region = reader.ion_signals([{"mz": 103, "tolerance": 0, "unit": "Da"}], region="sub")
        assert region["spot_ids"] == [2, 3]
        assert region["channels"][0]["intensities"] == [0, 40]
        for mass in [102, 105, 100.5]:
            empty = reader.ion_signals([{"mz": mass, "tolerance": 0, "unit": "Da"}])
            assert empty["channels"][0]["intensities"] == [0, 0, 0, 0]
        with pytest.raises(ValueError):
            reader.ion_signals([{"mz": 100, "tolerance": -1, "unit": "Da"}])
        with pytest.raises(ValueError):
            reader.ion_signals([{"mz": 100, "tolerance": 1, "unit": "Da"}], normalization="bad")


def test_reader_rejects_bad_offset_and_compact(sbd):
    with h5py.File(sbd, "r+") as f:
        f["SpectraGroup/imageSpotOffsets"][1] = 999999
    with pytest.raises(ValueError, match="偏移"):
        with SBDReader(sbd):
            pass
    with h5py.File(sbd, "r+") as f:
        f.attrs["spatialbridge_format"] = "sbd-extract"
    with pytest.raises(SpectraUnavailable, match="精简包"):
        with SBDReader(sbd):
            pass


def test_spectral_routes_attachment_recovery_and_validation(tmp_path, sbd):
    directory = tmp_path / "data"
    store = Store(directory)
    store.create_project("p", str(tmp_path))
    store.update_project("p", "ready", {"report": {"maldi_data": {"path": str(sbd), "spot_count": 4}}})
    store.create_project("empty", str(tmp_path))
    store.update_project("empty", "ready", {"report": {}})
    store.close()
    with TestClient(create_app(directory)) as client:
        assert client.get("/api/projects/missing/spectra").status_code == 404
        assert client.get("/api/projects/empty/spectra").json()["available"] is False
        assert client.get("/api/projects/p/spectra").json()["mz_count"] == 4
        assert client.get("/api/projects/p/spectra/mean?id=raw").json()["mz"] == [100, 101, 102, 103]
        assert client.get("/api/projects/p/spectra/spots/3").json()["intensities"] == [40]
        assert client.get("/api/projects/p/spectra/spots/4").status_code == 400
        body = {"targets": [{"mz": 103, "tolerance": 0, "unit": "Da"}]}
        assert client.post("/api/projects/p/spectra/ions", json=body).json()["channels"][0]["intensities"] == [0, 0, 0, 40]
        assert client.post("/api/projects/p/spectra/ions", json={"targets": []}).status_code == 422
        assert client.post("/api/projects/p/spectra/ions", json={"targets": [{"mz": -1}]}).status_code == 422
        assert client.post("/api/projects/empty/spectra/source", json={"path": str(sbd)}).status_code == 200
        assert client.get("/api/projects/empty/spectra").json()["available"]
        assert client.post("/api/projects/empty/spectra/source", json={"path": str(tmp_path / "missing.sbd")}).status_code == 400
        assert client.get("/api/projects/empty/spectra").json()["available"]
    sbd.unlink()
    with TestClient(create_app(directory)) as client:
        assert client.get("/api/projects/empty/spectra").json()["available"] is False


def test_attach_rejects_different_acquisition(tmp_path, sbd):
    original = tmp_path / "compact.sbd"
    with h5py.File(original, "w") as f:
        f.attrs["spatialbridge_format"] = "sbd-extract"
        f["Registrations/0/OriginalCoordinates"] = [[9, 1, 0, 1], [0, 0, 1, 1]]
        f["MeasurementRasterIndices"] = [[0, 0, 1, 1]]
    directory = tmp_path / "data"
    store = Store(directory)
    store.create_project("p", str(tmp_path))
    store.update_project("p", "ready", {"report": {"maldi_data": {"path": str(original), "spot_count": 4}}})
    store.close()
    with TestClient(create_app(directory)) as client:
        assert client.get("/api/projects/p/spectra").json()["available"] is False
        response = client.post("/api/projects/p/spectra/source", json={"path": str(sbd)})
        assert response.status_code == 400 and "坐标" in response.json()["detail"]
        assert not (directory / "projects/p/spectra-source.json").exists()


@pytest.mark.skipif(not os.getenv("SPATIALBRIDGE_TEST_SBD"), reason="local full SBD not configured")
def test_real_sbd_known_peak():
    with SBDReader(Path(os.environ["SPATIALBRIDGE_TEST_SBD"])) as reader:
        assert reader.spot_count == 153596
        spot = reader.spot_spectrum(149125)
        assert len(spot["mz"]) == 4886
        assert spot["mz"][2763] == pytest.approx(726.5024230225748)
        assert spot["intensities"][2763] == 36762
        image = reader.ion_signals([{"mz": 726.5016154578016, "tolerance": 0, "unit": "Da"}])
        values = image["channels"][0]["intensities"]
        assert np.count_nonzero(values) == 62434
        assert int(np.argmax(values)) == 149125
        assert values[149125] == 36762
        assert image["coordinates"][149125] == [1619, 561]
