import numpy as np

from spatialbridge.lattice import _linear_model_matrix, evaluate_coordinate_model, match_outline


def test_normalized_coordinate_model_preserves_xy_and_degree_terms():
    model = {
        "model_type": "normalized_polynomial",
        "degree": 2,
        "term_order": ["1", "x", "y", "x2", "xy", "y2"],
        "normalization": {"center": [10.0, 20.0], "scale": [10.0, 20.0]},
        "coefficients": [
            [100.0, 200.0], [10.0, 0.0], [0.0, 20.0],
            [1.0, 0.0], [0.0, 0.0], [0.0, -2.0],
        ],
    }
    result = evaluate_coordinate_model(model, np.array([[10.0, 20.0], [20.0, 40.0]]))

    assert np.allclose(result, [[100.0, 200.0], [111.0, 218.0]])


def test_linear_matrix_matches_normalized_coordinate_model():
    model = {
        "degree": 1,
        "normalization": {"center": [12345.0, -220.0], "scale": [300.0, 7.0]},
        "coefficients": [[100.0, 200.0], [10.0, 4.0], [-6.0, 20.0]],
    }
    points = np.array([[12345.0, -220.0], [12425.0, -218.0], [12000.0, -230.0]])
    matrix = _linear_model_matrix(model)
    homogeneous = np.column_stack((points, np.ones(len(points))))
    assert np.allclose((matrix @ homogeneous.T).T[:, :2], evaluate_coordinate_model(model, points))


def test_match_outline_records_resolved_mirror_and_sparse_cells():
    # The second axis is intentionally reversed and the lower edge is sparse;
    # a rectangular completion would lose this evidence.
    original = np.array([[x, y] for x in range(20) for y in range(30)
                         if y >= (x // 3) and y < 28 - (x % 5)], dtype=int)
    recovered = (original * np.array([1, -1])) + np.array([7, 11])
    result = match_outline(recovered, original)

    assert result is not None
    assert result["orientation_resolved"]
    assert result["signs"] == [1, -1]
    assert result["sparse_outline_preserved"]
