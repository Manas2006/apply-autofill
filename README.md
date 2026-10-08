# Apply Autofill

A Chrome extension that fills job applications from a profile you control, ranks your resumes for each posting, and can draft written answers with Claude. It outlines everything it touched, lists what still needs you, and never submits a form.

Works on Greenhouse, Lever, Ashby, Workday, iCIMS, SmartRecruiters, Jobvite, Workable and Rippling forms, including ones embedded in a company's own careers page, plus most plain HTML forms.

## Features

- **One-click fill** of contact details, links, education, work authorization, EEO questions and more. Handles text fields, native selects, radio groups, Yes/No button groups and React-style search dropdowns.
- **Smart matching** for messy option lists: "University of X - Campus" vs "The University of X at Campus", range buckets like GPA `3.71 - 3.9` or graduation windows like `January 2028 - July 2028`, and pronoun variants like `He/Him` vs `he / him / his`.
- **Never guesses.** Blank answers are flagged in amber instead of filled. Green means filled, purple means AI draft.
- **Resume hub.** Drop in all your resume PDFs and Word files. On any job page the popup reads the full job description (from the page, or from the Greenhouse, Lever and Ashby posting APIs when the application page hides it) and ranks your top 3 resumes for that role. Download the best one renamed to `First_Last_Role.pdf` in one click.
- **Attaches your resume.** With "Attach my top resume" on (the default), Fill puts the best-ranked resume for the posting into the resume upload field, renamed to `First_Last_Role.pdf` (or the Word file when the field doesn't take PDFs). Cover letter, transcript and other uploads are left to you. The popup also has **Attach to this form**.
- **Learns as you go.** Answer an amber question yourself and it offers to save that answer, so the next form fills it.
- **Application tracker.** Optional Airtable logging: duplicate warnings, and a row added or updated when you submit.
- **AI mode (optional).** With your own Anthropic API key, unanswered written questions get drafted from your "AI context", your best-matching resume and the job description. Drafts respect length limits, and questions needing facts it doesn't have (salary, dates, references) are left for you. Claude can also rank your resumes with a one-line reason for each.

## Install

1. Download this repo (Code > Download ZIP, then unzip) or `git clone` it.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the repo folder.
4. Options opens on first install. Fill in your details and the **One-time answers** at the top.
5. Pin the extension from the puzzle-piece menu.

To update, pull or re-download into the same folder and click the reload arrow on the extension's card. Your saved profile stays.

## Use

On any application page, click the toolbar button and **Fill this page**, or press **Option+Shift+F** (Alt+Shift+F on Windows; change it at `chrome://extensions/shortcuts`).

- Green outline: filled from your profile.
- Purple outline: AI draft. Read and edit before you submit.
- Amber outline: needs you (essays with AI off, cover letters and other uploads, blanks in Options, or no matching option). Answer it and you'll be offered to save the answer.

Fields that already have text are left alone unless you tick **Overwrite** in the popup.

**Custom answers** (Options): if a question contains your phrase, it gets your answer ahead of every built-in rule. Wrap the phrase in `/slashes/` for a regular expression.

## Learning your answers

When you answer an amber question yourself, a small "Save for next time?" card offers to remember it. Blank settings (work authorization, how you heard, ZIP code and so on) are saved straight into Options; anything else becomes a custom answer keyed on the question's first sentence, which you can shorten before saving. Nothing is saved until you press **Save**, essays and long answers are never offered, and salary, dates, signatures and references are skipped. Turn it off in Options > While filling.

## Application tracker (Airtable)

Optional. Point it at an Airtable table of applications and it will:

- warn you on the page and in the popup when the job is already in your tracker (same posting id or URL, or the same company and role), with its status and date;
- add a row, or update the existing one, when you apply: status Applied, today's date, company, role, req (for example `job-boards.greenhouse.io/acme 8011590003`), location, the resume you used, the posting URL in Notes, and the term when the title names a season your Term column already has.

Setup, in Options > Application tracker:

1. Create a personal access token at airtable.com/create/tokens with the `data.records:read` and `data.records:write` scopes, limited to your tracker base, and paste it in.
2. Enter the base ID (the `app…` part of the base's URL) and the table name or ID. Under **Columns**, match the column names to yours (defaults: Company, Role, Status, Applied Date, Req, Location, Resume Variant, Notes, Term). Field IDs (`fld…`) work too and survive renames; leave a column blank to skip it.
3. Click **Test**.

Logging happens on its own only on pages you filled, after **you** click submit and a confirmation appears (a "thank you for applying" message or a confirmation page). A submit that fails validation logs nothing. Rows already past Applied (interviewing, offer, rejected) are never moved back. The popup's tracker card also lets you log or update a row by hand, with the company, role and status editable.

## AI mode

In Options > AI mode, paste an Anthropic API key, pick a model and tick **Draft written answers when I click Fill**. Fill in the **AI context** with who you are and how you write; template lines still in `[brackets]` are ignored. Usage is billed to your own API account, typically a few cents per application.

## Privacy

- Your profile, resumes and settings live in this browser's extension storage and never leave it.
- In AI mode, the question, your AI context, the top resume's text and the job description are sent to `api.anthropic.com` with your key.
- With the tracker set up, the rows of your tracker table are read from, and the new or updated row written to, `api.airtable.com` with your token.
- The attached resume goes only into the form you filled, where you submit it yourself.
- Nothing is sent anywhere else. The API key and Airtable token are stored separately from your profile and never included in profile exports.

## What it will never do

- Submit or advance a form, or click any button that could submit one.
- Attach anything except your own top-ranked resume, and only into a field labelled as a resume upload.
- Save an answer you typed without you pressing Save.
- Log an application you didn't submit: automatic logging waits for a confirmation.
- Agree to anything unless "Agree to privacy statements and codes of conduct" is set to Yes. Even then, marketing, SMS and talent-community opt-ins are left for you.
- Guess an answer you left blank.

## How it works

Plain Manifest V3 JavaScript with no build step.

| File | Role |
| --- | --- |
| `engine.js` | Injected into each frame on demand: reads field labels, matches them to profile answers, fills fields, attaches the resume, offers to save typed answers, notices a submitted application, scrapes the job description |
| `background.js` | Service worker: injection across frames, job-description lookup, resume ranking, AI drafting, tracker logging |
| `lib/ranking.js` | Local BM25 ranking with phrase handling and technical-term weighting |
| `lib/jobsource.js` | Greenhouse, Lever and Ashby posting API lookups |
| `lib/ai.js` | Claude API calls, prompts and answer cleanup |
| `lib/filestore.js` | IndexedDB store for original resume files |
| `lib/naming.js` | Role, company, job id and file names from a posting |
| `lib/airtable.js` | Airtable reads, duplicate matching and row writes |
| `popup.*`, `options.*`, `hub.*` | Extension UI |

It only runs when you click Fill or press the shortcut (`activeTab`), plus host permissions for the ATS domains above so it can reach embedded application iframes, and for `api.anthropic.com` and `api.airtable.com`.

Third-party code: [pdf.js](https://github.com/mozilla/pdf.js) (Apache 2.0) and [mammoth](https://github.com/mwilliamson/mammoth.js) (BSD 2-Clause), vendored in `lib/vendor` with their licenses, for extracting resume text locally.

## License

MIT
