from __future__ import annotations

import sys
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

BACKEND_ROOT = Path(__file__).resolve().parents[1]

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from synthetic_capture import (  # noqa: E402
    CAVEAT_HEADLINE,
    CAVEAT_LINES,
    DEGRADATION_DESCRIPTIONS,
    DEGRADATION_ORDER,
    DEGRADATIONS,
    REALISTIC_STRENGTHS,
    apply_condition,
    build_conditions,
    caveat_block,
    derive_seed,
    make_rng,
)


def synthetic_card_image(width: int = 220, height: int = 308) -> Image.Image:
    """A deterministic card-ish image: gradient background, coloured art box,
    a title band and a footer band. Not random, so tests never flake."""
    yy, xx = np.mgrid[0:height, 0:width]
    red = (40 + (xx / max(1, width - 1)) * 180).astype(np.uint8)
    green = (30 + (yy / max(1, height - 1)) * 170).astype(np.uint8)
    blue = ((xx + yy) % 200 + 30).astype(np.uint8)
    array = np.dstack([red, green, blue])
    array[24:40, 16 : width - 16] = (240, 240, 230)
    array[56 : height // 2, 20 : width - 20] = (20, 90, 160)
    array[height - 34 : height - 18, 16 : width // 2] = (250, 250, 240)
    return Image.fromarray(array, mode="RGB")


def mean_abs_difference(left: Image.Image, right: Image.Image) -> float:
    left_array = np.asarray(left.convert("RGB"), dtype=np.float32)
    right_array = np.asarray(right.convert("RGB"), dtype=np.float32)
    return float(np.abs(left_array - right_array).mean())


class SeedingTests(unittest.TestCase):
    def test_derive_seed_is_stable_and_order_sensitive(self) -> None:
        self.assertEqual(derive_seed("a", 1), derive_seed("a", 1))
        self.assertNotEqual(derive_seed("a", 1), derive_seed(1, "a"))
        self.assertNotEqual(derive_seed("a", 1), derive_seed("a", 2))
        # Known value pins the hash choice so a future refactor cannot silently
        # change every published synthetic number.
        self.assertEqual(derive_seed("spotlight"), 13097856826901139243)

    def test_make_rng_is_reproducible(self) -> None:
        first = make_rng(7, "glare").random(5)
        second = make_rng(7, "glare").random(5)
        np.testing.assert_array_equal(first, second)
        self.assertFalse(np.array_equal(first, make_rng(8, "glare").random(5)))


class DegradationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.image = synthetic_card_image()

    def test_registry_covers_every_ordered_degradation(self) -> None:
        self.assertEqual(set(DEGRADATION_ORDER), set(DEGRADATIONS))
        self.assertEqual(set(DEGRADATION_ORDER), set(DEGRADATION_DESCRIPTIONS))
        self.assertEqual(set(DEGRADATION_ORDER), set(REALISTIC_STRENGTHS))
        self.assertEqual(len(DEGRADATION_ORDER), len(set(DEGRADATION_ORDER)))

    def test_each_degradation_is_deterministic_given_a_seed(self) -> None:
        for name, function in DEGRADATIONS.items():
            with self.subTest(degradation=name):
                first = function(self.image, make_rng(1234, name), 1.0)
                second = function(self.image, make_rng(1234, name), 1.0)
                self.assertEqual(
                    mean_abs_difference(first, second),
                    0.0,
                    msg=f"{name} is not deterministic under a fixed seed",
                )

    def test_each_degradation_changes_the_image_visibly(self) -> None:
        for name, function in DEGRADATIONS.items():
            with self.subTest(degradation=name):
                degraded = function(self.image, make_rng(99, name), 1.0)
                self.assertGreater(
                    mean_abs_difference(self.image, degraded),
                    1.0,
                    msg=f"{name} barely changed the image; it would not simulate anything",
                )

    def test_each_degradation_changes_the_image_across_many_seeds(self) -> None:
        # Guards the "drawn away from zero" property: no seed may sample a
        # degradation into an accidental identity transform.
        for name, function in DEGRADATIONS.items():
            for seed in range(12):
                with self.subTest(degradation=name, seed=seed):
                    degraded = function(self.image, make_rng(seed, name), 1.0)
                    self.assertGreater(mean_abs_difference(self.image, degraded), 0.5)

    def test_different_seeds_produce_different_output(self) -> None:
        # JPEG quality is a small integer space, so two seeds may legitimately
        # collide. Assert seed sensitivity over a spread of seeds instead of on
        # a single pair.
        for name, function in DEGRADATIONS.items():
            with self.subTest(degradation=name):
                variants = [function(self.image, make_rng(seed, name), 1.0) for seed in range(6)]
                distinct = {np.asarray(variant, dtype=np.uint8).tobytes() for variant in variants}
                self.assertGreater(len(distinct), 1, msg=f"{name} ignored its generator")

    def test_each_degradation_preserves_size_mode_and_is_not_corrupt(self) -> None:
        for name, function in DEGRADATIONS.items():
            with self.subTest(degradation=name):
                degraded = function(self.image, make_rng(5, name), 1.0)
                self.assertEqual(degraded.size, self.image.size)
                self.assertEqual(degraded.mode, "RGB")
                array = np.asarray(degraded, dtype=np.float32)
                self.assertEqual(array.shape, (self.image.height, self.image.width, 3))
                self.assertTrue(np.isfinite(array).all())
                self.assertGreater(float(array.std()), 1.0, msg=f"{name} produced a flat/empty image")
                self.assertGreater(float(array.max()), 0.0)

    def test_each_degradation_is_a_no_op_at_zero_strength(self) -> None:
        for name, function in DEGRADATIONS.items():
            with self.subTest(degradation=name):
                degraded = function(self.image, make_rng(3, name), 0.0)
                self.assertEqual(mean_abs_difference(self.image, degraded), 0.0)

    def test_degradations_do_not_mutate_the_input_image(self) -> None:
        before = np.asarray(self.image, dtype=np.uint8).copy()
        for name, function in DEGRADATIONS.items():
            function(self.image, make_rng(11, name), 1.0)
            np.testing.assert_array_equal(
                np.asarray(self.image, dtype=np.uint8), before, err_msg=f"{name} mutated its input"
            )

    def test_stronger_settings_degrade_more(self) -> None:
        # Monotonicity is what makes --strength-scale meaningful.
        for name, function in DEGRADATIONS.items():
            with self.subTest(degradation=name):
                mild = mean_abs_difference(self.image, function(self.image, make_rng(21, name), 0.25))
                harsh = mean_abs_difference(self.image, function(self.image, make_rng(21, name), 1.0))
                self.assertGreater(harsh, mild, msg=f"{name} did not scale with strength")

    def test_glare_brightens_the_image(self) -> None:
        base = np.asarray(self.image, dtype=np.float32).mean()
        glared = np.asarray(DEGRADATIONS["glare"](self.image, make_rng(4, "glare"), 1.0), dtype=np.float32).mean()
        self.assertGreater(glared, base)

    def test_blur_reduces_high_frequency_detail(self) -> None:
        def edge_energy(image: Image.Image) -> float:
            array = np.asarray(image.convert("L"), dtype=np.float32)
            return float(np.abs(np.diff(array, axis=1)).mean() + np.abs(np.diff(array, axis=0)).mean())

        baseline = edge_energy(self.image)
        for name in ("defocus", "motion_blur"):
            with self.subTest(degradation=name):
                blurred = DEGRADATIONS[name](self.image, make_rng(6, name), 1.0)
                self.assertLess(edge_energy(blurred), baseline)

    def test_non_square_and_small_images_are_handled(self) -> None:
        for size in ((64, 90), (400, 120), (33, 47)):
            image = synthetic_card_image(width=size[0], height=size[1])
            for name, function in DEGRADATIONS.items():
                with self.subTest(size=size, degradation=name):
                    degraded = function(image, make_rng(8, name), 1.0)
                    self.assertEqual(degraded.size, image.size)
                    self.assertTrue(np.isfinite(np.asarray(degraded, dtype=np.float32)).all())


class ConditionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.image = synthetic_card_image()
        self.conditions = {condition.name: condition for condition in build_conditions()}

    def test_standard_condition_set_shape(self) -> None:
        names = [condition.name for condition in build_conditions()]
        self.assertEqual(names, ["clean", *DEGRADATION_ORDER, "realistic"])
        self.assertTrue(self.conditions["clean"].is_clean)
        self.assertFalse(self.conditions["realistic"].is_clean)
        self.assertEqual(set(self.conditions["realistic"].strengths), set(DEGRADATION_ORDER))

    def test_build_conditions_respects_scale(self) -> None:
        scaled = {condition.name: condition for condition in build_conditions(scale=0.5)}
        self.assertAlmostEqual(
            scaled["realistic"].strengths["glare"],
            self.conditions["realistic"].strengths["glare"] * 0.5,
        )

    def test_clean_condition_returns_an_equal_but_independent_image(self) -> None:
        result = apply_condition(self.image, self.conditions["clean"], seed=1, key="card-1")
        self.assertIsNot(result, self.image)
        self.assertEqual(mean_abs_difference(self.image, result), 0.0)

    def test_realistic_condition_is_deterministic_and_degrading(self) -> None:
        first = apply_condition(self.image, self.conditions["realistic"], seed=42, key="card-1")
        second = apply_condition(self.image, self.conditions["realistic"], seed=42, key="card-1")
        self.assertEqual(mean_abs_difference(first, second), 0.0)
        self.assertGreater(mean_abs_difference(self.image, first), 5.0)
        self.assertEqual(first.size, self.image.size)
        self.assertGreater(float(np.asarray(first, dtype=np.float32).std()), 1.0)

    def test_condition_randomness_is_keyed_per_card_and_seed(self) -> None:
        realistic = self.conditions["realistic"]
        base = apply_condition(self.image, realistic, seed=42, key="card-1")
        other_card = apply_condition(self.image, realistic, seed=42, key="card-2")
        other_seed = apply_condition(self.image, realistic, seed=43, key="card-1")
        self.assertGreater(mean_abs_difference(base, other_card), 0.0)
        self.assertGreater(mean_abs_difference(base, other_seed), 0.0)

    def test_single_degradation_conditions_only_touch_their_own_degradation(self) -> None:
        for name in DEGRADATION_ORDER:
            with self.subTest(condition=name):
                condition = self.conditions[name]
                self.assertEqual(set(condition.strengths), {name})
                direct = DEGRADATIONS[name](
                    self.image, make_rng(77, "card-1", name, name), REALISTIC_STRENGTHS[name]
                )
                via_condition = apply_condition(self.image, condition, seed=77, key="card-1")
                self.assertEqual(mean_abs_difference(direct, via_condition), 0.0)

    def test_realistic_is_at_least_as_destructive_as_any_single_degradation(self) -> None:
        realistic = mean_abs_difference(
            self.image, apply_condition(self.image, self.conditions["realistic"], seed=9, key="card-1")
        )
        for name in DEGRADATION_ORDER:
            single = mean_abs_difference(
                self.image, apply_condition(self.image, self.conditions[name], seed=9, key="card-1")
            )
            self.assertGreaterEqual(realistic, single * 0.5, msg=f"realistic looked milder than {name} alone")


class CaveatTests(unittest.TestCase):
    def test_caveat_block_states_it_is_not_an_accuracy_benchmark(self) -> None:
        text = caveat_block()
        self.assertIn(CAVEAT_HEADLINE, text)
        self.assertIn("NOT AN ACCURACY BENCHMARK", text)
        lowered = text.lower()
        for expected in ("floor", "relative", "same reference image", "sensor noise", "print variation"):
            self.assertIn(expected, lowered)

    def test_caveat_block_supports_a_prefix(self) -> None:
        prefixed = caveat_block(prefix="# ")
        self.assertTrue(all(line.startswith("#") for line in prefixed.splitlines() if line))
        self.assertGreaterEqual(len(prefixed.splitlines()), len(CAVEAT_LINES))


if __name__ == "__main__":
    unittest.main()
