importScripts('defaults.js', 'lib/ranking.js', 'lib/jobsource.js', 'lib/ai.js');

const clip = (s, n = 90) => (s.length > n ? s.slice(0, n - 1).trim() + '…' : s);

async function loadProfile() {
  const { profile } = await chrome.storage.local.get('profile');
  return mergeProfile(profile);
}
async function loadAi() {
  const { ai } = await chrome.storage.local.get('ai');
  return mergeAi(ai);
}
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
  for (const pg of pages) {
    job = await AAFJob.fromApi(pg.url);
    if (job) break;
  }
  if (!job && pages.length) {
    pages.sort((a, b) => b.text.length - a.text.length);
    const top = pages.find((x) => x.top) || pages[0];
    const best = pages[0];
    job = { url: top.url, title: best.title || top.title, text: best.text, source: best.host };
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
  return { job: { url: job.url, title: job.title, source: job.source, chars: job.text.length, preview: job.text.slice(0, 1200) }, ranking };
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

async function fillTab(tabId) {
  const profile = await loadProfile();
  const ai = await loadAi();
  const { settings = {} } = await chrome.storage.local.get('settings');
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
      args: [profile, { overwrite: !!settings.overwrite, ai: useAi }],
    });
  } catch (e) {
    return save(tabId, { error: 'Something on this page blocked the fill: ' + (e && e.message ? e.message : e) });
  }
  const summary = { filled: [], review: [], ai: [], frames: 0, at: Date.now() };
  const reached = new Set();
  const tasks = [];
  let embedded = [];
  for (const r of results) {
    const v = r && r.result;
    if (!v) continue;
    summary.frames++;
    reached.add(v.host);
    summary.filled.push(...v.filled);
    summary.review.push(...v.review);
    for (const t of v.ai || []) tasks.push(Object.assign({ frameId: r.frameId }, t));
    if (v.top) embedded = v.iframes || [];
  }
  if (tasks.length) await draftAll(tabId, tasks, profile, ai, summary);
  if (ai.drafts && !ai.apiKey) summary.note = 'AI drafts are on, but no API key is set in Options.';

  const NOISE = /google|gstatic|youtube|doubleclick|facebook|captcha|stripe|intercom|hotjar|linkedin|twitter|vimeo|cookie|onetrust|segment/;
  const unreached = [...new Set(embedded)].filter((h) => !reached.has(h) && !NOISE.test(h));
  if (!summary.filled.length && !summary.review.length && !summary.ai.length && unreached.length) {
    summary.hint = `The form looks embedded from ${unreached[0]}, which this extension can't reach. Open the form in its own tab, or add that site to host_permissions in manifest.json.`;
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

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    chrome.storage.session.remove(['last:' + tabId, 'job:' + tabId, 'jdPaste:' + tabId]).catch(() => {});
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});
