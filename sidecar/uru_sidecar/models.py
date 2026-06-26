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


class ForgetRequest(BaseModel):
    external_id: str | None = None
    document_id: str | None = None
