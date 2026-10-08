importScripts('defaults.js', 'lib/ranking.js', 'lib/jobsource.js', 'lib/ai.js', 'lib/filestore.js', 'lib/naming.js', 'lib/airtable.js');

const clip = (s, n = 90) => (s.length > n ? s.slice(0, n - 1).trim() + '…' : s);

async function loadProfile() {
  const { profile } = await chrome.storage.local.get('profile');
  return mergeProfile(profile);
}
async function loadAi() {
  const { ai } = await chrome.storage.local.get('ai');
  return mergeAi(ai);
}
async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return mergeSettings(settings);
}
async function loadAir() {
  const { airtable } = await chrome.storage.local.get('airtable');
  return mergeAirtable(airtable);
}
const sget = async (k) => (await chrome.storage.session.get(k))[k];
function progress(tabId, text) {
  chrome.runtime.sendMessage({ type: 'progress', tabId, text }).catch(() => {});
}

// ---------- job description ----------
async function getJob(tabId, { fresh } = {}) {
  const ses = await chrome.storage.session.get(['jdPaste:' + tabId, 'job:' + tabId]);
  if (ses['jdPaste:' + tabId]) return ses['jdPaste:' + tabId];
  if (!fresh && ses['job:' + tabId]) return ses['job:' + tabId];
  let pages = [];
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['engine.js'] });
    const rs = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => (window.__appAutofill ? window.__appAutofill.extractJob() : null) });
    pages = rs.map((r) => r && r.result).filter(Boolean);
  } catch (e) {
    return null;
  }
  let job = null;
  const topPage = pages.find((x) => x.top) || pages[0];
  for (const pg of pages) {
    job = await AAFJob.fromApi(pg.url);
    if (job) { job.pageTitle = pg.pageTitle || ''; break; }
  }
  if (!job && pages.length) {
    const best = [...pages].sort((a, b) => b.text.length - a.text.length)[0];
    job = { url: topPage.url, title: best.title || topPage.title, text: best.text, source: best.host, pageTitle: best.pageTitle || topPage.pageTitle || '' };
  }
  if (job && topPage) {
    job.topUrl = topPage.url;
    job.siteName = topPage.siteName || '';
    if (!job.pageTitle) job.pageTitle = topPage.pageTitle || '';
  }
  if (job) await chrome.storage.session.set({ ['job:' + tabId]: job });
  return job;
}

// ---------- resume ranking ----------
async function rankForJob(job, ai) {
  const { resumes = [], resumesRev = 0 } = await chrome.storage.local.get(['resumes', 'resumesRev']);
  if (!resumes.length || !job || !job.text) return { count: resumes.length, top: [], by: 'none' };
  const wantClaude = !!(ai.rankWithClaude && ai.apiKey && new Set(resumes.map((r) => AAFRank.baseName(r.name))).size > 1);
  const key = `rank2:${job.url}|${job.text.length}|${resumesRev}|${wantClaude ? ai.model : 'local'}`;
  const cached = (await chrome.storage.session.get(key))[key];
  if (cached) return cached;

  // Rank every file, then keep one entry per resume (a PDF and a DOCX of the same
  // resume share a name), remembering which file in the group is the PDF.
  const groups = new Map();
  for (const r of resumes) {
    const k = AAFRank.baseName(r.name);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const seen = new Set();
  const local = AAFRank.rankResumes(job.text, resumes).filter((x) => {
    const k = AAFRank.baseName(x.name);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const view = (x, why) => {
    const g = groups.get(AAFRank.baseName(x.name)) || [];
    const pdf = g.find((r) => /\.pdf$/i.test(r.name));
    return { id: x.id, name: x.name, rel: x.rel, hits: x.hits, why: why || '', pdfId: pdf ? pdf.id : '', formats: g.map((r) => (r.name.match(/\.([a-z]+)$/i) || ['', '?'])[1].toLowerCase()) };
  };
  let out = { count: groups.size, top: local.slice(0, 3).map((x) => view(x)), by: 'keywords' };
  if (wantClaude) {
    const shortlist = local.slice(0, 8).map((x) => resumes.find((r) => r.id === x.id));
    try {
      const picks = await AAFAI.rankWithClaude(ai, job, shortlist);
      if (picks) out = { count: groups.size, top: picks.slice(0, 3).map((c) => view(local.find((x) => x.id === c.id), c.why)), by: 'claude' };
    } catch (e) {
      out.warn = e.message;
    }
  }
  if (!out.warn) await chrome.storage.session.set({ [key]: out });
  return out;
}

async function matchForTab(tabId, { fresh } = {}) {
  const ai = await loadAi();
  const job = await getJob(tabId, { fresh });
  if (!job) return { error: "Couldn't read this page." };
  const ranking = await rankForJob(job, ai);
  return { job: { url: job.url, title: job.title, role: AAFName.roleFor(job), source: job.source, chars: job.text.length, preview: job.text.slice(0, 1200) }, ranking };
}

// ---------- fill ----------
async function inFrame(tabId, frameId, func, args) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args });
  return r && r.result;
}

