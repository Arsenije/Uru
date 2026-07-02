# Feature request: configurable `maxItems` on extraction JSON schema (small-model / grammar-constrained decoding)

**khora version observed:** 0.21.0
**Backend:** `sqlite_lance` + VectorCypher engine
**Model:** local `Qwen2.5-3B-Instruct` (Q4_K_M GGUF) served by llama.cpp `llama-server`, OpenAI-compatible endpoint, `response_format = json_schema` (grammar-constrained / GBNF decoding)

## Summary

khora's LLM extraction JSON schema declares the `entities`, `relationships`, and
`events` arrays with **no `maxItems`**. Under grammar-constrained decoding
(`json_schema` mode, which llama.cpp enforces via GBNF), an unbounded array gives
the model no *structural* reason to ever close it. Large frontier models stop on
their own judgment; a small local model (3B) does not — it keeps emitting array
elements until it hits `max_tokens`, producing truncated JSON and multi-minute calls.

The system/extraction prompts already ask for a cap ("extract at most N entities"),
but a **prompt-level** cap is only a suggestion a weak model routinely ignores. A
**schema-level** `maxItems` is grammar-*enforced*: once the array reaches the cap,
the grammar can only emit the closing `]`, so the model is physically unable to
continue. That is the piece that's missing.

## Evidence (our measurements)

Driving khora 0.21.0 extraction with Qwen2.5-3B-Instruct-Q4_K_M via llama.cpp:

- **~62% of extraction calls hit the `max_tokens` ceiling** (`finish_reason=length`)
  instead of stopping naturally, across a real mixed-content corpus.
- Capped calls trigger khora's retry-at-larger-budget, so a single chunk can take
  **~180s** (2048-token attempt + ~4096-token retry) vs. ~40s for a clean call.
- Average call time ~88s, dominated entirely by the capped-call retries.
- Tightening the system prompt and the extraction prompt to say "at most 15
  entities / 20 relationships" **did not** meaningfully reduce the cap-hit rate —
  the small model does not obey a prose cap under grammar-constrained decoding.

## Root cause (code references)

`src/khora/extraction/extractors/llm.py`, khora 0.21.0:

- `_get_response_format()` (~line 621) — the single-doc json_schema. The
  `entities` (~637), `relationships` (~666), and `events` (~703) arrays are
  `{"type": "array", "items": {...}}` with no `maxItems`.
- `_get_multi_response_format()` (~line 724) — the batch json_schema. Same arrays
  (~735 / ~764 / ~801), same omission.

Both builders would need the cap applied for it to take effect on all paths.

## Proposed change

Add **optional, opt-in** per-array item caps, defaulting to unbounded so existing
behavior is byte-for-byte unchanged. Two reasonable ways to surface them (either or both):

1. **`LLMSettings` (env-configurable)** — natural home alongside the existing
   `max_tokens` in `src/khora/config/schema.py` (`env_prefix="KHORA_LLM_"`):

   ```python
   max_entities_per_extraction: int | None = Field(default=None, ...)
   max_relationships_per_extraction: int | None = Field(default=None, ...)
   max_events_per_extraction: int | None = Field(default=None, ...)
   ```
   → env `KHORA_LLM_MAX_ENTITIES_PER_EXTRACTION`, etc.

2. **`ExpertiseConfig`** — a per-ontology cap (e.g. `max_entities`, `max_relationships`)
   so different domains can tune density, mirroring how `confidence` thresholds
   already live there.

Then, in both `_get_response_format()` and `_get_multi_response_format()`, when a
cap is set, inject it into the corresponding array schema:

```python
entities_schema = {"type": "array", "items": {...}}
if max_entities is not None:
    entities_schema["maxItems"] = max_entities   # grammar-enforced hard cap
```

`maxItems` is standard JSON Schema and is honored by llama.cpp's GBNF grammar
compiler (and ignored harmlessly by providers that don't grammar-constrain), so it
degrades gracefully across backends.

## Why this matters beyond our project

Local/self-hosted khora deployments on small models are exactly the case where
grammar constraints are load-bearing, and exactly where an unbounded array turns a
"be concise" prompt into a runaway generation. A single optional field makes khora
robust on small models at zero cost to existing large-model users.

## Workaround we're using meanwhile

We monkeypatch the extraction system prompt for conciseness and set a low
`KHORA_LLM_MAX_TOKENS` as a hard time backstop — this bounds the *damage* (worst
case ~3 min instead of ~12 min) but does not reduce the *frequency* of runaways,
because only `maxItems` addresses the structural cause.
