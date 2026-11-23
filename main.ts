// mend: applies an edit an AI model wrote to a tree of text files (SPEC.md v1).
// One command-line tool, Node 22 and its standard library alone, run as
// `node main.ts [options] [PATCH]`. Four patch formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), lines matched at the first of three tiers, every change
// or none. In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that hand-over
// and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 extends Error {
  line: string;
  constructor(line: string) {
    super(line);
    this.line = line;
  }
}

class Fail extends Error {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    super(code);
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with /, holds no \, and none of its segments is empty, . or .. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines, its line break, and whether it ends with one. */
function splitFile(text: string): { lines: string[]; br: string; ends: boolean } {
  if (text === '') return { lines: [], br: '\n', ends: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const ends = text.endsWith(br);
  if (ends) lines.pop();
  return { lines, br, ends };
}

function joinFile(lines: string[], br: string, ends: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (ends ? br : '');
}

/** A path's byte order (UTF-8). */
const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private orig = new Map<string, string | null>();
  now = new Map<string, string | null>();
  moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------- matching (section 5)

type Tier = 0 | 1 | 2;

const trimRightST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, '');
const leadingWS = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function norm(line: string, tier: Tier): string {
  if (tier === 0) return line;
  if (tier === 1) return trimRightST(line);
  return trimST(line);
}

/** Positions i where O matches fileLines[i..] at tier (occurrences may overlap). */
function occurrences(fileLines: string[], o: string[], tier: Tier, from: number): number[] {
  const res: number[] = [];
  if (o.length === 0) return res;
  const on = o.map((l) => norm(l, tier));
  for (let i = from; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (norm(fileLines[i + k], tier) !== on[k]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at least once, and its positions. */
function findTier(fileLines: string[], o: string[], strict: boolean, from: number): { tier: Tier; positions: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(fileLines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** A new line re-indented at tier 2: its leading P replaced by F, when it is not empty or only whitespace and starts with P. */
function reindent(line: string, p: string, f: string): string {
  if (line === '' || /^[ \t]+$/.test(line)) return line;
  if (!line.startsWith(p)) return line;
  return f + line.slice(p.length);
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface HunkItem {
  t: ' ' | '-' | '+' | '\\';
  text: string;
  raw: string;
}

interface Hunk {
  a: number;
  body: HunkItem[];
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path after `--- ` or `+++ `: text after the four characters, up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  const startSection = (): Section => {
    const s: Section = { oldPath: null, newPath: null, newFileMode: false, deletedFileMode: false, hunks: [] };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const s = startSection();
      s.oldPath = m[1].startsWith('a/') ? m[1].slice(2) : m[1];
      s.newPath = m[2].startsWith('b/') ? m[2].slice(2) : m[2];
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      inHeader = false;
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      i++;
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          hunk.body.push({ t: ' ', text: '', raw: '' });
          i++;
        } else if (b[0] === ' ' || b[0] === '-' || b[0] === '+' || b[0] === '\\') {
          hunk.body.push({ t: b[0] as HunkItem['t'], text: b.slice(1), raw: b });
          i++;
        } else break;
      }
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1].raw === '') hunk.body.pop();
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) {
        if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = headerPath(line);
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        cur.oldPath = line.slice('rename from '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        cur.newPath = line.slice('rename to '.length).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.newFileMode = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.deletedFileMode = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = startSection();
      s.oldPath = headerPath(line);
      i++;
      continue;
    }
    i++;
  }
  return sections.map((sec) => makeUnifiedEdit(sec, strict));
}

/** Whether the hunk's last context or + line is followed by a \ line (no final line break then). */
function hunkNoFinal(body: HunkItem[]): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    const t = body[i].t;
    if (t === ' ' || t === '+') return i + 1 < body.length && body[i + 1].t === '\\';
  }
  return false;
}

function applyHunks(before: string, hunks: Hunk[], strict: boolean, path: string): string {
  const { lines, br, ends } = splitFile(before);
  let cur = lines;
  let curEnds = ends;
  let d = 0;
  for (const h of hunks) {
    const oLines: string[] = [];
    const nItems: { kind: 'ctx' | 'new'; text: string; oIndex: number }[] = [];
    for (const item of h.body) {
      if (item.t === ' ') {
        oLines.push(item.text);
        nItems.push({ kind: 'ctx', text: item.text, oIndex: oLines.length - 1 });
      } else if (item.t === '-') oLines.push(item.text);
      else if (item.t === '+') nItems.push({ kind: 'new', text: item.text, oIndex: -1 });
    }
    if (oLines.length > 0) {
      const found = findTier(cur, oLines, strict, 0);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.positions[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const p = best;
      const f = leadingWS(cur[p]);
      const pp = leadingWS(oLines[0]);
      const repl = nItems.map((it) => {
        if (it.kind === 'ctx') return cur[p + it.oIndex];
        return found.tier === 2 ? reindent(it.text, pp, f) : it.text;
      });
      if (p + oLines.length === cur.length) curEnds = !hunkNoFinal(h.body);
      cur = [...cur.slice(0, p), ...repl, ...cur.slice(p + oLines.length)];
      d += nItems.length - oLines.length;
    } else {
      const at = Math.min(h.a + d, cur.length);
      const repl = nItems.map((it) => it.text);
      if (at === cur.length) curEnds = !hunkNoFinal(h.body);
      cur = [...cur.slice(0, at), ...repl, ...cur.slice(at)];
      d += nItems.length;
    }
  }
  return joinFile(cur, br, curEnds);
}

function makeUnifiedEdit(sec: Section, strict: boolean): Edit {
  return (tree: Tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    const isDeletion = newP === null || sec.deletedFileMode;
    const isCreation = oldP === null || sec.newFileMode;
    if (isDeletion) {
      if (oldP === null || tree.get(oldP) === null) throw new Fail('missing', oldP ?? '');
      tree.now.set(oldP, null);
      return;
    }
    if (isCreation) {
      if (newP === null) throw new Fail('missing', '');
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const plus: string[] = [];
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          if (h.body[k].t === '+') {
            plus.push(h.body[k].text);
            lastPlus = { hunk: h, idx: k };
          }
        }
      }
      const noFinal = lastPlus !== null && lastPlus.idx + 1 < lastPlus.hunk.body.length && lastPlus.hunk.body[lastPlus.idx + 1].t === '\\';
      tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (oldP !== null && newP !== null && oldP !== newP) {
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const after = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, after);
      tree.moves.push({ old: oldP, new: newP });
      return;
    }
    const p = (oldP ?? newP) as string;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, sec.hunks, strict, p));
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let searchFrom = 0;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j].trimEnd() === '<<<<<<< SEARCH') {
        si = j;
        break;
      }
    }
    if (si === -1) break;
    let path: string | null = null;
    for (let j = si - 1; j >= searchFrom; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    prevPath = path;
    let eq = -1;
    for (let j = si + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq === -1) throw new Exit2(`error: parse ${si + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j].trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${si + 1}`);
    const oldLines = lines.slice(si + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(((p: string, o: string[], n: string[]): Edit => {
      return (tree: Tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (o.length === 0) {
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, n.length === 0 ? '' : n.join('\n') + '\n');
          return;
        }
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const { lines: fl, br, ends } = splitFile(before);
        const found = findTier(fl, o, strict, 0);
        if (found === null) throw new Fail('no-match', p);
        if (found.positions.length > 1) throw new Fail('ambiguous', p);
        const pos = found.positions[0];
        let repl = n;
        if (found.tier === 2) {
          const f = leadingWS(fl[pos]);
          const pp = leadingWS(o[0]);
          repl = n.map((l) => reindent(l, pp, f));
        }
        tree.now.set(p, joinFile([...fl.slice(0, pos), ...repl, ...fl.slice(pos + o.length)], br, ends));
      };
    })(path, oldLines, newLines));
    searchFrom = rep + 1;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface V4aChunk {
  anchor: string | null;
  endOfFile: boolean;
  body: { t: ' ' | '-' | '+'; text: string }[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isHeader = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    while (i < last && blank(lines[i])) i++;
    if (i >= last) break;
    const line = lines[i];
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.*)$/.exec(line)) !== null) {
      const path = m[1].trim();
      i++;
      const secLines: string[] = [];
      while (i < last && !isHeader(lines[i])) {
        const l = lines[i];
        if (l.startsWith('+')) secLines.push(l.slice(1));
        else if (l === '') secLines.push('');
        else throw new Exit2(`error: parse ${i + 1}`);
        i++;
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      edits.push(((p: string, ls: string[]): Edit => {
        return (tree: Tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) !== null) throw new Fail('exists', p);
          tree.now.set(p, ls.length === 0 ? '' : ls.join('\n') + '\n');
        };
      })(path, secLines));
      continue;
    }
    if ((m = /^\*\*\* Delete File: (.*)$/.exec(line)) !== null) {
      const path = m[1].trim();
      i++;
      edits.push(((p: string): Edit => {
        return (tree: Tree) => {
          if (!safe(p)) throw new Fail('unsafe', p);
          if (tree.get(p) === null) throw new Fail('missing', p);
          tree.now.set(p, null);
        };
      })(path));
      continue;
    }
    if ((m = /^\*\*\* Update File: (.*)$/.exec(line)) !== null) {
      const path = m[1].trim();
      const updateLine = i + 1;
      i++;
      let secEnd = last;
      for (let j = i; j < last; j++) {
        if (isHeader(lines[j])) {
          secEnd = j;
          break;
        }
      }
      const raw = lines.slice(i, secEnd);
      while (raw.length > 0 && blank(raw[raw.length - 1])) raw.pop();
      let idx = 0;
      let moveTo: string | null = null;
      if (idx < raw.length && raw[idx].startsWith('*** Move to: ')) {
        moveTo = raw[idx].slice('*** Move to: '.length).trim();
        idx++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let started = false;
      const rawLineNo = (k: number): number => i + k + 1;
      while (idx < raw.length) {
        const l = raw[idx];
        if (l.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, endOfFile: false, body: [] };
          started = true;
          idx++;
        } else if (l === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${rawLineNo(idx)}`);
          cur.endOfFile = true;
          chunks.push(cur);
          cur = null;
          idx++;
        } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l === '') {
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${rawLineNo(idx)}`);
            cur = { anchor: null, endOfFile: false, body: [] };
            started = true;
          }
          cur.body.push({ t: (l === '' ? ' ' : l[0]) as ' ' | '-' | '+', text: l === '' ? '' : l.slice(1) });
          idx++;
        } else throw new Exit2(`error: parse ${rawLineNo(idx)}`);
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeV4aUpdateEdit(path, moveTo, chunks, strict));
      i = secEnd;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function makeV4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const { lines, br, ends } = splitFile(before);
    let cur = lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        let foundIdx = -1;
        const tiers: Tier[] = strict ? [0] : [0, 1, 2];
        for (const tier of tiers) {
          for (let k = cursor; k < cur.length; k++) {
            if (norm(cur[k], tier) === norm(ch.anchor, tier)) {
              foundIdx = k;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      const oLines: string[] = [];
      const nItems: { kind: 'ctx' | 'new'; text: string; oIndex: number }[] = [];
      for (const item of ch.body) {
        if (item.t === ' ') {
          oLines.push(item.text);
          nItems.push({ kind: 'ctx', text: item.text, oIndex: oLines.length - 1 });
        } else if (item.t === '-') oLines.push(item.text);
        else if (item.t === '+') nItems.push({ kind: 'new', text: item.text, oIndex: -1 });
      }
      if (oLines.length === 0) {
        const at = ch.endOfFile ? cur.length : cursor;
        const repl = nItems.map((it) => it.text);
        cur = [...cur.slice(0, at), ...repl, ...cur.slice(at)];
        cursor = at + repl.length;
      } else {
        const found = findTier(cur, oLines, strict, cursor);
        if (found === null) throw new Fail('no-match', path);
        let pos = found.positions[0];
        if (ch.endOfFile) {
          const ok = found.positions.find((pp) => pp + oLines.length === cur.length);
          if (ok === undefined) throw new Fail('no-match', path);
          pos = ok;
        }
        const f = leadingWS(cur[pos]);
        const pp = leadingWS(oLines[0]);
        const repl = nItems.map((it) => {
          if (it.kind === 'ctx') return cur[pos + it.oIndex];
          return found.tier === 2 ? reindent(it.text, pp, f) : it.text;
        });
        cur = [...cur.slice(0, pos), ...repl, ...cur.slice(pos + oLines.length)];
        cursor = pos + repl.length;
      }
    }
    const after = joinFile(cur, br, ends);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, after);
      tree.moves.push({ old: path, new: moveTo });
    } else {
      tree.now.set(path, after);
    }
  };
}

