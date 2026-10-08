// Names and identifiers derived from a job posting: the role, the company, a
// stable job id, the tracker "Req" text and the renamed resume file. Shared by
// the popup and the service worker.
(function (root) {
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

  const parse = (url) => { try { return new URL(url); } catch (e) { return null; } };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  // Which ATS a URL belongs to, the company's board slug there, and the posting id.
  function atsInfo(url) {
    const u = parse(url);
    if (!u) return { ats: '', slug: '', id: '', host: '' };
    const host = u.hostname.replace(/^www\./, '');
    const p = u.pathname.split('/').filter(Boolean);
    const q = (k) => u.searchParams.get(k) || '';
    let ats = '', slug = '', id = '';
    if (/greenhouse\.io$/.test(host)) {
      ats = 'Greenhouse';
      const i = p.indexOf('jobs');
      if (i > 0) { slug = p[i - 1]; id = p[i + 1] || ''; }
      if (!slug && q('for')) { slug = q('for'); id = q('token'); }
      if (slug === 'embed') slug = q('for');
    } else if (host === 'jobs.lever.co') {
      ats = 'Lever'; slug = p[0] || ''; id = UUID.test(p[1] || '') ? p[1] : '';
    } else if (/ashbyhq\.com$/.test(host)) {
      ats = 'Ashby'; slug = p[0] || ''; id = UUID.test(p[1] || '') ? p[1] : '';
    } else if (/myworkday(jobs)?\.com$/.test(host)) {
      ats = 'Workday'; slug = host.split('.')[0];
      const m = u.pathname.match(/_((?:JR|R|REQ)[-_]?\d{3,}(?:-\d+)?)\b/i);
      id = m ? m[1] : '';
    } else if (/smartrecruiters\.com$/.test(host)) {
      ats = 'SmartRecruiters'; slug = p[0] || ''; const m = u.pathname.match(/\/(\d{6,})/); id = m ? m[1] : '';
    } else if (/icims\.com$/.test(host)) {
      ats = 'iCIMS'; slug = host.split('.')[0].replace(/^careers-/, ''); const m = u.pathname.match(/\/jobs\/(\d+)/); id = m ? m[1] : '';
    } else if (/workable\.com$/.test(host)) {
      ats = 'Workable'; slug = p[0] || ''; const i = p.indexOf('j'); id = i >= 0 ? p[i + 1] || '' : '';
    } else if (/jobvite\.com$/.test(host)) {
      ats = 'Jobvite'; slug = p[0] || ''; const i = p.indexOf('job'); id = i >= 0 ? p[i + 1] || '' : '';
    } else if (host === 'ats.rippling.com') {
      ats = 'Rippling'; slug = p[0] || ''; id = UUID.test(p[2] || '') ? p[2] : (p[2] || '');
    }
    if (!id && q('gh_jid')) { id = q('gh_jid'); ats = ats || 'Greenhouse'; }
    if (!id) {
      for (const k of ['jobId', 'job_id', 'jid', 'reqId', 'req_id', 'requisitionId', 'postingId']) if (/^[\w-]{4,}$/.test(q(k))) { id = q(k); break; }
    }
    if (!id) {
      const seg = [...p].reverse().find((s) => /\d{5,}/.test(s) || UUID.test(s));
      if (seg) id = UUID.test(seg) ? seg : (seg.match(/\d{5,}/) || [''])[0];
    }
    if (!/^[\w-]{3,}$/.test(id)) id = '';
    return { ats, slug, id, host };
  }

  // "job-boards.greenhouse.io/affirm 8011590003", "jobs.lever.co/acme 3f1e…", "amazon.jobs 10565667"
  function reqFor(url) {
    const u = parse(url);
    if (!u) return '';
    const a = atsInfo(url);
    const board = a.slug && /^(Greenhouse|Lever|Ashby|SmartRecruiters|Workable|Jobvite|Rippling)$/.test(a.ats) ? `${a.host}/${a.slug}` : a.host;
    if (a.id) return `${board} ${a.id}`;
    return (u.host + u.pathname).replace(/\/$/, '');
  }

  const titleCase = (s) => String(s || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Ai|Ml|Io|Hq)\b/g, (w) => w.toUpperCase());

  // Loose key for comparing company names: "Affirm, Inc." and "affirm" are the same.
  const coKey = (s) => String(s || '').toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\b(inc|llc|ltd|limited|corp|corporation|co|company|the|technologies|technology|hq|group|holdings)\b\.?/g, ' ')
    .replace(/[^a-z0-9]/g, '');
  // Loose key for roles: drops the season, year and bracketed extras.
  const roleKey = (s) => String(s || '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(summer|fall|autumn|winter|spring)\b|\b20\d\d\b|\b\d{2}\b/g, ' ')
    .replace(/\binternship\b/g, 'intern')
    .replace(/[^a-z0-9]/g, '');

  const GENERIC_HOST = /^(careers?|jobs?|apply|boards?|job-boards|www|work|talent|recruiting|hire|join)$/;

  // Best guess at the employer's name from the posting's titles, API data and URL.
  function guessCompany({ url, topUrl, title, pageTitle, siteName, apiCompany } = {}) {
    for (const t of [pageTitle, title]) {
      const s = String(t || '').trim();
      const m = s.match(/^job application for .+? at (.+)$/i) || s.match(/\s(?:at|@)\s+(.+?)(?:\s+[|·–-]\s+.*)?$/i);
      const co = m ? m[1].replace(/[\s,.]+$/, '').trim() : '';
      if (co.length > 1 && !/^(the )?(company|us)$/i.test(co)) return co;
    }
    if (apiCompany && String(apiCompany).trim()) return String(apiCompany).trim();
    const lever = String(pageTitle || '').match(/^([^–|-]+?)\s+[-–]\s+.+$/);
    const a = atsInfo(url || topUrl || '');
    if (a.ats === 'Lever' && lever) return lever[1].trim();
    if (siteName && !/greenhouse|lever|ashby|workday|icims|smartrecruiters|jobvite|workable|rippling|linkedin|indeed/i.test(siteName)) return String(siteName).trim();
    if (a.slug && a.slug !== 'embed') return titleCase(a.slug);
    const t = atsInfo(topUrl || url || '');
    const labels = (t.host || '').split('.').filter((x) => !GENERIC_HOST.test(x));
    if (labels.length >= 2) return titleCase(labels[labels.length - 2]);
    return '';
  }

  // "Software Engineer Intern - Summer 2027" -> "Summer 2027". Empty when no season is named.
  function termFrom(...texts) {
    for (const t of texts) {
      const m = String(t || '').match(/\b(summer|fall|autumn|winter|spring)\s*(?:of\s*)?'?(20\d\d)\b/i);
      if (!m) continue;
      const season = m[1].toLowerCase() === 'autumn' ? 'fall' : m[1].toLowerCase();
      return `${season[0].toUpperCase()}${season.slice(1)} ${m[2]}`;
    }
    return '';
  }

  function today(d) {
    const x = d || new Date();
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  }

  // "Acme - Machine Learning Intern" or "Machine Learning Intern | Acme" -> "Machine Learning Intern"
  function stripCompany(role, company) {
    const r = String(role || '').trim();
    const c = String(company || '').trim();
    if (!c) return r;
    const e = c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const out = r.replace(new RegExp('^' + e + '\\s*[-–|:·]\\s*', 'i'), '').replace(new RegExp('\\s*[-–|:·]\\s*' + e + '$', 'i'), '').trim();
    return out || r;
  }
  function roleFor(job) {
    if (!job || job.source === 'pasted') return '';
    const co = guessCompany({ url: job.url, topUrl: job.topUrl, title: job.title, pageTitle: job.pageTitle, siteName: job.siteName, apiCompany: job.company });
    return stripCompany(cleanRole(job.title), co);
  }

  root.AAFName = { cleanRole, fileStem, atsInfo, reqFor, guessCompany, termFrom, coKey, roleKey, titleCase, today, stripCompany, roleFor };
})(typeof self !== 'undefined' ? self : this);
