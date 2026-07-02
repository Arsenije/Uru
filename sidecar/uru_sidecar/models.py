"""Wire request schemas for the sidecar control API."""

from __future__ import annotations

from pydantic import BaseModel, Field


class RecallRequest(BaseModel):
    query: str
    limit: int = 10
    min_similarity: float = 0.0


class RememberRequest(BaseModel):
    external_id: str
    content: str
    title: str = ""
    metadata: dict = Field(default_factory=dict)


class BatchDocument(BaseModel):
    external_id: str
    content: str
    title: str = ""
    metadata: dict = Field(default_factory=dict)


class BatchRequest(BaseModel):
    documents: list[BatchDocument]


class LinkRequest(BaseModel):
    """Compute related-note links (semantic + lexical) for the whole corpus.

    The plugin sends every note's text; the sidecar embeds + BM25s them and
    returns per-note neighbours. Thresholds default to the calibrated values in
    linking.py; leaving them None uses those defaults.
    """

    documents: list[BatchDocument]
    k: int | None = None
    min_cos: float | None = None
    min_bm25: float | None = None


class ForgetRequest(BaseModel):
    external_id: str | None = None
    document_id: str | None = None


class ChatMessage(BaseModel):
    role: str
    content: str


class NoteContext(BaseModel):
    """Explicit context for 'current note' chat scope (skips vault recall)."""

    external_id: str | None = None
    title: str | None = None
    content: str


class ChatRequest(BaseModel):
    query: str
    history: list[ChatMessage] = Field(default_factory=list)
    limit: int = 8
    stream: bool = True
    note: NoteContext | None = None
