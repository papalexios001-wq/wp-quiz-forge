// services/persistenceService.ts
// SOTA Enterprise-Grade Persistence Layer with IndexedDB, Write Batching, and Integrity Checks

import { ToolIdea, ContentHealth } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

const DB_NAME = 'QuizForgeDB';
const DB_VERSION = 2;
const DRAFTS_STORE = 'drafts';
const METADATA_STORE = 'metadata';
const BATCH_DELAY_MS = 500;
const MAX_DRAFTS = 200;
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DraftData {
    ideas?: ToolIdea[];
    health?: ContentHealth | null;
    selectedIdea?: ToolIdea | null;
    generatedQuizHtml?: string;
    suggestedContentUpdate?: string | null;
}

interface StoredDraft extends DraftData {
    postId: number;
    updatedAt: number;
    version: number;
    checksum: string;
}

interface DBMetadata {
    key: string;
    value: any;
    updatedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE SINGLETON
// ═══════════════════════════════════════════════════════════════════════════════

let dbInstance: IDBDatabase | null = null;
let dbInitPromise: Promise<IDBDatabase> | null = null;

async function getDB(): Promise<IDBDatabase> {
    if (dbInstance) return dbInstance;
    if (dbInitPromise) return dbInitPromise;

    dbInitPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => {
            console.error('[PersistenceService] Database error:', request.error);
            reject(request.error);
        };

        request.onsuccess = () => {
            dbInstance = request.result;
            
            // Handle connection loss
            dbInstance.onclose = () => {
                dbInstance = null;
                dbInitPromise = null;
            };
            
            dbInstance.onerror = (event) => {
                console.error('[PersistenceService] Database runtime error:', event);
            };

            resolve(dbInstance);
        };

        request.onupgradeneeded = (event) => {
            const db = (event.target as IDBOpenDBRequest).result;

            // Drafts store
            if (!db.objectStoreNames.contains(DRAFTS_STORE)) {
                const draftsStore = db.createObjectStore(DRAFTS_STORE, { keyPath: 'postId' });
                draftsStore.createIndex('updatedAt', 'updatedAt', { unique: false });
            }

            // Metadata store for app settings
            if (!db.objectStoreNames.contains(METADATA_STORE)) {
                db.createObjectStore(METADATA_STORE, { keyPath: 'key' });
            }
        };
    });

    return dbInitPromise;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKSUM UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function computeChecksum(data: DraftData): string {
    const str = JSON.stringify(data);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

function validateChecksum(stored: StoredDraft): boolean {
    const { postId, updatedAt, version, checksum, ...data } = stored;
    return computeChecksum(data) === checksum;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WRITE BATCHING
// ═══════════════════════════════════════════════════════════════════════════════

interface BatchedWrite {
    postId: number;
    data: DraftData;
    timestamp: number;
}

const pendingWrites: Map<number, BatchedWrite> = new Map();
let batchTimer: ReturnType<typeof setTimeout> | null = null;

async function flushBatch(): Promise<void> {
    if (pendingWrites.size === 0) return;

    const writes = Array.from(pendingWrites.values());
    pendingWrites.clear();
    batchTimer = null;

    const db = await getDB();
    const transaction = db.transaction(DRAFTS_STORE, 'readwrite');
    const store = transaction.objectStore(DRAFTS_STORE);

    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);

        for (const write of writes) {
            const storedDraft: StoredDraft = {
                postId: write.postId,
                ...write.data,
                updatedAt: write.timestamp,
                version: DB_VERSION,
                checksum: computeChecksum(write.data),
            };
            store.put(storedDraft);
        }
    });
}

