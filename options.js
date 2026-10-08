const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const YN = ['', 'Yes', 'No'];
const DECLINE = 'Decline to self-identify';

const SECTIONS = [
  {
    title: 'One-time answers', key: true,
    note: 'Questions nearly every application asks. Set these once and they stop showing up as things to review.',
    fields: [
      { k: 'workAuth', label: 'Authorized to work in the US?', type: 'select', options: YN },
      { k: 'sponsorship', label: 'Need visa sponsorship now or in the future?', type: 'select', options: YN },
      { k: 'over18', label: 'At least 18 years old?', type: 'select', options: YN },
      { k: 'relocate', label: 'Willing to relocate?', type: 'select', options: YN },
      { k: 'degreeLevel', label: 'Degree level for dropdowns', type: 'select', options: ['', "Bachelor's", "Master's"], hint: 'Only used when a form makes you pick a degree type from a list. Typed degree fields use your full degree name below.' },
      { k: 'howHeard', label: 'How did you hear about the role?', list: ['LinkedIn', 'Company website', 'Handshake', 'Referral', 'Job board'] },
      { k: 'autoAgree', label: 'Agree to privacy statements and codes of conduct?', type: 'select', options: YN, hint: 'Yes picks "I agree" on privacy statement, terms and code of conduct questions. Marketing, SMS and talent-community opt-ins are never auto-agreed.' },
    ],
  },
  {
    title: 'Basics',
    fields: [
      { k: 'firstName', label: 'First name' },
      { k: 'lastName', label: 'Last name' },
      { k: 'preferredName', label: 'Preferred name', hint: 'Blank uses your first name.' },
      { k: 'email', label: 'Email', type: 'email' },
      { k: 'phone', label: 'Phone', type: 'tel', hint: 'Fields that only take 10 digits get the digits only.' },
    ],
  },
  {
    title: 'Location',
    fields: [
      { k: 'address', label: 'Street address', wide: true, hint: 'Only filled into address fields. Leave blank to type it per form.' },
      { k: 'city', label: 'City' },
      { k: 'state', label: 'State', hint: 'Two-letter code or full name.' },
      { k: 'zip', label: 'ZIP code' },
      { k: 'country', label: 'Country' },
    ],
  },
  {
    title: 'Links',
    fields: [
      { k: 'linkedin', label: 'LinkedIn', type: 'url' },
      { k: 'github', label: 'GitHub', type: 'url' },
      { k: 'website', label: 'Website / portfolio', type: 'url' },
      { k: 'scholar', label: 'Google Scholar', type: 'url' },
    ],
  },
  {
    title: 'Education',
    fields: [
      { k: 'school', label: 'School', wide: true },
      { k: 'degreeText', label: 'Degree (typed fields)', wide: true },
      { k: 'major', label: 'Major / discipline' },
      { k: 'gpa', label: 'GPA' },
      { k: 'eduStartMonth', label: 'Start month', type: 'select', options: ['', ...MONTHS] },
      { k: 'eduStartYear', label: 'Start year' },
      { k: 'gradMonth', label: 'Graduation month', type: 'select', options: ['', ...MONTHS] },
      { k: 'gradYear', label: 'Graduation year' },
    ],
  },
  {
    title: 'High school and test scores',
    fields: [
      { k: 'hsGradYear', label: 'High school graduation year' },
      { k: 'testType', label: 'Standardized test you took', type: 'select', options: ['', 'SAT', 'ACT', 'Both', 'None'] },
      { k: 'sat', label: 'SAT score', hint: 'Exact score, or a range like 1400-1500 if that is all you want to share. Ranges only fill dropdowns.' },
      { k: 'act', label: 'ACT score', hint: 'Type None if you did not take it.' },
    ],
  },
  {
    title: 'Current role',
    fields: [
      { k: 'currentTitle', label: 'Title' },
      { k: 'currentCompany', label: 'Company / organization' },
    ],
  },
  {
    title: 'Voluntary self-identification',
    note: `Optional EEO questions at the end of most US applications. Leave a field blank to answer it yourself on each form, or choose "${DECLINE}".`,
    fields: [
      { k: 'pronouns', label: 'Pronouns', list: ['He/him/his', 'She/her/hers', 'They/them/theirs', DECLINE], hint: 'Also matches He/Him, he / him / his and similar.' },
      { k: 'gender', label: 'Gender', list: [DECLINE, 'Male', 'Female', 'Non-binary'] },
      { k: 'race', label: 'Race / ethnicity', list: [DECLINE, 'Asian', 'Black or African American', 'White', 'Hispanic or Latino', 'Native Hawaiian or Other Pacific Islander', 'American Indian or Alaska Native', 'Two or More Races'] },
      { k: 'hispanic', label: 'Hispanic or Latino?', type: 'select', options: ['', 'Yes', 'No', DECLINE] },
      { k: 'veteran', label: 'Veteran status', list: [DECLINE, 'I am not a protected veteran', 'I identify as one or more of the classifications of protected veteran'] },
      { k: 'disability', label: 'Disability status', list: [DECLINE, 'No, I do not have a disability', 'Yes, I have a disability (or previously had a disability)'] },
    ],
  },
];

