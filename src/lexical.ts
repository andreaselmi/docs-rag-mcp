// The lexical track: decides WHICH query terms deserve an exact search.
// All pure, no I/O — the database enters only through the docFreq map.
//
// Why a gate at all: running FTS5 on every word would flood the results with
// matches on common terms ("authentication" appears everywhere), diluting
// precision. The lexical track earns its place where dense is weak: rare terms
// present verbatim in one or two documents — acronyms, error codes,
// identifiers.

const MIN_DOC_FREQ_CEILING = 5; // on a small corpus the ratio would fall below 1

// Same splitting rule as FTS5's unicode61 tokenizer: anything that is not a
// letter or a digit separates. So ERR_TOKEN_EXPIRED becomes three terms, each
// judged for rarity on its own.
export function queryTerms(query: string): string[] {
  const raw = query.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const seen = new Set<string>();
  for (const t of raw) if (t.length > 1) seen.add(t);
  return [...seen];
}

// A term is rare when it appears in at most max(5, ratio * total) chunks AND in
// no more than half the corpus. The second clause is what keeps the floor
// honest: on a tiny index the floor of 5 can exceed the whole corpus, so a word
// present in EVERY chunk would qualify as rare and a nonsense query would come
// back with a confident [exact match] — the one thing this tool promises not to
// do. On a real corpus the clause never binds.
// Absent from the index (docFreq 0) means there is nothing to search for.
export function rareTerms(
  terms: string[],
  docFreq: Map<string, number>,
  totalChunks: number,
  maxDocFreqRatio: number
): string[] {
  const ceiling = Math.max(MIN_DOC_FREQ_CEILING, Math.floor(maxDocFreqRatio * totalChunks));
  return terms.filter((t) => {
    const df = docFreq.get(t);
    return df !== undefined && df > 0 && df <= ceiling && df * 2 <= totalChunks;
  });
}

// The quotes isolate each term from FTS5 syntax, which would otherwise give
// special meaning to characters like '*' or '-' coming from the user's text.
export function ftsQuery(terms: string[]): string {
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
