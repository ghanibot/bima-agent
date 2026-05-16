'use strict';

// Unit tests for src/filemaker.js. Uses node:test only.

const test     = require('node:test');
const assert   = require('node:assert/strict');
const fs       = require('node:fs');
const path     = require('node:path');
const os       = require('node:os');

const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'bima-fm-test-'));
process.env.BIMA_DATA = TMP_ROOT;

const fm = require('../src/filemaker');

// Each test gets its own filesDir under TMP_ROOT to avoid cross-pollution.
function freshDir(label) {
  const d = path.join(TMP_ROOT, label);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

test.after(() => {
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch {}
});

// ──────────────────────────────────────────────────────────────
// createFile — extension dispatch
// ──────────────────────────────────────────────────────────────

test('createFile produces PDF with correct extension', async () => {
  const dir = freshDir('pdf');
  const out = await fm.createFile('note.pdf', 'hello PDF body', dir, { title: 'Test' });
  assert.equal(path.extname(out), '.pdf');
  assert.ok(fs.existsSync(out));
  // PDFs start with %PDF magic bytes
  const head = fs.readFileSync(out).slice(0, 4).toString('utf8');
  assert.equal(head, '%PDF');
});

test('createFile produces DOCX with correct extension', async () => {
  const dir = freshDir('docx');
  const out = await fm.createFile('note.docx', 'hello docx body', dir);
  assert.equal(path.extname(out), '.docx');
  assert.ok(fs.existsSync(out));
  // DOCX is a zip — starts with PK
  const head = fs.readFileSync(out).slice(0, 2).toString('utf8');
  assert.equal(head, 'PK');
});

test('createFile produces XLSX with correct extension', async () => {
  const dir = freshDir('xlsx');
  const out = await fm.createFile('sheet.xlsx', 'a,b,c\n1,2,3', dir);
  assert.equal(path.extname(out), '.xlsx');
  assert.ok(fs.existsSync(out));
  const head = fs.readFileSync(out).slice(0, 2).toString('utf8');
  assert.equal(head, 'PK'); // xlsx is also zip-based
});

test('createFile produces TXT with correct extension', async () => {
  const dir = freshDir('txt');
  const out = await fm.createFile('note.txt', 'plain text', dir);
  assert.equal(path.extname(out), '.txt');
  assert.equal(fs.readFileSync(out, 'utf8'), 'plain text');
});

// ──────────────────────────────────────────────────────────────
// Anti-overwrite + overwrite
// ──────────────────────────────────────────────────────────────

test('second createFile with same name auto-renames (_1, _2, ...)', async () => {
  const dir = freshDir('rename');
  const first  = await fm.createFile('doc.txt', 'one',   dir);
  const second = await fm.createFile('doc.txt', 'two',   dir);
  const third  = await fm.createFile('doc.txt', 'three', dir);

  assert.equal(path.basename(first),  'doc.txt');
  assert.equal(path.basename(second), 'doc_1.txt');
  assert.equal(path.basename(third),  'doc_2.txt');
  assert.equal(fs.readFileSync(first,  'utf8'), 'one');
  assert.equal(fs.readFileSync(second, 'utf8'), 'two');
  assert.equal(fs.readFileSync(third,  'utf8'), 'three');
});

test('createFile with overwrite: true replaces in place', async () => {
  const dir = freshDir('overwrite');
  const first  = await fm.createFile('doc.txt', 'one', dir);
  const second = await fm.createFile('doc.txt', 'two', dir, { overwrite: true });

  assert.equal(first, second, 'overwrite should reuse same path');
  assert.equal(fs.readFileSync(second, 'utf8'), 'two');
  // Only one file exists in dir.
  const txtFiles = fs.readdirSync(dir).filter(f => f.endsWith('.txt'));
  assert.equal(txtFiles.length, 1);
});

// ──────────────────────────────────────────────────────────────
// editFile
// ──────────────────────────────────────────────────────────────

test('editFile makes timestamped .bak backup and overwrites original', async () => {
  const dir = freshDir('edit');
  await fm.createFile('doc.txt', 'original content', dir);
  const result = await fm.editFile('doc.txt', 'new content', dir);

  assert.ok(result.path.endsWith('doc.txt'));
  assert.ok(result.backup.endsWith('.bak'));
  assert.ok(fs.existsSync(result.backup), 'backup file should exist');
  assert.equal(fs.readFileSync(result.path,   'utf8'), 'new content');
  assert.equal(fs.readFileSync(result.backup, 'utf8'), 'original content');
  // Backup filename embeds an ISO-ish timestamp like 2025-01-01T00-00-00-000Z
  assert.match(path.basename(result.backup), /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
});

test('editFile on missing file throws', async () => {
  const dir = freshDir('edit_missing');
  await assert.rejects(
    () => fm.editFile('ghost.txt', 'x', dir),
    /tidak ditemukan/i
  );
});

// ──────────────────────────────────────────────────────────────
// findFile — fuzzy
// ──────────────────────────────────────────────────────────────

test('findFile does fuzzy (case-insensitive substring) match', async () => {
  const dir = freshDir('find');
  await fm.createFile('Laporan_Harian.txt', 'x', dir);
  await fm.createFile('Notes.txt',          'y', dir);

  const f1 = fm.findFile('laporan', dir);
  assert.ok(f1, 'should match by lowercase substring');
  assert.equal(f1.name, 'Laporan_Harian.txt');

  const f2 = fm.findFile('NOTE', dir);
  assert.ok(f2);
  assert.equal(f2.name, 'Notes.txt');

  const f3 = fm.findFile('nonexistent', dir);
  assert.ok(!f3, 'should not find anything');
});

// ──────────────────────────────────────────────────────────────
// safeName — path traversal
// ──────────────────────────────────────────────────────────────

test('safeName strips path traversal (../../etc/passwd → passwd)', () => {
  assert.equal(fm.safeName('../../etc/passwd'), 'passwd');
  assert.equal(fm.safeName('..\\..\\windows\\system32\\hosts'), 'hosts');
  assert.equal(fm.safeName('/abs/path/file.txt'), 'file.txt');
  // Forbidden chars get replaced with underscore
  assert.equal(fm.safeName('weird<name>.txt'), 'weird_name_.txt');
  // Empty input throws
  assert.throws(() => fm.safeName(''), /kosong/);
});

// ──────────────────────────────────────────────────────────────
// listFiles — excludes .bak + hidden
// ──────────────────────────────────────────────────────────────

test('listFiles excludes .bak and hidden files', async () => {
  const dir = freshDir('list');
  await fm.createFile('visible.txt', 'v', dir);
  // Hand-craft a .bak and a hidden file (filemaker normally only creates .bak via editFile)
  fs.writeFileSync(path.join(dir, 'something.bak'), 'b');
  fs.writeFileSync(path.join(dir, '.hidden'),       'h');

  const files = fm.listFiles(dir);
  const names = files.map(f => f.name);
  assert.ok(names.includes('visible.txt'));
  assert.ok(!names.includes('something.bak'), '.bak should be excluded');
  assert.ok(!names.includes('.hidden'),       'hidden should be excluded');
});
