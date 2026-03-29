/**
 * storage.js — Phase 2: IndexedDB + GPS 통합 저장
 */

const TreeStorage = (() => {
    const DB_NAME = 'TreeMeasureDB';
    const DB_VERSION = 3;
    const STORE_NAME = 'measurements';

    function openDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                // 기존 스토어 삭제 후 재생성 (v2 → v3 스키마 변경)
                if (db.objectStoreNames.contains(STORE_NAME)) {
                    db.deleteObjectStore(STORE_NAME);
                }
                const store = db.createObjectStore(STORE_NAME, {
                    keyPath: 'id',
                    autoIncrement: true,
                });
                store.createIndex('timestamp', 'timestamp', { unique: false });
                store.createIndex('treeId', 'treeId', { unique: false });
                store.createIndex('lat', 'lat', { unique: false });
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * 측정 데이터 저장
     * GPS가 measure.js에서 이미 취득되었으면 그것을 사용하고,
     * 없으면 여기서 다시 시도한다.
     */
    async function save(data) {
        const db = await openDB();

        // GPS가 없으면 여기서 취득 시도
        if (!data.gps && navigator.geolocation) {
            try {
                const pos = await new Promise((resolve, reject) => {
                    navigator.geolocation.getCurrentPosition(resolve, reject, {
                        timeout: 5000,
                        enableHighAccuracy: true,
                    });
                });
                data.gps = {
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                    accuracy: pos.coords.accuracy,
                    altitude: pos.coords.altitude,
                };
            } catch (e) {
                data.gps = null;
            }
        }

        // 타임스탬프 보장
        if (!data.timestamp) data.timestamp = Date.now();

        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.add(data);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function getAll() {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const request = store.getAll();
            request.onsuccess = () => {
                const results = request.result.sort((a, b) => b.timestamp - a.timestamp);
                resolve(results);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async function remove(id) {
        const db = await openDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const request = store.delete(id);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    return { save, getAll, remove };
})();
