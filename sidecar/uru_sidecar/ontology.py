"""The knowledge-graph ontology Uru uses to extract entities + relationships.

This is the single place to tune *what* the local chat model looks for when it
reads a note. It is deliberately small and permissive: an Obsidian vault holds
arbitrary personal content (journals, reading notes, project notes, random
imports), and the goal is **linking** — connecting the same person/place/idea
across unrelated notes — not precise business-style classification.

Design notes (why it looks like this):
- Type *consistency* matters more than granularity. khora resolves entities by
  ``name + type``, so if the same real thing is typed differently in two notes
  it never links. Fewer, broader, unambiguous types → better linking.
- ``TOPIC`` (ideas/themes/skills) is expected to dominate personal notes, so its
  description explicitly welcomes lowercase concepts, not just proper nouns.
- Relationship source/target pairings are advisory only — khora 0.21 does not
  structurally enforce them — so they stay permissive; ``RELATED_TO`` is treated
  as a legitimate, expected majority, not a fallback to avoid.

Advanced users: edit ENTITY_TYPES / RELATIONSHIP_TYPES / the two prompts below.
``build_expertise()`` turns these into khora's ``ExpertiseConfig`` at runtime.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from khora.extraction.skills.base import ExpertiseConfig

# (name, description)
ENTITY_TYPES: list[tuple[str, str]] = [
    ("PERSON",
     "A named individual person — a friend, family member, colleague, author, or "
     "public/historical figure. Never the note's own first-person narrator (\"I\", \"me\")."),
    ("ORGANIZATION",
     "A named group of people — a company, team, band, school, club, institution, "
     "or government body."),
    ("LOCATION",
     "A place — a city, country, region, venue, building, or geographic feature."),
    ("TOPIC",
     "An idea, subject, theme, field, skill, method, or abstract technology "
     "(e.g. \"machine learning\", \"stoicism\", \"Python\", \"anxiety\"). The most common "
     "type in personal notes — include important lowercase concepts, not just proper nouns."),
    ("WORK",
     "A specific named artifact you could point to — a book, article, paper, film, "
     "album, song, app, tool, device, or product (e.g. \"Atomic Habits\", \"Obsidian\")."),
    ("EVENT",
     "Something that happened or is scheduled at a point in time — a meeting, trip, "
     "match, release, election, or milestone."),
]

# (name, description, source_types, target_types).  "*" = any type.
# Pairings are guidance for the model, not enforced constraints.
RELATIONSHIP_TYPES: list[tuple[str, str, list[str], list[str]]] = [
    ("RELATED_TO",
     "A real, meaningful connection that does not fit a more specific type below. "
     "Expected to be the most common relationship — use it freely for genuine links.",
     ["*"], ["*"]),
    ("PART_OF",
     "One entity is a component, member, section, or subset of another (a chapter of "
     "a book, a task of a project, a subtopic of a topic, a city within a country).",
     ["*"], ["*"]),
    ("CREATED_BY",
     "One entity was authored, invented, founded, or made by a person or organization.",
     ["*"], ["PERSON", "ORGANIZATION"]),
    ("LOCATED_IN",
     "One entity is physically or organizationally situated in a place.",
     ["*"], ["LOCATION"]),
    ("WORKS_FOR",
     "A person is employed by, is a member of, or plays/volunteers for an organization.",
     ["PERSON"], ["ORGANIZATION"]),
]

# System prompt — used for BOTH the main extraction (via ExpertiseConfig) and the
# second-pass relationship extraction (via the DEFAULT_SYSTEM_PROMPT monkeypatch in
# lifecycle.py, which hardcodes the default rather than reading expertise). Keeping
# one shared string means both paths get the same 3B-tuned guidance.
SYSTEM_PROMPT = (
    "You extract a knowledge graph from a personal note. Return ONLY valid JSON.\n\n"
    "Your goal is LINKING: identify the people, places, ideas, and things a note is "
    "about, using consistent canonical names so the same entity in different notes "
    "connects into one.\n\n"
    "Rules:\n"
    "- Extract only the CENTRAL entities the note is actually about — at most 15 — not "
    "every capitalized word or passing mention.\n"
    "- Include important lowercase topics and ideas (e.g. \"burnout\", \"focus\", "
    "\"stoicism\"), not just proper nouns.\n"
    "- Do NOT extract the note's own author or first-person narrator (\"I\", \"me\", \"my\").\n"
    "- Use canonical names (\"Jennifer Walsh\", not \"Jenny\"; \"machine learning\", not "
    "\"ML\") so entities merge across notes. Add an alias only when the text itself gives "
    "an alternate name.\n"
    "- Only create a relationship the text states or clearly implies — at most 20. Do "
    "not invent a link just because two things appear in the same note.\n"
    "- Give each entity exactly one type from the provided list, and type the same "
    "real-world thing the same way every time.\n\n"
    "Return ONLY valid JSON, no other text."
)

# Extraction prompt — a Jinja2 template rendered by khora's ExpertiseComposer.
# Reliable variables: ``expertise`` (the ExpertiseConfig, whose .entity_types /
# .relationship_types carry the descriptions below) and ``text`` (the chunk).
# Unlike khora's default template — which only injects a flat comma-list of type
# names — this renders each type's description so the small model has real
# definitions to work from.
EXTRACTION_PROMPT_TEMPLATE = """\
Extract entities and relationships from the note text below.

Entity types (use ONLY these):
{% for et in expertise.entity_types %}- {{ et.name }}: {{ et.description }}
{% endfor %}
Relationship types (use ONLY these):
{% for rt in expertise.relationship_types %}- {{ rt.name }}: {{ rt.description }}
{% endfor %}
Extract at most 15 entities and 20 relationships — prioritize the most central ones.

Text:
{{ text }}"""


def entity_type_names() -> list[str]:
    return [name for name, _ in ENTITY_TYPES]


def relationship_type_names() -> list[str]:
    return [name for name, _, _, _ in RELATIONSHIP_TYPES]


def build_expertise() -> ExpertiseConfig:
    """Assemble the khora ExpertiseConfig from the data above.

    Imports khora lazily so this module stays importable at CLI-parse time
    (config.py pulls the type-name lists) before khora's env is set up.
    """
    from khora.extraction.skills.base import (
        ConfidenceConfig,
        EntityTypeConfig,
        ExpertiseConfig,
        RelationshipTypeConfig,
    )

    return ExpertiseConfig(
        name="uru-vault",
        version="1.0.0",
        description="General-purpose personal-vault ontology for Uru (linking-focused).",
        system_prompt=SYSTEM_PROMPT,
        extraction_prompt=EXTRACTION_PROMPT_TEMPLATE,
        entity_types=[EntityTypeConfig(name=n, description=d) for n, d in ENTITY_TYPES],
        relationship_types=[
            RelationshipTypeConfig(name=n, description=d, source_types=s, target_types=t)
            for n, d, s, t in RELATIONSHIP_TYPES
        ],
        # khora's own defaults (0.5) — set explicitly so the threshold is visible
        # and adjustable here. Prunes low-confidence rule-based co-occurrence edges.
        confidence=ConfidenceConfig(min_entity=0.5, min_relationship=0.5),
    )
