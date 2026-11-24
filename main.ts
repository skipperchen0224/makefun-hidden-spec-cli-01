// mend: one patch tool for every AI edit format.
//
// Takes a patch written as a unified diff, SEARCH/REPLACE blocks, a V4A
// patch or JSON editor calls, and applies it to the tree under the working
// directory. Either every edit lands or the disk is left exactly as it was.
// Node 22, standard library only. When MAKEFUN_ENV_URL is set the run is
// handed to the kit runner at the bottom instead of the CLI.

import * as fs from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Outcomes

class Exit2 {
  line: string;
  constructor(line: string) {
    this.line = line;
  }
}

const usageError = (): Exit2 => new Exit2('error: usage');
const parseError = (n: number): Exit2 => new Exit2(`error: parse ${n}`);

class EditFail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Arguments

const FORMATS = new Set(['auto', 'unified', 'search-replace', 'v4a', 'json']);

interface Opts {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseArgs(argv: string[]): Opts {
  const seen = new Set<string>();
  let format = 'auto';
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let closed = false;
  for (const a of argv) {
    if (!closed && a === '--') {
      closed = true;
      continue;
    }
    if (!closed && a.length > 1 && a[0] === '-') {
      if (a === '--check' || a === '--strict') {
        if (seen.has(a)) throw usageError();
        seen.add(a);
        if (a === '--check') check = true;
        else strict = true;
      } else if (a.startsWith('--format=')) {
        if (seen.has('format')) throw usageError();
        seen.add('format');
        const v = a.slice('--format='.length);
        if (!FORMATS.has(v)) throw usageError();
        format = v;
      } else {
        throw usageError();
      }
    } else {
      if (patch !== null) throw usageError();
      patch = a;
    }
  }
  return { format, check, strict, patch };
}

function readPatchText(patch: string | null): string {
  if (patch === null || patch === '-') {
    try {
      return fs.readFileSync(0, 'utf8');
    } catch {
      return '';
    }
  }
  try {
    return fs.readFileSync(patch, 'utf8');
  } catch {
    throw new Exit2('error: no-patch');
  }
}

// ---------------------------------------------------------------------------
// Lines, paths, files

function patchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].endsWith('\r')) parts[i] = parts[i].slice(0, -1);
  }
  return parts;
}