async function draftAll(tabId, tasks, profile, ai, summary) {
  progress(tabId, `Drafting ${tasks.length} written answer${tasks.length > 1 ? 's' : ''}…`);
  const job = await getJob(tabId);
  const ranking = await rankForJob(job, ai);
  const { resumes = [] } = await chrome.storage.local.get('resumes');
  const resume = ranking.top[0] ? resumes.find((r) => r.id === ranking.top[0].id) : null;
  summary.resumeUsed = resume ? resume.name : '';
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      try {
        const out = await AAFAI.draftAnswer(ai, profile, job, resume, t);
        if (out.skip || !out.text) {
          await inFrame(tabId, t.frameId, (id) => window.__appAutofill.aiFailed(id), [t.id]);
          summary.review.push({ label: clip(t.label), reason: "AI skipped it: it needs a fact you haven't given. Answer this yourself" });
        } else {
          await inFrame(tabId, t.frameId, (id, text) => window.__appAutofill.fillAi(id, text), [t.id, out.text]);
          summary.ai.push({ label: clip(t.label), value: out.text });
        }
      } catch (e) {
        summary.aiError = e.message;
        try { await inFrame(tabId, t.frameId, (id) => window.__appAutofill.aiFailed(id), [t.id]); } catch (e2) { /* frame gone */ }
        summary.review.push({ label: clip(t.label), reason: 'AI draft failed. Write this one yourself' });
      }
      progress(tabId, `Drafted ${summary.ai.length} of ${tasks.length}…`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

// ---------- attaching your resume ----------
const MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', doc: 'application/msword', txt: 'text/plain', md: 'text/markdown' };
const extOf = (name) => ((String(name).match(/\.([a-z0-9]+)$/i) || ['', ''])[1] || '').toLowerCase();

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// The best file of the top resume for an upload field: the PDF unless the field's
// `accept` rules it out.
async function pickFile(top, accept) {
  const { resumes = [] } = await chrome.storage.local.get('resumes');
  const key = AAFRank.baseName(top.name);
  const group = resumes.filter((r) => AAFRank.baseName(r.name) === key && r.hasFile);
  if (!group.length) return { error: 'Your top resume was added before files were kept. Drop it into the resume hub again to attach it automatically.' };
  const acc = String(accept || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const allowed = (r) => {
    if (!acc.length) return true;
    const e = extOf(r.name);
    return acc.some((a) => a === '.' + e || a === MIME[e] || (a.endsWith('/*') && (MIME[e] || '').startsWith(a.slice(0, -1))));
  };
  const order = ['pdf', 'docx', 'doc', 'txt', 'md'];
  const ok = group.filter(allowed).sort((a, b) => order.indexOf(extOf(a.name)) - order.indexOf(extOf(b.name)));
  if (!ok.length) return { error: `This upload only takes ${acc.join(', ')} files, and your top resume isn't in that format.` };
  const rec = ok[0];
  const blob = await AAFFiles.get(rec.id);
  if (!blob) return { error: 'The saved resume file is missing. Drop it into the resume hub again.' };
  const ext = extOf(rec.name) || 'pdf';
  return { rec, ext, type: blob.type || MIME[ext] || 'application/octet-stream', b64: b64(await blob.arrayBuffer()) };
}

function attachName(profile, job, ext, override) {
  const clean = String(override || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\.(pdf|docx?|txt|md)$/i, '');
  return (clean || AAFName.fileStem(profile.firstName, profile.lastName, AAFName.roleFor(job)) || 'Resume') + '.' + ext;
}

async function attachToTarget(tabId, t, profile, ai, nameOverride) {
  const job = await getJob(tabId);
  if (!job) return { error: "Couldn't read the job to pick a resume." };
  const ranking = await rankForJob(job, ai);
  const top = ranking.top[0];
  if (!top) return { error: ranking.count ? 'No resume ranked for this job.' : 'Add your resumes to the hub to attach them automatically.' };
  const pick = await pickFile(top, t.accept);
  if (pick.error) return pick;
  const name = attachName(profile, job, pick.ext, nameOverride);
  let res = null;
  try {
    res = await inFrame(tabId, t.frameId, (id, data, n, type) => window.__appAutofill.attachFile(id, data, n, type), [t.id, pick.b64, name, pick.type]);
  } catch (e) {
    return { error: 'The page blocked the upload: ' + (e && e.message ? e.message : e) };
  }
  if (!res || !res.ok) return { error: (res && res.error) || "Couldn't attach the file." };
  const info = { name, resume: top.name.replace(/\.[a-z0-9]+$/i, ''), label: t.label, at: Date.now() };
  await chrome.storage.session.set({ ['attached:' + tabId]: info });
  return Object.assign({ ok: true }, info);
}

// The popup's "Attach to this form": finds the resume field itself.
async function attachFromPopup(tabId, nameOverride) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['engine.js'] });
  } catch (e) {
    return { error: "Chrome doesn't let extensions run on this page." };
  }
  const rs = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => (window.__appAutofill ? window.__appAutofill.findResumeFields() : []) });
  const targets = [];
  for (const r of rs) for (const t of (r && r.result) || []) targets.push(Object.assign({ frameId: r.frameId }, t));
  if (!targets.length) return { error: 'No resume upload field on this page yet. Open the step of the form that asks for it, then try again.' };
  const t = targets.find((x) => !x.has) || targets[0];
  return attachToTarget(tabId, t, await loadProfile(), await loadAi(), nameOverride);
}

