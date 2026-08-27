// Splits a markdown document into retrieval-ready chunks: one per
// heading-section, minus near-empty sections. Each chunk carries its heading
// "breadcrumb" (e.g. "Design > 3. Approach") plus two texts: `text` (verbatim
// payload) and `embedText` (from Task 2: code-fence contents collapsed to a
// marker so embeddings capture prose, not syntax noise).
// Fence-aware: heading-like lines inside ``` / ~~~ blocks never split sections.

export const MIN_BODY_CHARS = 30; // section body below this -> not indexed
export const MAX_CHUNK_CHARS = 2000; // payload above this -> paragraph split (Task 2)

export interface Chunk {
  heading: string;
  text: string;
  embedText: string;
}

const HEADING_RE = /^(#{1,6})\s+(.*)$/;

// Fence delimiter check: returns the marker type or null.
function fenceMarker(line: string): "```" | "~~~" | null {
  if (line.startsWith("```")) return "```";
  if (line.startsWith("~~~")) return "~~~";
  return null;
}

// Collapse every fenced block (delimiters included) to a single marker line.
// The embedding then represents the prose; the verbatim payload keeps the code.
function collapseFences(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let openMarker: "```" | "~~~" | null = null;
  for (const line of text.split("\n")) {
    if (inFence) {
      if (openMarker && line.startsWith(openMarker)) inFence = false;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker) {
      inFence = true;
      openMarker = marker;
      const lang = line.slice(marker.length).trim();
      out.push(lang ? `[code: ${lang}]` : "[code]");
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

// Group section lines into paragraphs (blank-line separated, fences atomic),
// then greedily pack paragraphs into parts of at most MAX_CHUNK_CHARS.
// A single paragraph over the cap stays intact — never split inside one.
function splitOversize(lines: string[]): string[] {
  const paragraphs: string[] = [];
  let para: string[] = [];
  let inFence = false;
  let openMarker: "```" | "~~~" | null = null;
  for (const line of lines) {
    if (inFence) {
      para.push(line);
      if (openMarker && line.startsWith(openMarker)) inFence = false;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker) {
      inFence = true;
      openMarker = marker;
      para.push(line);
      continue;
    }
    if (line.trim() === "") {
      if (para.length) {
        paragraphs.push(para.join("\n"));
        para = [];
      }
      continue;
    }
    para.push(line);
  }
  if (para.length) paragraphs.push(para.join("\n"));

  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const p of paragraphs) {
    // Never close a part that is still below MIN_BODY_CHARS (e.g. just the
    // heading line): that would resurrect the heading-only noise chunks this
    // very change eliminates. Such a part absorbs the next paragraph even if
    // that overflows the cap.
    if (current.length && size >= MIN_BODY_CHARS && size + 2 + p.length > MAX_CHUNK_CHARS) {
      parts.push(current.join("\n\n"));
      current = [];
      size = 0;
    }
    current.push(p);
    size += (size ? 2 : 0) + p.length;
  }
  if (current.length) parts.push(current.join("\n\n"));
  return parts;
}

export function chunkMarkdown(md: string): Chunk[] {
  const lines = md.split(/\r?\n/);

  interface Section {
    heading: string;
    lines: string[];
  }
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let buffer: string[] = [];
  let bufferStartsWithHeading = false;
  let inFence = false;
  let openMarker: "```" | "~~~" | null = null;

  const flush = () => {
    // The min-body filter looks at the body WITHOUT the heading line: a bare
    // "## Architecture" or a "TBD" stub carries no signal of its own — the
    // parent title already lives on in every child's breadcrumb.
    const bodyLines = bufferStartsWithHeading ? buffer.slice(1) : buffer;
    const body = bodyLines.join("\n").trim();
    if (body.length >= MIN_BODY_CHARS) {
      sections.push({
        heading: stack.map((h) => h.title).join(" > "),
        lines: buffer,
      });
    }
    buffer = [];
    bufferStartsWithHeading = false;
  };

  for (const line of lines) {
    if (inFence) {
      buffer.push(line);
      if (openMarker && line.startsWith(openMarker)) inFence = false;
      continue;
    }
    const marker = fenceMarker(line);
    if (marker) {
      inFence = true;
      openMarker = marker;
      buffer.push(line);
      continue;
    }
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      const level = m[1].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: m[2].trim() });
      buffer.push(line); // keep the heading text inside the section body too
      bufferStartsWithHeading = true;
    } else {
      buffer.push(line);
    }
  }
  flush(); // a fence left open at EOF closes implicitly here

  const out: Chunk[] = [];
  for (const s of sections) {
    const text = s.lines.join("\n").trim();
    if (text.length <= MAX_CHUNK_CHARS) {
      out.push({ heading: s.heading, text, embedText: collapseFences(text) });
      continue;
    }
    const parts = splitOversize(s.lines);
    const n = parts.length;
    parts.forEach((partText, i) => {
      const suffix = `(part ${i + 1}/${n})`;
      const heading = n > 1 ? (s.heading ? `${s.heading} ${suffix}` : suffix) : s.heading;
      const trimmed = partText.trim();
      out.push({ heading, text: trimmed, embedText: collapseFences(trimmed) });
    });
  }
  return out;
}
