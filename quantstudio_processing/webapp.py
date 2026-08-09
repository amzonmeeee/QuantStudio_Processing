"""Local Flask GUI over the framework-independent analysis service.

The deployable browser build uses Pyodide instead of these HTTP routes, but the
desktop ``qsp gui`` command remains useful and exercises the same webcore.
"""
from __future__ import annotations

import base64
import io as _io
import secrets
import tempfile
import threading
import webbrowser
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from . import webcore

WEB = Path(__file__).parent / "web"
BROWSER_MODULES = frozenset(
    {
        "__init__.py",
        "analysis.py",
        "browser.py",
        "io.py",
        "platemap.py",
        "plot.py",
        "webcore.py",
    }
)
SESSIONS: dict[str, dict] = {}

app = Flask(__name__, static_folder=None)


# ----------------------------------------------------------------- serving --
@app.get("/")
def index():
    return send_from_directory(WEB, "index.html")


@app.get("/python/quantstudio_processing/<name>")
def browser_module(name):
    """Serve the same sources used by the static build for local ``qsp gui``."""
    if name not in BROWSER_MODULES:
        abort(404)
    return send_from_directory(Path(__file__).parent, name)


@app.get("/<path:name>")
def asset(name):
    return send_from_directory(WEB, name)


# -------------------------------------------------------------------- load --
@app.post("/api/load")
def load():
    uploaded = request.files.get("file")
    if uploaded is None:
        return jsonify(error="No file in the request."), 400

    # The local server is intentionally single-user, but still avoid treating
    # a browser-supplied filename as a filesystem path.
    tmp = Path(tempfile.mkdtemp()) / "upload.xlsx"
    uploaded.save(tmp)
    try:
        bundle, payload = webcore.load_export(tmp, uploaded.filename or "export.xlsx")
    except webcore.UserError as exc:
        return jsonify(error=str(exc)), 400

    sid = secrets.token_urlsafe(12)
    SESSIONS[sid] = {"bundle": bundle, "path": tmp,
                     "filename": uploaded.filename or "export.xlsx"}
    return jsonify(sid=sid, **payload)


# ----------------------------------------------------------------- analyse --
@app.post("/api/analyze")
def analyze():
    body = request.get_json(force=True)
    session = SESSIONS.get(body.get("sid"))
    if session is None:
        return jsonify(error="This file is no longer loaded. Load it again."), 400

    try:
        tables, plots, payload = webcore.analyze_bundle(session["bundle"], body)
    except webcore.UserError as exc:
        return jsonify(error=str(exc)), 400

    session["tables"] = tables
    payload["plots"] = {
        name: "data:image/png;base64," + base64.b64encode(data).decode()
        for name, data in plots.items()
    }
    return jsonify(**payload)


@app.get("/api/download/<sid>")
def download(sid):
    session = SESSIONS.get(sid)
    if session is None or "tables" not in session:
        return jsonify(error="Nothing to download yet. Run the analysis first."), 400
    data = webcore.workbook_bytes(session["tables"])
    return send_file(
        _io.BytesIO(data),
        as_attachment=True,
        download_name=webcore.processed_filename(session["filename"]),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.post("/api/platemap-yaml")
def platemap_yaml():
    body = request.get_json(force=True)
    text = webcore.platemap_yaml_text(body.get("fields") or {}, body.get("name"))
    return jsonify(yaml=text)


def serve(host="127.0.0.1", port=8765, open_browser=True):
    if open_browser:
        threading.Timer(0.6, lambda: webbrowser.open(f"http://{host}:{port}")).start()
    print(f"QuantStudio_Processing GUI on http://{host}:{port}  (ctrl-c to stop)")
    app.run(host=host, port=port, debug=False)
