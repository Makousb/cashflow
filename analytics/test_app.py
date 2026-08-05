"""Tests for this service.

Standard library only, as the Node side is: `python -m unittest` from here.

Everything the service is given is a date it did not read off its own clock —
the caller sends the day, and the timezone the caller was in has already been
resolved by then. That only holds while a day stays a day on the way over.
"""

import unittest
from datetime import date

from app import last_n_month_keys, month_key


class MonthKey(unittest.TestCase):
    def test_names_the_month_the_day_falls_in(self):
        self.assertEqual(month_key("2026-08-05"), "2026-08")
        self.assertEqual(month_key("2026-12-31"), "2026-12")

    def test_the_first_of_a_month_belongs_to_that_month(self):
        # The date every version of this mistake gets wrong, and the only one
        # where being a day out is also being a month out.
        self.assertEqual(month_key("2026-09-01"), "2026-09")
        self.assertEqual(month_key("2026-01-01"), "2026-01")

    def test_refuses_an_instant_instead_of_filing_it_under_the_wrong_month(self):
        # What the 1st of September in Nairobi looks like once it has been
        # through a JS Date and JSON: 21:00 on the 31st of August, in UTC.
        # Slicing seven characters off that gives "2026-08" — a month out, and
        # silently, which is the only way this could have gone unnoticed.
        with self.assertRaises(ValueError):
            month_key("2026-08-31T21:00:00.000Z")

    def test_refuses_the_other_shapes_a_date_arrives_in(self):
        for value in ("2026-08-31T21:00:00", "2026-08-31 21:00:00", "2026-08", ""):
            with self.subTest(value=value), self.assertRaises(ValueError):
                month_key(value)

    def test_agrees_with_the_month_of_the_parsed_date(self):
        # The property the sliced version happened to have for well-formed
        # input, kept explicitly now that the implementation is not the string.
        for day in ("2026-01-01", "2026-02-28", "2024-02-29", "2026-12-31"):
            with self.subTest(day=day):
                parsed = date.fromisoformat(day)
                self.assertEqual(month_key(day), f"{parsed.year:04d}-{parsed.month:02d}")


class LastNMonthKeys(unittest.TestCase):
    def test_ends_with_the_month_it_is_given(self):
        keys = last_n_month_keys(date(2026, 8, 5))
        self.assertEqual(keys[-1], "2026-08")
        self.assertEqual(len(keys), 6)

    def test_counts_back_across_a_year_boundary(self):
        self.assertEqual(
            last_n_month_keys(date(2026, 2, 15), 4),
            ["2025-11", "2025-12", "2026-01", "2026-02"],
        )

    def test_the_keys_it_makes_are_the_keys_month_key_makes(self):
        # The two meet in the trend buckets: one builds the slots, the other
        # decides which slot a transaction lands in, and a transaction whose
        # month is spelled differently is silently counted nowhere.
        self.assertIn(month_key("2026-08-05"), last_n_month_keys(date(2026, 8, 31)))
        self.assertIn(month_key("2026-03-01"), last_n_month_keys(date(2026, 8, 31)))


if __name__ == "__main__":
    unittest.main()
