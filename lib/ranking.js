// Local resume ranking (no network). BM25 with the job description as the query
// and your resumes as the collection, so words that only some of your resumes
// contain (the ones that actually distinguish a variant) count the most.
// Technical terms count double, and filler words are ignored.
(function (root) {
  const STOP = new Set((
    'a an and are as at be been being but by can could do does doing done for from had has have he her his i if in into is it its '
    + 'may me more most must my no not of on or our out over own she should so such than that the their them then there these '
    + 'they this those through to too under up us very was we were what when where which while who whom why will with within would '
    + 'you your yours also about across after all any both each few just only other same some via per etc using use used uses '
    + 'ability able work works working worked experience experiences experienced team teams teammates role roles strong skills skill '
    + 'including include includes included requirements required require requires preferred qualifications qualification '
    + 'responsibilities responsibility knowledge years year plus new well help helps helping opportunity opportunities company '
    + 'companies candidate candidates job jobs position positions apply applicant applicants equal employer status like '
    + 'understanding familiarity familiar good great excellent build builds building built develop develops developing developed '
    + 'one two three four five first second problem problems range information between execution executing execute open source '
    + 'way ways make makes making made take takes taking part across world people person day days time times based within '
    + 'highly high low best better large small big real many much every everything something things thing get gets getting '
    + 'ensure ensuring provide provides providing support supporting supports including across around against among however '
    + 'want wants need needs looking look join joining grow growth impact impactful passion passionate excited exciting love '
    + 'learn learning learned fast pace paced environment environments culture mission values value benefits benefit salary '
    + 'compensation pay range location locations office offices remote hybrid onsite full part intern interns internship internships '
    + 'summer fall spring winter program programs graduate graduating degree degrees bachelor bachelors master masters phd '
    + 'student students university universities school college preferred related field fields similar equivalent relevant '
    + 'please note may might also currently current future today across together closely collaborate collaborating collaboration '
    + 'across cross functional functions function partner partners stakeholders business businesses customer customers user users '
    + 'product products solution solutions service services quality across key core critical complex complexity hard'
  ).split(/\s+/));

  // Terms that signal a real skill or domain. A match on one of these counts double.
  const TECH = new Set((
    'python java c c++ c# go golang rust javascript typescript js ts kotlin swift scala ruby php sql nosql bash shell matlab r haskell elixir '
    + 'react angular vue svelte next.js node node.js express django flask fastapi spring rails graphql rest grpc protobuf websocket '
    + 'aws gcp azure kubernetes k8s docker terraform ansible linux unix ci/cd jenkins github bazel helm serverless lambda ec2 s3 '
    + 'kafka spark flink airflow hadoop beam dbt snowflake bigquery redshift postgres postgresql mysql redis dynamodb cassandra mongodb '
    + 'elasticsearch opensearch clickhouse duckdb sqlite rocksdb raft paxos consensus replication sharding wal storage database databases '
    + 'distributed systems concurrency multithreading latency throughput caching cache scalability reliability observability monitoring '
    + 'tracing logging datadog prometheus grafana networking tcp http dns cdn edge ddos security cryptography authentication oauth '
    + 'compiler compilers kernel kernels operating os embedded firmware fpga verilog rtl gpu gpus cuda triton tensorrt nccl mpi hpc simd '
    + 'pytorch tensorflow jax numpy pandas scikit-learn sklearn xgboost huggingface transformers vllm onnx llm llms agents agent agentic '
    + 'rag retrieval embeddings vector search ranking recommendation recommender nlp vision cv rl reinforcement inference training '
    + 'evaluation eval evals benchmark benchmarks fine-tuning finetuning pretraining rlhf alignment interpretability safety diffusion '
    + 'multimodal speech ml ai deep machine-learning deep-learning reinforcement-learning computer-vision large-language-models '
    + 'natural-language-processing data-pipelines open-source full-stack backend frontend back-end front-end real-time low-latency '
    + 'distributed-systems mobile android ios web api apis microservices sre devops infra infrastructure platform orchestration '
    + 'scheduling scheduler pipelines pipeline etl streaming batch analytics statistics probability optimization algorithms fraud '
    + 'payments trading ledger marketplace robotics autonomy simulation'
  ).split(/\s+/));

  // Multi-word phrases become one token so "open source" and "machine learning"
  // match as phrases instead of as two filler words.
  const PHRASES = [
    'machine learning', 'deep learning', 'reinforcement learning', 'computer vision', 'large language models', 'natural language processing',
    'data pipelines', 'open source', 'full stack', 'back end', 'front end', 'real time', 'low latency', 'distributed systems',
  ];

  function tokens(text) {
    let s = String(text || '').toLowerCase().replace(/[’']/g, '');
    for (const ph of PHRASES) s = s.split(ph).join(ph.replace(/ /g, '-'));
    const m = s.match(/[a-z0-9][a-z0-9+#.\/-]*[a-z0-9+#]|[a-z0-9]/g) || [];
    const out = [];
    for (let t of m) {
      t = t.replace(/[.\/-]+$/, '');
      if (t.length < 2 && !/^[cr]$/.test(t)) continue;
      if (STOP.has(t) || /^\d+$/.test(t)) continue;
      out.push(t);
      // index the parts of slash compounds like "pytorch/vllm"
      if (t.includes('/') && !TECH.has(t)) for (const part of t.split('/')) if (part.length > 1 && !STOP.has(part)) out.push(part);
    }
    return out;
  }

  function counts(list) {
    const m = new Map();
    for (const t of list) m.set(t, (m.get(t) || 0) + 1);
    return m;
  }

  // resumes: [{ id, name, text }]; returns [{ id, name, score, rel, hits }] best first.
  function rankResumes(jobText, resumes, opts) {
    opts = opts || {};
    const k1 = 1.2, b = 0.75;
    const docs = resumes.filter((r) => r && r.text).map((r) => {
      const tf = counts(tokens(r.text));
      let len = 0; tf.forEach((v) => { len += v; });
      return { r, tf, len };
    });
    if (!docs.length) return [];
    const N = docs.length;
    const avg = docs.reduce((s, d) => s + d.len, 0) / N || 1;
    const df = new Map();
    for (const d of docs) d.tf.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1));
    const q = counts(tokens(jobText));
    const scored = docs.map((d) => {
      let score = 0;
      const contrib = [];
      q.forEach((qtf, t) => {
        const tf = d.tf.get(t);
        if (!tf) return;
        const n = df.get(t) || 0;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        const tech = TECH.has(t);
        const w = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * d.len) / avg))) * (1 + Math.log(qtf)) * (tech ? 2 : 1);
        score += w;
        contrib.push({ t, w, tech, distinct: n < N });
      });
      // Show technical, distinguishing terms first.
      contrib.sort((x, y) => (y.tech - x.tech) || (y.distinct - x.distinct) || (y.w - x.w));
      return { id: d.r.id, name: d.r.name, score, hits: contrib.slice(0, opts.hits || 6).map((c) => c.t.replace(/-/g, ' ')) };
    });
    scored.sort((x, y) => y.score - x.score);
    const top = scored[0] ? scored[0].score || 1 : 1;
    scored.forEach((s) => { s.rel = Math.round((s.score / top) * 100); });
    return scored;
  }

  // "First_Last_Resume.pdf" and "First_Last_Resume.docx" are one resume.
  const baseName = (name) => String(name || '').replace(/\.(pdf|docx?|txt|md)$/i, '').trim().toLowerCase();

  root.AAFRank = { tokens, rankResumes, baseName, TECH };
})(typeof self !== 'undefined' ? self : this);
