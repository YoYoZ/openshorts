import reframe_v2


def test_apply_zone_modes_sets_layouts_and_clears_auto_splits():
    bounds = [(0, 100), (100, 200), (200, 300)]
    strategies = ['SPLIT', 'TRACK', 'TRACK']
    splits = {0: object()}
    alternates = {}
    focus = {}
    reframe_v2.apply_zone_modes(
        strategies, bounds,
        {'0': {'mode': 'fit'}, '1': {'mode': 'zoom', 'x': 0.5, 'width': 0.75}, 'cuts': [1.0]},
        splits, alternates, focus, 1920)
    assert strategies == ['GENERAL', 'WIDE', 'TRACK']
    assert 0 not in splits
    x, w = focus[100]
    assert w == 1440 and x == 240
