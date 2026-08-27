# Writing docs that search well

This tool answers questions by finding the **most relevant _section_** of your
docs — not the most relevant file. How you structure a markdown document
directly decides how well it can be found. This page explains what the indexer
does and gives you concrete rules to write docs that retrieve well.

You don't need a rigid template or a special format. You just need decent
heading hygiene. Five minutes here will make every future search better.

## The one mental model to remember

> **A search result is a single section, shown on its own — without the
> paragraphs before or after it.**

Here's why. When you build the index, the tool splits each document **at every
markdown heading** (`#`, `##`, `###`, …). Each heading and the text under it
becomes one "chunk". At query time your question is compared against every chunk
and the closest ones are returned — each one *isolated* from its neighbours.

Two consequences follow from this, and every rule below is just a corollary:

1. **Headings are the unit of retrieval.** No headings → the whole file is one
   giant chunk → search can only ever return "the entire file" and its match
   quality is poor (the chunk's meaning is the average of everything in it).
2. **Each section must stand alone.** The reader (and the model) sees the
   matched section without the context around it, so a section that says "as
   mentioned above" or "this service" is missing the thing it refers to.

## The rules

### 1. One file, one topic — with a descriptive name
The file path is shown in every result, so a good name is free context.
`auth-refresh-token.md` beats `notes2.md`. Keep unrelated topics in separate
files rather than one sprawling document.

### 2. Always start with a `#` title, then break the body with `##` / `###`
A document with no headings becomes a single oversized chunk — the worst case
for retrieval. Split the body into sections, one idea per section.

### 3. Give every subsectioned heading 1-2 lead sentences
If a `##` has `###` children, don't drop straight into the first subheading —
write 1-2 sentences of its own body first. The indexer drops any section whose
body is under ~30 characters, so a bare heading with no lead-in vanishes from
search entirely, even though it reads fine in the file.

- ❌ `## Refreshing the token` followed immediately by `### Step 1` with no text in between.
- ✅ `## Refreshing the token` — "The client refreshes the token automatically before it
  expires. The steps below cover the manual case." — then `### Step 1`.

### 4. Make headings descriptive — they are part of the search
The heading text (and its full breadcrumb, e.g. `Auth > Refresh token > Errors`)
is embedded *together with* the section body. Vague headings waste that signal.

- ❌ `## Notes`  `## Misc`  `## Details`
- ✅ `## How the client refreshes an expired token`

Put the words someone would actually search for right in the heading.

### 5. Write self-contained sections
Because a section is retrieved alone:

- **Name the subject** instead of pointing at it. Not "this component handles
  it" — say "the auth service handles it". The reader hasn't seen the previous
  section.
- **Expand acronyms** on first use within the section.
- **Front-load the answer.** Put the conclusion in the first sentence or two,
  then the supporting detail. Retrieval and skim-reading both reward this.

### 6. Keep sections medium-sized
Aim for one concept per section — roughly one to three screens of text.

- **Too big** (a 3,000-word wall under a single `##`): the chunk becomes diluted
  and can hit the embedding model's context limit, silently dropping its tail.
  Split it with `###` sub-headings.
- **Too small** (a one-line section per heading): each chunk carries almost no
  signal. Group tiny points under one thematic heading instead of giving every
  line its own.

### 7. Nest headings logically
Use a sensible hierarchy (`##` then `###`, don't skip levels arbitrarily). The
breadcrumb built from the hierarchy is extra context that improves matching, so
it should reflect the real structure of the topic.

### 8. Lead with the searchable terms
The search is semantic, but explicit terms still help. Put the key terms — and
their common synonyms — in the heading and the first sentence of the section
(e.g. include both "401" and "session expired" if people say both).

## Document lifecycle & frontmatter

Docs age. A plan gets executed, a spec gets superseded by the reference doc it
produced, an old proposal becomes historical record rather than active
guidance. Say so with frontmatter, and the tool will act on it.

```yaml
---
status: superseded            # current (default) | draft | superseded | archived
date: 2026-03-01              # last substantive update (ISO date)
superseded_by: reference/auth.md   # where the durable content lives now
---
```

The frontmatter block is parsed and stripped before indexing — it is never
embedded as text and never pollutes the search. What each field does at
search time:

- **`status: superseded` or `status: archived`** — the doc is hidden from
  default search results. It's still fully indexed and reachable: pass
  `searchAll` (or `--all` on the CLI) to include it. When it does surface with
  `searchAll`, results carry a label like `[superseded → reference/auth.md]`
  or `[archived]` so the reader knows not to treat it as current guidance.
- **`status: draft`** — stays in default search (not hidden), but is labeled
  `[draft]` on results so the reader knows it isn't finalized.
- **`date`** — shown on results as `[2026-03-01]` (combined with any status
  label) so the reader can judge freshness at a glance.
- No frontmatter, or `status: current`/omitted — behaves exactly as before:
  no label, included in every search.

**Lifecycle guidance:**

- When you execute a plan, its durable content (the "how it actually works
  now") belongs in your reference docs, not the plan file. Move it there,
  then mark the plan `status: superseded` with `superseded_by: <path to the
  reference doc>` — the plan stays searchable on demand, but default search
  points people at the current doc instead.
- Dated specs, briefs, and one-off proposals that did their job get
  `status: archived` once they're no longer the thing to read — no successor
  doc needed for these, just the status.
- Either way, the doc never disappears: it's excluded from default results,
  not deleted, and `searchAll` always gets it back.

## What does NOT matter

- **YAML frontmatter presence** — it's expected, not a search liability: see
  "Document lifecycle & frontmatter" above for what it does and how to use it.
- **Tables, code blocks, lists** — shown in results verbatim, but NOT part of
  the semantic match. The surrounding prose is what gets found; if code is
  important to search, describe what it does in a sentence next to it.
- **A shared template across all docs** — not required. Good headings are
  enough; the shape of each doc can follow its content.

## Copy-paste template

```markdown
# Refreshing the authentication token

One line saying what this document covers and who needs it.

## Why the token needs refreshing
Answer in the first sentences, then the context/rationale.

## How the client refreshes the token
Concrete steps. Name "the client" and "the refresh token" explicitly —
don't rely on the previous section being visible.

### What to do when the refresh fails
An isolated error case, using the terms someone would search for
("401", "session expired").
```

## Before / after

**❌ An unstructured wall** — one chunk, averaged meaning, poor matches:

```markdown
# Auth
We handle auth with JWT. The token lasts 15 minutes and then there's the
refresh that... (2,000 words with no headings)
```

A question like *"how do you handle an expired session?"* can only match the
whole blob or nothing.

**✅ Split by intent** — three focused chunks, each matches its own question:

```markdown
# Authentication
## Lifetime and expiry of the JWT token
## Refreshing the token with the refresh token
## Handling an expired session (401 error)
```

## 30-second checklist

Before you save a doc, skim it and confirm:

- [ ] It has a `#` title and is broken into `##` / `###` sections.
- [ ] Every heading describes its content in searchable words (no "Notes"/"Misc").
- [ ] Each section makes sense read on its own (subject named, acronyms expanded).
- [ ] No section is a giant unstructured wall; none is a lonely one-liner.
- [ ] The filename says what the file is about.

That's it. Well-structured markdown in, precise answers out.
