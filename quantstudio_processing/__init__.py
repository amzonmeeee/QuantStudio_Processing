"""qpcr-tools: tidy, QC and plot QuantStudio-family qPCR exports."""
from importlib import import_module

from . import analysis, io, platemap

__version__ = "0.1.0"
__all__ = ["io", "platemap", "analysis", "plot"]


def __getattr__(name):
    # Plotting is comparatively expensive in Pyodide.  Load it only when the
    # user actually runs an analysis that asks for figures.
    if name == "plot":
        module = import_module(f"{__name__}.plot")
        globals()[name] = module
        return module
    raise AttributeError(name)
