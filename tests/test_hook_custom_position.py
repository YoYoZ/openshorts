from hooks import custom_overlay_y


def test_custom_overlay_y_clamps_to_frame():
    assert custom_overlay_y(0.25, 1000, 100) == 250
    assert custom_overlay_y(-0.2, 1000, 100) == 0
    assert custom_overlay_y(1.2, 1000, 100) == 900
