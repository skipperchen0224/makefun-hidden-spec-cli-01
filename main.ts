// mend (SPEC.md v1): applies an AI-written edit (unified diff, SEARCH/REPLACE blocks, V4A patch or JSON
// text-editor calls) to the tree rooted at the working directory. Every edit is applied to an in-memory view
// of the tree; the disk is written only when every edit succeeded. Node 22, standard library only.
// When MAKEFUN_ENV_URL is set, the run is handed over to the kit's runner.ts (bottom of this file).

import { mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------------------------------------------
// Errors

/** An exit-2 outcome: one line on stdout. */
class Stop {
  line: string;
  constructor(line: string) {
    this.line = line;
  }
}

const parseError = (n: number): Stop => new Stop(`error: parse ${n}`);

/** A failed edit. */
class Fail {
  code: string;
  path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Arguments

interface Options {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

function parseArgs(args: string[]): Options {
  const usage = new Stop('error: usage');
  let format: string | null = null;
  let check = false;
  let strict = false;
  const positional: string[] = [];
  let optionsEnded = false;
  for (const arg of args) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
    } else if (!optionsEnded && arg.startsWith('-') && arg !== '-') {
      if (arg === '--check') {
        if (check) throw usage;
        check = true;
      } else if (arg === '--strict') {
        if (strict) throw usage;
        strict = true;
      } else if (arg.startsWith('--format=')) {
        if (format !== null) throw usage;
        format = arg.slice('--format='.length);
        if (!FORMAT_NAMES.includes(format)) throw usage;
      } else {
        throw usage;
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw usage;
  return { format: format ?? 'auto', check, strict, patch: positional.length === 1 ? positional[0] : null };
}

function readPatch(patch: string | null): string {
  if (patch === null || patch === '-') {
    try {
      return readFileSync(0).toString('utf8');
    } catch {
      return '';
    }
  }
  try {
    return readFileSync(patch).toString('utf8');
  } catch {
    throw new Stop('error: no-patch');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Text, lines and paths (section 3)

const isBlank = (s: string): boolean => /^\s*$/.test(s);

/** Split at \n, one trailing \r removed from each piece, no empty piece after a final \n. */
function splitPatchLines(text: string): string[] {
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

interface FileLines {
  lines: string[];
  eol: string;
  finalBreak: boolean;
}

function lineBreakOf(text: string): string {
  const i = text.indexOf('\n');
  return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
}

function toLines(text: string): FileLines {
  if (text === '') return { lines: [], eol: '\n', finalBreak: false };
  const eol = lineBreakOf(text);
  const lines = text.split(eol);
  const finalBreak = text.endsWith(eol);
  if (finalBreak) lines.pop();
  return { lines, eol, finalBreak };
}

function fromLines(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.eol) + (f.finalBreak ? f.eol : '');
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------------------------------------------------------
// Matching (section 5)

let maxTier = 2;

const TIERS: ((s: string) => string)[] = [
  (s) => s,
  (s) => s.replace(/[ \t]+$/, ''),
  (s) => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, ''),
];

const leadingBlank = (s: string): string => /^[ \t]*/.exec(s)![0];

interface Found {
  tier: number;
  positions: number[];
}

/** Occurrences of `old` in `lines` at the first tier having any position `accept` takes. */
function findLines(lines: string[], old: string[], accept: (pos: number) => boolean = () => true): Found | null {
  for (let tier = 0; tier <= maxTier; tier += 1) {
    const norm = TIERS[tier];
    const o = old.map(norm);
    const f = lines.map(norm);
    const positions: number[] = [];
    for (let i = 0; i + o.length <= f.length; i += 1) {
      if (!accept(i)) continue;
      let ok = true;
      for (let j = 0; j < o.length; j += 1) {
        if (f[i + j] !== o[j]) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** A line of N: `ctx` is the index of the same line in O for a context line, else -1. */
interface NewLine {
  text: string;
  ctx: number;
}

function replacement(lines: string[], pos: number, tier: number, old: string[], add: NewLine[]): string[] {
  const fileIndent = leadingBlank(lines[pos]);
  const patchIndent = leadingBlank(old[0]);
  return add.map((n) => {
    if (n.ctx >= 0) return lines[pos + n.ctx];
    if (tier === 2 && !isBlank(n.text) && n.text.startsWith(patchIndent)) return fileIndent + n.text.slice(patchIndent.length);
    return n.text;
  });
}

const plain = (texts: string[]): NewLine[] => texts.map((text) => ({ text, ctx: -1 }));

// ---------------------------------------------------------------------------------------------------------------
// The tree

class Tree {
  before = new Map<string, string | null>();
  now = new Map<string, string | null>();

  get(p: string): string | null {
    if (!this.now.has(p)) {
      const v = readDisk(p);
      this.before.set(p, v);
      this.now.set(p, v);
    }
    return this.now.get(p)!;
  }

  set(p: string, v: string | null): void {
    this.get(p);
    this.now.set(p, v);
  }
}

function readDisk(p: string): string | null {
  try {
    if (!statSync(p).isFile()) return null;
    return readFileSync(p).toString('utf8');
  } catch {
    return null;
  }
}

type Write = [string, string | null];

interface Edit {
  /** Every path the edit names, checked for safety in this order. */
  paths: string[];
  /** The pair [old, new] when the edit is a move. */
  move?: [string, string];
  /** The writes the edit makes, or throws Fail. */
  run(t: Tree): Write[];
}

function mustExist(t: Tree, p: string): string {
  const v = t.get(p);
  if (v === null) throw new Fail('missing', p);
  return v;
}

function mustNotExist(t: Tree, p: string): void {
  if (t.get(p) !== null) throw new Fail('exists', p);
}

const createdText = (lines: string[], finalBreak = true): string => fromLines({ lines, eol: '\n', finalBreak });

// ---------------------------------------------------------------------------------------------------------------
// Format detection (section 4)

function detectFormat(lines: string[]): string | null {
  const first = lines.find((l) => !isBlank(l));
  if (first !== undefined) {
    const t = first.trim();
    if (t === '*** Begin Patch') return 'v4a';
    if (t[0] === '[' || t[0] === '{') return 'json';
  }
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Unified diffs (section 6)

interface Hunk {
  a: number;
  body: string[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  hasPair: boolean;
  pairOld?: string | null;
  pairNew?: string | null;
  renameFrom?: string;
  renameTo?: string;
  newMode: boolean;
  deletedMode: boolean;
  hunks: Hunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function pairPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function gitPaths(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length).trim();
  if (!rest.startsWith('a/')) return null;
  const splits: [string, string][] = [];
  for (let i = rest.indexOf(' b/'); i >= 0; i = rest.indexOf(' b/', i + 1)) {
    const x = rest.slice(2, i);
    const y = rest.slice(i + 3);
    if (x !== '' && y !== '') splits.push([x, y]);
  }
  if (splits.length === 0) return null;
  return splits.find(([x, y]) => x === y) ?? splits[0];
}

function parseUnified(lines: string[]): Edit[] {
  const n = lines.length;
  const isPair = (i: number): boolean => lines[i].startsWith('--- ') && i + 1 < n && lines[i + 1].startsWith('+++ ');
  const newSection = (): Section => ({ hasPair: false, newMode: false, deletedMode: false, hunks: [] });
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  while (i < n) {
    const l = lines[i];
    if (l.startsWith('diff --git ')) {
      const paths = gitPaths(l);
      if (paths === null) throw parseError(i + 1);
      sec = newSection();
      [sec.gitOld, sec.gitNew] = paths;
      sections.push(sec);
      i += 1;
      continue;
    }
    if (isPair(i)) {
      if (sec === null || sec.hunks.length > 0 || sec.hasPair) {
        sec = newSection();
        sections.push(sec);
      }
      sec.hasPair = true;
      sec.pairOld = pairPath(l);
      sec.pairNew = pairPath(lines[i + 1]);
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = HUNK_HEADER.exec(l);
      if (m === null || sec === null) throw parseError(i + 1);
      const body: string[] = [];
      let j = i + 1;
      while (j < n) {
        const b = lines[j];
        if (!(b === '' || ' -+\\'.includes(b[0])) || isPair(j)) break;
        body.push(b);
        j += 1;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      sec.hunks.push({ a: Number(m[1]), body });
      i = j;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      if (l.startsWith('--- ')) throw parseError(i + 2);
      if (l.startsWith('rename from ')) sec.renameFrom = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) sec.renameTo = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) sec.newMode = true;
      else if (l.startsWith('deleted file mode')) sec.deletedMode = true;
    }
    i += 1;
  }
  if (sections.length === 0) throw parseError(1);
  return sections.map(sectionEdit);
}

function sectionEdit(sec: Section): Edit {
  const oldPath = sec.hasPair ? sec.pairOld! : (sec.renameFrom ?? sec.gitOld ?? null);
  const newPath = sec.hasPair ? sec.pairNew! : (sec.renameTo ?? sec.gitNew ?? null);
  if (oldPath === null && newPath === null) return { paths: [], run: () => [] };
  if (newPath === null || (sec.deletedMode && !sec.newMode && oldPath !== null)) {
    const p = oldPath!;
    return {
      paths: [p],
      run: (t) => {
        mustExist(t, p);
        return [[p, null]];
      },
    };
  }
  if (oldPath === null || sec.newMode) {
    return {
      paths: [newPath],
      run: (t) => {
        mustNotExist(t, newPath);
        return [[newPath, createdFromHunks(sec.hunks)]];
      },
    };
  }
  if (oldPath !== newPath) {
    return {
      paths: [oldPath, newPath],
      move: [oldPath, newPath],
      run: (t) => {
        const text = mustExist(t, oldPath);
        mustNotExist(t, newPath);
        return [
          [newPath, applyHunks(text, sec.hunks, oldPath)],
          [oldPath, null],
        ];
      },
    };
  }
  return {
    paths: [oldPath],
    run: (t) => [[oldPath, applyHunks(mustExist(t, oldPath), sec.hunks, oldPath)]],
  };
}

const bodyKind = (b: string): string => (b === '' ? ' ' : b[0]);

function createdFromHunks(hunks: Hunk[]): string {
  const lines: string[] = [];
  let noFinalBreak = false;
  for (const h of hunks) {
    h.body.forEach((b, i) => {
      if (bodyKind(b) !== '+') return;
      lines.push(b.slice(1));
      noFinalBreak = i + 1 < h.body.length && bodyKind(h.body[i + 1]) === '\\';
    });
  }
  return createdText(lines, !noFinalBreak);
}

function applyHunks(text: string, hunks: Hunk[], path: string): string {
  const f = toLines(text);
  let d = 0;
  for (const h of hunks) {
    const old: string[] = [];
    const add: NewLine[] = [];
    let lastNew = -1;
    h.body.forEach((b, i) => {
      const kind = bodyKind(b);
      const s = b.slice(1);
      if (kind === ' ') {
        add.push({ text: s, ctx: old.length });
        old.push(s);
        lastNew = i;
      } else if (kind === '-') {
        old.push(s);
      } else if (kind === '+') {
        add.push({ text: s, ctx: -1 });
        lastNew = i;
      }
    });
    const noFinalBreak = lastNew >= 0 && lastNew + 1 < h.body.length && bodyKind(h.body[lastNew + 1]) === '\\';
    let pos: number;
    let repl: string[];
    if (old.length === 0) {
      pos = Math.max(0, Math.min(h.a + d, f.lines.length));
      repl = add.map((x) => x.text);
    } else {
      const found = findLines(f.lines, old);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      pos = found.positions[0];
      for (const p of found.positions) if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
      repl = replacement(f.lines, pos, found.tier, old, add);
    }
    const atEnd = pos + old.length === f.lines.length;
    f.lines = [...f.lines.slice(0, pos), ...repl, ...f.lines.slice(pos + old.length)];
    if (atEnd) f.finalBreak = !noFinalBreak;
    d += add.length - old.length;
  }
  return fromLines(f);
}

// ---------------------------------------------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let blockStart = 0;
  let lastPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    let path: string | null = null;
    for (let j = i - 1; j >= blockStart; j -= 1) {
      const s = lines[j].trim();
      if (!isBlank(lines[j]) && !s.startsWith('```')) {
        path = s;
        break;
      }
    }
    path ??= lastPath;
    if (path === null) throw parseError(i + 1);
    let sep = i + 1;
    while (sep < lines.length && lines[sep].trimEnd() !== '=======') sep += 1;
    let end = sep + 1;
    while (end < lines.length && lines[end].trimEnd() !== '>>>>>>> REPLACE') end += 1;
    if (end >= lines.length) throw parseError(i + 1);
    edits.push(blockEdit(path, lines.slice(i + 1, sep), lines.slice(sep + 1, end)));
    lastPath = path;
    blockStart = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw parseError(1);
  return edits;
}

function blockEdit(path: string, old: string[], add: string[]): Edit {
  return {
    paths: [path],
    run: (t) => {
      if (old.length === 0) {
        mustNotExist(t, path);
        return [[path, createdText(add)]];
      }
      const f = toLines(mustExist(t, path));
      const found = findLines(f.lines, old);
      if (found === null) throw new Fail('no-match', path);
      if (found.positions.length > 1) throw new Fail('ambiguous', path);
      const pos = found.positions[0];
      f.lines.splice(pos, old.length, ...replacement(f.lines, pos, found.tier, old, plain(add)));
      return [[path, fromLines(f)]];
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// V4A patches (section 8)

interface Chunk {
  anchor: string | null;
  old: string[];
  add: NewLine[];
  eof: boolean;
}

interface V4ASection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  body: { text: string; n: number }[];
}

const V4A_HEADERS: [string, V4ASection['kind']][] = [
  ['*** Add File: ', 'add'],
  ['*** Delete File: ', 'delete'],
  ['*** Update File: ', 'update'],
];

function parseV4A(lines: string[]): Edit[] {
  const nonBlank: number[] = [];
  lines.forEach((l, i) => {
    if (!isBlank(l)) nonBlank.push(i);
  });
  if (nonBlank.length === 0) throw parseError(1);
  const begin = nonBlank[0];
  if (lines[begin].trim() !== '*** Begin Patch') throw parseError(begin + 1);
  const end = nonBlank[nonBlank.length - 1];
  if (end === begin || lines[end].trim() !== '*** End Patch') throw parseError(lines.length + 1);

  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  for (let i = begin + 1; i < end; i += 1) {
    const l = lines[i];
    const header = V4A_HEADERS.find(([prefix]) => l.startsWith(prefix));
    if (header !== undefined) {
      cur = { kind: header[1], path: l.slice(header[0].length).trim(), line: i + 1, body: [] };
      sections.push(cur);
    } else if (cur !== null) {
      cur.body.push({ text: l, n: i + 1 });
    } else if (!isBlank(l)) {
      throw parseError(i + 1);
    }
  }
  if (sections.length === 0) throw parseError(1);
  return sections.map((s) => {
    while (s.body.length > 0 && isBlank(s.body[s.body.length - 1].text)) s.body.pop();
    if (s.kind === 'add') return v4aAdd(s);
    if (s.kind === 'delete') {
      if (s.body.length > 0) throw parseError(s.body[0].n);
      return {
        paths: [s.path],
        run: (t: Tree): Write[] => {
          mustExist(t, s.path);
          return [[s.path, null]];
        },
      };
    }
    return v4aUpdate(s);
  });
}

function v4aAdd(s: V4ASection): Edit {
  const fileLines = s.body.map((b) => {
    if (b.text === '') return '';
    if (b.text.startsWith('+')) return b.text.slice(1);
    throw parseError(b.n);
  });
  return {
    paths: [s.path],
    run: (t) => {
      mustNotExist(t, s.path);
      return [[s.path, createdText(fileLines)]];
    },
  };
}

function v4aUpdate(s: V4ASection): Edit {
  let k = 0;
  let moveTo: string | null = null;
  if (s.body.length > 0 && s.body[0].text.startsWith('*** Move to: ')) {
    moveTo = s.body[0].text.slice('*** Move to: '.length).trim();
    k = 1;
  }
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  const newChunk = (anchor: string | null): Chunk => {
    const c: Chunk = { anchor, old: [], add: [], eof: false };
    chunks.push(c);
    return c;
  };
  for (; k < s.body.length; k += 1) {
    const { text, n } = s.body[k];
    if (text.startsWith('@@')) {
      const anchor = text.slice(2).trim();
      cur = newChunk(anchor === '' ? null : anchor);
    } else if (text.trimEnd() === '*** End of File') {
      if (cur !== null) cur.eof = true;
      else if (chunks.length === 0) newChunk(null).eof = true;
      else throw parseError(n);
      cur = null;
    } else if (text === '' || ' -+'.includes(text[0])) {
      if (cur === null) {
        if (chunks.length > 0) throw parseError(n);
        cur = newChunk(null);
      }
      const kind = text === '' ? ' ' : text[0];
      const line = text.slice(1);
      if (kind === ' ') {
        cur.add.push({ text: line, ctx: cur.old.length });
        cur.old.push(line);
      } else if (kind === '-') {
        cur.old.push(line);
      } else {
        cur.add.push({ text: line, ctx: -1 });
      }
    } else {
      throw parseError(n);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw parseError(s.line);
  const path = s.path;
  return {
    paths: moveTo === null ? [path] : [path, moveTo],
    move: moveTo === null ? undefined : [path, moveTo],
    run: (t) => {
      const text = mustExist(t, path);
      if (moveTo !== null) mustNotExist(t, moveTo);
      const f = toLines(text);
      let cursor = 0;
      for (const c of chunks) {
        if (c.anchor !== null) {
          const found = findLines(f.lines, [c.anchor], (p) => p >= cursor);
          if (found === null) throw new Fail('no-match', path);
          cursor = found.positions[0] + 1;
        }
        if (c.old.length === 0) {
          const pos = c.eof ? f.lines.length : cursor;
          f.lines.splice(pos, 0, ...c.add.map((x) => x.text));
          cursor = pos + c.add.length;
          continue;
        }
        const k0 = c.old.length;
        const found = findLines(f.lines, c.old, (p) => p >= cursor && (!c.eof || p + k0 === f.lines.length));
        if (found === null) throw new Fail('no-match', path);
        const pos = found.positions[0];
        const repl = replacement(f.lines, pos, found.tier, c.old, c.add);
        f.lines.splice(pos, k0, ...repl);
        cursor = pos + repl.length;
      }
      const result = fromLines(f);
      return moveTo === null
        ? [[path, result]]
        : [
            [moveTo, result],
            [path, null],
          ];
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// JSON edits (section 9)

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw parseError(1);
  if (lines[first].trim().startsWith('[')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw parseError(first + 1);
    }
    if (!Array.isArray(value)) throw parseError(first + 1);
    if (value.length === 0) throw parseError(1);
    return value.map((o) => {
      const e = jsonEdit(o);
      if (e === null) throw parseError(first + 1);
      return e;
    });
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let value: unknown;
    try {
      value = JSON.parse(l);
    } catch {
      throw parseError(i + 1);
    }
    const e = jsonEdit(value);
    if (e === null) throw parseError(i + 1);
    edits.push(e);
  });
  if (edits.length === 0) throw parseError(1);
  return edits;
}

function jsonEdit(o: unknown): Edit | null {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  const path = r.path;
  if (typeof path !== 'string') return null;
  if (r.command === 'create') {
    const fileText = r.file_text;
    if (typeof fileText !== 'string') return null;
    return {
      paths: [path],
      run: (t) => {
        mustNotExist(t, path);
        return [[path, fileText]];
      },
    };
  }
  if (r.command === 'str_replace') {
    const oldStr = r.old_str;
    const newStr = Object.hasOwn(r, 'new_str') ? r.new_str : '';
    if (typeof oldStr !== 'string' || oldStr === '' || typeof newStr !== 'string') return null;
    return {
      paths: [path],
      run: (t) => {
        let text = mustExist(t, path);
        let a = oldStr;
        let b = newStr;
        const crlf = lineBreakOf(text) === '\r\n';
        if (crlf) {
          text = text.replaceAll('\r\n', '\n');
          a = a.replaceAll('\r\n', '\n');
          b = b.replaceAll('\r\n', '\n');
        }
        const at = text.indexOf(a);
        if (at < 0) throw new Fail('no-match', path);
        if (text.indexOf(a, at + 1) >= 0) throw new Fail('ambiguous', path);
        let result = text.slice(0, at) + b + text.slice(at + a.length);
        if (crlf) result = result.replaceAll('\n', '\r\n');
        return [[path, result]];
      },
    };
  }
  if (r.command === 'insert') {
    const line = r.insert_line;
    const newStr = r.new_str;
    if (typeof line !== 'number' || !Number.isInteger(line) || typeof newStr !== 'string') return null;
    return {
      paths: [path],
      run: (t) => {
        const f = toLines(mustExist(t, path));
        if (line < 0 || line > f.lines.length) throw new Fail('no-match', path);
        f.lines.splice(line, 0, ...splitPatchLines(newStr));
        return [[path, fromLines(f)]];
      },
    };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Applying (sections 2 and 10)

const byteOrder = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function apply(edits: Edit[], check: boolean): { code: number; out: string[] } {
  const tree = new Tree();
  const fails: Fail[] = [];
  const moves: [string, string][] = [];
  for (const e of edits) {
    try {
      for (const p of e.paths) if (!isSafePath(p)) throw new Fail('unsafe', p);
      const writes = e.run(tree);
      for (const [p, v] of writes) tree.set(p, v);
      if (e.move !== undefined) moves.push(e.move);
    } catch (err) {
      if (!(err instanceof Fail)) throw err;
      fails.push(err);
    }
  }
  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const kind = new Map<string, string>();
  for (const [p, after] of tree.now) {
    const before = tree.before.get(p)!;
    if (before === after) continue;
    kind.set(p, before === null ? 'A' : after === null ? 'D' : 'M');
  }
  const rows: { key: string; line: string }[] = [];
  for (const [o, n] of moves) {
    if (kind.get(o) === 'D' && kind.get(n) === 'A') {
      kind.delete(o);
      kind.delete(n);
      rows.push({ key: n, line: `R ${o} -> ${n}` });
    }
  }
  for (const [p, k] of kind) rows.push({ key: p, line: `${k} ${p}` });
  rows.sort((x, y) => byteOrder(x.key, y.key));

  if (!check) {
    const changed = [...tree.now].filter(([p, v]) => v !== tree.before.get(p));
    for (const [p, v] of changed) {
      if (v !== null) continue;
      rmSync(p, { force: true });
      for (let d = dirname(p); d !== '.' && d !== '/' && d !== ''; d = dirname(d)) {
        try {
          rmdirSync(d);
        } catch {
          break;
        }
      }
    }
    for (const [p, v] of changed) {
      if (v === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, v);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

function run(args: string[]): { code: number; out: string[] } {
  try {
    const opts = parseArgs(args);
    const text = readPatch(opts.patch);
    const lines = splitPatchLines(text);
    const format = opts.format === 'auto' ? detectFormat(lines) : opts.format;
    if (format === null) throw new Stop('error: format');
    maxTier = opts.strict ? 0 : 2;
    let edits: Edit[];
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4A(lines);
    else edits = parseJson(text, lines);
    return apply(edits, opts.check);
  } catch (err) {
    if (err instanceof Stop) return { code: 2, out: [err.line] };
    throw err;
  }
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