let profile = mergeProfile();
let saveTimer = null;

function flashSaved() {
  const s = document.getElementById('status');
  s.classList.add('on');
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => s.classList.remove('on'), 1200);
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const toStore = Object.assign({}, profile, { custom: profile.custom.filter((c) => c && (c.q || c.a)) });
    await chrome.storage.local.set({ profile: toStore });
    flashSaved();
    updatePills();
  }, 300);
}

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  }
  e.append(...kids.filter(Boolean));
  return e;
}

function control(f) {
  const id = 'f_' + f.k;
  let input;
  if (f.type === 'select') {
    input = el('select', { id });
    for (const o of f.options) input.append(el('option', { value: o, text: o || 'Not set' }));
    input.value = profile[f.k] || '';
  } else {
    input = el('input', { id, type: f.type || 'text', autocomplete: 'off', spellcheck: 'false' });
    input.value = profile[f.k] || '';
    if (f.list) {
      const lid = id + '_list';
      input.setAttribute('list', lid);
      const dl = el('datalist', { id: lid });
      f.list.forEach((o) => dl.append(el('option', { value: o })));
      input._dl = dl;
    }
  }
  const sync = () => {
    profile[f.k] = input.value.trim();
    input.classList.toggle('blank', !!f.flagBlank && !profile[f.k]);
    save();
  };
  input.addEventListener('input', sync);
  input.addEventListener('change', sync);
  input.dataset.key = f.k;
  return input;
}

function renderSections() {
  const top = document.getElementById('sectionsTop');
  const rest = document.getElementById('sections');
  top.replaceChildren(); rest.replaceChildren();
  for (const s of SECTIONS) {
    const root = s.key ? top : rest;
    const grid = el('div', { class: 'grid' });
    for (const f of s.fields) {
      if (s.key) f.flagBlank = true;
      const input = control(f);
      input.classList.toggle('blank', !!f.flagBlank && !profile[f.k]);
      const wrap = el('div', { class: 'f' + (f.wide ? ' wide' : '') }, el('label', { for: input.id, text: f.label }), input, input._dl, f.hint ? el('span', { class: 'hint', text: f.hint }) : null);
      grid.append(wrap);
    }
    const h = el('h2', { text: s.title });
    if (s.key) h.append(el('span', { class: 'pill', id: 'blankPill' }));
    root.append(el('section', { class: s.key ? 'key' : '' }, h, s.note ? el('p', { class: 'note', text: s.note }) : null, grid));
  }
  updatePills();
}

function updatePills() {
  const pill = document.getElementById('blankPill');
  if (!pill) return;
  const keys = SECTIONS[0].fields.map((f) => f.k);
  const n = keys.filter((k) => !profile[k]).length;
  pill.textContent = n ? `${n} not set` : '';
}

function renderCustom() {
  const box = document.getElementById('custom');
  box.replaceChildren();
  if (!profile.custom.length) {
    box.append(el('div', { class: 'empty', text: 'None yet. Example: "in person" answered with "Yes", or "previously worked" answered with "No".' }));
    return;
  }
  profile.custom.forEach((c, i) => {
    const q = el('input', { type: 'text', placeholder: 'e.g. previously worked for' }); q.value = c.q || '';
    const a = el('input', { type: 'text', placeholder: 'e.g. No' }); a.value = c.a || '';
    const del = el('button', { class: 'icon-btn', title: 'Remove' });
    del.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
    q.addEventListener('input', () => { profile.custom[i].q = q.value; save(); });
    a.addEventListener('input', () => { profile.custom[i].a = a.value; save(); });
    del.addEventListener('click', () => { profile.custom.splice(i, 1); save(); renderCustom(); });
    box.append(el('div', { class: 'row' }, q, a, del));
  });
}

