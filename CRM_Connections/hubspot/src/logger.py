"""Lightweight logging utilities — standalone replacement for shared.core.logger."""

from __future__ import annotations

import logging
import sys


def get_logger(name: str) -> logging.Logger:
    """Get a configured logger instance."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter("%(asctime)s [%(name)s] %(levelname)s %(message)s", datefmt="%H:%M:%S"))
        logger.addHandler(handler)
        logger.setLevel(logging.DEBUG if _is_debug() else logging.INFO)
    return logger


def print_status(message: str, status: str = "info") -> None:
    """Print a status message with a prefix indicator."""
    icons = {
        "success": "\u2705",
        "error": "\u274c",
        "warning": "\u26a0\ufe0f",
        "info": "\u2139\ufe0f",
        "processing": "\u23f3",
    }
    icon = icons.get(status, "\u2022")
    print(f" {icon}  {message}")


def _is_debug() -> bool:
    import os

    return os.environ.get("LOG_LEVEL", "").upper() == "DEBUG"