// ---------- learning answers you typed ----------
const LEARN_FIELDS = new Set(['firstName', 'lastName', 'email', 'phone', 'linkedin', 'github', 'scholar', 'website', 'address', 'city', 'state', 'zip', 'country', 'school', 'major', 'gpa', 'currentCompany', 'currentTitle', 'hsGradYear', 'testType', 'sat', 'act', 'workAuth', 'sponsorship', 'relocate', 'over18', 'howHeard', 'pronouns', 'gender', 'race', 'hispanic', 'veteran', 'disability', 'degreeLevel', 'degreeText']);
const qKey = (q) => String(q || '').toLowerCase().replace(/[^a-z0-9/]+/g, ' ').trim();

async function learnAnswers(items) {
  const { profile: stored } = await chrome.storage.local.get('profile');
  const profile = mergeProfile(stored);
  let saved = 0;
  for (const it of Array.isArray(items) ? items.slice(0, 20) : []) {
    const val = String((it && (it.kind === 'profile' ? it.value : it.a)) || '').trim().slice(0, 200);
    if (!val) continue;
    if (it.kind === 'profile' && LEARN_FIELDS.has(it.field)) {
      profile[it.field] = val;
      saved++;
    } else if (it.kind === 'custom' && String(it.q || '').trim().length >= 3) {
      const q = String(it.q).trim().slice(0, 200);
      const hit = profile.custom.find((c) => c && qKey(c.q) === qKey(q));
      if (hit) hit.a = val; else profile.custom.push({ q, a: val });
      saved++;
    }
  }
  if (saved) await chrome.storage.local.set({ profile });
  return { ok: true, saved };
}

