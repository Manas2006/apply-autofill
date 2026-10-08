/*
 * Apply Autofill engine. Injected into every frame of the active tab when you
 * click Fill (or press the shortcut). It reads each form field's label, matches
 * it to an answer from your profile, and fills it. It never submits anything and
 * never clicks a button that could submit a form. The only file it ever attaches
 * is your own top-ranked resume, into a field labelled as a resume upload, and
 * only while "Attach my top resume" is on.
 */
(() => {
  const VERSION = 7;
  if (window.__appAutofill && window.__appAutofill.version === VERSION) return;

  const W = window;
  const D = document;
  const TOAST_ID = 'aaf-toast-host';
  const LEARN_ID = 'aaf-learn-host';

  // ---------- text helpers ----------
  const SKIP_TEXT_IN = new Set(['SELECT', 'OPTION', 'SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT']);

  function textOf(node) {
    if (!node) return '';
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) { out.push(n.nodeValue); return; }
      if (n.nodeType !== 1 || SKIP_TEXT_IN.has(n.tagName)) return;
      for (const c of n.childNodes) walk(c);
    };
    walk(node);
    return out.join(' ').replace(/[ \s]+/g, ' ').trim();
  }

  const norm = (s) => (s || '')
    .replace(/[ \s]+/g, ' ')
    .replace(/[*✱]/g, '')
    .replace(/\(required\)|\brequired\b/gi, '')
    .replace(/[’‘]/g, "'")
    .trim()
    .toLowerCase();

  const humanize = (s) => (s || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-\[\].]+/g, ' ')
    .trim();

  const clip = (s, n = 90) => (s.length > n ? s.slice(0, n - 1).trim() + '…' : s);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeout) {
    const end = Date.now() + timeout;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(60);
    }
  }

  // ---------- visibility / state ----------
  function visible(el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hidden || n.getAttribute('aria-hidden') === 'true') return false;
      const cs = W.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }

  function inOwnUi(el) { return !!el.closest('#' + TOAST_ID + ',#' + LEARN_ID); }

  const PLACEHOLDER = /^(select|choose|please (select|choose)|--|-|—|none selected|pick one|$)/;

  function selectIsEmpty(sel) {
    const o = sel.options[sel.selectedIndex];
    return !o || sel.value === '' || PLACEHOLDER.test(norm(o.text));
  }

  // A react-select style box shows its chosen value in a sibling element. Only look
  // inside this field's own container, never one shared with another dropdown.
  function comboHasValue(el) {
    let scope = el.parentElement;
    for (let i = 0; i < 4 && scope && scope !== D.body; i++, scope = scope.parentElement) {
      const others = [...scope.querySelectorAll('input[role="combobox"], input[aria-autocomplete]')].filter((x) => x !== el);
      if (others.length) break;
      const v = scope.querySelector('[class*="single-value" i],[class*="singleValue"],[class*="multi-value" i],[class*="selected-value" i]');
      if (v && textOf(v)) return true;
    }
    return !!(el.value && el.value.trim());
  }

  // ---------- labels ----------
  const LABELISH = 'legend, label, [class*="label" i], [class*="heading" i], [class*="question" i] > [class*="text" i], [class*="title" i], h2, h3, h4, h5, h6, p';
  const CONTROLS = 'input:not([type="hidden"]), select, textarea, button';

  // Walks up from a control looking for the question text that belongs to it.
  // Stops as soon as an ancestor also contains some other field, so a label from
  // a neighbouring question is never borrowed.
  function questionText(el, group) {
    const own = new Set(group || [el]);
    let a = el.parentElement;
    for (let i = 0; a && i < 8 && a.tagName !== 'FORM' && a !== D.body; i++, a = a.parentElement) {
      const others = [...a.querySelectorAll(CONTROLS)].filter((c) => !own.has(c) && ![...own].some((o) => o.contains(c) || c.contains(o)) && visible(c));
      if (others.length) return '';
      if (a.tagName === 'FIELDSET') {
        const lg = a.querySelector(':scope > legend');
        if (lg && textOf(lg)) return textOf(lg);
      }
      const lb = a.getAttribute('aria-labelledby');
      if (lb) {
        const t = lb.split(/\s+/).map((id) => textOf(D.getElementById(id))).join(' ').trim();
        if (t) return t;
      }
      const al = a.getAttribute('aria-label');
      if (al && /group|radiogroup/.test(a.getAttribute('role') || '')) return al;
      const cand = [...a.querySelectorAll(LABELISH)].find((c) =>
        ![...own].some((o) => c.contains(o)) && !c.querySelector(CONTROLS) && textOf(c));
      if (cand) return textOf(cand);
    }
    return '';
  }

  function labelFor(el, group) {
    const isChoice = el.type === 'radio' || el.type === 'checkbox' || el.tagName === 'BUTTON';
    const parts = [];
    const lb = el.getAttribute('aria-labelledby');
    if (lb && !isChoice) lb.split(/\s+/).forEach((id) => parts.push(textOf(D.getElementById(id))));
    if (!isChoice && el.labels && el.labels.length) [...el.labels].forEach((l) => parts.push(textOf(l)));
    const al = el.getAttribute('aria-label');
    if (al && !isChoice) parts.push(al);
    const has = () => parts.some((x) => x && x.trim());
    if (!has() && !isChoice) {
      const wrap = el.closest('label');
      if (wrap) parts.push(textOf(wrap));
    }
    if (!has()) parts.push(questionText(el, group));
    if (!has() && el.placeholder) parts.push(el.placeholder);
    if (!has() && !isChoice) parts.push(humanize(el.name || el.id || ''));
    // Keep each distinct piece once: "Discipline Discipline" becomes "Discipline".
    const uniq = [];
    for (const raw of parts) {
      const t = (raw || '').replace(/\s+/g, ' ').trim();
      const nt = norm(t);
      if (!nt || uniq.some((u) => norm(u).includes(nt))) continue;
      for (let i = uniq.length - 1; i >= 0; i--) if (nt.includes(norm(uniq[i]))) uniq.splice(i, 1);
      uniq.push(t);
    }
    return uniq.join(' ').trim();
  }

  function context(el) {
    const bits = [];
    let n = el;
    for (let i = 0; i < 12 && n && n !== D.body; i++, n = n.parentElement) {
      bits.push(n.id || '', typeof n.className === 'string' ? n.className : '', n.getAttribute('data-automation-id') || '', n.getAttribute('aria-label') || '');
    }
    return bits.join(' ').toLowerCase();
  }

  function isRequired(el, rawLabel) {
    return !!(el.required || el.getAttribute('aria-required') === 'true' || /[*✱]|\(required\)/i.test(rawLabel));
  }

  // ---------- rules: label text -> profile key ----------
  const R = (key, re, not, extra) => Object.assign({ key, re, not }, extra || {});
  const EDU = /educat|school|universit|degree|academic/;
  const RULES = [
    R('preferredName', /preferred (first )?name|nick ?name|name you (go|prefer) by|what (should|do) (we|people) call you/),
    R('firstName', /\bfirst[\s_-]*name\b|\bgiven name\b|\bfname\b|^first$/, /preferred|reference|emergency|referr|manager|recruiter/),
    R('lastName', /\blast[\s_-]*name\b|\bsurname\b|family name|\blname\b|^last$/, /reference|emergency|referr|manager|recruiter/),
    R('fullName', /\bfull name\b|\blegal name\b|^name$|^your name$|^(applicant|candidate) name$|^name \(first and last\)$/, /company|school|universit|employer|reference|referr|emergency|manager|recruiter|user ?name|file|project|team|pronunc|signature/),
    R('email', /e-?mail/, /reference|referr|manager|recruiter|emergency|subscribe|marketing|newsletter|opt in/),
    R('phone', /phone|mobile|\bcell\b|telephone/, /type|extension|\bext\b|country code|reference|emergency|referr|device/),
    R('linkedin', /linked ?in/),
    R('github', /git ?hub/),
    R('scholar', /google scholar|scholar profile/),
    R('website', /website|portfolio|personal (site|url|page|link)|\bblog\b|other (url|link|website)|^url$|^links?$/, /linkedin|github|company('s)? website|twitter/),
    R('over18', /(18|eighteen) years|at least 18|over (the age of )?18|age of 18|legal age|legal working age/),
    R('sponsorship', /sponsor/),
    R('workAuth', /authori[sz]ed to work|work authori[sz]ation|eligible to work|legally (able|permitted|eligible|allowed) to work|right to work|employment eligibility|authori[sz]ation to work/),
    R('relocate', /relocat/),
    R('howHeard', /how did you (hear|find|learn|come across)|where did you (hear|find|learn|see)|how .{0,20}(hear|learn) about|^source$|referral source|how were you referred/),
    R('pronouns', /pronoun/),
    R('hispanic', /hispanic|latin[oax]/),
    R('race', /\brace\b|ethnicity|racial/),
    R('gender', /\bgender\b|^sex$|\bsex\b/, /orientation|transgender/),
    R('veteran', /veteran|armed forces|military service/),
    R('disability', /disabilit/),
    R('consent', /privacy (statement|policy|notice)|code of conduct|terms (and|&) conditions|terms of (use|service)|data (processing|protection|privacy)|candidate privacy|applicant privacy|privacy consent/, /\bsms\b|text messag|marketing|newsletter|talent (community|network|pool)|future (roles|opportunit|positions|openings)|whatsapp|record/),
    R('hsGrad', /high school.*(graduat|year|class of|complet|finish|diploma)|(graduat|year|class of|complet|finish|diploma).*high school/, /gpa|name|city|state|country/),
    R('testType', /(standardized )?test (score )?type|which (standardized )?test|type of (standardized )?test|\bsat or act\b|\bact or sat\b/),
    R('sat', /\bsat\b/),
    R('act', /\bact\b.*(score|result|composite)|(score|result|composite).*\bact\b/),
    R('gpa', /\bgpa\b|grade point|cumulative grade/, /high school/),
    R('major', /\bmajor\b|discipline|field of study|area of study|concentration|program of study|course of study|specialization/, /minor/),
    R('degree', /^degree\b|degree (type|level|pursuing|program|name|sought)|highest (level of )?(education|degree)|education(al)? level|level of (study|education)|type of degree|what degree|current degree|degree you are (pursuing|earning)/, /date|year|month|graduat|gpa|major|field|discipline/),
    R('eduStart', /\bstart\b|^from\b|began|enroll/, /available|availability|can you start|earliest|start working/, { ctx: EDU }),
    R('gradDate', /graduat|completion date|expected (end|finish|completion)|class of|degree (completion|end)|date (completed|received|conferred)/, /high school|graduate (school|student|degree|program|level|studies)|recent graduate|new graduate|post-?graduat/),
    R('gradDate', /\bend\b|^to\b|finish|ended|completed/, /available|availability/, { ctx: EDU }),
    R('school', /school|universit|college|institution|alma mater/, /high school|degree|gpa|major|year|date|graduat|discipline|field|program|city|state|country|e-?mail|location/),
    R('location', /^(current )?location\b|where are you (currently )?(located|based)|current(ly)? (located|based)|^city,? state|location \(city\)|^based in/, /relocat|prefer|office|willing|work location|which location|desired/),
    R('address', /street address|address line 1|^address( 1| line)?$|mailing address|home address|^street$/, /e-?mail|web|ip address|line 2/),
    R('city', /^city\b|\bcity$|city of residence|current city/, /ethnic/),
    R('state', /^state\b|^state\/province|^province|state of residence|^region$/, /united states|statement|state why/),
    R('zip', /\bzip\b|postal code|postcode/),
    R('country', /^country\b|country of residence|current country|^country\/region|\bcountry$/, /citizen|authori|code|sponsor/),
    R('currentTitle', /current (job )?(title|role|position)|^(job )?title$|^position$|^role$/, /desired|applying|interest/),
    R('currentCompany', /current (company|employer|organization)|^company( name)?$|^employer$|^organization$|most recent (company|employer)/, /previous|why|referr|heard|website/),
  ];

  function matchRule(label, el) {
    let ctx = null;
    for (const r of RULES) {
      if (!r.re.test(label) || (r.not && r.not.test(label))) continue;
      if (r.ctx) {
        if (ctx === null) ctx = label + ' ' + context(el);
        if (!r.ctx.test(ctx)) continue;
      }
      return r.key;
    }
    return null;
  }

  // ---------- values ----------
  const STATES = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming' };
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const LAST_DAY = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const DECLINE = /decline|prefer not|don'?t wish|do not wish|not wish to|choose not|rather not|not to (say|answer|disclose|identify|self.?identify)|no answer|i don'?t want/;
  const SETTING_KEYS = new Set(['workAuth', 'sponsorship', 'relocate', 'over18', 'howHeard', 'pronouns', 'gender', 'race', 'hispanic', 'veteran', 'disability']);
  const NICE = { workAuth: 'work authorization', sponsorship: 'sponsorship', relocate: 'relocation', over18: '18+', howHeard: 'how you heard', pronouns: 'pronouns', gender: 'gender', race: 'race/ethnicity', hispanic: 'Hispanic/Latino', veteran: 'veteran status', disability: 'disability status', degree: 'degree level', address: 'street address', zip: 'ZIP code', hsGrad: 'high school graduation year', testType: 'test type', sat: 'SAT score', act: 'ACT score', gpa: 'GPA' };

  // Range-style dropdown options: "3.5 - 3.7", "1401 - 1500", "1400+", "Below 3.0",
  // "January 2028 - July 2028", "Spring 2028", "Before May 2027".
  const NONE_OPT = /don'?t have|do not have|have not taken|haven'?t taken|did not take|didn'?t take|not taken|^n\/?a\b|^none\b|not applicable|no (act|sat|test)? ?scores?\b|i did not/;
  const AGREE_OPT = /^(i )?(agree|accept|acknowledge|consent)\b|^yes\b|have read and (agree|accept)/;
  const NO_AGREE = /\b(not|don'?t|disagree|decline|do not)\b/;
  function numRange(t) {
    const s = norm(t).replace(/,/g, '');
    let m;
    if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|to|through)\s*(\d+(?:\.\d+)?)/))) return [+m[1], +m[2]];
    if ((m = s.match(/(\d+(?:\.\d+)?)\s*(?:\+|or (?:above|higher|more|greater))/))) return [+m[1], Infinity];
    if ((m = s.match(/(?:above|over|greater than|more than|at least|>=?)\s*(\d+(?:\.\d+)?)/))) return [+m[1], Infinity];
    if ((m = s.match(/(?:below|under|less than|<=?)\s*(\d+(?:\.\d+)?)/))) return [-Infinity, +m[1]];
    if ((m = s.match(/^(\d+(?:\.\d+)?)$/))) return [+m[1], +m[1]];
    return null;
  }
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const SEASON = { spring: [0, 4], summer: [5, 7], fall: [8, 11], autumn: [8, 11], winter: [0, 2] };
  function dateRange(t) {
    const s = norm(t);
    const pts = [];
    const re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?\s*(\d{4})\b|\b(\d{1,2})\/(\d{4})\b|\b(spring|summer|fall|autumn|winter)\s*(\d{4})\b|\b((?:19|20)\d{2})\b/g;
    let m;
    while ((m = re.exec(s))) {
      if (m[1]) { const v = +m[2] * 12 + MON[m[1]]; pts.push([v, v]); }
      else if (m[3]) { const v = +m[4] * 12 + (+m[3] - 1); pts.push([v, v]); }
      else if (m[5]) { const se = SEASON[m[5]]; pts.push([+m[6] * 12 + se[0], +m[6] * 12 + se[1]]); }
      else { pts.push([+m[7] * 12, +m[7] * 12 + 11]); }
    }
    if (!pts.length) return null;
    if (/\b(before|prior to|earlier than|by)\b/.test(s)) return [-Infinity, pts[0][0] - 1];
    if (/\b(after|later than)\b/.test(s)) return [pts[0][1] + 1, Infinity];
    return [pts[0][0], pts[pts.length - 1][1]];
  }
  function bestRange(O, want, parse) {
    let best = null, width = Infinity;
    for (const o of O) {
      const r = parse(o.n);
      if (!r || r[0] > want[0] || want[1] > r[1]) continue;
      const w = r[1] - r[0];
      if (w < width) { best = o; width = w; }
    }
    return best;
  }

  function dateValue(month, year, el, label) {
    const d = dateValue0(month, year, el, label);
    const y = parseInt(year, 10), mi = MONTHS.indexOf(month);
    if (y && mi >= 0) d.ym = [y * 12 + mi, y * 12 + mi];
    return d;
  }
  function dateValue0(month, year, el, label) {
    const mi = Math.max(0, MONTHS.indexOf(month));
    const mm = String(mi + 1).padStart(2, '0');
    const dd = String(LAST_DAY[mi]).padStart(2, '0');
    const season = mi <= 5 ? 'Spring' : mi <= 7 ? 'Summer' : 'Fall';
    const t = (el.type || '').toLowerCase();
    const ph = norm(el.placeholder || '');
    const hasMonth = /month/.test(label), hasYear = /year/.test(label) && !/class of/.test(label);
    if (hasMonth && !hasYear) return { text: month, choices: [month, month.slice(0, 3), mm, String(mi + 1)] };
    if (hasYear && !hasMonth) return { text: year, choices: [year] };
    if (t === 'month') return { text: `${year}-${mm}` };
    if (t === 'date') return { text: `${year}-${mm}-${dd}` };
    if (/class of/.test(label)) return { text: year, choices: [year] };
    if (/mm\s*\/\s*dd/.test(ph)) return { text: `${mm}/${dd}/${year}` };
    if (/mm\s*\/\s*yy/.test(ph)) return { text: `${mm}/${year}` };
    if (/^yyyy$/.test(ph)) return { text: year };
    return { text: `${month} ${year}`, choices: [`${month} ${year}`, `${month.slice(0, 3)} ${year}`, `${mm}/${year}`, `${season} ${year}`, year] };
  }

  function phoneFor(el, phone) {
    const digits = (phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (!digits) return '';
    const pat = el.getAttribute('pattern') || '';
    if (el.maxLength === 10 || /^\\d|\[0-9\]\{10\}|\\d\{10\}/.test(pat)) return digits;
    return phone;
  }

  const isChoiceEl = (el) => el.tagName === 'SELECT' || el.type === 'radio' || el.type === 'checkbox' || el.tagName === 'BUTTON' || isCombo(el);
  function isCombo(el) {
    return el.tagName === 'INPUT' && (el.getAttribute('role') === 'combobox' || /list|both/.test(el.getAttribute('aria-autocomplete') || '') || /select__input|select2-search/.test(el.className || ''));
  }

  function settingChoices(v) {
    if (DECLINE.test(norm(v))) return [v, 'Decline to self-identify', "I don't wish to answer", 'Prefer not to say'];
    return [v];
  }

  // Returns { key, text, choices } or { key, missing: true } or null (no rule matched).
  function resolve(p, label, el) {
    const n = norm(label);
    if (!n) return null;
    for (const c of p.custom || []) {
      if (!c || !c.q || !c.a) continue;
      const q = c.q.trim();
      let hit = false;
      if (q.length > 2 && q.startsWith('/') && q.endsWith('/')) {
        try { hit = new RegExp(q.slice(1, -1), 'i').test(n); } catch (e) { hit = false; }
      } else {
        hit = n.includes(norm(q));
      }
      if (hit) return { key: 'custom', text: c.a, choices: [c.a] };
    }
    const key = matchRule(n, el);
    if (!key) return null;
    const v = (x) => (x == null ? '' : String(x).trim());
    const out = (text, choices) => (v(text) ? { key, text: v(text), choices: (choices || [text]).filter(Boolean) } : { key, missing: true });
    const stateFull = STATES[v(p.state).toUpperCase()] || v(p.state);
    const stateAbbr = Object.keys(STATES).find((k) => STATES[k].toLowerCase() === stateFull.toLowerCase()) || v(p.state);
    switch (key) {
      case 'firstName': return out(p.firstName);
      case 'lastName': return out(p.lastName);
      case 'preferredName': return out(p.preferredName || p.firstName);
      case 'fullName': return out(`${v(p.firstName)} ${v(p.lastName)}`.trim());
      case 'email': return out(p.email);
      case 'phone': return out(phoneFor(el, p.phone));
      case 'linkedin': return out(p.linkedin);
      case 'github': return out(p.github);
      case 'scholar': return out(p.scholar);
      case 'website': return out(p.website);
      case 'address': return out(p.address);
      case 'city': return out(p.city);
      case 'state': return out(isChoiceEl(el) ? stateFull : (el.maxLength === 2 ? stateAbbr : stateFull), [stateFull, stateAbbr]);
      case 'zip': return out(p.zip);
      case 'country': return out(p.country, [p.country, 'United States', 'United States of America', 'USA', 'US']);
      case 'location': return out(`${v(p.city)}, ${stateAbbr}`, [`${v(p.city)}, ${stateFull}, ${v(p.country)}`, `${v(p.city)}, ${stateFull}`, `${v(p.city)}, ${stateAbbr}`, v(p.city)]);
      case 'school': {
        // Split "University of X at Campus" into the system name and the campus,
        // so search boxes get queries that also surface "University of X - Campus".
        const s = v(p.school).replace(/^the\s+/i, '');
        const m = s.match(/^(.*?)(?:\s+at\s+|\s*[‐-―−-]\s*|\s*,\s*)([^,]+)$/i);
        const base = m ? m[1].trim() : s, campus = m ? m[2].trim() : '';
        const choices = [p.school, 'The ' + s, s];
        if (campus) choices.push(`${base} - ${campus}`, `${base}-${campus}`, `${base}, ${campus}`, `${base} at ${campus}`);
        if (/^university of texas$/i.test(base) && /^austin$/i.test(campus)) choices.push('UT Austin', 'UT-Austin');
        const r = out(p.school, choices);
        r.search = campus ? [base, campus, s] : [s];
        return r;
      }
      case 'degree':
        if (isChoiceEl(el)) {
          if (!v(p.degreeLevel)) return { key, missing: true };
          const m = /master/i.test(p.degreeLevel);
          return out(p.degreeLevel, m ? [p.degreeLevel, "Master's Degree", "Master's", 'Masters', 'Master of Science', 'MS', 'M.S.'] : [p.degreeLevel, "Bachelor's Degree", "Bachelor's", 'Bachelors', 'Bachelor of Science', 'BS', 'B.S.']);
        }
        return out(p.degreeText);
      case 'major': {
        const mj = v(p.major);
        const choices = [mj, mj.replace(/ and /i, ' & ')];
        const search = [mj];
        const mm = mj.match(/^(.+?) (?:and|&) (.+?) (engineering|science|sciences|studies)$/i);
        if (mm) {
          const a = `${mm[1]} ${mm[3]}`, b = `${mm[2]} ${mm[3]}`;
          choices.push(b, a);
          search.push(b, a);
          if (/^electrical$/i.test(mm[1])) { choices.push(`Electrical and Electronics ${mm[3]}`, `Electrical & Electronics ${mm[3]}`); search.push('Electrical'); }
        }
        const r = out(mj, choices);
        if (!r.missing) r.search = search;
        return r;
      }
      case 'gpa': {
        const r = out(p.gpa);
        if (!r.missing && /^\d+(\.\d+)?$/.test(r.text)) r.hint = { range: [+r.text, +r.text] };
        return r;
      }
      case 'eduStart': case 'gradDate': {
        const d = key === 'eduStart' ? dateValue(v(p.eduStartMonth), v(p.eduStartYear), el, n) : dateValue(v(p.gradMonth), v(p.gradYear), el, n);
        const r = out(d.text, d.choices);
        if (!r.missing && d.ym) r.hint = { ym: d.ym };
        return r;
      }
      case 'hsGrad': {
        const y = v(p.hsGradYear);
        if (!y) return { key, missing: true };
        const t = (el.type || '').toLowerCase();
        if (t === 'date' || t === 'month' || (/month/.test(n) && !/year/.test(n))) return null;
        return { key, text: y, choices: [y, 'Class of ' + y], hint: /^\d{4}$/.test(y) ? { ym: [+y * 12, +y * 12 + 11] } : undefined };
      }
      case 'testType': {
        const t = v(p.testType);
        if (!t) return { key, missing: true };
        if (/^none|^n\/?a/i.test(t)) return { key, text: t, choices: ['None', 'N/A', "I haven't taken either"], hint: { none: true } };
        if (/both/i.test(t)) return { key, text: t, choices: ['Both', 'SAT and ACT', 'SAT & ACT', 'ACT and SAT'] };
        return { key, text: t, choices: [t, `${t} only`, `${t} score`] };
      }
      case 'sat': case 'act': {
        const sv = v(p[key]);
        if (!sv) return { key, missing: true };
        if (/^(none|n\/?a|no|not taken|didn'?t take|did not take)$/i.test(sv)) {
          if (!isChoiceEl(el)) return { key, text: 'N/A', choices: ['N/A'] };
          return { key, text: sv, choices: [`I don't have ${key.toUpperCase()} score`, 'None', 'N/A'], hint: { none: true } };
        }
        const m = sv.match(/^(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)$/);
        if (m) {
          if (!isChoiceEl(el)) return { key, missing: true, reason: `Type your exact ${key.toUpperCase()} score (Options only has a range)` };
          return { key, text: sv, choices: [sv, `${m[1]} - ${m[2]}`, `${m[1]}-${m[2]}`], hint: { range: [+m[1], +m[2]] } };
        }
        return /^\d+(\.\d+)?$/.test(sv) ? { key, text: sv, choices: [sv], hint: { range: [+sv, +sv] } } : { key, text: sv, choices: [sv] };
      }
      case 'consent':
        // Only when "Agree to privacy statements and codes of conduct" is Yes in Options.
        if (!/^y/i.test(v(p.autoAgree))) return null;
        return { key, text: 'I agree', choices: ['I agree', 'I Agree', 'Agree', 'I accept', 'Accept', 'I acknowledge', 'Acknowledged', 'Yes'], hint: { agree: true } };
      case 'gender': {
        const g = v(p.gender);
        if (!g) return { key, missing: true };
        if (/^male$|^man$/i.test(g)) return { key, text: g, choices: [g, 'Male', 'Man', 'Cisgender Male', 'Cisgender Man'] };
        if (/^female$|^woman$/i.test(g)) return { key, text: g, choices: [g, 'Female', 'Woman', 'Cisgender Female', 'Cisgender Woman'] };
        return { key, text: g, choices: settingChoices(g) };
      }
      case 'currentCompany': return out(p.currentCompany);
      case 'currentTitle': return out(p.currentTitle);
      case 'pronouns': {
        // "He/him/his" also matches "He/Him", "he / him / his" and "He/Him/His/Himself".
        const val = v(p.pronouns);
        if (!val) return { key, missing: true };
        if (DECLINE.test(norm(val))) return { key, text: val, choices: settingChoices(val) };
        const parts = val.split(/\s*\/\s*/).filter(Boolean);
        const cap = (x) => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase();
        const two = parts.slice(0, 2);
        return { key, text: val, choices: [val, parts.join('/'), two.join('/'), parts.map(cap).join('/'), two.map(cap).join('/'), parts.join(' / '), two.join(' / ')] };
      }
      default:
        if (SETTING_KEYS.has(key)) return v(p[key]) ? { key, text: v(p[key]), choices: settingChoices(v(p[key])) } : { key, missing: true };
        return null;
    }
  }

  // ---------- option matching ----------
  // "University of X - Campus", "The University of X at Campus",
  // "University of X–Campus" and "University of X, Campus" all reduce to
  // "university of x campus", so any of them matches any other.
  const canon = (s) => norm(s)
    .replace(/\s*\/\s*/g, '/')
    .replace(/[‐-―−-]/g, ' ')
    .replace(/[,()]/g, ' ')
    .replace(/\bat\b/g, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasWord = (hay, needle) => new RegExp('(^|[^a-z0-9])' + escRe(needle) + '($|[^a-z0-9])').test(hay);

  function pickOption(opts, cands, hint) {
    hint = hint || {};
    const O = opts.map((o) => Object.assign({}, o, { n: norm(o.text) })).filter((o) => o.n && !PLACEHOLDER.test(o.n));
    const C = cands.map(norm).filter(Boolean);
    for (const c of C) { const h = O.find((o) => o.n === c); if (h) return h; }
    for (const c of C.map(canon)) { if (!c) continue; const h = O.find((o) => canon(o.n) === c); if (h) return h; }
    if (hint.none) return O.find((o) => NONE_OPT.test(o.n)) || null;
    if (hint.agree) { const h = O.find((o) => AGREE_OPT.test(o.n) && !NO_AGREE.test(o.n)); if (h) return h; }
    if (hint.range) return bestRange(O, hint.range, numRange);
    if (hint.ym) return bestRange(O, hint.ym, dateRange);
    for (const c of C) {
      if (c === 'yes' || c === 'no') { const h = O.find((o) => new RegExp('^' + c + '\\b').test(o.n)); if (h) return h; continue; }
      if (DECLINE.test(c)) { const h = O.find((o) => DECLINE.test(o.n)); if (h) return h; continue; }
      // Whole-word matches only, so "Male" can never pick "Female".
      const h = O.find((o) => hasWord(o.n, c) || (o.n.length >= 4 && hasWord(c, o.n)));
      if (h) return h;
    }
    return null;
  }

  // ---------- DOM writes ----------
  function fire(el, type, Ctor, init) {
    const C = Ctor || W.Event;
    el.dispatchEvent(new C(type, Object.assign({ bubbles: true, cancelable: true }, init || {})));
  }
  function setNative(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? W.HTMLSelectElement.prototype : W.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    fire(el, 'input', W.InputEvent || W.Event);
    fire(el, 'change');
  }
  function blur(el) {
    el.dispatchEvent(new (W.FocusEvent || W.Event)('blur', { bubbles: false }));
    el.dispatchEvent(new (W.FocusEvent || W.Event)('focusout', { bubbles: true }));
  }
  function clickLikeUser(el) {
    const P = typeof W.PointerEvent === 'function' ? W.PointerEvent : W.MouseEvent;
    fire(el, 'pointerdown', P); fire(el, 'mousedown', W.MouseEvent);
    fire(el, 'pointerup', P); fire(el, 'mouseup', W.MouseEvent);
    el.click();
  }
  function key(el, k) { fire(el, 'keydown', W.KeyboardEvent, { key: k }); fire(el, 'keyup', W.KeyboardEvent, { key: k }); }

  // A button is only ever clicked if clicking it cannot submit a form.
  const safeButton = (b) => b.getAttribute('type') === 'button' || !b.form;

  const MARK_STYLE = { filled: '2px solid #16a34a', review: '2px solid #f59e0b', ai: '2px solid #7c3aed', pending: '2px dashed #7c3aed' };
  function mark(el, state) {
    const t = el && el.nodeType === 1 ? el : null;
    if (!t) return;
    const st = state === true ? 'filled' : state === false ? 'review' : state;
    if (!t.hasAttribute('data-aaf')) t.setAttribute('data-aaf-prev', t.style.outline || '');
    t.setAttribute('data-aaf', st);
    t.style.outline = MARK_STYLE[st];
    t.style.outlineOffset = '1px';
  }
  function clearMarks() {
    D.querySelectorAll('[data-aaf]').forEach((el) => {
      el.style.outline = el.getAttribute('data-aaf-prev') || '';
      el.style.outlineOffset = '';
      el.removeAttribute('data-aaf'); el.removeAttribute('data-aaf-prev');
    });
    D.querySelectorAll('[data-aaf-ai]').forEach((el) => el.removeAttribute('data-aaf-ai'));
  }

  // ---------- AI drafting targets ----------
  // Written questions no rule can answer. Short single-line fields only qualify when
  // they read like a question, and never when they ask for a fact (pay, dates, IDs).
  const NOT_FOR_AI = /salary|compensation|\bpay\b|hourly|\brate\b|\bdate\b|\bwhen\b|start|notice period|phone|\bzip\b|postal|number|\bid\b|social security|\bssn\b|address|e-?mail|\bname\b|\burl\b|\blink|website|gpa|score|\byear|referr|reference|signature|initials|password|user ?name|twitter|handle|pronoun|gender|race|veteran|disabilit/;
  function aiEligible(el, raw) {
    const n = norm(raw);
    if (!n || n.length < 6) return false;
    if (el.tagName === 'TEXTAREA') return !/signature|initials/.test(n) && !(NOT_FOR_AI.test(n) && n.length < 45);
    if (el.tagName !== 'INPUT' || !/^(text|search|)$/.test((el.getAttribute('type') || '').toLowerCase())) return false;
    if (NOT_FOR_AI.test(n)) return false;
    return /\?$|\b(why|describe|tell us|explain|what|how|share|briefly|summar|interest|excite|motivat)/.test(n);
  }
  function limitsFor(el, raw) {
    const n = norm(raw);
    const num = (x) => +String(x).replace(/,/g, '');
    let chars = el.maxLength > 0 && el.maxLength < 100000 ? el.maxLength : 0;
    const mc = n.match(/(\d[\d,]*)\s*(?:characters|character|chars)\b/);
    if (mc) chars = chars ? Math.min(chars, num(mc[1])) : num(mc[1]);
    const mw = n.match(/(\d[\d,]*)\s*words?\b/);
    return { chars, words: mw ? num(mw[1]) : 0 };
  }
  let aiSeq = 0;

  function getOptions(el) {
    const ids = [el.getAttribute('aria-controls'), el.getAttribute('aria-owns')].filter(Boolean).join(' ').split(/\s+/).filter(Boolean);
    let nodes = [];
    for (const id of ids) { const box = D.getElementById(id); if (box) nodes.push(...box.querySelectorAll('[role="option"]')); }
    if (!nodes.length) nodes = [...D.querySelectorAll('[role="option"]')];
    return nodes.filter((o) => o.getAttribute('aria-disabled') !== 'true' && visible(o)).map((o) => ({ text: textOf(o), el: o }));
  }

  async function fillCombobox(el, choices, search, hint) {
    el.focus();
    const control = el.closest('[class*="control" i]') || el.parentElement;
    if (control) { fire(control, 'mousedown', W.MouseEvent); }
    key(el, 'ArrowDown');
    let hit = await waitFor(() => { const o = getOptions(el); return o.length ? pickOption(o, choices, hint) || null : null; }, 400);
    if (!hit) {
      for (const c of (search && search.length ? search : choices.slice(0, 2)).slice(0, 3)) {
        setNative(el, c);
        hit = await waitFor(() => { const o = getOptions(el); return o.length ? pickOption(o, choices, hint) : null; }, 1600);
        if (hit) break;
      }
    }
    if (hit) { clickLikeUser(hit.el); await sleep(80); blur(el); return hit.text; }
    setNative(el, ''); key(el, 'Escape'); blur(el);
    return null;
  }

  const missingWhy = (r) => r.reason || `Set ${NICE[r.key] || r.key} once in Options`;

  // ---------- file uploads ----------
  const RESUME_RE = /resum|résumé|\bcv\b|curriculum vitae/;
  const COVER_RE = /cover ?letter|motivation letter|letter of motivation/;
  const OTHER_DOC = /transcript|portfolio|writing sample|work sample|photo|headshot|passport|driver|certificat|recommendation|reference letter|\bid\b|other (file|document|attachment)s?|additional (file|document|attachment)s?/;
  const HAS_FILE = /[\w)\]-]\.(pdf|docx?|rtf|txt|odt|pages)\b/i;
  let fileSeq = 0;

  // The block around one upload field, never wide enough to include another one.
  function fileScope(el) {
    let scope = el.parentElement || el;
    for (let a = el.parentElement, i = 0; a && i < 6 && a !== D.body && a.tagName !== 'FORM'; i++, a = a.parentElement) {
      if ([...a.querySelectorAll('input[type="file"]')].some((x) => x !== el)) break;
      if (textOf(a).length > 600) break;
      scope = a;
    }
    return scope;
  }
  function visibleBox(el) {
    let b = el;
    while (b && b !== D.body && !visible(b)) b = b.parentElement;
    return b || el;
  }
  function classifyFiles(els) {
    const out = els.map((el) => {
      const scope = fileScope(el);
      const label = labelFor(el);
      const meta = norm([label, el.id, el.name, el.getAttribute('aria-label') || '', el.getAttribute('data-automation-id') || '', el.getAttribute('data-testid') || ''].join(' ')).replace(/[_-]+/g, ' ');
      const near = norm(textOf(scope)).slice(0, 600);
      let kind = 'unknown';
      if (COVER_RE.test(meta)) kind = 'cover';
      else if (RESUME_RE.test(meta)) kind = 'resume';
      else if (COVER_RE.test(near) && !RESUME_RE.test(near)) kind = 'cover';
      else if (RESUME_RE.test(near)) kind = 'resume';
      else if (OTHER_DOC.test(meta + ' ' + near)) kind = 'other';
      const head = [...scope.querySelectorAll(LABELISH)].map(textOf).find((t) => t && t.length < 80 && (RESUME_RE.test(norm(t)) || COVER_RE.test(norm(t))));
      const display = head || (label && label.length < 80 ? label : kind === 'resume' ? 'Resume/CV' : 'File upload');
      const has = !!(el.files && el.files.length) || el.hasAttribute('data-aaf-attached') || HAS_FILE.test(textOf(scope));
      return { el, kind, label: display, box: visibleBox(scope), has, required: isRequired(el, label) || /[*✱]/.test(head || '') };
    });
    // A form with a single unlabeled upload is asking for the resume.
    if (out.length === 1 && out[0].kind === 'unknown') out[0].kind = 'resume';
    return out;
  }
  const fileEl = (id) => D.querySelector('[data-aaf-file="' + String(id).replace(/[^a-z0-9]/gi, '') + '"]');

  function attachFile(id, b64, name, type) {
    const el = fileEl(id);
    if (!el) return { ok: false, error: 'The upload field is gone. Fill the page again.' };
    let file;
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      file = new File([bytes], name, { type: type || 'application/octet-stream', lastModified: Date.now() });
      const dt = new DataTransfer();
      dt.items.add(file);
      el.files = dt.files;
    } catch (e) {
      return { ok: false, error: "This upload field wouldn't take a file: " + (e && e.message ? e.message : e) };
    }
    el.setAttribute('data-aaf-attached', name);
    fire(el, 'input');
    fire(el, 'change');
    mark(visibleBox(fileScope(el)), 'filled');
    toastState.filled++;
    toast();
    return { ok: true, size: file.size, name };
  }
  function fileNote(id) {
    const el = fileEl(id);
    if (!el) return false;
    mark(visibleBox(fileScope(el)), false);
    toastState.review++;
    toast();
    return true;
  }
  // Resume upload fields in this frame, for the popup's "Attach to this form".
  function findResumeFields() {
    const els = [...D.querySelectorAll('input[type="file"]')].filter((el) => !el.disabled && !inOwnUi(el));
    return classifyFiles(els).filter((f) => f.kind === 'resume').map((f) => {
      const id = f.el.getAttribute('data-aaf-file') || ('f' + (++fileSeq) + Math.random().toString(36).slice(2, 6));
      f.el.setAttribute('data-aaf-file', id);
      return { id, label: clip(f.label.replace(/[*✱]/g, '').trim(), 60), accept: f.el.accept || '', has: f.has };
    });
  }

  // ---------- learning from what you type ----------
  // When you answer a question the engine flagged amber, it offers to remember the
  // answer: a setting from Options when the flag was a blank setting, otherwise a
  // custom answer for that question. Nothing is saved until you press Save.
  const LEARN_FIELD = {
    firstName: 'firstName', lastName: 'lastName', email: 'email', phone: 'phone', linkedin: 'linkedin', github: 'github', scholar: 'scholar', website: 'website',
    address: 'address', city: 'city', state: 'state', zip: 'zip', country: 'country', school: 'school', major: 'major', gpa: 'gpa',
    currentCompany: 'currentCompany', currentTitle: 'currentTitle', hsGrad: 'hsGradYear', testType: 'testType', sat: 'sat', act: 'act',
    workAuth: 'workAuth', sponsorship: 'sponsorship', relocate: 'relocate', over18: 'over18', howHeard: 'howHeard', pronouns: 'pronouns',
    gender: 'gender', race: 'race', hispanic: 'hispanic', veteran: 'veteran', disability: 'disability', degree: 'degreeLevel',
  };
  const YES_NO = new Set(['workAuth', 'sponsorship', 'relocate', 'over18', 'hispanic']);
  const NO_LEARN = /signature|initials|today'?s date|\bdate\b|password|captcha|social security|\bssn\b|reference|emergency contact|referr(er|al)'?s? (name|e-?mail|phone)|salary|compensation|\bpay\b/;
  // The save panel lives in a closed shadow root and only takes real clicks, so the
  // page itself can neither read it, change what it says, nor press Save.
  const learn = { watch: [], pending: new Map(), cleanup: [], dismissed: new Set(), seq: 0, msg: '', root: null };

  // The question as a reusable phrase: its first sentence, without punctuation at the end.
  function learnPhrase(label) {
    let s = String(label || '').replace(/[*✱]/g, '').replace(/\(required\)/gi, '').replace(/\s+/g, ' ').trim();
    const first = s.match(/^(.{15,}?[?.!])(\s|$)/);
    if (first) s = first[1];
    if (s.length > 120) s = s.slice(0, 120).replace(/\s+\S*$/, '');
    return s.replace(/[\s?.!:]+$/, '').trim();
  }
  function proposal(w, answer) {
    const a = String(answer || '').replace(/\s+/g, ' ').trim();
    if (!a || a.length > 100 || PLACEHOLDER.test(norm(a))) return null;
    const q = learnPhrase(w.label);
    if (q.length < 3 || NO_LEARN.test(norm(w.label))) return null;
    const asCustom = { kind: 'custom', q, a };
    if (!w.missing || !LEARN_FIELD[w.key]) return asCustom;
    let field = LEARN_FIELD[w.key], value = a;
    if (w.key === 'degree') {
      if (!w.choice) field = 'degreeText';
      else { value = /master/i.test(a) ? "Master's" : /bachelor/i.test(a) ? "Bachelor's" : ''; if (!value) return asCustom; }
    } else if (YES_NO.has(w.key)) {
      value = /^yes\b/i.test(a) ? 'Yes' : /^no\b/i.test(a) ? 'No' : DECLINE.test(norm(a)) ? 'Decline to self-identify' : '';
      if (!value) return asCustom;
    } else if (w.key === 'hsGrad') {
      const m = a.match(/\b(19|20)\d{2}\b/);
      if (!m) return asCustom;
      value = m[0];
    }
    return { kind: 'profile', field, value, nice: NICE[w.key] || humanize(field).toLowerCase(), q };
  }
  const optText = (g) => [...(g.labels || [])].map(textOf).join(' ').trim() || g.value;
  function comboScope(el) {
    let scope = el.parentElement || el;
    for (let a = el.parentElement, i = 0; a && i < 4 && a !== D.body; i++, a = a.parentElement) {
      if ([...a.querySelectorAll('input[role="combobox"], input[aria-autocomplete]')].some((x) => x !== el)) break;
      scope = a;
    }
    return scope;
  }
  function comboValue(el) {
    const v = comboScope(el).querySelector('[class*="single-value" i],[class*="singleValue"],[class*="selected-value" i]');
    return v ? textOf(v) : '';
  }
  function clearLearn() {
    learn.cleanup.splice(0).forEach((f) => { try { f(); } catch (e) { /* gone */ } });
    learn.watch = []; learn.pending.clear(); learn.dismissed.clear(); learn.msg = '';
    const old = D.getElementById(LEARN_ID);
    if (old) old.remove();
    learn.root = null;
  }
  function watchLearn(w) {
    const id = 'L' + (++learn.seq);
    const offer = (ans) => {
      if (learn.dismissed.has(id)) return;
      const pr = proposal(w, ans);
      if (pr) learn.pending.set(id, Object.assign(pr, { id, w, on: true }));
      else learn.pending.delete(id);
      learn.msg = '';
      renderLearn();
    };
    const on = (node, ev, fn) => { node.addEventListener(ev, fn, true); learn.cleanup.push(() => node.removeEventListener(ev, fn, true)); };
    if (w.kind === 'select') on(w.el, 'change', () => offer(selectIsEmpty(w.el) ? '' : w.el.options[w.el.selectedIndex].text));
    else if (w.kind === 'text') on(w.el, 'change', () => offer(w.el.value));
    else if (w.kind === 'radio') w.group.forEach((g) => on(g, 'change', () => { const c = w.group.find((x) => x.checked); offer(c ? optText(c) : ''); }));
    else if (w.kind === 'check1') on(w.el, 'change', () => offer(w.el.checked ? 'Yes' : ''));
    else if (w.kind === 'buttons') w.btns.forEach((b) => on(b, 'click', () => setTimeout(() => offer(textOf(b)), 30)));
    else if (w.kind === 'combo') {
      let t = null;
      const read = () => offer(comboValue(w.el));
      const mo = new MutationObserver(() => { clearTimeout(t); t = setTimeout(read, 250); });
      mo.observe(comboScope(w.el), { subtree: true, childList: true, characterData: true });
      learn.cleanup.push(() => { mo.disconnect(); clearTimeout(t); });
      on(w.el, 'blur', () => setTimeout(read, 300));
    }
    learn.watch.push(w);
  }
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function renderLearn() {
    let host = D.getElementById(LEARN_ID);
    const items = [...learn.pending.values()];
    if (!items.length && !learn.msg) { if (host) host.remove(); learn.root = null; return; }
    if (!host || !learn.root) {
      if (host) host.remove();
      host = D.createElement('div');
      host.id = LEARN_ID;
      host.style.cssText = 'position:fixed;right:16px;bottom:72px;z-index:2147483647;';
      learn.root = host.attachShadow({ mode: 'closed' });
      (D.body || D.documentElement).appendChild(host);
    }
    placeLearn();
    const root = learn.root;
    const on = items.filter((x) => x.on).length;
    root.innerHTML = `<style>
      .p{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#1c1917;color:#fafaf9;border-radius:12px;padding:10px 12px;box-shadow:0 8px 28px rgba(0,0,0,.3);width:320px;max-height:60vh;overflow:auto}
      .h{display:flex;align-items:center;gap:8px;font-weight:600;margin-bottom:6px}.h span{flex:1}
      .x{all:unset;cursor:pointer;color:#a8a29e;font-size:16px;padding:0 2px}
      .it{border-top:1px solid #3f3a36;padding:7px 0}.it:first-of-type{border-top:0}
      .t{display:flex;gap:6px;align-items:flex-start;cursor:pointer}.t input{margin:2px 0 0}
      .k{color:#a8a29e;font-size:11px;display:block;margin:4px 0 2px}
      input[type=text]{all:unset;box-sizing:border-box;width:100%;background:#292524;border:1px solid #44403c;border-radius:6px;padding:4px 6px;font-size:12px;color:#fafaf9}
      .go{all:unset;cursor:pointer;background:#e8803a;color:#1c1917;font-weight:600;border-radius:7px;padding:5px 12px;margin-top:6px}
      .m{color:#4ade80;font-size:12px}.m.bad{color:#fbbf24}
    </style><div class="p"><div class="h"><span>${items.length ? 'Save for next time?' : 'Apply Autofill'}</span><button class="x" title="Not now">×</button></div>
    ${items.map((x) => `<div class="it" data-id="${x.id}">
      <label class="t"><input type="checkbox" class="on" ${x.on ? 'checked' : ''}><span>${x.kind === 'profile' ? `Your <b>${esc(x.nice)}</b>` : `When a question contains`}</span></label>
      ${x.kind === 'custom' ? `<input type="text" class="q" value="${esc(x.q)}"><span class="k">answer with</span>` : '<span class="k">saved in Options as</span>'}
      <input type="text" class="a" value="${esc(x.kind === 'profile' ? x.value : x.a)}"></div>`).join('')}
    ${items.length ? `<button class="go">Save ${on || ''}</button>` : ''}
    ${learn.msg ? `<div class="m${/couldn|reload/i.test(learn.msg) ? ' bad' : ''}">${esc(learn.msg)}</div>` : ''}</div>`;
    root.querySelector('.x').addEventListener('click', () => {
      for (const id of learn.pending.keys()) learn.dismissed.add(id);
      learn.pending.clear(); learn.msg = ''; renderLearn();
    });
    root.querySelectorAll('.it').forEach((row) => {
      const x = learn.pending.get(row.getAttribute('data-id'));
      if (!x) return;
      row.querySelector('.on').addEventListener('change', (e) => { x.on = e.target.checked; const b = root.querySelector('.go'); if (b) b.textContent = `Save ${[...learn.pending.values()].filter((y) => y.on).length || ''}`; });
      const q = row.querySelector('.q');
      if (q) q.addEventListener('input', () => { x.q = q.value; });
      const a = row.querySelector('.a');
      a.addEventListener('input', () => { if (x.kind === 'profile') x.value = a.value; else x.a = a.value; });
    });
    const go = root.querySelector('.go');
    if (go) go.addEventListener('click', (e) => { if (e.isTrusted) saveLearned(); });
  }
  // Sits just above the summary toast, whatever its height.
  function placeLearn() {
    const host = D.getElementById(LEARN_ID);
    if (!host) return;
    const t = D.getElementById(TOAST_ID);
    const h = t ? t.getBoundingClientRect().height : 0;
    host.style.bottom = (16 + (h ? h + 10 : 0)) + 'px';
  }
  async function saveLearned() {
    const chosen = [...learn.pending.values()].filter((x) => x.on && (x.kind === 'profile' ? String(x.value).trim() : String(x.q).trim() && String(x.a).trim()));
    if (!chosen.length) return;
    const items = chosen.map((x) => (x.kind === 'profile' ? { kind: 'profile', field: x.field, value: String(x.value).trim() } : { kind: 'custom', q: String(x.q).trim(), a: String(x.a).trim() }));
    let r = null;
    try { r = await chrome.runtime.sendMessage({ type: 'learn', items }); } catch (e) { r = { error: 'Reload the page: the extension was updated since you filled it.' }; }
    if (!r || !r.ok) { learn.msg = (r && r.error) || "Couldn't save."; renderLearn(); return; }
    for (const x of chosen) { learn.pending.delete(x.id); learn.dismissed.add(x.id); if (x.w.box) mark(x.w.box, 'filled'); }
    learn.msg = `Saved ${chosen.length}. ${chosen.length > 1 ? 'They fill' : 'It fills'} automatically next time.`;
    renderLearn();
    setTimeout(() => { if (!learn.pending.size) { learn.msg = ''; renderLearn(); } }, 4000);
  }

  // ---------- noticing a submitted application ----------
  // Only after you click a submit button yourself: the extension is told so it can
  // log the application once a confirmation shows up.
  const CONFIRM = /thank(s| you) for (applying|your application|submitting)|application (was |has been )?(successfully )?(submitted|received|sent|complete)|we('ve| have) received your application|successfully (submitted|applied)|your application (is|has been) (in|complete|on its way|submitted|received)|you('ve| have) (successfully )?applied/g;
  const confirmCount = () => (norm(textOf(D.body)).slice(0, 300000).match(CONFIRM) || []).length;
  const SUBMIT_TEXT = /^(submit|submit (my |your )?application|apply|apply now|send application|send|complete (my )?application|finish( application)?)$/;
  const sub = { on: false, last: 0, timer: null };
  function watchSubmit() {
    if (sub.on) return;
    sub.on = true;
    const attempt = () => {
      if (Date.now() - sub.last < 1500) return;
      sub.last = Date.now();
      const base = confirmCount();
      const formCount = D.querySelectorAll('form, input, textarea, select').length;
      try { chrome.runtime.sendMessage({ type: 'submitAttempt', url: location.href }).catch(() => {}); } catch (e) { return; }
      clearTimeout(sub.timer);
      const end = Date.now() + 60000;
      const tick = () => {
        const now = confirmCount();
        const formGone = D.querySelectorAll('form, input, textarea, select').length < formCount * 0.3;
        if (now > base || (now > 0 && formGone)) {
          try { chrome.runtime.sendMessage({ type: 'submitConfirmed', url: location.href }).catch(() => {}); } catch (e) { /* extension reloaded */ }
          return;
        }
        if (Date.now() < end) sub.timer = setTimeout(tick, 700);
      };
      sub.timer = setTimeout(tick, 700);
    };
    const NOT_FINAL = /next|continue|save|draft|back|previous|upload|attach|search/;
    D.addEventListener('submit', (e) => {
      if (inOwnUi(e.target)) return;
      const by = e.submitter;
      if (by && NOT_FINAL.test(norm(textOf(by) || by.value || by.getAttribute('aria-label') || ''))) return;
      attempt();
    }, true);
    D.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('button, input[type="submit"], [role="button"]') : null;
      if (!b || inOwnUi(b)) return;
      const t = norm(textOf(b) || b.value || b.getAttribute('aria-label') || '');
      if (SUBMIT_TEXT.test(t) || (b.type === 'submit' && b.form && !NOT_FINAL.test(t) && !/cancel/.test(t))) attempt();
    }, true);
  }

  // ---------- main ----------
  async function run(profile, opts) {
    opts = opts || {};
    const p = profile || {};
    const res = { host: location.host, filled: [], review: [], ai: [], files: [], top: W === W.top };
    clearMarks();
    clearLearn();
    const tidy = (s) => clip(s.replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim());
    const learnable = [];
    // `w` describes how to read your answer back if you fill this one in yourself.
    const note = (label, el, reason, w) => {
      res.review.push({ label: tidy(label), reason });
      mark(el, false);
      if (w) learnable.push(Object.assign({ label, box: el }, w));
    };
    const done = (label, el, value) => { res.filled.push({ label: tidy(label), value: clip(String(value), 60) }); mark(el, true); };

    const all = [...D.querySelectorAll('input, select, textarea')].filter((el) => !inOwnUi(el));
    const singles = [], radios = new Map(), checks = new Map(), combos = [], uploads = [];
    for (const el of all) {
      const t = (el.type || '').toLowerCase();
      if (t === 'file') { if (!el.disabled) uploads.push(el); continue; }
      if (el.disabled || /^(hidden|file|password|submit|button|reset|image|range|color)$/.test(t)) continue;
      if (/captcha/i.test(el.name || el.id || '')) continue;
      if (t === 'radio' || t === 'checkbox') {
        const okVis = visible(el) || [...(el.labels || [])].some(visible);
        if (!okVis) continue;
        const k = el.name || ('__' + (el.closest('fieldset,[role="radiogroup"],[role="group"],ul,ol') || el.parentElement).tagName + all.indexOf(el));
        const m = t === 'radio' ? radios : checks;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(el);
        continue;
      }
      if (!visible(el)) continue;
      if (isCombo(el)) { combos.push(el); continue; }
      if (el.readOnly) continue;
      singles.push(el);
    }

    // Text inputs, textareas, native selects.
    for (const el of singles) {
      const raw = labelFor(el);
      if (!raw) continue;
      const req = isRequired(el, raw);
      const empty = el.tagName === 'SELECT' ? selectIsEmpty(el) : !el.value.trim();
      if (!empty && !opts.overwrite) continue;
      const r = resolve(p, raw, el);
      if (!r && opts.ai && el.tagName !== 'SELECT' && aiEligible(el, raw)) {
        const id = 'q' + (++aiSeq) + Math.random().toString(36).slice(2, 7);
        el.setAttribute('data-aaf-ai', id);
        const lim = limitsFor(el, raw);
        res.ai.push({ id, label: clip(raw.replace(/[*✱]/g, '').replace(/\s+/g, ' ').trim(), 600), kind: el.tagName === 'TEXTAREA' ? 'paragraph' : 'single line', chars: lim.chars, words: lim.words, required: req });
        mark(el, 'pending');
        continue;
      }
      const kind = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? null : 'text';
      const w = (extra) => (kind ? Object.assign({ kind, el, choice: kind === 'select' }, extra) : null);
      if (!r) { if (req && empty) note(raw, el, el.tagName === 'TEXTAREA' ? 'Write this one yourself' : 'No saved answer', w()); continue; }
      if (r.missing) { if (req || r.reason || SETTING_KEYS.has(r.key) || r.key === 'degree') note(raw, el, missingWhy(r), w({ key: r.key, missing: !r.reason })); continue; }
      if (el.tagName === 'SELECT') {
        const hit = pickOption([...el.options].map((o) => ({ text: o.text, el: o })), r.choices.length ? r.choices : [r.text], r.hint);
        if (!hit) { note(raw, el, `No option matched "${clip(r.text, 40)}"`, w({ key: r.key })); continue; }
        setNative(el, hit.el.value); blur(el); done(raw, el, hit.text);
      } else {
        setNative(el, r.text); blur(el); done(raw, el, r.text);
      }
    }

    // Radio groups.
    for (const group of radios.values()) {
      const raw = labelFor(group[0], group);
      if (!raw) continue;
      const box = group[0].closest('fieldset,[role="radiogroup"],li,[class*="question" i],[class*="field" i]') || group[0].parentElement;
      const req = group.some((g) => isRequired(g, raw));
      if (group.some((g) => g.checked) && !opts.overwrite) continue;
      const r = resolve(p, raw, group[0]);
      const w = (extra) => Object.assign({ kind: 'radio', group, choice: true }, extra);
      if (!r) { if (req) note(raw, box, 'No saved answer', w()); continue; }
      if (r.missing) { note(raw, box, missingWhy(r), w({ key: r.key, missing: !r.reason })); continue; }
      const optsList = group.map((g) => ({ text: [...(g.labels || [])].map(textOf).join(' ') || g.value, el: g }));
      const hit = pickOption(optsList, r.choices.length ? r.choices : [r.text], r.hint);
      if (!hit) { note(raw, box, `No option matched "${clip(r.text, 40)}"`, w({ key: r.key })); continue; }
      if (!hit.el.checked) hit.el.click();
      if (!hit.el.checked) { hit.el.checked = true; fire(hit.el, 'input'); fire(hit.el, 'change'); }
      done(raw, box, hit.text);
    }

    // Checkbox groups (e.g. multi-select race questions). Single checkboxes are
    // only ticked when you saved a custom answer for them, so consent and
    // acknowledgement boxes are always left to you.
    for (const group of checks.values()) {
      const raw = labelFor(group[0], group) || (group.length === 1 ? [...(group[0].labels || [])].map(textOf).join(' ').trim() : '');
      if (!raw) continue;
      const box = group[0].closest('fieldset,[role="group"],li,[class*="question" i],[class*="field" i]') || group[0].parentElement;
      if (group.some((g) => g.checked) && !opts.overwrite) continue;
      const r = resolve(p, raw, group[0]);
      if (!r && group.length === 1 && isRequired(group[0], raw)) { note(raw, box, 'Tick this yourself', { kind: 'check1', el: group[0], choice: true }); continue; }
      if (!r || r.missing) { if (r && r.missing && SETTING_KEYS.has(r.key)) note(raw, box, missingWhy(r)); continue; }
      if (group.length === 1) {
        const tick = (r.key === 'custom' && /^(yes|true|check(ed)?|x)$/i.test(r.text)) || r.key === 'consent';
        if (tick && !group[0].checked) { group[0].click(); done(raw, box, r.key === 'consent' ? 'Agreed' : 'checked'); }
        continue;
      }
      const hit = pickOption(group.map((g) => ({ text: [...(g.labels || [])].map(textOf).join(' ') || g.value, el: g })), r.choices, r.hint);
      if (!hit) { note(raw, box, `No option matched "${clip(r.text, 40)}"`); continue; }
      if (!hit.el.checked) hit.el.click();
      done(raw, box, hit.text);
    }

    // Yes/No button groups (Ashby style).
    const seen = new Set();
    for (const b of D.querySelectorAll('button')) {
      if (inOwnUi(b) || !/^(yes|no)$/.test(norm(textOf(b)))) continue;
      const wrap = b.parentElement;
      if (!wrap || seen.has(wrap)) continue;
      const btns = [...wrap.querySelectorAll('button')];
      if (btns.length < 2 || btns.length > 4 || !btns.every((x) => norm(textOf(x)).length <= 24) || !visible(wrap)) continue;
      seen.add(wrap);
      const raw = questionText(btns[0], btns);
      if (!raw) continue;
      const already = btns.some((x) => x.getAttribute('aria-pressed') === 'true' || x.getAttribute('aria-checked') === 'true' || /\b(active|selected|checked)\b|_active|--selected/i.test(x.className || ''));
      if (already && !opts.overwrite) continue;
      const r = resolve(p, raw, btns[0]);
      const w = (extra) => Object.assign({ kind: 'buttons', btns, choice: true }, extra);
      if (!r) { if (/[*✱]/.test(raw)) note(raw, wrap, 'No saved answer', w()); continue; }
      if (r.missing) { note(raw, wrap, missingWhy(r), w({ key: r.key, missing: !r.reason })); continue; }
      const hit = pickOption(btns.map((x) => ({ text: textOf(x), el: x })), r.choices, r.hint);
      if (!hit) { note(raw, wrap, `No option matched "${clip(r.text, 40)}"`, w({ key: r.key })); continue; }
      if (!safeButton(hit.el)) { note(raw, wrap, `Click "${hit.text}" yourself (button could submit the form)`); continue; }
      clickLikeUser(hit.el);
      done(raw, wrap, hit.text);
    }

    // Comboboxes last, one at a time, since each opens a menu.
    for (const el of combos) {
      const raw = labelFor(el);
      if (!raw) continue;
      const req = isRequired(el, raw);
      if (comboHasValue(el) && !opts.overwrite) continue;
      const r = resolve(p, raw, el);
      const w = (extra) => Object.assign({ kind: 'combo', el, choice: true }, extra);
      if (!r) { if (req) note(raw, el, 'No saved answer', w()); continue; }
      if (r.missing) { note(raw, el, missingWhy(r), w({ key: r.key, missing: !r.reason })); continue; }
      const got = await fillCombobox(el, r.choices.length ? r.choices : [r.text], r.search, r.hint);
      if (got) done(raw, el, got); else note(raw, el, `No option matched "${clip(r.text, 40)}"`, w({ key: r.key }));
    }

    // File uploads. Resume fields go back to the extension, which attaches your
    // top-ranked resume; every other upload is left to you.
    for (const f of classifyFiles(uploads)) {
      if (f.has && !opts.overwrite) continue;
      if (f.kind === 'resume' && opts.attach) {
        const id = 'f' + (++fileSeq) + Math.random().toString(36).slice(2, 6);
        f.el.setAttribute('data-aaf-file', id);
        res.files.push({ id, label: tidy(f.label), accept: f.el.accept || '', required: f.required });
        continue;
      }
      if (f.required) note(f.label, f.box, f.kind === 'cover' ? 'Attach your cover letter yourself' : 'Attach this yourself');
    }

    if (opts.learn) learnable.forEach(watchLearn);
    if (opts.track) watchSubmit();

    toastState = { filled: res.filled.length, review: res.review.length, drafting: res.ai.length, drafted: 0, note: '', tone: '' };
    if (res.filled.length || res.review.length || res.ai.length || res.files.length) toast();
    const iframes = res.top ? [...D.querySelectorAll('iframe')].map((f) => {
      try { return new URL(f.getAttribute('src') || '', location.href).host; } catch (e) { return ''; }
    }).filter((h) => h && h !== location.host) : [];
    return { host: res.host, top: res.top, filled: res.filled, review: res.review, ai: res.ai, files: res.files, learning: opts.learn ? learnable.length : 0, iframes };
  }

  // ---------- AI results coming back from the extension ----------
  function aiTarget(id) { return D.querySelector('[data-aaf-ai="' + String(id).replace(/[^a-z0-9]/gi, '') + '"]'); }
  function fillAi(id, text) {
    const el = aiTarget(id);
    if (!el) return false;
    setNative(el, text); blur(el); mark(el, 'ai');
    toastState.drafting = Math.max(0, toastState.drafting - 1); toastState.drafted++;
    toast();
    return true;
  }
  function aiFailed(id) {
    const el = aiTarget(id);
    if (el) mark(el, false);
    toastState.drafting = Math.max(0, toastState.drafting - 1); toastState.review++;
    toast();
    return !!el;
  }

  // ---------- job description scraping ----------
  const JD_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'FORM', 'NAV', 'FOOTER', 'BUTTON', 'SELECT', 'TEXTAREA', 'INPUT', 'SVG', 'IFRAME', 'TEMPLATE']);
  const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|BR|SECTION|ARTICLE|TR|TABLE|DD|DT|HEADER)$/;
  function blockText(root) {
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) { out.push(n.nodeValue); return; }
      if (n.nodeType !== 1 || JD_SKIP.has(n.tagName) || n.id === TOAST_ID) return;
      if (n.hidden || n.getAttribute('aria-hidden') === 'true') return;
      const block = BLOCK.test(n.tagName);
      if (block) out.push('\n');
      if (n.tagName === 'LI') out.push('- ');
      for (const c of n.childNodes) walk(c);
      if (block) out.push('\n');
    };
    if (root) walk(root);
    return out.join('').replace(/[ \t\u00a0]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function extractJob() {
    const sel = '[class*="job-description" i],[class*="jobdescription" i],[class*="description" i],[class*="posting" i],[data-automation-id="jobPostingDescription"],#content,.job-post,.job__description,main,article,[role="main"]';
    let best = '';
    for (const el of D.querySelectorAll(sel)) {
      const t = blockText(el);
      if (t.length > best.length) best = t;
    }
    const text = best.length > 600 ? best : blockText(D.body);
    const h1 = D.querySelector('h1') || D.querySelector('.posting-headline h2, [data-automation-id="jobPostingHeader"], [class*="job-title" i], [class*="jobTitle"], [class*="posting-title" i]');
    const site = D.querySelector('meta[property="og:site_name"]');
    return { url: location.href, host: location.host, title: (h1 && textOf(h1)) || D.title || '', pageTitle: D.title || '', siteName: site ? site.getAttribute('content') || '' : '', text: text.slice(0, 30000), top: W === W.top };
  }

  // ---------- on-page summary ----------
  let toastState = { filled: 0, review: 0, drafting: 0, drafted: 0, note: '', tone: '' };
  function toast() {
    const old = D.getElementById(TOAST_ID);
    if (old) old.remove();
    const host = D.createElement('div');
    host.id = TOAST_ID;
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    const t = toastState;
    root.innerHTML = `<style>
      .t{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#1c1917;color:#fafaf9;border-radius:10px;padding:10px 12px;box-shadow:0 6px 24px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center}
      .g{color:#4ade80}.a{color:#fbbf24}.p{color:#c4b5fd}button{all:unset;cursor:pointer;color:#a8a29e;padding:0 2px;font-size:15px}
      .w{display:flex;flex-direction:column;gap:6px;align-items:flex-end}.n{font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#1c1917;color:#fafaf9;border-radius:10px;padding:7px 12px;box-shadow:0 6px 24px rgba(0,0,0,.25);max-width:340px}.n.warn{color:#fbbf24}.n.ok{color:#4ade80}
    </style><div class="w">${t.note ? `<div class="n ${t.tone || ''}">${esc(t.note)}</div>` : ''}${t.filled || t.review || t.drafting || t.drafted || !t.note ? `<div class="t"><span>Autofill:</span><span class="g">${t.filled} filled</span>${t.drafted ? `<span class="p">${t.drafted} AI draft${t.drafted > 1 ? 's' : ''}</span>` : ''}${t.drafting ? `<span class="p">drafting ${t.drafting}…</span>` : ''}${t.review ? `<span class="a">${t.review} to review</span>` : ''}<button title="Dismiss">×</button></div>` : ''}</div>`;
    const x = root.querySelector('button');
    if (x) x.addEventListener('click', () => { host.remove(); placeLearn(); });
    (D.body || D.documentElement).appendChild(host);
    placeLearn();
    clearTimeout(toast.timer);
    if (!t.drafting) toast.timer = setTimeout(() => { host.remove(); placeLearn(); }, t.tone === 'warn' ? 20000 : 12000);
  }
  // A line above the summary, e.g. "Already in your tracker: Applied Sep 3".
  function notify(text, tone) {
    toastState.note = String(text || '');
    toastState.tone = tone || '';
    toast();
    return true;
  }

  window.__appAutofill = {
    version: VERSION, run, fillAi, aiFailed, extractJob, attachFile, fileNote, findResumeFields, notify,
    _test: { resolve, pickOption, labelFor, matchRule, norm, aiEligible, limitsFor, numRange, dateRange, classifyFiles, proposal, learnPhrase, learn, confirmCount, saveLearned },
  };
})();
