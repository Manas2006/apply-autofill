// Finds the full job description for a posting. Application pages often hide or
// omit the description (Lever and Ashby put the form on a separate tab), so for the
// big ATS hosts we read the posting from their public job-board APIs instead.
(function (root) {
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: ', ', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', hellip: '...', bull: '-' };
  function decode(s) {
    return String(s || '')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
  }
  function stripHtml(html) {
    let s = decode(html); // Greenhouse double-encodes its HTML
    s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/li>/gi, '')
      .replace(/<(br|\/p|\/div|\/h[1-6]|\/ul|\/ol|\/tr|p|div|h[1-6]|ul|ol)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
    return decode(s).replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  // Returns { kind, apiUrl, pick(json) } for URLs on hosts with a public posting API.
  function apiFor(url) {
    let u;
    try { u = new URL(url); } catch (e) { return null; }
    const p = u.pathname.split('/').filter(Boolean);
    if (u.hostname === 'jobs.lever.co' && p.length >= 2) {
      return {
        kind: 'Lever', apiUrl: `https://api.lever.co/v0/postings/${p[0]}/${p[1]}`,
        pick: (j) => ({
          title: j.text || '',
          text: [j.descriptionPlain || stripHtml(j.description), ...(j.lists || []).map((l) => `${l.text}\n${stripHtml(l.content)}`), j.additionalPlain || stripHtml(j.additional)].filter(Boolean).join('\n\n'),
        }),
      };
    }
    if (/(^|\.)ashbyhq\.com$/.test(u.hostname) && u.hostname.startsWith('jobs.') && p.length >= 2) {
      const id = p[1];
      return {
        kind: 'Ashby', apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${p[0]}?includeCompensation=true`,
        pick: (j) => {
          const job = (j.jobs || []).find((x) => x.id === id) || null;
          return job ? { title: job.title || '', text: job.descriptionPlain || stripHtml(job.descriptionHtml) } : null;
        },
      };
    }
    if (/greenhouse\.io$/.test(u.hostname)) {
      let board = null, id = null;
      const i = p.indexOf('jobs');
      if (i > 0 && p[i + 1]) { board = p[i - 1]; id = p[i + 1]; }
      if (!board && u.searchParams.get('for') && u.searchParams.get('token')) { board = u.searchParams.get('for'); id = u.searchParams.get('token'); }
      if (board && /^\d+$/.test(id || '')) {
        return { kind: 'Greenhouse', apiUrl: `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`, pick: (j) => ({ title: j.title || '', text: stripHtml(j.content) }) };
      }
    }
    return null;
  }

  async function fromApi(url, fetchImpl) {
    const a = apiFor(url);
    if (!a) return null;
    try {
      const r = await (fetchImpl || fetch)(a.apiUrl, { headers: { accept: 'application/json' } });
      if (!r.ok) return null;
      const got = a.pick(await r.json());
      if (!got || !got.text || got.text.length < 200) return null;
      return { url, title: got.title, text: got.text.slice(0, 30000), source: `${a.kind} API` };
    } catch (e) { return null; }
  }

  root.AAFJob = { stripHtml, apiFor, fromApi };
})(typeof self !== 'undefined' ? self : this);