// ---------- application tracker (Airtable) ----------
async function airRows(air, fresh) {
  const sig = `${air.baseId}|${air.table}|${air.fields.company}`;
  const c = await sget('airRows');
  if (!fresh && c && c.sig === sig && Date.now() - c.at < 5 * 60 * 1000) return c.rows;
  const rows = await AAFAir.listRows(air);
  await chrome.storage.session.set({ airRows: { sig, at: Date.now(), rows } });
  return rows;
}

async function tabUrl(tabId) {
  try { return (await chrome.tabs.get(tabId)).url || ''; } catch (e) { return ''; }
}

// What a tracker row for this tab's job would say.
async function buildDraft(tabId, rows, over) {
  over = over || {};
  const job = await getJob(tabId);
  const url = (job && job.source !== 'pasted' && job.url) || (await tabUrl(tabId));
  const topUrl = (job && job.topUrl) || url;
  const info = AAFName.atsInfo(url);
  let company = String(over.company || '').trim();
  if (!company) {
    company = AAFName.guessCompany({ url, topUrl, title: job && job.title, pageTitle: job && job.pageTitle, siteName: job && job.siteName, apiCompany: job && job.company });
    company = AAFAir.canonicalCompany(rows, company, info.slug);
  }
  const role = String(over.role || '').trim() || AAFName.stripCompany(AAFName.roleFor(job), company);
  const att = await sget('attached:' + tabId);
  let resume = att ? att.resume : '';
  if (!resume && job) {
    try {
      const rk = await rankForJob(job, await loadAi());
      if (rk.top[0]) resume = rk.top[0].name.replace(/\.[a-z0-9]+$/i, '');
    } catch (e) { /* ranking is optional here */ }
  }
  return {
    company, role, url, topUrl, jobId: info.id, req: AAFName.reqFor(url),
    location: (job && job.location) || '', resume,
    term: AAFName.termFrom(job && job.title, job && job.pageTitle),
    date: AAFName.today(),
  };
}

const rowView = (r) => ({ company: r.company || '', role: r.role || '', status: r.status || '', date: r.date || '' });

async function trackStatus(tabId, { fresh } = {}) {
  const air = await loadAir();
  if (!AAFAir.ready(air)) return { configured: false };
  const rows = await airRows(air, fresh);
  const draft = await buildDraft(tabId, rows);
  const m = AAFAir.findMatches(rows, draft);
  const statuses = [...new Set([air.statusApplied, ...rows.map((r) => r.status)].filter(Boolean))];
  return {
    configured: true, autoLog: !!air.autoLog, statusApplied: air.statusApplied, draft, statuses, rows: rows.length,
    exact: m.exact.slice(0, 3).map(rowView), likely: m.likely.slice(0, 3).map(rowView), sameCompany: m.company.length,
    logged: (await sget('logged:' + tabId)) || null, pend: (await sget('pend:' + tabId)) ? true : false,
    logErr: (await sget('logErr:' + tabId)) || null,
  };
}

// One line for the toast and popup about rows that already track this job.
function trackLine(t) {
  const r = (t.exact && t.exact[0]) || (t.likely && t.likely[0]);
  if (!r) return null;
  const sure = !!(t.exact && t.exact[0]);
  const when = r.date ? ` on ${r.date}` : '';
  const applied = AAFAir.LATER.test(r.status) || /^applied$/i.test(r.status);
  return {
    text: `${sure ? 'Already in your tracker' : 'Maybe already in your tracker'}: ${[r.company, r.role].filter(Boolean).join(', ')} (${r.status || 'no status'}${when})`,
    tone: applied ? 'warn' : '',
  };
}

