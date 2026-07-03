"""LLM-free note linking.

Connect notes by two fast, local signals and fuse them into per-note "related
note" suggestions that the plugin writes as frontmatter links (Obsidian's graph
view then draws the edges):

  1. SEMANTIC — mean bge-m3 chunk embedding per note → cosine kNN (similar notes).
  2. LEXICAL  — BM25 "more-like-this" doc-vs-doc (specific shared terms).

No chat model and no entity extraction: this runs in seconds on a few hundred
notes using only the already-running embed server. The thresholds below were
calibrated on a mixed 250-note corpus (see the dk/model-testing comparison):
real same-topic links score BM25 ~114-228 and cosine >=0.72, while cross-domain
vocab/genre noise sits at BM25 ~27-85 and cosine ~0.55 — hence the gap-splitting
defaults. They are deliberately conservative (precision over recall): a note with
no genuine neighbour is left unlinked rather than force-filled.

scikit-learn is imported for its sparse CountVectorizer (BM25 term matrix); it is
present transitively via the pinned ``khora[sqlite-lance]==0.21.0`` dependency.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable

import httpx
import numpy as np

log = logging.getLogger("uru.sidecar")

CHUNK_WORDS = 400        # ~500-600 tokens, safely under the embed server's ctx
EMBED_BATCH = 32
_FM = re.compile(r"^---\n.*?\n---\n", re.DOTALL)

# Calibrated defaults (see module docstring). Exposed as request params.
DEFAULT_K = 8            # max related links per note
DEFAULT_MIN_COS = 0.72   # semantic edge threshold (cosine)
DEFAULT_MIN_BM25 = 100.0 # lexical edge threshold


def _body(text: str) -> str:
    """Strip a leading YAML frontmatter block so it doesn't pollute the signal."""
    return _FM.sub("", text, count=1)


def _chunks(text: str) -> list[str]:
    words = text.split()
    if not words:
        return []
    return [" ".join(words[i:i + CHUNK_WORDS]) for i in range(0, len(words), CHUNK_WORDS)]


def _embed_all(base: str, texts: list[str]) -> np.ndarray:
    """Embed texts via the local embed server, L2-normalized (rows = unit vectors)."""
    vecs: list[list[float]] = []
    with httpx.Client(timeout=120) as client:
        for i in range(0, len(texts), EMBED_BATCH):
            batch = texts[i:i + EMBED_BATCH]
            r = client.post(f"{base}/v1/embeddings", json={"model": "uru-embed", "input": batch})
            r.raise_for_status()
            vecs.extend(d["embedding"] for d in r.json()["data"])
    a = np.asarray(vecs, dtype=np.float32)
    a /= (np.linalg.norm(a, axis=1, keepdims=True) + 1e-9)
    return a


def _bm25_scores(bodies: list[str], k1: float = 1.5, b: float = 0.75) -> np.ndarray:
    """Full doc-vs-doc BM25 score matrix: scores[i, j] = BM25 of doc j for doc i's terms."""
    from sklearn.feature_extraction.text import CountVectorizer

    cv = CountVectorizer(
        stop_words="english",
        token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z]+\b",
        max_df=0.5,  # drop terms in >50% of notes (generic vocab → false bridges)
    )
    tf = cv.fit_transform(bodies).astype(np.float32)          # docs x terms (counts)
    n_docs = tf.shape[0]
    df = np.asarray((tf > 0).sum(axis=0)).ravel()
    idf = np.log(1 + (n_docs - df + 0.5) / (df + 0.5))
    dl = np.asarray(tf.sum(axis=1)).ravel()
    avgdl = dl.mean() + 1e-9
    tfd = tf.toarray()
    denom = tfd + k1 * (1 - b + b * (dl[:, None] / avgdl))
    bm = (tfd * (k1 + 1)) / (denom + 1e-9) * idf[None, :]      # docs x terms BM25 weight
    qbin = (tfd > 0).astype(np.float32)                        # query = terms present in doc i
    return qbin @ bm.T


def compute_links(
    documents: list[dict[str, Any]],
    embed_base: str,
    *,
    k: int = DEFAULT_K,
    min_cos: float = DEFAULT_MIN_COS,
    min_bm25: float = DEFAULT_MIN_BM25,
    on_progress: Callable[[int, int], None] | None = None,
) -> dict[str, Any]:
    """Suggest related notes per document from semantic + lexical similarity.

    ``documents``: list of ``{"external_id": str, "content": str}``. Returns
    ``{"links": {external_id: [{"target", "score", "via"}]}, "stats": {...}}``
    where ``via`` is "semantic", "lexical", or "both". Notes with no neighbour
    above threshold are omitted from ``links``. Synchronous and CPU/IO bound —
    call it from a worker thread so the event loop stays responsive.
    """
    ids = [d["external_id"] for d in documents]
    bodies = [_body(d.get("content") or "") for d in documents]
    n = len(documents)
    if n < 2:
        return {"links": {}, "stats": {"notes": n, "linked": 0, "edges": 0}}

    # ---- 1) SEMANTIC: mean chunk embedding per doc, cosine matrix ----
    all_chunks: list[str] = []
    owner: list[int] = []
    for di, body in enumerate(bodies):
        cs = _chunks(body) or [body or " "]  # never leave a doc with zero chunks
        for c in cs:
            all_chunks.append(c)
            owner.append(di)
    if on_progress:
        on_progress(0, n)
    cvecs = _embed_all(embed_base, all_chunks)
    dim = cvecs.shape[1]
    docvec = np.zeros((n, dim), dtype=np.float32)
    counts = np.zeros(n, dtype=np.float32)
    for oi, di in enumerate(owner):
        docvec[di] += cvecs[oi]
        counts[di] += 1
    docvec /= (counts[:, None] + 1e-9)
    docvec /= (np.linalg.norm(docvec, axis=1, keepdims=True) + 1e-9)
    cos = docvec @ docvec.T
    np.fill_diagonal(cos, -1.0)

    # ---- 2) LEXICAL: BM25 more-like-this ----
    bm = _bm25_scores(bodies)
    np.fill_diagonal(bm, -1.0)

    # ---- 3) fuse per doc: top-k union of (cos >= min_cos) and (bm25 >= min_bm25) ----
    links: dict[str, list[dict[str, Any]]] = {}
    linked = edges = 0
    for i in range(n):
        vsim = {int(j): float(cos[i, j]) for j in np.argsort(-cos[i])[:k] if cos[i, j] >= min_cos}
        lsim = {int(j): float(bm[i, j]) for j in np.argsort(-bm[i])[:k] if bm[i, j] >= min_bm25}
        # Rank neighbours by semantic score first (falls back to 0 for lexical-only).
        neigh = sorted(set(vsim) | set(lsim), key=lambda j: -vsim.get(j, 0.0))[:k]
        if neigh:
            out = []
            for j in neigh:
                via = "both" if j in vsim and j in lsim else ("semantic" if j in vsim else "lexical")
                score = vsim[j] if j in vsim else lsim[j]
                out.append({"target": ids[j], "score": round(score, 3), "via": via})
            links[ids[i]] = out
            linked += 1
            edges += len(out)
        if on_progress:
            on_progress(i + 1, n)

    log.info("compute_links: %d notes -> %d linked, %d edges (k=%d cos>=%.2f bm25>=%.0f)",
             n, linked, edges, k, min_cos, min_bm25)
    return {"links": links, "stats": {"notes": n, "linked": linked, "edges": edges}}
