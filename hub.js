import * as pdfjs from './lib/vendor/pdf.min.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/vendor/pdf.worker.min.mjs');

const $ = (id) => document.getElementById(id);
let resumes = [];

async function load() {
  ({ resumes = [] } = await chrome.storage.local.get('resumes'));
  render();
}
async function persist() {
  const { resumesRev = 0 } = await chrome.storage.local.get('resumesRev');
  await chrome.storage.local.set({ resumes, resumesRev: resumesRev + 1 });
}

// ---------- text extraction (all local) ----------
async function pdfText(buf) {
  const doc = await pdfjs.getDocument({ data: buf, isEvalSupported: false, useSystemFonts: true }).promise;
  const lines = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '', lastEnd = null, lastY = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue;
      const x = it.transform[4], y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2 && line) { lines.push(line); line = ''; lastEnd = null; }
      if (lastEnd !== null && x - lastEnd > 1 && !line.endsWith(' ') && !it.str.startsWith(' ')) line += ' ';
      line += it.str;
      lastEnd = x + (it.width || 0);
      lastY = y;
      if (it.hasEOL) { lines.push(line); line = ''; lastEnd = null; lastY = null; }
    }
    if (line) lines.push(line);
  }
  return lines.join('\n');
}
async function docxText(buf) {
  const r = await window.mammoth.extractRawText({ arrayBuffer: buf });
  return r.value || '';
}
async function extract(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf') || file.type === 'application/pdf') return pdfText(await file.arrayBuffer());
  if (name.endsWith('.docx')) return docxText(await file.arrayBuffer());
  if (/\.(txt|md)$/.test(name) || file.type.startsWith('text/')) return file.text();
  throw new Error('Only PDF, .docx or text files');
}
const tidy = (t) => t.replace(/\r/g, '').replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function addFiles(files) {
  const list = [...files];
  if (!list.length) return;
  const errors = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    $('busy').textContent = `Reading ${f.name} (${i + 1} of ${list.length})…`;
    try {
      const text = tidy(await extract(f));
      const prev = resumes.find((r) => r.name === f.name);
      const id = prev ? prev.id : crypto.randomUUID();
      let hasFile = false;
      try { await window.AAFFiles.put(id, f); hasFile = true; } catch (e) { /* text still works */ }
      const rec = { id, name: f.name, text, chars: text.length, notes: prev ? prev.notes : '', addedAt: Date.now(), hasFile };
      if (prev) Object.assign(prev, rec); else resumes.push(rec);
    } catch (e) {
      errors.push(`${f.name}: ${e.message || e}`);
    }
  }
  resumes.sort((a, b) => a.name.localeCompare(b.name));
  await persist();
  $('busy').textContent = errors.length ? `Couldn't read ${errors.join('; ')}` : `Added ${list.length} file${list.length > 1 ? 's' : ''}.`;
  render();
}

// ---------- list ----------
function render() {
  $('count').textContent = resumes.length ? `${resumes.length}` : '';
  const box = $('list');
  box.replaceChildren();
  if (!resumes.length) {
    box.append(Object.assign(document.createElement('div'), { className: 'empty', textContent: 'No resumes yet. Drop some files above.' }));
    return;
  }
  for (const r of resumes) {
    const row = document.createElement('div'); row.className = 'res';
    const left = document.createElement('div');
    const nm = document.createElement('div'); nm.className = 'name'; nm.textContent = r.name;
    const meta = document.createElement('div');
    const thin = r.chars < 300;
    meta.className = 'meta' + (thin ? ' bad' : '');
    meta.textContent = thin
      ? 'Almost no text found. If this is a scanned PDF, export a text PDF or the .docx instead.'
      : `${r.chars.toLocaleString()} characters · added ${new Date(r.addedAt).toLocaleDateString()}${r.hasFile ? '' : ' · text only, drop the file in again to enable downloads'}`;
    left.append(nm, meta);
    const acts = document.createElement('div'); acts.className = 'acts';
    const prev = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Preview' });
    const del = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Remove' });
    if (r.hasFile) {
      const dl = Object.assign(document.createElement('button'), { className: 'btn', textContent: 'Download' });
      dl.addEventListener('click', async () => {
        const blob = await window.AAFFiles.get(r.id);
        if (!blob) { dl.textContent = 'File missing'; return; }
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: r.name });
        a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      });
      acts.append(dl);
    }
    acts.append(prev, del);
    const notes = Object.assign(document.createElement('input'), { type: 'text', placeholder: 'Note (optional): what this version emphasizes', value: r.notes || '' });
    let t;
    notes.addEventListener('input', () => { r.notes = notes.value; clearTimeout(t); t = setTimeout(persist, 400); });
    let pre = null;
    prev.addEventListener('click', () => {
      if (pre) { pre.remove(); pre = null; prev.textContent = 'Preview'; return; }
      pre = Object.assign(document.createElement('pre'), { textContent: r.text });
      row.append(pre); prev.textContent = 'Hide';
    });
    del.addEventListener('click', async () => {
      try { await window.AAFFiles.del(r.id); } catch (e) { /* nothing stored */ }
      resumes = resumes.filter((x) => x.id !== r.id);
      await persist(); render();
    });
    row.append(left, acts, notes);
    box.append(row);
  }
}

// ---------- drop zone ----------
const drop = $('drop');
drop.addEventListener('click', () => $('pick').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('pick').click(); } });
$('pick').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
// Dropping anywhere else on the page should not navigate away to the file.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- try a ranking ----------
$('rankBtn').addEventListener('click', async () => {
  const text = $('jd').value.trim();
  const out = $('rankOut');
  out.replaceChildren();
  if (!text) { $('rankStatus').textContent = 'Paste a job description first.'; return; }
  if (!resumes.length) { $('rankStatus').textContent = 'Add resumes first.'; return; }
  $('rankStatus').textContent = 'Ranking…';
  const r = await chrome.runtime.sendMessage({ type: 'rankText', text });
  if (!r || r.error) { $('rankStatus').textContent = (r && r.error) || 'Ranking failed.'; return; }
  $('rankStatus').textContent = r.by === 'claude' ? 'Ranked by Claude' : `Ranked by keyword match${r.warn ? ` (Claude unavailable: ${r.warn})` : ''}`;
  for (const t of r.top) {
    const li = document.createElement('li');
    const n = document.createElement('strong'); n.textContent = t.name;
    const w = document.createElement('span'); w.className = 'why';
    w.textContent = t.why || (t.hits.length ? `Matches: ${t.hits.join(', ')}` : '');
    li.append(n, w);
    out.append(li);
  }
});

$('toOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.storage.onChanged.addListener((ch, area) => {
  if (area === 'local' && ch.resumes && !document.hasFocus()) load();
});

load();
