// Claude API calls for AI mode. Your key is read from chrome.storage.local and sent
// only to api.anthropic.com, straight from the extension.
(function (root) {
  const ENDPOINT = 'https://api.anthropic.com/v1/messages';

  async function callClaude(ai, { system, user, maxTokens }, fetchImpl) {
    if (!ai || !ai.apiKey) throw new Error('Add your Anthropic API key in Options to use AI mode.');
    const r = await (fetchImpl || fetch)(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ai.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model: ai.model || 'claude-sonnet-5-5', max_tokens: maxTokens || 800, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = (j.error && j.error.message) || ''; } catch (e) { /* ignore */ }
      if (r.status === 401) throw new Error('Anthropic rejected the API key. Check it in Options.');
      if (r.status === 429) throw new Error('Rate limited by the Anthropic API. Try again in a minute.');
      throw new Error(`Anthropic API error ${r.status}${detail ? ': ' + detail : ''}`);
    }
    const j = await r.json();
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  }

  // Remove em dashes and trim to the field's limits without cutting mid-sentence.
  function cleanAnswer(text, lim) {
    let t = String(text || '').trim()
      .replace(/^```[a-z]*\n?|```$/g, '')
      .replace(/^(answer|response)\s*:\s*/i, '')
      .replace(/^["“](.*)["”]$/s, '$1')
      .replace(/\s*[—―]\s*/g, ', ')
      .replace(/\s+–\s+/g, ', ')
      .replace(/,\s*,/g, ',')
      .trim();
    lim = lim || {};
    if (lim.words) {
      const w = t.split(/\s+/);
      if (w.length > lim.words) t = cutAtSentence(w.slice(0, lim.words).join(' '));
    }
    if (lim.chars && t.length > lim.chars) t = cutAtSentence(t.slice(0, lim.chars));
    return t;
  }
  function cutAtSentence(t) {
    const m = t.match(/^[\s\S]*[.!?](?=\s|$)/);
    if (m && m[0].length >= t.length * 0.5) return m[0].trim();
    return t.replace(/\s+\S*$/, '').replace(/[,;:]$/, '').trim() + '.';
  }

  function profileFacts(p) {
    const v = (x) => String(x || '').trim();
    const grad = [v(p.gradMonth), v(p.gradYear)].filter(Boolean).join(' ');
    const links = [p.website, p.linkedin, p.github].filter((x) => v(x));
    return [
      v(p.firstName) || v(p.lastName) ? `Name: ${v(p.firstName)} ${v(p.lastName)}`.trim() : '',
      v(p.school) ? `School: ${v(p.school)}` : '',
      v(p.degreeText) || grad ? `Degree: ${[v(p.degreeText), grad ? `expected graduation ${grad}` : ''].filter(Boolean).join(', ')}` : '',
      v(p.currentTitle) ? `Current role: ${[v(p.currentTitle), v(p.currentCompany)].filter(Boolean).join(', ')}` : '',
      links.length ? `Links: ${links.join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }

  // Template lines the user hasn't filled in yet ("- [Your school...]") are dropped.
  const usableContext = (t) => String(t || '').split('\n').filter((l) => !/^\s*-?\s*\[[^\]]*\]\s*$/.test(l)).join('\n').trim();

  function draftSystem(p, job, resume) {
    const text = `You fill in written questions on a job application for the applicant described below. Reply with only the exact text to paste into the field: no preamble, no quotation marks, no markdown, no sign-off.

Rules:
- Write as the applicant, in first person, following the applicant's own writing instructions.
- Use only facts from the applicant context, profile and resume below. Never invent employers, projects, tools, metrics, dates or links.
- If the question needs a fact you do not have (salary expectations, specific dates, references, legal attestations, ID numbers, personal details not given), reply with exactly SKIP.
- Respect the length limit you are given. Never use em dashes.

<applicant_context>
${usableContext(p.aiContext)}
</applicant_context>

<profile>
${profileFacts(p)}
</profile>

<resume name="${resume ? resume.name : 'none'}">
${resume ? resume.text.slice(0, 12000) : 'No resume uploaded. Rely on the applicant context.'}
</resume>

<job url="${job ? job.url : ''}" title="${job ? (job.title || '').replace(/"/g, "'") : ''}">
${job ? job.text.slice(0, 16000) : 'Job description unavailable.'}
</job>`;
    return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
  }

  async function draftAnswer(ai, p, job, resume, task, fetchImpl) {
    const limit = [task.chars ? `at most ${task.chars} characters` : '', task.words ? `at most ${task.words} words` : ''].filter(Boolean).join(' and ');
    const user = `Question on the form: ${task.label}
Field type: ${task.kind}${task.kind === 'single line' ? ' (one sentence or a short phrase)' : ''}
Length limit: ${limit || 'none stated, follow the applicant instructions'}

Write the answer now.`;
    const maxTokens = task.chars ? Math.min(1500, Math.ceil(task.chars / 3) + 60) : task.words ? Math.min(1500, task.words * 2 + 60) : 700;
    const raw = await callClaude(ai, { system: draftSystem(p, job, resume), user, maxTokens }, fetchImpl);
    if (/^\s*SKIP\.?\s*$/i.test(raw)) return { skip: true };
    return { text: cleanAnswer(raw, task) };
  }

  // Re-rank the local shortlist with Claude. Returns [{ id, why }] best first, or null.
  async function rankWithClaude(ai, job, shortlist, fetchImpl) {
    const docs = shortlist.map((r, i) => `<resume id="r${i + 1}" name="${r.name.replace(/"/g, "'")}"${r.notes ? ` notes="${r.notes.replace(/"/g, "'")}"` : ''}>\n${r.text.slice(0, 6000)}\n</resume>`).join('\n\n');
    const n = Math.min(3, shortlist.length);
    const system = 'You help a job applicant pick which version of their resume to submit. Judge fit to the specific job: the stack, the domain, and what the team builds. Reply with JSON only.';
    const user = `<job title="${(job.title || '').replace(/"/g, "'")}">\n${job.text.slice(0, 14000)}\n</job>\n\n${docs}\n\nPick the best ${n} resumes for this job, best first. Reply with only this JSON: {"top":[{"id":"r1","why":"one short sentence on what makes it the best fit, no em dashes"}]}`;
    const raw = await callClaude(ai, { system, user, maxTokens: 400 }, fetchImpl);
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let j;
    try { j = JSON.parse(m[0]); } catch (e) { return null; }
    const out = [];
    for (const t of j.top || []) {
      const idx = parseInt(String(t.id || '').replace(/\D/g, ''), 10) - 1;
      const r = shortlist[idx];
      if (r && !out.some((o) => o.id === r.id)) out.push({ id: r.id, why: cleanAnswer(t.why || '') });
    }
    return out.length ? out : null;
  }

  root.AAFAI = { callClaude, cleanAnswer, draftAnswer, rankWithClaude };
})(typeof self !== 'undefined' ? self : this);