async function logApplied(tabId, opts) {
  opts = opts || {};
  const air = await loadAir();
  if (!AAFAir.ready(air)) return { error: 'Set up the Airtable tracker in Options first.' };
  const rows = await airRows(air, true);
  const draft = opts.draft ? Object.assign({}, opts.draft) : await buildDraft(tabId, rows, opts);
  if (opts.company) draft.company = opts.company;
  if (opts.role) draft.role = opts.role;
  if (!draft.company || !draft.role) return { error: 'Add the company and role first.' };
  const r = await AAFAir.logApplication(air, draft, rows, { status: opts.status, auto: !!opts.auto });
  await chrome.storage.session.remove('airRows');
  const status = opts.status || air.statusApplied;
  const logged = { at: Date.now(), action: r.action, company: draft.company, role: draft.role, status, reason: r.reason || '' };
  if (r.action !== 'skipped') await chrome.storage.session.set({ ['logged:' + tabId]: logged });
  return Object.assign({ ok: true }, logged);
}

function loggedText(r) {
  const what = `${r.company}, ${r.role}`;
  if (r.action === 'created') return `Logged to your tracker: ${what} (${r.status})`;
  if (r.action === 'updated') return `Updated your tracker: ${what} is now ${r.status}`;
  if (r.action === 'skipped') return r.reason;
  return `Already logged in your tracker: ${what}`;
}

async function tellPage(tabId, frameId, text, tone) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId || 0] }, files: ['engine.js'] });
    await inFrame(tabId, frameId || 0, (t, k) => window.__appAutofill && window.__appAutofill.notify(t, k), [text, tone]);
  } catch (e) { /* page not reachable; the popup shows it */ }
}

// You clicked a submit button on a page you filled. Remember what the row would
// say now, while the job is still on screen; it is only written once a
// confirmation appears.
const building = new Map();
async function onSubmitAttempt(tabId, frameId, url) {
  const air = await loadAir();
  if (!AAFAir.ready(air) || !air.autoLog) return { ok: false };
  const p = (async () => {
    let draft = null;
    try { draft = await buildDraft(tabId, await airRows(air)); } catch (e) { draft = null; }
    await chrome.storage.session.set({ ['pend:' + tabId]: { at: Date.now(), draft, frameId, url } });
  })();
  building.set(tabId, p);
  await p;
  return { ok: true };
}

async function onSubmitConfirmed(tabId, frameId) {
  if (building.has(tabId)) { try { await building.get(tabId); } catch (e) { /* ignore */ } }
  const k = 'pend:' + tabId;
  const pend = await sget(k);
  if (!pend || Date.now() - pend.at > 10 * 60 * 1000) return { ok: false };
  await chrome.storage.session.remove(k);
  try {
    const r = await logApplied(tabId, { draft: pend.draft || undefined, auto: true });
    if (r.error) throw new Error(r.error);
    await tellPage(tabId, frameId, loggedText(r), r.action === 'skipped' ? 'warn' : 'ok');
    if (r.action !== 'skipped') { try { await chrome.action.setBadgeText({ tabId, text: '✓' }); await chrome.action.setBadgeBackgroundColor({ tabId, color: '#15803d' }); } catch (e) { /* tab gone */ } }
    return r;
  } catch (e) {
    await chrome.storage.session.set({ ['logErr:' + tabId]: { at: Date.now(), error: e.message, draft: pend.draft } });
    await tellPage(tabId, frameId, `Couldn't log this to your tracker: ${e.message}`, 'warn');
    return { error: e.message };
  }
}

const CONFIRM_PAGE = /thank(s| you) for (applying|your application|submitting)|application (was |has been )?(successfully )?(submitted|received|sent|complete)|we('ve| have) received your application|successfully (submitted|applied)|you('ve| have) (successfully )?applied/;

