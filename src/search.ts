import type { Memory } from "./store.ts";

export function tokenize(value: string): string[] {
  const tokens: string[] = [];
  for (const match of value.normalize("NFKC").toLowerCase().matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[\p{L}\p{N}_]+/gu)) {
    const word = match[0];
    if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(word)) {
      const chars = [...word];
      tokens.push(...chars.map(char => "c:" + char));
      for (let i = 0; i + 1 < chars.length; i++) tokens.push("b:" + chars[i] + chars[i + 1]);
    } else tokens.push(word);
  }
  return tokens;
}

export interface Hit { note: Memory; score: number }

/** Small-corpus BM25: title weight 3, body weight 1; no network or persisted index. */
export function search(notes: Memory[], query: string, limit = 5): Hit[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !notes.length) return [];
  const documents = notes.map(note => [tokenize(note.title), tokenize((note.description ?? "") + " " + note.content)]);
  const averages = [0, 1].map(field => documents.reduce((sum, fields) => sum + fields[field].length, 0) / notes.length || 1);
  const frequency = new Map(terms.map(term => [term, documents.filter(fields => fields.some(tokens => tokens.includes(term))).length]));
  return notes.map((note, index) => {
    const fields = documents[index];
    let score = 0;
    for (const term of terms) {
      const df = frequency.get(term)!;
      const idf = Math.log(1 + (notes.length - df + 0.5) / (df + 0.5));
      fields.forEach((tokens, field) => {
        const tf = tokens.filter(token => token === term).length;
        const norm = 1 - 0.75 + 0.75 * tokens.length / averages[field];
        score += (field === 0 ? 3 : 1) * idf * tf * 2.2 / (tf + 1.2 * norm);
      });
    }
    return { note, score };
  }).filter(hit => hit.score > 0).sort((a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id)).slice(0, limit);
}