function scheduleBatch(): void {
    if (batchTimer) return;
    batchTimer = setTimeout(flushBatch, BATCH_DELAY_MS);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GARBAGE COLLECTION
// ═══════════════════════════════════════════════════════════════════════════════

async function evictOldDrafts(): Promise<number> {
    const db = await getDB();
    const transaction = db.transaction(DRAFTS_STORE, 'readwrite');
    const store = transaction.objectStore(DRAFTS_STORE);
    const index = store.index('updatedAt');

    return new Promise((resolve, reject) => {
        const now = Date.now();
        const cutoff = now - DRAFT_TTL_MS;
        let evicted = 0;

        const countRequest = store.count();
        countRequest.onsuccess = () => {
            const totalCount = countRequest.result;
            
            if (totalCount <= MAX_DRAFTS) {
                // Only evict expired items
                const range = IDBKeyRange.upperBound(cutoff);
                const cursor = index.openCursor(range);
                
                cursor.onsuccess = (event) => {
                    const c = (event.target as IDBRequest).result;
                    if (c) {
                        c.delete();
                        evicted++;
                        c.continue();
                    } else {
                        resolve(evicted);
                    }
                };
            } else {
                // Evict oldest until under limit
                const toEvict = totalCount - MAX_DRAFTS + 10; // Buffer
                const cursor = index.openCursor();
                
                cursor.onsuccess = (event) => {
                    const c = (event.target as IDBRequest).result;
                    if (c && evicted < toEvict) {
                        c.delete();
                        evicted++;
                        c.continue();
                    } else {
                        resolve(evicted);
                    }
                };
            }
        };

        transaction.onerror = () => reject(transaction.error);
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API - DRAFTS
// ═══════════════════════════════════════════════════════════════════════════════

export async function saveDraft(postId: number, data: DraftData): Promise<void> {
    // Merge with pending write if exists
    const existing = pendingWrites.get(postId);
    const mergedData = existing ? { ...existing.data, ...data } : data;

    pendingWrites.set(postId, {
        postId,
        data: mergedData,
        timestamp: Date.now(),
    });

    scheduleBatch();
}

export async function saveDraftImmediate(postId: number, data: DraftData): Promise<void> {
    // Bypass batching for critical saves
    const db = await getDB();
    const transaction = db.transaction(DRAFTS_STORE, 'readwrite');
    const store = transaction.objectStore(DRAFTS_STORE);

    const storedDraft: StoredDraft = {
        postId,
        ...data,
        updatedAt: Date.now(),
        version: DB_VERSION,
        checksum: computeChecksum(data),
    };

    return new Promise((resolve, reject) => {
        const request = store.put(storedDraft);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

export async function getDraft(postId: number): Promise<DraftData | null> {
    // Check pending writes first
    const pending = pendingWrites.get(postId);
    if (pending) return pending.data;

    try {
        const db = await getDB();
        const transaction = db.transaction(DRAFTS_STORE, 'readonly');
        const store = transaction.objectStore(DRAFTS_STORE);

        return new Promise((resolve, reject) => {
            const request = store.get(postId);
            
            request.onsuccess = () => {
                const stored = request.result as StoredDraft | undefined;
                
                if (!stored) {
                    resolve(null);
                    return;
                }

                // Validate integrity
                if (!validateChecksum(stored)) {
                    console.warn(`[PersistenceService] Checksum mismatch for post ${postId}, discarding`);
                    deleteDraft(postId).catch(() => {});
                    resolve(null);
                    return;
                }

                // Check expiry
                if (Date.now() - stored.updatedAt > DRAFT_TTL_MS) {
                    deleteDraft(postId).catch(() => {});
                    resolve(null);
                    return;
                }

                const { postId: _, updatedAt, version, checksum, ...data } = stored;
                resolve(data);
            };

            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[PersistenceService] getDraft error:', error);
        return null;
    }
}

export async function deleteDraft(postId: number): Promise<void> {
    // Remove from pending
    pendingWrites.delete(postId);

    try {
        const db = await getDB();
        const transaction = db.transaction(DRAFTS_STORE, 'readwrite');
        const store = transaction.objectStore(DRAFTS_STORE);

        return new Promise((resolve, reject) => {
            const request = store.delete(postId);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[PersistenceService] deleteDraft error:', error);
    }
}

export async function getAllDrafts(): Promise<Map<number, DraftData>> {
    const results = new Map<number, DraftData>();

    // Add pending writes
    pendingWrites.forEach((write, postId) => {
        results.set(postId, write.data);
    });

    try {
        const db = await getDB();
        const transaction = db.transaction(DRAFTS_STORE, 'readonly');
        const store = transaction.objectStore(DRAFTS_STORE);

        return new Promise((resolve, reject) => {
            const request = store.getAll();

            request.onsuccess = () => {
                const stored = request.result as StoredDraft[];
                const now = Date.now();

                for (const draft of stored) {
                    if (!validateChecksum(draft)) continue;
                    if (now - draft.updatedAt > DRAFT_TTL_MS) continue;
                    if (results.has(draft.postId)) continue; // Pending takes priority

                    const { postId, updatedAt, version, checksum, ...data } = draft;
                    results.set(postId, data);
                }

                resolve(results);
            };

            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[PersistenceService] getAllDrafts error:', error);
        return results;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC API - METADATA
// ═══════════════════════════════════════════════════════════════════════════════

export async function setMetadata<T>(key: string, value: T): Promise<void> {
    try {
        const db = await getDB();
        const transaction = db.transaction(METADATA_STORE, 'readwrite');
        const store = transaction.objectStore(METADATA_STORE);

        const entry: DBMetadata = {
            key,
            value,
            updatedAt: Date.now(),
        };

        return new Promise((resolve, reject) => {
            const request = store.put(entry);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[PersistenceService] setMetadata error:', error);
    }
}

export async function getMetadata<T>(key: string): Promise<T | null> {
    try {
        const db = await getDB();
        const transaction = db.transaction(METADATA_STORE, 'readonly');
        const store = transaction.objectStore(METADATA_STORE);

        return new Promise((resolve, reject) => {
            const request = store.get(key);
            request.onsuccess = () => {
                const entry = request.result as DBMetadata | undefined;
                resolve(entry?.value ?? null);
            };
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('[PersistenceService] getMetadata error:', error);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAINTENANCE
// ═══════════════════════════════════════════════════════════════════════════════

export async function runMaintenance(): Promise<{ evicted: number; flushed: number }> {
    await flushBatch();
    const evicted = await evictOldDrafts();
    return { evicted, flushed: pendingWrites.size };
}

export async function clearAllData(): Promise<void> {
    pendingWrites.clear();
    if (batchTimer) {
        clearTimeout(batchTimer);
        batchTimer = null;
    }

    const db = await getDB();
    const transaction = db.transaction([DRAFTS_STORE, METADATA_STORE], 'readwrite');

    return new Promise((resolve, reject) => {
        transaction.objectStore(DRAFTS_STORE).clear();
        transaction.objectStore(METADATA_STORE).clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
    });
}

export function getStats(): { pendingWrites: number; batchScheduled: boolean } {
    return {
        pendingWrites: pendingWrites.size,
        batchScheduled: batchTimer !== null,
    };
}

// Initialize maintenance on load
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        flushBatch();
    });

    // Run maintenance every 5 minutes
    setInterval(() => {
        runMaintenance().catch(console.error);
    }, 5 * 60 * 1000);
}