// After a submit click the page navigated. Log it only if the new page is a confirmation.
async function checkAfterNavigation(tabId, url) {
  const pend = await sget('pend:' + tabId);
  if (!pend || Date.now() - pend.at > 3 * 60 * 1000) return;
  let ok = url !== pend.url && /confirm|thank|success|submitted|applied|complete/i.test(url || '');
  if (!ok) {
    try {
      const rs = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (src) => new RegExp(src).test(((document.body && document.body.innerText) || '').toLowerCase().replace(/[’‘]/g, "'")),
        args: [CONFIRM_PAGE.source],
      });
      ok = rs.some((r) => r && r.result);
    } catch (e) { ok = false; }
  }
  if (ok) await onSubmitConfirmed(tabId, 0);
}

async function fillTab(tabId) {
  const profile = await loadProfile();
  const ai = await loadAi();
  const settings = await loadSettings();
  const air = await loadAir();
  const tracking = AAFAir.ready(air);
  const trackP = tracking && air.dupCheck ? trackStatus(tabId).catch((e) => ({ error: e.message })) : null;
  const useAi = !!(ai.drafts && ai.apiKey);
  const target = { tabId, allFrames: true };
  try {
    await chrome.scripting.executeScript({ target, files: ['engine.js'] });
  } catch (e) {
    return save(tabId, { error: "Chrome doesn't let extensions run on this page." });
  }
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target,
      func: (p, o) => (window.__appAutofill ? window.__appAutofill.run(p, o) : null),
      args: [profile, { overwrite: !!settings.overwrite, ai: useAi, attach: !!settings.attach, learn: !!settings.learn, track: tracking && !!air.autoLog }],
    });
  } catch (e) {
    return save(tabId, { error: 'Something on this page blocked the fill: ' + (e && e.message ? e.message : e) });
  }
  const summary = { filled: [], review: [], ai: [], frames: 0, at: Date.now(), learning: 0 };
  const reached = new Set();
  const tasks = [];
  const uploads = [];
  let embedded = [];
  for (const r of results) {
    const v = r && r.result;
    if (!v) continue;
    summary.frames++;
    reached.add(v.host);
    summary.filled.push(...v.filled);
    summary.review.push(...v.review);
    for (const t of v.ai || []) tasks.push(Object.assign({ frameId: r.frameId }, t));
    for (const f of v.files || []) uploads.push(Object.assign({ frameId: r.frameId }, f));
    summary.learning += v.learning || 0;
    if (v.top) embedded = v.iframes || [];
  }
  if (uploads.length) {
    progress(tabId, 'Attaching your resume…');
    const t = uploads.find((u) => u.required) || uploads[0];
    const a = await attachToTarget(tabId, t, profile, ai);
    if (a.ok) {
      summary.filled.unshift({ label: t.label, value: a.name });
      summary.attached = a;
    } else {
      summary.review.unshift({ label: t.label, reason: `${a.error} Attach it yourself.` });
      try { await inFrame(tabId, t.frameId, (id) => window.__appAutofill.fileNote(id), [t.id]); } catch (e) { /* frame gone */ }
    }
  }
  if (tasks.length) await draftAll(tabId, tasks, profile, ai, summary);
  if (ai.drafts && !ai.apiKey) summary.note = 'AI drafts are on, but no API key is set in Options.';

  const NOISE = /google|gstatic|youtube|doubleclick|facebook|captcha|stripe|intercom|hotjar|linkedin|twitter|vimeo|cookie|onetrust|segment/;
  const unreached = [...new Set(embedded)].filter((h) => !reached.has(h) && !NOISE.test(h));
  if (!summary.filled.length && !summary.review.length && !summary.ai.length && unreached.length) {
    summary.hint = `The form looks embedded from ${unreached[0]}, which this extension can't reach. Open the form in its own tab, or add that site to host_permissions in manifest.json.`;
  }
  if (trackP) {
    const t = await trackP;
    if (t && t.error) summary.trackError = t.error;
    const line = t && !t.error ? trackLine(t) : null;
    if (line) {
      summary.tracker = line;
      await tellPage(tabId, 0, line.text, line.tone);
    }
  }
  return save(tabId, summary);
}

