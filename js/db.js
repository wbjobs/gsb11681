/* IndexedDB：保存转换历史（缩略图 + 元信息） */
(function (global) {
  'use strict';
  const DB_NAME = 'clipboard-converter';
  const STORE = 'history';
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function tx(mode, fn) {
    return open().then((db) => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(result && result._val);
      t.onerror = () => reject(t.error);
    }));
  }

  global.HistoryDB = {
    add(record) {
      return tx('readwrite', (store) => store.add(record));
    },
    list() {
      return tx('readonly', (store) => {
        const out = { _val: [] };
        store.openCursor(null, 'prev').onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) { out._val.push(cursor.value); cursor.continue(); }
        };
        return out;
      });
    },
    clear() {
      return tx('readwrite', (store) => store.clear());
    },
  };
})(window);
