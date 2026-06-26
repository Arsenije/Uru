"""Convert khora result dataclasses into JSON-safe dicts for the wire.

The TS client mirrors these shapes, so the contract lives here. We project only
the fields the plugin needs (recall→note linkback, entity/relationship graph)
rather than dumping the whole dataclass.
"""

from __future__ import annotations

from typing import Any


def _s(v: Any) -> Any:
    """Best-effort scalar coercion (UUID/datetime → str)."""
    if v is None or isinstance(v, (str, int, float, bool)):
        return v
    return str(v)


def recall_to_dict(result: Any) -> dict[str, Any]:
    return {
        "namespace_id": _s(result.namespace_id),
        "chunks": [
            {
                "document_id": _s(c.document_id),
                "content": c.content,
                "score": c.score,
            }
            for c in result.chunks
        ],
        "documents": [
            {
                "id": _s(d.id),
                "external_id": d.external_id,
                "title": d.title,
                "source_type": d.source_type,
            }
            for d in result.documents
        ],
        "entities": [
            {
                "name": e.name,
                "entity_type": e.entity_type,
                "score": e.score,
                "source_document_ids": [_s(x) for x in e.source_document_ids],
            }
            for e in result.entities
        ],
        "relationships": [
            {
                "source": getattr(r, "source", None) or getattr(r, "source_name", None),
                "target": getattr(r, "target", None) or getattr(r, "target_name", None),
                "type": getattr(r, "relationship_type", None) or getattr(r, "type", None),
                "score": getattr(r, "score", None),
                "source_document_ids": [_s(x) for x in getattr(r, "source_document_ids", [])],
            }
            for r in result.relationships
        ],
        "engine_info": {k: _s(v) for k, v in (getattr(result, "engine_info", {}) or {}).items()},
    }


def remember_to_dict(result: Any) -> dict[str, Any]:
    return {
        "document_id": _s(result.document_id),
        "namespace_id": _s(result.namespace_id),
        "chunks_created": result.chunks_created,
        "entities_extracted": result.entities_extracted,
        "relationships_created": result.relationships_created,
        "relationships_skipped": getattr(result, "relationships_skipped", 0),
    }


def batch_to_dict(result: Any) -> dict[str, Any]:
    return {
        "total": result.total,
        "processed": result.processed,
        "skipped": result.skipped,
        "failed": result.failed,
        "chunks": result.chunks,
        "entities": result.entities,
        "relationships": result.relationships,
    }
