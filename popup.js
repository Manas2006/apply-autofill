const $ = (id) => document.getElementById(id);
const ONE_TIME = ['workAuth', 'sponsorship', 'over18', 'relocate', 'degreeLevel', 'howHeard'];
let tab = null;
let profile = null;
const DL = document.getElementById('dl'); // kept as a reference so re-renders can move it
const { cleanRole, fileStem } = AAFName;

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
  const role = job && job.source !== 'pasted' ? (job.role || cleanRole(job.title)) : '';
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
  $('attachBtn').disabled = !ok;
  $('attachBtn').onclick = async () => {
    $('attachBtn').disabled = true;
    $('dlMsg').textContent = 'Attaching…';
    const r = await chrome.runtime.sendMessage({ type: 'attach', tabId: tab.id, name: $('dlName').value });
    $('attachBtn').disabled = false;
    $('dlMsg').textContent = r && r.ok ? `Attached ${r.name} to "${r.label}". Check that the form shows it before you submit.` : (r && r.error) || "Couldn't attach it.";
    if (r && r.ok) loadTrack(false);
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
  const msgs = [s.tracker && s.tracker.tone === 'warn' ? s.tracker.text + '.' : '', s.hint, s.note, s.aiError ? `AI: ${s.aiError}` : '', s.trackError ? `Tracker: ${s.trackError}` : ''].filter(Boolean);
  $('msg').textContent = msgs.join(' ');
  show('msg', msgs.length > 0);
  const info = [s.tracker && s.tracker.tone !== 'warn' ? s.tracker.text + '.' : '', s.learning ? 'Answer the amber questions yourself and Autofill offers to save those answers for next time.' : ''].filter(Boolean);
  $('info').textContent = info.join(' ');
  show('info', info.length > 0);
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

// ---------- application tracker ----------
let trackEdited = false;
function loggedLine(l) {
  const what = `${l.company}, ${l.role}`;
  if (l.action === 'created') return `Logged: ${what} (${l.status}).`;
  if (l.action === 'updated') return `Updated: ${what} is now ${l.status}.`;
  return `Already logged: ${what}.`;
}
async function loadTrack(fresh) {
  if (!tab) return;
  const card = $('track'), st = $('trackStatus'), form = $('trackForm');
  st.className = 'src';
  const t = await chrome.runtime.sendMessage({ type: 'track', tabId: tab.id, fresh });
  card.hidden = false;
  if (!t || t.error) { st.textContent = (t && t.error) || "Couldn't reach Airtable."; st.className = 'src warn'; form.hidden = !(t && t.configured); return; }
  if (!t.configured) {
    st.innerHTML = 'Log applications to your Airtable tracker and get warned about duplicates. <a class="link" id="setupAir">Set it up</a>';
    $('setupAir').addEventListener('click', () => chrome.runtime.openOptionsPage());
    form.hidden = true;
    return;
  }
  form.hidden = false;
  const hit = t.exact[0] || t.likely[0];
  const later = (s) => /interview|assessment|\boa\b|offer|reject|declin|withdr|hired|closed|^applied$/i.test(s || '');
  if (t.logged) {
    st.textContent = loggedLine(t.logged); st.className = 'src good';
  } else if (hit) {
    st.textContent = `${t.exact[0] ? 'Already in your tracker' : 'Possibly in your tracker (same company and role)'}: ${hit.status || 'no status'}${hit.date ? `, applied ${hit.date}` : ''}.`;
    if (later(hit.status)) st.className = 'src warn';
  } else {
    const n = t.sameCompany;
    st.textContent = `Not in your tracker yet.${n ? ` ${n} other row${n > 1 ? 's' : ''} at ${t.draft.company}.` : ''}${t.autoLog ? ' It gets logged when you submit after filling.' : ''}`;
  }
  if (t.logErr) { st.textContent += ` Last auto-log failed: ${t.logErr.error}`; st.className = 'src warn'; }
  else if (t.pend && !t.logged) st.textContent += ' Waiting for the confirmation page to log your submission.';
  if (!trackEdited) {
    $('tCompany').value = (hit && hit.company) || t.draft.company || '';
    $('tRole').value = (hit && hit.role) || t.draft.role || '';
  }
  const sel = $('tStatus');
  const keep = sel.value;
  sel.replaceChildren(...t.statuses.map((x) => Object.assign(document.createElement('option'), { value: x, textContent: x })));
  sel.value = keep && t.statuses.includes(keep) ? keep : t.statusApplied;
  const label = () => { const applied = sel.value === t.statusApplied; $('logBtn').textContent = hit ? (applied ? 'Mark as applied' : 'Update row') : (applied ? 'Log as applied' : 'Add to tracker'); };
  sel.onchange = label;
  label();
  $('logBtn').onclick = async () => {
    const btn = $('logBtn');
    btn.disabled = true; $('trackMsg').textContent = 'Saving to Airtable…';
    const r = await chrome.runtime.sendMessage({ type: 'logApplied', tabId: tab.id, company: $('tCompany').value, role: $('tRole').value, status: sel.value });
    btn.disabled = false;
    $('trackMsg').textContent = r && r.ok ? (r.action === 'unchanged' ? 'That row already says this.' : r.action === 'created' ? 'Added a new row.' : 'Updated the existing row.') : (r && r.error) || "Couldn't save.";
    if (r && r.ok) loadTrack(false);
  };
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  const cmds = await chrome.commands.getAll();
  const c = cmds.find((x) => x.name === 'fill-form');
  $('shortcut').innerHTML = c && c.shortcut
    ? `Or press <kbd>${c.shortcut}</kbd> on any application page`
    : 'Set a keyboard shortcut at chrome://extensions/shortcuts';

  const st = await chrome.storage.local.get(['settings', 'profile', 'ai']);
  const settings = mergeSettings(st.settings);
  const ai = mergeAi(st.ai);
  for (const k of ['overwrite', 'attach']) {
    $(k).checked = !!settings[k];
    $(k).addEventListener('change', async (e) => {
      const cur = mergeSettings((await chrome.storage.local.get('settings')).settings);
      cur[k] = e.target.checked;
      await chrome.storage.local.set({ settings: cur });
    });
  }

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
  $('retrack').addEventListener('click', () => loadTrack(true));
  for (const id of ['tCompany', 'tRole']) $(id).addEventListener('input', () => { trackEdited = true; });
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
    loadMatch(false).then(() => loadTrack(false));
  }

  $('fill').addEventListener('click', async () => {
    if (!tab) return;
    const btn = $('fill');
    btn.disabled = true; btn.textContent = 'Filling…';
    try { render(await chrome.runtime.sendMessage({ type: 'fill', tabId: tab.id })); }
    finally { btn.disabled = false; btn.textContent = 'Fill again'; }
    loadTrack(false);
  });
})();
