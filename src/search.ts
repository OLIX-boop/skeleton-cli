/**
 * Keyword relevance ranking (BM25) over source files, used by `--query` to pick the files a
 * task is about. Identifiers are split into words (`parseInvoicePdf`, `parse_invoice_pdf`
 * → parse, invoice, pdf) and matched loosely (`invoices` ~ `invoice`, `render` ~ `renderer`);
 * words in the file path weigh more than words in the body.
 */

export interface SearchDocument {
  path: string;
  text: string;
  /** Score multiplier, e.g. below 1 for prose that mentions everything (READMEs, changelogs). */
  weight?: number;
}

export interface SearchHit {
  path: string;
  score: number;
  /** Query words (as written in the query) found in the file. */
  matched: string[];
}

const STOP_WORDS = new Set([
  ...'a an and are as at be but by for from how i in is it of on or that the this to was what where which why with'.split(' '),
  // Italian
  ...'il lo la le gli un una di da del della dei delle che per con su come dove non'.split(' '),
]);

/** Extra score for a query word in the file path, as a multiple of the word's IDF. */
const PATH_BONUS = 1.5;
const K1 = 1.2;
const B = 0.75;

/** Strip one inflection (`invoices` → `invoic`, `parsing` → `pars`, `policies` → `policy`). */
export function stem(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'es', 's', 'e']) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) return word.slice(0, -suffix.length);
  }
  return word;
}

/**
 * Whether a query stem matches a word stem: equal, or one extends the other (`render` ~
 * `renderer`, `pars` ~ `parser`) when the shorter has at least four letters.
 */
function related(term: string, word: string): boolean {
  if (term === word) return true;
  const [short, long] = term.length < word.length ? [term, word] : [word, term];
  return short.length >= 4 && long.startsWith(short);
}

/** Split text into lowercase stemmed words, breaking identifiers at case and `_`/`-` boundaries. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const parts = raw
      .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
      .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
      .split(' ');
    for (const part of parts) {
      const w = part.toLowerCase();
      if (w.length > 1 && !STOP_WORDS.has(w) && !/^\d+$/.test(w)) out.push(stem(w));
    }
  }
  return out;
}

/** Rank `documents` by relevance to `query`, best first. Files matching no query word are left out. */
export function search(documents: readonly SearchDocument[], query: string): SearchHit[] {
  const terms = [...new Set(words(query))];
  if (!terms.length || !documents.length) return [];
  // Report matches with the user's own spelling rather than the stem.
  const spelling = new Map<string, string>();
  for (const raw of query.match(/[\p{L}\p{N}]+/gu) ?? []) {
    for (const w of words(raw)) if (!spelling.has(w)) spelling.set(w, raw.toLowerCase());
  }
  // Word → query terms it matches, memoized across documents.
  const matches = new Map<string, string[]>();
  const termsFor = (w: string) => {
    let hit = matches.get(w);
    if (!hit) matches.set(w, (hit = terms.filter((t) => related(t, w))));
    return hit;
  };

  const stats = documents.map((doc) => {
    const counts = new Map<string, number>();
    const body = words(doc.text);
    for (const w of body) for (const t of termsFor(w)) counts.set(t, (counts.get(t) ?? 0) + 1);
    const inPath = new Set(words(doc.path).flatMap(termsFor));
    for (const t of inPath) if (!counts.has(t)) counts.set(t, 0);
    return { doc, counts, inPath, length: body.length + 1 };
  });

  const avgLength = stats.reduce((n, s) => n + s.length, 0) / stats.length;
  const idf = new Map(
    terms.map((t) => {
      const df = stats.filter((s) => s.counts.has(t)).length;
      return [t, Math.log(1 + (documents.length - df + 0.5) / (df + 0.5))];
    }),
  );

  const hits: SearchHit[] = [];
  for (const { doc, counts, inPath, length } of stats) {
    if (!counts.size) continue;
    let score = 0;
    for (const [term, tf] of counts) {
      score += idf.get(term)! * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / avgLength)));
      // Outside the saturating BM25 term, so a file named after the topic stands out.
      if (inPath.has(term)) score += idf.get(term)! * PATH_BONUS;
    }
    // Files matching more distinct query words beat files repeating one word.
    score *= (1 + (counts.size - 1) / terms.length) * (doc.weight ?? 1);
    hits.push({ path: doc.path, score, matched: terms.filter((t) => counts.has(t)).map((t) => spelling.get(t) ?? t) });
  }
  return hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
}

/**
 * The hits worth focusing: at most `limit`, dropping the long tail that scores far below
 * the best match.
 */
export function topHits(hits: readonly SearchHit[], limit: number, cutoff = 0.25): SearchHit[] {
  const best = hits[0]?.score ?? 0;
  return hits.slice(0, limit).filter((h) => h.score >= best * cutoff);
}