async function save(tabId, summary) {
  const n = summary.filled ? summary.filled.length + (summary.ai ? summary.ai.length : 0) : 0;
  const m = summary.review ? summary.review.length : 0;
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: m ? '#b45309' : '#15803d' });
    await chrome.action.setBadgeText({ tabId, text: summary.error ? '!' : n ? String(n) : '' });
    await chrome.storage.session.set({ ['last:' + tabId]: summary });
  } catch (e) { /* tab may have closed */ }
  return summary;
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => { p.then(sendResponse, (e) => sendResponse({ error: e.message || String(e) })); return true; };
  if (!msg) return false;
  if (msg.type === 'fill') return reply(fillTab(msg.tabId));
  if (msg.type === 'last') return reply(chrome.storage.session.get('last:' + msg.tabId).then((o) => o['last:' + msg.tabId] || null));
  if (msg.type === 'match') return reply(matchForTab(msg.tabId, { fresh: msg.fresh }));
  if (msg.type === 'pasteJd') {
    return reply((async () => {
      const k = 'jdPaste:' + msg.tabId;
      if (msg.text && msg.text.trim()) await chrome.storage.session.set({ [k]: { url: 'pasted:' + msg.tabId, title: 'Pasted job description', text: msg.text.trim().slice(0, 30000), source: 'pasted' } });
      else await chrome.storage.session.remove(k);
      return matchForTab(msg.tabId);
    })());
  }
  if (msg.type === 'rankText') {
    return reply((async () => rankForJob({ url: 'hub-test', title: 'Pasted job description', text: msg.text || '' }, await loadAi()))());
  }
  if (msg.type === 'attach') return reply(attachFromPopup(msg.tabId, msg.name));
  if (msg.type === 'learn') {
    if (_sender.id !== chrome.runtime.id) return false;
    return reply(learnAnswers(msg.items));
  }
  if (msg.type === 'track') return reply(trackStatus(msg.tabId, { fresh: msg.fresh }));
  if (msg.type === 'logApplied') return reply(logApplied(msg.tabId, { company: msg.company, role: msg.role, status: msg.status }));
  if (msg.type === 'submitAttempt' && _sender.tab) return reply(onSubmitAttempt(_sender.tab.id, _sender.frameId, msg.url));
  if (msg.type === 'submitConfirmed' && _sender.tab) return reply(onSubmitConfirmed(_sender.tab.id, _sender.frameId));
  if (msg.type === 'airTest') {
    return reply((async () => {
      const air = await loadAir();
      if (!air.token) return { error: 'Paste a personal access token first.' };
      if (!air.baseId || !air.table) return { error: 'Add the base ID and table first.' };
      const rows = await airRows(air, true);
      const statuses = [...new Set(rows.map((r) => r.status).filter(Boolean))];
      return { ok: true, rows: rows.length, statuses, hasApplied: statuses.includes(air.statusApplied) };
    })());
  }
  if (msg.type === 'testKey') {
    return reply((async () => {
      const ai = await loadAi();
      const text = await AAFAI.callClaude(ai, { system: 'Reply with the single word OK.', user: 'Ping', maxTokens: 5 });
      return { ok: true, model: ai.model, text };
    })());
  }
  return false;
});

chrome.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'fill-form') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) fillTab(tab.id);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading') {
    // A submit that is waiting for its confirmation page keeps its saved row.
    chrome.storage.session.remove(['last:' + tabId, 'job:' + tabId, 'jdPaste:' + tabId, 'attached:' + tabId, 'logged:' + tabId, 'logErr:' + tabId]).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
  if (info.status === 'complete') checkAfterNavigation(tabId, (tab && tab.url) || '').catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(['pend:' + tabId, 'last:' + tabId, 'job:' + tabId, 'attached:' + tabId, 'logged:' + tabId, 'logErr:' + tabId]).catch(() => {});
});

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});
