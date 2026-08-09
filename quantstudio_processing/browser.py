"""Stateful bridge called by the browser's Pyodide Web Worker."""
from __future__ import annotations

import gc
import io as _io
import json
import re
import sys
import zipfile
from pathlib import Path

from . import webcore


_PLOT_SUFFIXES = {
    "amplification": "amplification",
    "melt": "melt",
    "plate": "plate_ct",
}


def _json_envelope(*, data=None, error: str | None = None) -> str:
    value = {"ok": error is None, "data": data} if error is None else {
        "ok": False,
        "error": error,
    }
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))


class BrowserSession:
    """One workbook session living entirely in a browser worker's memory."""

    def __init__(self):
        self.bundle: dict | None = None
        self.tables: dict | None = None
        self.plots: dict[str, bytes] = {}
        self.plots_archive: bytes | None = None
        self.filename: str | None = None

    def reset(self):
        self.bundle = None
        self.tables = None
        self.plots = {}
        self.plots_archive = None
        self.filename = None
        plt = sys.modules.get("matplotlib.pyplot")
        if plt is not None:
            plt.close("all")
        gc.collect()

    def _load(self, source, filename: str) -> str:
        self.reset()
        try:
            bundle, payload = webcore.load_export(source, filename)
        except webcore.UserError as exc:
            return _json_envelope(error=str(exc))
        self.bundle = bundle
        self.filename = filename
        return _json_envelope(data=payload)

    def load_path(self, path: str, filename: str) -> str:
        """Load a workbook from Pyodide's ephemeral MEMFS."""
        return self._load(Path(path), filename)

    def load_bytes(self, data: bytes, filename: str) -> str:
        """Native-test-friendly equivalent of :meth:`load_path`."""
        return self._load(_io.BytesIO(bytes(data)), filename)

    def analyze_json(self, request_json: str) -> str:
        self.tables = None
        self.plots = {}
        self.plots_archive = None
        if self.bundle is None:
            return _json_envelope(error="Load a workbook before running the analysis.")
        try:
            body = json.loads(request_json)
            if not isinstance(body, dict):
                raise webcore.UserError("The analysis request must be a JSON object.")
            tables, plots, payload = webcore.analyze_bundle(self.bundle, body)
        except (json.JSONDecodeError, webcore.UserError) as exc:
            return _json_envelope(error=str(exc))
        self.tables = tables
        self.plots = plots
        return _json_envelope(data=payload)

    def take_plot(self, name: str) -> bytes:
        try:
            return self.plots.pop(name)
        except KeyError as exc:
            raise webcore.UserError(f"Plot {name!r} is no longer available.") from exc

    def plot_bytes(self, name: str) -> bytes:
        """Return a plot without consuming it so a ZIP can be built later."""
        try:
            return self.plots[name]
        except KeyError as exc:
            raise webcore.UserError(f"Plot {name!r} is no longer available.") from exc

    def plots_zip_bytes(self) -> bytes:
        """Package the current PNG plots into one safe, reusable ZIP archive."""
        if self.plots_archive is not None:
            return self.plots_archive
        if not self.plots:
            raise webcore.UserError(
                "Run an analysis with plots before downloading plot images."
            )

        source_stem = Path(self.filename or "quantstudio_export").stem
        stem = re.sub(r'[\\/:*?"<>|]+', "_", source_stem).strip(" ._")
        stem = stem or "quantstudio_export"
        buffer = _io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_STORED) as archive:
            for name, data in self.plots.items():
                suffix = _PLOT_SUFFIXES.get(name)
                if suffix is None:
                    suffix = re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_")
                    suffix = suffix or "plot"
                archive.writestr(f"{stem}_{suffix}.png", data)

        self.plots_archive = buffer.getvalue()
        # The UI already owns Blob copies of every PNG. Keep only the archive
        # in Python after it is requested instead of retaining both copies.
        self.plots = {}
        return self.plots_archive

    def workbook_bytes(self) -> bytes:
        if self.tables is None:
            raise webcore.UserError("Run the analysis before downloading a workbook.")
        return webcore.workbook_bytes(self.tables)

    def platemap_yaml_json(self, request_json: str) -> str:
        try:
            body = json.loads(request_json)
            if not isinstance(body, dict):
                raise webcore.UserError("The platemap request must be a JSON object.")
            fields = body.get("fields") or {}
            if not isinstance(fields, dict):
                raise webcore.UserError("Platemap fields must be a JSON object.")
            text = webcore.platemap_yaml_text(
                fields, body.get("name")
            )
        except (json.JSONDecodeError, webcore.UserError) as exc:
            return _json_envelope(error=str(exc))
        return _json_envelope(data={"yaml": text})


_SESSION = BrowserSession()


def reset():
    _SESSION.reset()


def load_path(path: str, filename: str) -> str:
    return _SESSION.load_path(path, filename)


def analyze_json(request_json: str) -> str:
    return _SESSION.analyze_json(request_json)


def take_plot(name: str) -> bytes:
    return _SESSION.take_plot(name)


def plot_bytes(name: str) -> bytes:
    return _SESSION.plot_bytes(name)


def plots_zip_bytes() -> bytes:
    return _SESSION.plots_zip_bytes()


def workbook_bytes() -> bytes:
    return _SESSION.workbook_bytes()


def platemap_yaml_json(request_json: str) -> str:
    return _SESSION.platemap_yaml_json(request_json)
