const DB_NAME = 'livelingo-data';
const DB_VERSION = 1;
const LESSON_STORE = 'lessons';
const META_STORE = 'meta';
const MAX_LESSONS = 50;

let dbPromise = null;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LESSON_STORE)) {
        const lessons = db.createObjectStore(LESSON_STORE, { keyPath: 'id' });
        lessons.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
  });
}

async function getAllLessons() {
  const db = await openDatabase();
  const tx = db.transaction(LESSON_STORE, 'readonly');
  const done = transactionDone(tx);
  const lessons = await requestResult(tx.objectStore(LESSON_STORE).getAll());
  await done;
  return lessons.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function trimLessons() {
  const lessons = await getAllLessons();
  if (lessons.length <= MAX_LESSONS) return;
  const idsToDelete = lessons.slice(MAX_LESSONS).map((lesson) => lesson.id);
  const db = await openDatabase();
  const tx = db.transaction(LESSON_STORE, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(LESSON_STORE);
  idsToDelete.forEach((id) => store.delete(id));
  await done;
}

async function saveLesson(lesson) {
  const db = await openDatabase();
  const tx = db.transaction(LESSON_STORE, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(LESSON_STORE).put(lesson);
  await done;
  await trimLessons();
}

async function clearLessons() {
  const db = await openDatabase();
  const tx = db.transaction(LESSON_STORE, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(LESSON_STORE).clear();
  await done;
}

async function saveDraft(draft) {
  const db = await openDatabase();
  const tx = db.transaction(META_STORE, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(META_STORE).put({ key: 'draft', value: draft });
  await done;
}

async function getDraft() {
  const db = await openDatabase();
  const tx = db.transaction(META_STORE, 'readonly');
  const done = transactionDone(tx);
  const record = await requestResult(tx.objectStore(META_STORE).get('draft'));
  await done;
  return record?.value || null;
}

async function clearDraft() {
  const db = await openDatabase();
  const tx = db.transaction(META_STORE, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(META_STORE).delete('draft');
  await done;
}

async function migrateLegacyLocalStorage() {
  const marker = localStorage.getItem('ll-idb-migrated');
  if (marker === '1') return;

  try {
    const lessons = JSON.parse(localStorage.getItem('ll-lessons') || '[]');
    if (Array.isArray(lessons) && lessons.length) {
      const db = await openDatabase();
      const tx = db.transaction(LESSON_STORE, 'readwrite');
      const done = transactionDone(tx);
      const store = tx.objectStore(LESSON_STORE);
      lessons.slice(0, MAX_LESSONS).forEach((lesson) => {
        if (lesson?.id) store.put(lesson);
      });
      await done;
    }

    const draft = JSON.parse(localStorage.getItem('ll-draft') || 'null');
    if (draft?.id && Array.isArray(draft.segments)) await saveDraft(draft);

    localStorage.setItem('ll-idb-migrated', '1');
    localStorage.removeItem('ll-lessons');
    localStorage.removeItem('ll-draft');
  } catch (error) {
    console.warn('[LiveLingo] Legacy storage migration deferred', error);
  }
}

export const lessonStore = {
  init: migrateLegacyLocalStorage,
  getLessons: getAllLessons,
  saveLesson,
  clearLessons,
  saveDraft,
  getDraft,
  clearDraft
};
