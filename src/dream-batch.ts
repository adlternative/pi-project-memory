import { search } from "./search.ts";
import type { Memory } from "./model.ts";

export interface DreamItem { id: string; type: string; title: string; content: string }

const item = (note: Memory): DreamItem => ({ id: note.id, type: note.type, title: note.title, content: note.content });
const size = (value: DreamItem) => Buffer.byteLength(JSON.stringify(value)) + 1;

/**
 * Picks one consolidation batch of whole notes within a byte budget.
 *
 * Seeded with the newest note not reviewed in this cycle, then its closest notes by local BM25 over title
 * and body (related notes must share a batch to be merged), then other unreviewed notes, newest first.
 * Reviewed notes are only used as neighbours, so each pass moves on through the store.
 */
export function pickDreamBatch(notes: Memory[], reviewed: ReadonlySet<string>, skip: ReadonlySet<string>, budget: number): DreamItem[] {
  const usable = notes.filter(note => !skip.has(note.id));
  const newest = [...usable].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const pending = newest.filter(note => !reviewed.has(note.id));
  const seed = pending[0] ?? newest[0];
  if (!seed) return [];
  const chosen: DreamItem[] = [];
  const taken = new Set<string>();
  let left = budget;
  const add = (note: Memory) => {
    if (taken.has(note.id)) return;
    const next = item(note);
    if (size(next) > left) return;
    left -= size(next);
    taken.add(note.id);
    chosen.push(next);
  };
  add(seed);
  if (!chosen.length) return [];
  // Related notes must share a batch to be merged. Unreviewed ones come first; already reviewed ones may
  // join but only up to a quarter of the budget, or similar notes would fill every batch and each pass
  // would review a single new note.
  const neighbours = search(usable.filter(note => note.id !== seed.id), `${seed.title} ${seed.content}`, usable.length).map(hit => hit.note).slice(0, 12);
  for (const note of neighbours) if (!reviewed.has(note.id)) add(note);
  let reviewedRoom = budget / 4;
  for (const note of neighbours) {
    if (!reviewed.has(note.id) || size(item(note)) > reviewedRoom) continue;
    const before = left;
    add(note);
    reviewedRoom -= before - left;
  }
  for (const note of pending) add(note);
  return chosen;
}
