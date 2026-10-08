// Original resume files (PDF, DOCX) kept in this extension's IndexedDB so the popup
// can hand you a renamed copy. Nothing here leaves your browser.
(function (root) {
  let dbp = null;
  function db() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open('apply-autofill-files', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('files');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbp;
  }
  async function tx(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const t = d.transaction('files', mode);
      const req = fn(t.objectStore('files'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  }
  root.AAFFiles = {
    put: (id, blob) => tx('readwrite', (s) => s.put(blob, id)),
    get: (id) => tx('readonly', (s) => s.get(id)),
    del: (id) => tx('readwrite', (s) => s.delete(id)),
  };
})(typeof self !== 'undefined' ? self : this);