function newFileText(lines: string[]): string {
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

function isCrlf(text: string): boolean {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r';
}

function isSafe(p: string): boolean {
  if (p === '' || p[0] === '/' || p.includes('\\')) return false;
  const parts = p.split('/');
  for (const s of parts) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Line matching

// Whitespace-insensitive views of a line. Tier 0 is the line itself,
// tier 1 drops trailing blanks, tier 2 drops both ends.
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}

function indentOf(s: string): string {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i += 1;
  return s.slice(0, i);
}

// A file's text, split once and kept mutable while edits apply. The
// whitespace-insensitive views are built lazily per tier and dropped
// whenever the lines change, so a file with many hunks is normalized once
// per tier instead of once per hunk.
class Doc {
  lines: string[];
  eol: string;
  endsWithBreak: boolean;
  cache = new Map<number, string[]>();

  constructor(text: string) {
    if (text === '') {
      this.lines = [];
      this.eol = '\n';
      this.endsWithBreak = false;
      return;
    }
    const nl = text.indexOf('\n');
    this.eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
    const parts = text.split(this.eol);
    this.endsWithBreak = text.endsWith(this.eol);
    if (this.endsWithBreak) parts.pop();
    this.lines = parts;
  }

  serialize(): string {
    if (this.lines.length === 0) return '';
    return this.lines.join(this.eol) + (this.endsWithBreak ? this.eol : '');
  }

  normalized(tier: number): string[] {
    const hit = this.cache.get(tier);
    if (hit !== undefined) return hit;
    const built = this.lines.map((l) => normLine(l, tier));
    this.cache.set(tier, built);
    return built;
  }

  invalidate(): void {
    this.cache.clear();
  }
}

interface Hit {
  tier: number;
  at: number[];
}

// First tier (lowest number) at which `old` occurs, with every position
// the `accept` filter keeps. Candidates are found by the first line only,
// then verified, instead of comparing the whole block at every offset.
function findOccurrences(doc: Doc, old: string[], cap: number, accept?: (pos: number) => boolean): Hit | null {
  const total = doc.lines.length;
  const size = old.length;
  if (size === 0 || size > total) return null;
  for (let tier = 0; tier <= cap; tier += 1) {
    const normed = doc.normalized(tier);
    const first = normLine(old[0], tier);
    const rest: string[] = [];
    for (let j = 1; j < size; j += 1) rest.push(normLine(old[j], tier));
    const at: number[] = [];
    if (size === 1) {
      // One line to find: a native indexOf sweep over the normalized view
      // beats a manual scan, and anchor lookups always take this path.
      let idx = normed.indexOf(first);
      while (idx !== -1) {
        if (accept === undefined || accept(idx)) at.push(idx);
        idx = normed.indexOf(first, idx + 1);
      }
    } else {
      for (let i = 0; i + size <= total; i += 1) {
        if (normed[i] !== first) continue;
        if (accept !== undefined && !accept(i)) continue;
        let ok = true;
        for (let j = 0; j < rest.length; j += 1) {
          if (normed[i + 1 + j] !== rest[j]) {
            ok = false;
            break;
          }
        }
        if (ok) at.push(i);
      }
    }
    if (at.length > 0) return { tier, at };
  }
  return null;
}

// One line of replacement text. fromOld >= 0 means it is a context line
// and must be written as the file's own matched line at that offset.
interface NewText {
  text: string;
  fromOld: number;
}

function renderReplacement(doc: Doc, pos: number, tier: number, old: string[], add: NewText[]): string[] {
  const out: string[] = new Array(add.length);
  if (tier !== 2) {
    for (let i = 0; i < add.length; i += 1) {
      out[i] = add[i].fromOld >= 0 ? doc.lines[pos + add[i].fromOld] : add[i].text;
    }
    return out;
  }
  const fileIndent = indentOf(doc.lines[pos]);
  const patchIndent = indentOf(old[0]);
  for (let i = 0; i < add.length; i += 1) {
    const x = add[i];
    if (x.fromOld >= 0) {
      out[i] = doc.lines[pos + x.fromOld];
      continue;
    }
    const t = x.text;
    out[i] = t.trim() !== '' && t.startsWith(patchIndent) ? fileIndent + t.slice(patchIndent.length) : t;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The in-memory tree

class Store {
  before = new Map<string, string | null>();
  after = new Map<string, string | null>();

  read(p: string): string | null {
    if (!this.after.has(p)) {
      let value: string | null = null;
      try {
        if (fs.statSync(p).isFile()) value = fs.readFileSync(p, 'utf8');
      } catch {
        value = null;
      }
      this.before.set(p, value);
      this.after.set(p, value);
    }
    const v = this.after.get(p);
    return v === undefined ? null : v;
  }

  write(p: string, v: string | null): void {
    this.read(p);
    this.after.set(p, v);
  }
}

// ---------------------------------------------------------------------------
// Edits as data, run by one executor

interface HunkData {
  at: number;
  body: string[];
}

interface ChunkData {
  anchor: string | null;
  old: string[];
  add: NewText[];
  eof: boolean;
}

type Op =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string }
  | { kind: 'nothing' }
  | { kind: 'unified'; path: string; moveTo: string | null; hunks: HunkData[] }
  | { kind: 'replace'; path: string; old: string[]; add: string[] }
  | { kind: 'v4aUpdate'; path: string; moveTo: string | null; chunks: ChunkData[] }
  | { kind: 'strReplace'; path: string; oldStr: string; newStr: string }
  | { kind: 'insert'; path: string; line: number; newStr: string };

interface Job {
  paths: string[];
  move: [string, string] | null;
  op: Op;
}

interface Ctx {
  strict: boolean;
}

function needFile(s: Store, p: string): string {
  const v = s.read(p);
  if (v === null) throw new EditFail('missing', p);
  return v;
}

function needAbsent(s: Store, p: string): void {
  if (s.read(p) !== null) throw new EditFail('exists', p);
}

function applyHunksTo(doc: Doc, hunks: HunkData[], path: string, ctx: Ctx): void {
  const cap = ctx.strict ? 0 : 2;
  let drift = 0;
  for (const h of hunks) {
    const old: string[] = [];
    const add: NewText[] = [];
    let lastNew = -1;
    for (let i = 0; i < h.body.length; i += 1) {
      const b = h.body[i];
      const kind = b === '' ? ' ' : b[0];
      const s = b.slice(1);
      if (kind === ' ') {
        add.push({ text: s, fromOld: old.length });
        old.push(s);
        lastNew = i;
      } else if (kind === '-') {
        old.push(s);
      } else if (kind === '+') {
        add.push({ text: s, fromOld: -1 });
        lastNew = i;
      }
    }
    const noBreak = lastNew >= 0 && lastNew + 1 < h.body.length && h.body[lastNew + 1][0] === '\\';
    let pos: number;
    let repl: string[];
    if (old.length === 0) {
      pos = Math.min(Math.max(h.at + drift, 0), doc.lines.length);
      repl = add.map((x) => x.text);
    } else {
      const hit = findOccurrences(doc, old, cap);
      if (hit === null) throw new EditFail('no-match', path);
      const target = h.at - 1 + drift;
      pos = hit.at[0];
      for (const p of hit.at) {
        if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      }
      repl = renderReplacement(doc, pos, hit.tier, old, add);
    }
    const touchesEnd = pos + old.length === doc.lines.length;
    doc.lines.splice(pos, old.length, ...repl);
    doc.invalidate();
    if (touchesEnd) doc.endsWithBreak = !noBreak;
    drift += add.length - old.length;
  }
}

function applyChunks(doc: Doc, chunks: ChunkData[], path: string, ctx: Ctx): void {
  const cap = ctx.strict ? 0 : 2;
  let cursor = 0;
  for (const c of chunks) {
    if (c.anchor !== null) {
      const hit = findOccurrences(doc, [c.anchor], cap, (p) => p >= cursor);
      if (hit === null) throw new EditFail('no-match', path);
      cursor = hit.at[0] + 1;
    }
    if (c.old.length === 0) {
      const at = c.eof ? doc.lines.length : cursor;
      doc.lines.splice(at, 0, ...c.add.map((x) => x.text));
      doc.invalidate();
      cursor = at + c.add.length;
      continue;
    }
    const k = c.old.length;
    const hit = findOccurrences(doc, c.old, cap, (p) => p >= cursor && (!c.eof || p + k === doc.lines.length));
    if (hit === null) throw new EditFail('no-match', path);
    const pos = hit.at[0];
    const repl = renderReplacement(doc, pos, hit.tier, c.old, c.add);
    doc.lines.splice(pos, k, ...repl);
    doc.invalidate();
    cursor = pos + repl.length;
  }
}

// The text a creation section writes: the `+` lines of its hunks. A `\`
// line after the section's last `+` line drops the final break.
function creationText(hunks: HunkData[]): string {
  const lines: string[] = [];
  let lastPlus: { h: number; i: number } | null = null;
  hunks.forEach((h, hi) => {
    h.body.forEach((b, bi) => {
      if (b === '' || b[0] !== '+') return;
      lines.push(b.slice(1));
      lastPlus = { h: hi, i: bi };
    });
  });
  if (lines.length === 0) return '';
  let noBreak = false;
  if (lastPlus !== null) {
    const body = hunks[lastPlus.h].body;
    noBreak = lastPlus.i + 1 < body.length && body[lastPlus.i + 1][0] === '\\';
  }
  return lines.join('\n') + (noBreak ? '' : '\n');
}

function execOp(op: Op, s: Store, ctx: Ctx): [string, string | null][] {
  switch (op.kind) {
    case 'create': {
      needAbsent(s, op.path);
      return [[op.path, op.text]];
    }
    case 'delete': {
      needFile(s, op.path);
      return [[op.path, null]];
    }
    case 'nothing':
      return [];
    case 'replace': {
      const doc = new Doc(needFile(s, op.path));
      const hit = findOccurrences(doc, op.old, ctx.strict ? 0 : 2);
      if (hit === null) throw new EditFail('no-match', op.path);
      if (hit.at.length > 1) throw new EditFail('ambiguous', op.path);
      const pos = hit.at[0];
      const add = op.add.map((t) => ({ text: t, fromOld: -1 }));
      const repl = renderReplacement(doc, pos, hit.tier, op.old, add);
      doc.lines.splice(pos, op.old.length, ...repl);
      return [[op.path, doc.serialize()]];
    }
    case 'unified': {
      const doc = new Doc(needFile(s, op.path));
      if (op.moveTo !== null) needAbsent(s, op.moveTo);
      applyHunksTo(doc, op.hunks, op.path, ctx);
      const out = doc.serialize();
      if (op.moveTo === null) return [[op.path, out]];
      return [
        [op.moveTo, out],
        [op.path, null],
      ];
    }
    case 'v4aUpdate': {
      const doc = new Doc(needFile(s, op.path));
      if (op.moveTo !== null) needAbsent(s, op.moveTo);
      applyChunks(doc, op.chunks, op.path, ctx);
      const out = doc.serialize();
      if (op.moveTo === null) return [[op.path, out]];
      return [
        [op.moveTo, out],
        [op.path, null],
      ];
    }
    case 'strReplace': {
      let text = needFile(s, op.path);
      let a = op.oldStr;
      let b = op.newStr;
      const crlf = isCrlf(text);
      if (crlf) {
        text = text.split('\r\n').join('\n');
        a = a.split('\r\n').join('\n');
        b = b.split('\r\n').join('\n');
      }
      const first = text.indexOf(a);
      if (first < 0) throw new EditFail('no-match', op.path);
      if (text.indexOf(a, first + 1) >= 0) throw new EditFail('ambiguous', op.path);
      let out = text.slice(0, first) + b + text.slice(first + a.length);
      if (crlf) out = out.split('\n').join('\r\n');
      return [[op.path, out]];
    }
    case 'insert': {
      const doc = new Doc(needFile(s, op.path));
      if (op.line < 0 || op.line > doc.lines.length) throw new EditFail('no-match', op.path);
      doc.lines.splice(op.line, 0, ...patchLines(op.newStr));
      return [[op.path, doc.serialize()]];
    }
    default:
      throw new Error('unknown op');
  }
}

// ---------------------------------------------------------------------------
// Format detection

function detectFormat(lines: string[]): string | null {
  const first = lines.find((l) => l.trim() !== '');
  if (first !== undefined) {
    const t = first.trim();
    if (t === '*** Begin Patch') return 'v4a';
    if (t[0] === '[' || t[0] === '{') return 'json';
  }
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs

interface RawSection {
  oldFromGit: string | null;
  newFromGit: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: HunkData[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

// The two paths of a `diff --git a/X b/Y` line. Paths may themselves hold
// " b/", so every split point is tried and the one where both sides agree
// wins; otherwise the first split wins.
function gitPair(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length).trim();
  if (!rest.startsWith('a/')) return null;
  const cands: [string, string][] = [];
  let at = rest.indexOf(' b/');
  while (at !== -1) {
    const x = rest.slice(2, at);
    const y = rest.slice(at + 3);
    if (x !== '' && y !== '') cands.push([x, y]);
    at = rest.indexOf(' b/', at + 1);
  }
  if (cands.length === 0) return null;
  for (const c of cands) {
    if (c[0] === c[1]) return c;
  }
  return cands[0];
}

function parseUnified(lines: string[]): Job[] {
  const sections: RawSection[] = [];
  const fresh = (): RawSection => ({
    oldFromGit: null,
    newFromGit: null,
    pairOld: null,
    pairNew: null,
    hasPair: false,
    renameFrom: null,
    renameTo: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  const pairAt = (i: number): boolean =>
    lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ');
  let cur: RawSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const g = gitPair(l);
      if (g === null) throw parseError(i + 1);
      cur = fresh();
      cur.oldFromGit = g[0];
      cur.newFromGit = g[1];
      sections.push(cur);
      i += 1;
      continue;
    }
    if (pairAt(i)) {
      if (cur === null || cur.hunks.length > 0 || cur.hasPair) {
        cur = fresh();
        sections.push(cur);
      }
      cur.hasPair = true;
      cur.pairOld = headerPath(l);
      cur.pairNew = headerPath(lines[i + 1]);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEAD.exec(l);
      if (m === null || cur === null) throw parseError(i + 1);
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const b = lines[j];
        if (b !== '' && b[0] !== ' ' && b[0] !== '-' && b[0] !== '+' && b[0] !== '\\') break;
        if (pairAt(j)) break;
        body.push(b);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ at: Number(m[1]), body });
      i = j;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('--- ')) throw parseError(i + 2);
      if (l.startsWith('rename from ')) cur.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.newFile = true;
      else if (l.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw parseError(1);
  return sections.map(sectionToJob);
}

function sectionToJob(sec: RawSection): Job {
  const oldP = sec.hasPair ? sec.pairOld : (sec.renameFrom ?? sec.oldFromGit);
  const newP = sec.hasPair ? sec.pairNew : (sec.renameTo ?? sec.newFromGit);
  if (oldP === null && newP === null) return { paths: [], move: null, op: { kind: 'nothing' } };
  if (newP === null || (sec.deletedFile && !sec.newFile && oldP !== null)) {
    return { paths: [oldP!], move: null, op: { kind: 'delete', path: oldP! } };
  }
  if (oldP === null || sec.newFile) {
    return { paths: [newP!], move: null, op: { kind: 'create', path: newP!, text: creationText(sec.hunks) } };
  }
  if (oldP !== newP) {
    return { paths: [oldP, newP], move: [oldP, newP], op: { kind: 'unified', path: oldP, moveTo: newP, hunks: sec.hunks } };
  }
  return { paths: [oldP], move: null, op: { kind: 'unified', path: oldP, moveTo: null, hunks: sec.hunks } };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks

function parseSearchReplace(lines: string[]): Job[] {
  const jobs: Job[] = [];
  let windowStart = 0;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = i - 1; j >= windowStart; j -= 1) {
      const t = lines[j].trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw parseError(i + 1);
    let sep = i + 1;
    while (sep < lines.length && lines[sep].trimEnd() !== '=======') sep += 1;
    let end = sep + 1;
    while (end < lines.length && lines[end].trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (end >= lines.length) throw parseError(i + 1);
    const old = lines.slice(i + 1, sep);
    const add = lines.slice(sep + 1, end);
    if (old.length === 0) {
      jobs.push({ paths: [path], move: null, op: { kind: 'create', path, text: newFileText(add) } });
    } else {
      jobs.push({ paths: [path], move: null, op: { kind: 'replace', path, old, add } });
    }
    prevPath = path;
    windowStart = end + 1;
    i = end;
  }
  if (jobs.length === 0) throw parseError(1);
  return jobs;
}

// ---------------------------------------------------------------------------
// V4A patches

const V4A_ADD = '*** Add File: ';
const V4A_DEL = '*** Delete File: ';
const V4A_UPD = '*** Update File: ';
const V4A_MOV = '*** Move to: ';

interface V4ASectionData {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  body: { text: string; n: number }[];
}

function v4aHeader(l: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (l.startsWith(V4A_ADD)) return { kind: 'add', path: l.slice(V4A_ADD.length).trim() };
  if (l.startsWith(V4A_DEL)) return { kind: 'delete', path: l.slice(V4A_DEL.length).trim() };
  if (l.startsWith(V4A_UPD)) return { kind: 'update', path: l.slice(V4A_UPD.length).trim() };
  return null;
}

function parseV4A(lines: string[]): Job[] {
  const nonBlank: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') nonBlank.push(i);
  }
  if (nonBlank.length === 0) throw parseError(1);
  const begin = nonBlank[0];
  if (lines[begin].trim() !== '*** Begin Patch') throw parseError(begin + 1);
  const end = nonBlank[nonBlank.length - 1];
  if (end === begin || lines[end].trim() !== '*** End Patch') throw parseError(lines.length + 1);
  const sections: V4ASectionData[] = [];
  let cur: V4ASectionData | null = null;
  for (let i = begin + 1; i < end; i += 1) {
    const l = lines[i];
    const hdr = v4aHeader(l);
    if (hdr !== null) {
      cur = { kind: hdr.kind, path: hdr.path, lineNo: i + 1, body: [] };
      sections.push(cur);
    } else if (cur !== null) {
      cur.body.push({ text: l, n: i + 1 });
    } else if (l.trim() !== '') {
      throw parseError(i + 1);
    }
  }
  if (sections.length === 0) throw parseError(1);
  const jobs: Job[] = [];
  for (const s of sections) {
    while (s.body.length > 0 && s.body[s.body.length - 1].text.trim() === '') s.body.pop();
    if (s.kind === 'add') jobs.push(v4aAddJob(s));
    else if (s.kind === 'delete') {
      if (s.body.length > 0) throw parseError(s.body[0].n);
      jobs.push({ paths: [s.path], move: null, op: { kind: 'delete', path: s.path } });
    } else jobs.push(v4aUpdateJob(s));
  }
  return jobs;
}

function v4aAddJob(s: V4ASectionData): Job {
  const out: string[] = [];
  for (const b of s.body) {
    if (b.text === '') {
      out.push('');
      continue;
    }
    if (b.text[0] === '+') {
      out.push(b.text.slice(1));
      continue;
    }
    throw parseError(b.n);
  }
  return { paths: [s.path], move: null, op: { kind: 'create', path: s.path, text: newFileText(out) } };
}

function v4aUpdateJob(s: V4ASectionData): Job {
  let k = 0;
  let moveTo: string | null = null;
  if (s.body.length > 0 && s.body[0].text.startsWith(V4A_MOV)) {
    moveTo = s.body[0].text.slice(V4A_MOV.length).trim();
    k = 1;
  }
  const chunks: ChunkData[] = [];
  let cur: ChunkData | null = null;
  const startChunk = (anchor: string | null): ChunkData => {
    const c: ChunkData = { anchor, old: [], add: [], eof: false };
    chunks.push(c);
    return c;
  };
  for (; k < s.body.length; k += 1) {
    const { text, n } = s.body[k];
    if (text.startsWith('@@')) {
      const a = text.slice(2).trim();
      cur = startChunk(a === '' ? null : a);
    } else if (text.trimEnd() === '*** End of File') {
      if (cur !== null) {
        cur.eof = true;
        cur = null;
      } else if (chunks.length === 0) {
        startChunk(null).eof = true;
        cur = null;
      } else {
        throw parseError(n);
      }
    } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw parseError(n);
        cur = startChunk(null);
      }
      const kind = text === '' ? ' ' : text[0];
      const line = text.slice(1);
      if (kind === ' ') {
        cur.add.push({ text: line, fromOld: cur.old.length });
        cur.old.push(line);
      } else if (kind === '-') {
        cur.old.push(line);
      } else {
        cur.add.push({ text: line, fromOld: -1 });
      }
    } else {
      throw parseError(n);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw parseError(s.lineNo);
  return {
    paths: moveTo === null ? [s.path] : [s.path, moveTo],
    move: moveTo === null ? null : [s.path, moveTo],
    op: { kind: 'v4aUpdate', path: s.path, moveTo, chunks },
  };
}

// ---------------------------------------------------------------------------
// JSON edits

function parseJsonEdits(text: string, lines: string[]): Job[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first === -1) throw parseError(1);
  if (lines[first].trim()[0] === '[') {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw parseError(first + 1);
    }
    if (!Array.isArray(value)) throw parseError(first + 1);
    if (value.length === 0) throw parseError(1);
    return value.map((o) => jsonToJob(o, first + 1));
  }
  const jobs: Job[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.trim() === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(l);
    } catch {
      throw parseError(i + 1);
    }
    jobs.push(jsonToJob(value, i + 1));
  }
  if (jobs.length === 0) throw parseError(1);
  return jobs;
}

function jsonToJob(o: unknown, errLine: number): Job {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw parseError(errLine);
  const r = o as Record<string, unknown>;
  const path = r.path;
  if (typeof path !== 'string') throw parseError(errLine);
  if (r.command === 'create') {
    if (typeof r.file_text !== 'string') throw parseError(errLine);
    return { paths: [path], move: null, op: { kind: 'create', path, text: r.file_text } };
  }
  if (r.command === 'str_replace') {
    const oldStr = r.old_str;
    const newStr = Object.hasOwn(r, 'new_str') ? r.new_str : '';
    if (typeof oldStr !== 'string' || oldStr === '' || typeof newStr !== 'string') throw parseError(errLine);
    return { paths: [path], move: null, op: { kind: 'strReplace', path, oldStr, newStr } };
  }
  if (r.command === 'insert') {
    const ln = r.insert_line;
    if (typeof ln !== 'number' || !Number.isInteger(ln) || typeof r.new_str !== 'string') throw parseError(errLine);
    return { paths: [path], move: null, op: { kind: 'insert', path, line: ln, newStr: r.new_str } };
  }
  throw parseError(errLine);
}

// ---------------------------------------------------------------------------
// Running the jobs and writing the disk

function flushWrites(store: Store): void {
  const changed: [string, string | null][] = [];
  for (const [p, v] of store.after) {
    if (v !== (store.before.get(p) ?? null)) changed.push([p, v]);
  }
  for (const [p, v] of changed) {
    if (v !== null) continue;
    fs.rmSync(p, { force: true });
    let d = dirname(p);
    while (d !== '.' && d !== '/' && d !== '') {
      try {
        fs.rmdirSync(d);
      } catch {
        break;
      }
      d = dirname(d);
    }
  }
  for (const [p, v] of changed) {
    if (v === null) continue;
    fs.mkdirSync(dirname(p), { recursive: true });
    fs.writeFileSync(p, v);
  }
}

function runJobs(jobs: Job[], checkOnly: boolean, ctx: Ctx): { code: number; out: string[] } {
  const store = new Store();
  const fails: EditFail[] = [];
  const moves: [string, string][] = [];
  for (const job of jobs) {
    try {
      for (const p of job.paths) {
        if (!isSafe(p)) throw new EditFail('unsafe', p);
      }
      const writes = execOp(job.op, store, ctx);
      for (const [p, v] of writes) store.write(p, v);
      if (job.move !== null) moves.push(job.move);
    } catch (err) {
      if (err instanceof EditFail) {
        fails.push(err);
        continue;
      }
      throw err;
    }
  }
  if (fails.length > 0) {
    const out = fails.map((f) => `error: ${f.code} ${f.path}`);
    out.push(`failed: ${fails.length} of ${jobs.length} edits`);
    return { code: 1, out };
  }
  const state = new Map<string, string>();
  for (const [p, after] of store.after) {
    const before = store.before.get(p) ?? null;
    if (before === after) continue;
    state.set(p, before === null ? 'A' : after === null ? 'D' : 'M');
  }
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of moves) {
    if (state.get(o) === 'D' && state.get(n) === 'A') {
      state.delete(o);
      state.delete(n);
      rows.push({ key: n, line: `R ${o} -> ${n}` });
    }
  }
  for (const [p, k] of state) rows.push({ key: p, line: `${k} ${p}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!checkOnly) flushWrites(store);
  const out = rows.map((r) => r.line);
  out.push(`ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

function run(argv: string[]): { code: number; out: string[] } {
  try {
    const opts = parseArgs(argv);
    const text = readPatchText(opts.patch);
    const lines = patchLines(text);
    let format = opts.format;
    if (format === 'auto') {
      const d = detectFormat(lines);
      if (d === null) throw new Exit2('error: format');
      format = d;
    }
    const ctx: Ctx = { strict: opts.strict };
    let jobs: Job[];
    if (format === 'unified') jobs = parseUnified(lines);
    else if (format === 'search-replace') jobs = parseSearchReplace(lines);
    else if (format === 'v4a') jobs = parseV4A(lines);
    else jobs = parseJsonEdits(text, lines);
    return runJobs(jobs, opts.check, ctx);
  } catch (err) {
    if (err instanceof Exit2) return { code: 2, out: [err.line] };
    throw err;
  }
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const r = run(process.argv.slice(2));
  fs.writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