// ---------------------------------------------------------------- JSON edits (section 9)

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------- format detection (section 4)

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- invocation, output, order (sections 1, 2, 10)

function parseArgs(args: string[]): { format: string | null; check: boolean; strict: boolean; patch: string | null } | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return null;
        const v = a.slice('--format='.length);
        if (!FORMATS.includes(v)) return null;
        format = v;
      } else if (a === '--check') {
        if (check) return null;
        check = true;
      } else if (a === '--strict') {
        if (strict) return null;
        strict = true;
      } else return null;
    } else pos.push(a);
  }
  if (pos.length > 1) return null;
  return { format, check, strict, patch: pos.length === 0 ? null : pos[0] === '-' ? null : pos[0] };
}

function outputRows(tree: Tree): string[] {
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.get(mv.old);
    const wasNew = tree.original(mv.new);
    const nowNew = tree.get(mv.new);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.new, line: `R ${mv.old} -> ${mv.new}` });
      covered.add(mv.old);
      covered.add(mv.new);
    }
  }
  const keys = [...tree.now.keys()].sort(byteOrder);
  for (const p of keys) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => byteOrder(a.key, b.key));
  return rows.map((r) => r.line);
}

function run(args: string[]): { code: number; out: string[] } {
  const parsed = parseArgs(args);
  if (parsed === null) return { code: 2, out: ['error: usage'] };
  const { format, check, strict, patch } = parsed;
  let text = '';
  try {
    text = readFileSync(patch ?? 0, 'utf8');
  } catch {
    if (patch !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const beforeNow = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of beforeNow) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows = outputRows(tree);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
