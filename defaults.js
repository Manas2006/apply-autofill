// Default profile. Everything here is editable on the Options page; your edits
// are saved in this browser only (chrome.storage.local) and never leave it.
// Blank fields are never guessed: questions that need them get flagged for you.
const PROFILE_VERSION = 3;

// Lines still in [brackets] are skipped when the AI context is sent, so you can
// fill this in a bit at a time.
const DEFAULT_AI_CONTEXT = `About me
- [School, degree and expected graduation date]
- [Current role, research or job, one line each]
- [Past internships or jobs; say "past tense" for ones that are over]
- [Your best projects, and which kinds of roles each one fits]

How to write
- First person, plain and specific. Sound like a person, not a cover letter template. No buzzwords.
- Never use em dashes.
- Match any requested length exactly. With no limit given, 2 to 4 sentences.
- "Why this company" answers: 3 sentences. Name a real product, team or problem from the job description and connect it to one concrete thing I built.
- Only claim experience, tools and numbers that appear in my resume or in this context. Never invent metrics.`;

const AUTOFILL_DEFAULTS = {
  firstName: '',
  lastName: '',
  preferredName: '',
  email: '',
  phone: '',

  address: '',
  city: '',
  state: '',
  zip: '',
  country: '',

  linkedin: '',
  github: '',
  website: '',
  scholar: '',

  school: '',
  degreeText: '',
  degreeLevel: '',
  major: '',
  gpa: '',
  eduStartMonth: '',
  eduStartYear: '',
  gradMonth: '',
  gradYear: '',

  hsGradYear: '',
  testType: '',
  sat: '',
  act: '',

  currentCompany: '',
  currentTitle: '',

  over18: '',
  workAuth: '',
  sponsorship: '',
  relocate: '',
  howHeard: '',
  pronouns: '',
  autoAgree: '',

  gender: '',
  race: '',
  hispanic: '',
  veteran: '',
  disability: '',

  aiContext: DEFAULT_AI_CONTEXT,

  custom: [],
  _v: PROFILE_VERSION,
};

function mergeProfile(stored) {
  const s = stored || {};
  const p = Object.assign({}, AUTOFILL_DEFAULTS, s);
  if (!s._v || s._v < 2) {
    if (!String(s.aiContext || '').trim()) p.aiContext = DEFAULT_AI_CONTEXT;
  }
  p._v = PROFILE_VERSION;
  p.custom = Array.isArray(p.custom) ? p.custom : [];
  return p;
}

// AI settings live apart from the profile so an exported profile never carries the API key.
const AI_DEFAULTS = { apiKey: '', model: 'claude-sonnet-5-5', drafts: false, rankWithClaude: true };
const AI_MODELS = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (fast, recommended)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (best writing, slower)'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5 (cheapest)'],
];
function mergeAi(stored) { return Object.assign({}, AI_DEFAULTS, stored || {}); }

// Fill behavior. The popup and Options both edit these.
const SETTINGS_DEFAULTS = { overwrite: false, attach: true, learn: true };
function mergeSettings(stored) { return Object.assign({}, SETTINGS_DEFAULTS, stored || {}); }

// Application tracker in Airtable. Columns can be field IDs (fld...) or field names.
// The token is stored apart from the profile and never exported.
const AIRTABLE_DEFAULTS = {
  token: '',
  baseId: '',
  table: 'Applications',
  fields: {
    company: 'Company',
    role: 'Role',
    status: 'Status',
    date: 'Applied Date',
    req: 'Req',
    location: 'Location',
    resume: 'Resume Variant',
    notes: 'Notes',
    term: 'Term',
  },
  statusApplied: 'Applied',
  dupCheck: true,
  autoLog: true,
};
function mergeAirtable(stored) {
  const s = stored || {};
  const o = Object.assign({}, AIRTABLE_DEFAULTS, s);
  o.fields = Object.assign({}, AIRTABLE_DEFAULTS.fields, s.fields || {});
  return o;
}
