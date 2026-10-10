"""Fixture module for check-evidence files_read path-resolution tests."""

TIMEOUT_SECONDS = 30


def is_ready(status):
    return status == "ready"
