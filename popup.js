const $ = (id) => document.getElementById(id);
const ONE_TIME = ['workAuth', 'sponsorship', 'over18', 'relocate', 'degreeLevel', 'howHeard'];
let tab = null;
let profile = null;
const DL = document.getElementById('dl'); // kept as a reference so re-renders can move it

// "Job Application for Software Engineer Intern at Example Co" -> "Software Engineer Intern"
function cleanRole(t) {
  let s = String(t || '').trim();
  s = s.replace(/^job application for\s+/i, '').replace(/^apply (now )?(for|to)\s+/i, '');
  s = s.replace(/\s*[|·]\s.*$/, '');
  const at = s.match(/^(.*\S\s\S.*?)\s+(?:at|@)\s+[^,]+$/i);
  if (at) s = at[1];
  return s.trim();
}
function fileStem(first, last, role) {
  const clean = (x) => String(x || '').replace(/&/g, ' and ').replace(/[^A-Za-z0-9]+/g, ' ').trim().replace(/\s+/g, '_');
  return [clean(first), clean(last), clean(role)].filter(Boolean).join('_').slice(0, 120);
}

async function renderDownload(job, top) {
  const box = DL;
  if (!top) { box.style.display = 'none'; return; }
  box.style.display = 'block';
  const { resumes = [] } = await chrome.storage.local.get('resumes');
  const fileId = top.pdfId || top.id;
  const rec = resumes.find((r) => r.id === fileId);
  const ext = rec ? ((rec.name.match(/\.([a-z0-9]+)$/i) || ['', 'pdf'])[1].toLowerCase()) : 'pdf';
  $('dlExt').textContent = '.' + ext;
  $('dlBtn').textContent = ext === 'pdf' ? 'Download PDF' : `Download .${ext}`;
  const role = job && job.source !== 'pasted' ? cleanRole(job.title) : '';
  $('dlName').value = fileStem(profile.firstName, profile.lastName, role) || 'Resume';
  const ok = !!(rec && rec.hasFile);
  $('dlBtn').disabled = !ok;
  $('dlMsg').textContent = !ok
    ? 'This resume was added before downloads existed. Drop the file into the resume hub again to enable this.'
    : ext !== 'pdf' ? 'No PDF of this resume is in your hub, so this is the original file.' : '';
  $('dlBtn').onclick = async () => {
    const blob = await AAFFiles.get(fileId);
    if (!blob) { $('dlMsg').textContent = 'The saved file is missing. Drop it into the resume hub again.'; return; }
    const name = ($('dlName').value.trim() || 'Resume').replace(/[\\/:*?"<>|]+/g, '_').replace(/\.(pdf|docx?)$/i, '') + '.' + ext;
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 20000);
    $('dlMsg').textContent = `Saved ${name} to your Downloads.`;
  };
}

function item(q, r, cls) {
  const el = document.createElement('li');
  el.className = 'it' + (cls ? ' ' + cls : '');
  const a = document.createElement('span'); a.className = 'q'; a.textContent = q;
  const b = document.createElement('span'); b.className = 'r'; b.textContent = r;
  el.append(a, b);
  return el;
}

function draftItem(d) {
  const el = item(d.label, d.value, 'draft');
  const tools = document.createElement('div'); tools.className = 'tools';
  const more = Object.assign(document.createElement('a'), { className: 'link', textContent: 'Show all' });
  const copy = Object.assign(document.createElement('a'), { className: 'link', textContent: 'Copy' });
  more.addEventListener('click', () => { el.classList.toggle('open'); more.textContent = el.classList.contains('open') ? 'Show less' : 'Show all'; });
  copy.addEventListener('click', async () => { await navigator.clipboard.writeText(d.value); copy.textContent = 'Copied'; });
  tools.append(more, copy);
  el.append(tools);
  return el;
}

// ---------- fill results ----------
function render(s) {
  const out = $('out');
  if (!s) { out.style.display = 'none'; return; }
  out.style.display = 'block';
  const show = (id, on) => { $(id).style.display = on ? 'block' : 'none'; };
  if (s.error) {
    $('nFilled').textContent = ''; $('nAi').textContent = ''; $('nReview').textContent = '';
    $('msg').textContent = s.error; show('msg', true); show('used', false);
    show('aiWrap', false); show('needWrap', false); show('doneWrap', false);
    return;
  }
  const n = s.filled.length, a = (s.ai || []).length, m = s.review.length;
  $('nFilled').textContent = n || a || m ? `${n} filled` : 'No application fields found on this page';
  $('nAi').textContent = a ? `${a} AI draft${a > 1 ? 's' : ''}` : '';
  $('nReview').textContent = m ? `${m} need you` : '';
  const msgs = [s.hint, s.note, s.aiError ? `AI: ${s.aiError}` : ''].filter(Boolean);
  $('msg').textContent = msgs.join(' ');
  show('msg', msgs.length > 0);
  $('used').textContent = a && s.resumeUsed ? `Drafts were written from ${s.resumeUsed}.` : '';
  show('used', !!(a && s.resumeUsed));
  $('drafts').replaceChildren(...(s.ai || []).map(draftItem));
  show('aiWrap', a > 0);
  $('need').replaceChildren(...s.review.map((r) => item(r.label, r.reason, 'need')));
  show('needWrap', m > 0);
  $('done').replaceChildren(...s.filled.map((f) => item(f.label, f.value)));
  show('doneWrap', n > 0);
}

// ---------- resume ranking ----------
function renderMatch(r) {
  const list = $('rank');
  $('match').append(DL);          // park it before the list is cleared
  DL.style.display = 'none';
  list.replaceChildren();
  $('jdBox').style.display = 'none';
  if (!r || r.error) { $('matchStatus').textContent = (r && r.error) || "Couldn't read this page."; $('jdBox').style.display = 'block'; return; }
  const j = r.job, rk = r.ranking;
  $('jdBox').style.display = 'block';
  $('jdSummary').textContent = `Job description: ${j.chars.toLocaleString()} characters from ${j.source}`;
  $('jdPreview').textContent = j.preview + (j.chars > j.preview.length ? '\n…' : '');
  if (!rk.count) {
    $('matchStatus').innerHTML = 'Add your resumes in the <a class="link" id="goHub">resume hub</a> to rank them for each job.';
    $('goHub').addEventListener('click', openHub);
    return;
  }
  if (j.chars < 400) {
    $('matchStatus').textContent = 'Very little job text found on this page. Paste the description below for a better ranking.';
    $('jdBox').open = true;
  } else {
    $('matchStatus').textContent = rk.by === 'claude' ? `Ranked by Claude from ${rk.count} resumes` : `Ranked by keyword match from ${rk.count} resumes${rk.warn ? ` (Claude unavailable: ${rk.warn})` : ''}`;
  }
  renderDownload(j, rk.top[0]);
  for (const t of rk.top) {
    const li = document.createElement('li');
    const both = (t.formats || []).length > 1 ? ` (${t.formats.join(' + ')})` : '';
    const nm = Object.assign(document.createElement('span'), { className: 'nm', textContent: t.name.replace(/\.(pdf|docx?|txt|md)$/i, '') + both });
    const why = Object.assign(document.createElement('span'), { className: 'why', textContent: t.why || (t.hits.length ? `Matches: ${t.hits.join(', ')}` : '') });
    li.append(nm, why);
    list.append(li);
  }
  // The download sits right under the #1 resume.
  if (list.firstElementChild) list.firstElementChild.append(DL);
}
async function loadMatch(fresh) {
  if (!tab) return;
  $('matchStatus').textContent = 'Reading the job description…';
  $('rank').replaceChildren();
  renderMatch(await chrome.runtime.sendMessage({ type: 'match', tabId: tab.id, fresh }));
}

const openHub = () => chrome.tabs.create({ url: chrome.runtime.getURL('hub.html') });

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const cmds = await chrome.commands.getAll();
  const c = cmds.find((x) => x.name === 'fill-form');
  $('shortcut').innerHTML = c && c.shortcut
    ? `Or press <kbd>${c.shortcut}</kbd> on any application page`
    : 'Set a keyboard shortcut at chrome://extensions/shortcuts';

  const st = await chrome.storage.local.get(['settings', 'profile', 'ai']);
  const settings = st.settings || {};
  const ai = mergeAi(st.ai);
  $('overwrite').checked = !!settings.overwrite;
  $('overwrite').addEventListener('change', async (e) => {
    const cur = (await chrome.storage.local.get('settings')).settings || {};
    cur.overwrite = e.target.checked;
    await chrome.storage.local.set({ settings: cur });
  });

  $('aiDrafts').checked = !!ai.drafts && !!ai.apiKey;
  if (!ai.apiKey) {
    $('aiToggle').classList.add('off');
    $('aiDrafts').disabled = true;
    $('aiWhy').innerHTML = '(<a class="link" id="addKey">add an API key</a>)';
    $('addKey').addEventListener('click', () => chrome.runtime.openOptionsPage());
  }
  $('aiDrafts').addEventListener('change', async (e) => {
    const cur = mergeAi((await chrome.storage.local.get('ai')).ai);
    cur.drafts = e.target.checked;
    await chrome.storage.local.set({ ai: cur });
  });

  const p = mergeProfile(st.profile);
  profile = p;
  const blanks = ONE_TIME.filter((k) => !String(p[k] || '').trim()).length;
  if (blanks) {
    $('nudge').style.display = 'block';
    $('nudge').innerHTML = `${blanks} one-time answer${blanks > 1 ? 's are' : ' is'} still blank, so those questions get flagged instead of filled. <a id="goOpts">Set them</a>`;
    $('goOpts').addEventListener('click', () => chrome.runtime.openOptionsPage());
  }

  $('opts').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('hub').addEventListener('click', openHub);
  $('rerank').addEventListener('click', () => loadMatch(true));
  $('useJd').addEventListener('click', async () => {
    $('matchStatus').textContent = 'Ranking against the pasted description…';
    renderMatch(await chrome.runtime.sendMessage({ type: 'pasteJd', tabId: tab.id, text: $('jdPaste').value }));
  });
  $('clearJd').addEventListener('click', async () => {
    $('jdPaste').value = '';
    renderMatch(await chrome.runtime.sendMessage({ type: 'pasteJd', tabId: tab.id, text: '' }));
  });

  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'progress' && tab && m.tabId === tab.id) $('fill').textContent = m.text;
  });

  if (tab) {
    render(await chrome.runtime.sendMessage({ type: 'last', tabId: tab.id }));
    loadMatch(false);
  }

  $('fill').addEventListener('click', async () => {
    if (!tab) return;
    const btn = $('fill');
    btn.disabled = true; btn.textContent = 'Filling…';
    try { render(await chrome.runtime.sendMessage({ type: 'fill', tabId: tab.id })); }
    finally { btn.disabled = false; btn.textContent = 'Fill again'; }
  });
})();
