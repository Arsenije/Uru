"""Uru sidecar: a local HTTP service that drives khora for the Obsidian plugin.

Owns a llama-cpp-python OpenAI-compatible server (chat + embedding models on one
port) and a connected ``Khora`` instance backed by the embedded sqlite_lance stack.
"""

__version__ = "0.2.11"
