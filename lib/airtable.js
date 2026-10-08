// Your Airtable application tracker: reads rows to warn about jobs you already
// track, and adds or updates the row when you apply. Talks only to
// api.airtable.com, with the personal access token you saved in Options.
(function (root) {
  const API = 'https://api.airtable.com/v0/';
  const KEYS = ['company', 'role', 'status', 'date', 'req', 'location', 'resume', 'notes', 'term'];
  const isFieldId = (f) => /^fld[A-Za-z0-9]{14}$/.test(String(f || ''));
  // Statuses that mean the application is already past "Applied". Auto-logging never
  // moves a row backwards from one of these.
  const LATER = /interview|assessment|\boa\b|offer|reject|declin|withdr|hired|closed/i;

  function ready(cfg) {
    return !!(cfg && cfg.token && cfg.baseId && cfg.table && cfg.fields && cfg.fields.company && cfg.fields.role);
  }

  function friendly(status, body) {
    const e = (body && body.error) || {};
    const msg = typeof e === 'string' ? e : (e.message || e.type || '');
    if (status === 401) return 'Airtable rejected the token. Check it in Options.';
    if (status === 403) return "The token can't use this base. Give it the data.records:read and data.records:write scopes and access to the base.";
    if (status === 404) return 'Airtable base or table not found. Check the IDs in Options.';
    if (status === 429) return 'Airtable is rate limiting requests. Try again in a few seconds.';
    if (status === 422) return `Airtable: ${msg || 'invalid request'}`;
    return `Airtable error ${status}${msg ? ': ' + msg : ''}`;
  }

  async function call(cfg, query, init, fetchImpl) {
    const url = API + encodeURIComponent(cfg.baseId) + '/' + encodeURIComponent(cfg.table) + (query || '');
    const r = await (fetchImpl || fetch)(url, Object.assign({}, init, {
      headers: { Authorization: 'Bearer ' + cfg.token, 'content-type': 'application/json' },
    }));
    let body = null;
    try { body = await r.json(); } catch (e) { body = null; }
    if (!r.ok) {
      const err = new Error(friendly(r.status, body));
      err.status = r.status;
      err.type = body && body.error && body.error.type;
      throw err;
    }
    return body;
  }

  const asText = (v) => (v == null ? '' : Array.isArray(v) ? v.map(asText).join(', ') : typeof v === 'object' ? (v.name || v.email || '') : String(v));

  // Every row, reduced to the mapped columns.
  async function listRows(cfg, fetchImpl) {
    const f = cfg.fields;
    const byId = isFieldId(f.company);
    const want = KEYS.map((k) => f[k]).filter(Boolean);
    const rows = [];
    let offset = '';
    for (let page = 0; page < 30; page++) {
      const q = new URLSearchParams();
      want.forEach((x) => q.append('fields[]', x));
      q.set('pageSize', '100');
      if (byId) q.set('returnFieldsByFieldId', 'true');
      if (offset) q.set('offset', offset);
      const j = await call(cfg, '?' + q.toString(), { method: 'GET' }, fetchImpl);
      for (const rec of j.records || []) {
        const o = { id: rec.id };
        for (const k of KEYS) if (f[k]) o[k] = asText((rec.fields || {})[f[k]]);
        rows.push(o);
      }
      if (!j.offset) break;
      offset = j.offset;
    }
    return rows;
  }

  // Rows that are this job (same posting id or URL), rows with the same company and
  // role, and other rows at the same company.
  function findMatches(rows, draft) {
    const N = root.AAFName;
    const id = String(draft.jobId || '').toLowerCase();
    const idRe = id.length >= 4 ? new RegExp('(^|[^a-z0-9])' + id.replace(/[^a-z0-9]/g, (c) => '\\' + c) + '($|[^a-z0-9])') : null;
    const reqKey = String(draft.req || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const urlKey = String(draft.url || '').split(/[?#]/)[0].replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
    const ck = N.coKey(draft.company), rk = N.roleKey(draft.role);
    const exact = [], likely = [], company = [];
    for (const r of rows || []) {
      const hay = `${r.req || ''} ${r.notes || ''}`.toLowerCase();
      const sameReq = reqKey && String(r.req || '').toLowerCase().replace(/\s+/g, ' ').trim() === reqKey;
      if (sameReq || (idRe && idRe.test(hay)) || (urlKey.length > 12 && hay.includes(urlKey))) { exact.push(r); continue; }
      const sameCo = ck && N.coKey(r.company) === ck;
      if (sameCo && rk && N.roleKey(r.role) === rk) likely.push(r);
      else if (sameCo) company.push(r);
    }
    return { exact, likely, company };
  }

  // The tracker's own spelling of a company, if any row matches loosely.
  function canonicalCompany(rows, guess, slug) {
    const N = root.AAFName;
    const keys = [N.coKey(guess), N.coKey(slug)].filter((k) => k.length >= 3);
    for (const r of rows || []) {
      const k = N.coKey(r.company);
      if (k && keys.some((x) => x === k)) return r.company;
    }
    return guess;
  }

  // Adds the job, or updates the row that already tracks it. `opts.status` is the
  // status to set; `opts.auto` protects rows that are already past "Applied".
  async function logApplication(cfg, draft, rows, opts, fetchImpl) {
    opts = opts || {};
    const f = cfg.fields;
    const status = opts.status || cfg.statusApplied || 'Applied';
    const applied = status === (cfg.statusApplied || 'Applied');
    const m = findMatches(rows, draft);
    const row = m.exact[0] || m.likely[0] || null;
    const date = draft.date || root.AAFName.today();
    const note = `Applied ${date} via ${draft.topUrl || draft.url} (Apply Autofill)`;
    const put = (o, k, v) => { if (f[k] && v != null && String(v).trim() !== '') o[f[k]] = v; };

    let fields = {}, recordId = null, action;
    if (row) {
      recordId = row.id;
      if (opts.auto && LATER.test(row.status || '')) {
        return { action: 'skipped', row, reason: `Already "${row.status}" in your tracker, so it was left as is.` };
      }
      if ((row.status || '') !== status) put(fields, 'status', status);
      if (applied && !row.date) put(fields, 'date', date);
      if (!row.req) put(fields, 'req', draft.req);
      if (!row.location) put(fields, 'location', draft.location);
      if (!row.resume) put(fields, 'resume', draft.resume);
      if (!row.term) put(fields, 'term', draft.term);
      const urlBare = String(draft.topUrl || draft.url || '').split(/[?#]/)[0];
      if (applied && f.notes && !(row.notes || '').includes(urlBare)) fields[f.notes] = (row.notes ? row.notes.replace(/\s+$/, '') + '\n' : '') + note;
      if (!Object.keys(fields).length) return { action: 'unchanged', row };
      action = 'updated';
    } else {
      put(fields, 'company', draft.company);
      put(fields, 'role', draft.role);
      put(fields, 'status', status);
      if (applied) put(fields, 'date', date);
      put(fields, 'req', draft.req);
      put(fields, 'location', draft.location);
      put(fields, 'resume', draft.resume);
      put(fields, 'term', draft.term);
      if (applied) put(fields, 'notes', note);
      action = 'created';
    }

    const send = (flds) => call(cfg, '', {
      method: recordId ? 'PATCH' : 'POST',
      body: JSON.stringify({ records: [recordId ? { id: recordId, fields: flds } : { fields: flds }] }),
    }, fetchImpl);
    let res;
    try {
      res = await send(fields);
    } catch (e) {
      // A season that isn't one of the Term column's options: save the row without it.
      if (e.status === 422 && f.term && fields[f.term] !== undefined) {
        delete fields[f.term];
        if (!Object.keys(fields).length) return { action: 'unchanged', row };
        res = await send(fields);
      } else throw e;
    }
    const rec = (res.records || [])[0] || {};
    const out = { id: rec.id || recordId };
    for (const k of KEYS) if (f[k]) out[k] = asText(fields[f[k]] !== undefined ? fields[f[k]] : row && row[k]);
    return { action, row: out, fields };
  }

  root.AAFAir = { ready, listRows, findMatches, canonicalCompany, logApplication, isFieldId, LATER, KEYS };
})(typeof self !== 'undefined' ? self : this);
