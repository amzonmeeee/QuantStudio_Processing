#!/usr/bin/env python3
"""Build the browser-only QuantStudio app for Cloudflare Static Assets."""

from pathlib import Path
import shutil


ROOT = Path(__file__).resolve().parents[1]
WEB_SOURCE = ROOT / "quantstudio_processing" / "web"
PACKAGE_SOURCE = ROOT / "quantstudio_processing"
DIST = ROOT / "dist"
PYTHON_TARGET = DIST / "python" / "quantstudio_processing"
MAX_ASSET_BYTES = 25 * 1024 * 1024

WEB_FILES = (
    "_headers",
    "OFL-Bricolage.txt",
    "app.css",
    "app.js",
    "favicon.svg",
    "fonts/LICENSE-Yellowtail.txt",
    "fonts/yellowtail-regular.ttf",
    "index.html",
    "pyodide-client.js",
    "pyodide-worker.js",
)

PYTHON_MODULES = (
    "__init__.py",
    "analysis.py",
    "browser.py",
    "io.py",
    "platemap.py",
    "plot.py",
    "webcore.py",
)


def fail(message):
    raise SystemExit(f"web build failed: {message}")


def require_file(path):
    if not path.is_file():
        fail(f"required file is missing: {path.relative_to(ROOT)}")
    if path.stat().st_size > MAX_ASSET_BYTES:
        size_mib = path.stat().st_size / (1024 * 1024)
        fail(
            f"asset exceeds Cloudflare's 25 MiB limit: "
            f"{path.relative_to(ROOT)} ({size_mib:.2f} MiB)"
        )


def ignore_generated(_directory, names):
    return [
        name
        for name in names
        if name == "__pycache__" or name.endswith((".pyc", ".pyo"))
    ]


def recreate_dist():
    # Keep the only recursive removal pinned to this repository's literal dist/.
    if DIST.parent != ROOT or DIST.name != "dist":
        fail("refusing to remove an unexpected output directory")
    if DIST.is_symlink():
        fail("refusing to replace dist because it is a symbolic link")
    if DIST.exists():
        if not DIST.is_dir():
            fail("dist exists but is not a directory")
        shutil.rmtree(DIST)


def validate_output():
    assets = [path for path in DIST.rglob("*") if path.is_file()]
    if not assets:
        fail("no assets were produced")

    forbidden = [
        path
        for path in DIST.rglob("*")
        if path.name == "__pycache__" or path.suffix in {".pyc", ".pyo"}
    ]
    if forbidden:
        fail(f"generated Python cache copied into dist: {forbidden[0]}")

    for path in assets:
        require_file(path)

    total_bytes = sum(path.stat().st_size for path in assets)
    print(
        f"Built {len(assets)} static assets in {DIST.relative_to(ROOT)} "
        f"({total_bytes / (1024 * 1024):.2f} MiB)."
    )


def main():
    for name in WEB_FILES:
        require_file(WEB_SOURCE / name)
    for name in PYTHON_MODULES:
        require_file(PACKAGE_SOURCE / name)

    recreate_dist()
    shutil.copytree(WEB_SOURCE, DIST, ignore=ignore_generated)
    PYTHON_TARGET.mkdir(parents=True, exist_ok=True)
    for name in PYTHON_MODULES:
        shutil.copy2(PACKAGE_SOURCE / name, PYTHON_TARGET / name)

    validate_output()


if __name__ == "__main__":
    main()