document.getElementById('addRow').addEventListener('click', () => {
  profile.custom.push({ q: '', a: '' });
  renderCustom();
  const rows = document.querySelectorAll('#custom .row input');
  if (rows.length) rows[rows.length - 2].focus();
});

document.getElementById('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: 'apply-autofill-profile.json' });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

document.getElementById('import').addEventListener('click', () => document.getElementById('importFile').click());
document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    profile = mergeProfile(data);
    await chrome.storage.local.set({ profile });
    renderSections(); renderCustom(); renderAi(); flashSaved();
  } catch (err) {
    alert("That file isn't a valid profile export.");
  }
  e.target.value = '';
});

document.getElementById('reset').addEventListener('click', async () => {
  if (!confirm('Reset every field to the defaults? Your custom answers will be removed too.')) return;
  await chrome.storage.local.remove('profile');
  profile = mergeProfile();
  renderSections(); renderCustom(); renderAi(); flashSaved();
});

// ---------- AI mode ----------
let ai = mergeAi();
async function saveAi() { await chrome.storage.local.set({ ai }); flashSaved(); }

function renderAi() {
  const key = document.getElementById('apiKey');
  key.value = ai.apiKey || '';
  const model = document.getElementById('model');
  model.replaceChildren(...AI_MODELS.map(([v, t]) => el('option', { value: v, text: t })));
  model.value = ai.model;
  document.getElementById('drafts').checked = !!ai.drafts;
  document.getElementById('rankClaude').checked = !!ai.rankWithClaude;
  document.getElementById('aiContext').value = profile.aiContext || '';
}

let keyTimer;
document.getElementById('apiKey').addEventListener('input', (e) => {
  ai.apiKey = e.target.value.trim();
  clearTimeout(keyTimer); keyTimer = setTimeout(saveAi, 400);
});
document.getElementById('showKey').addEventListener('click', (e) => {
  const k = document.getElementById('apiKey');
  k.type = k.type === 'password' ? 'text' : 'password';
  e.target.textContent = k.type === 'password' ? 'Show' : 'Hide';
});
document.getElementById('model').addEventListener('change', (e) => { ai.model = e.target.value; saveAi(); });
document.getElementById('drafts').addEventListener('change', (e) => { ai.drafts = e.target.checked; saveAi(); });
document.getElementById('rankClaude').addEventListener('change', (e) => { ai.rankWithClaude = e.target.checked; saveAi(); });
document.getElementById('testKey').addEventListener('click', async () => {
  const st = document.getElementById('keyStatus');
  clearTimeout(keyTimer); await saveAi();
  st.className = 'hint'; st.textContent = 'Testing…';
  const r = await chrome.runtime.sendMessage({ type: 'testKey' });
  if (r && r.ok) { st.className = 'hint good'; st.textContent = `Key works with ${r.model}.`; }
  else { st.className = 'hint bad'; st.textContent = (r && r.error) || 'Test failed.'; }
});
document.getElementById('aiContext').addEventListener('input', (e) => { profile.aiContext = e.target.value; save(); });
document.getElementById('resetCtx').addEventListener('click', () => {
  if (profile.aiContext !== DEFAULT_AI_CONTEXT && !confirm('Replace your AI context with the default text?')) return;
  profile.aiContext = DEFAULT_AI_CONTEXT;
  document.getElementById('aiContext').value = DEFAULT_AI_CONTEXT;
  save();
});
document.getElementById('openHub').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('hub.html') }));

(async () => {
  const st = await chrome.storage.local.get(['profile', 'ai', 'resumes']);
  profile = mergeProfile(st.profile);
  ai = mergeAi(st.ai);
  renderSections();
  renderCustom();
  renderAi();
  const n = (st.resumes || []).length;
  document.getElementById('hubCount').textContent = n ? `${n} resume${n > 1 ? 's' : ''} uploaded` : 'No resumes uploaded yet';
  if (!st.profile || !st.profile._v || st.profile._v < PROFILE_VERSION) save();
})();
