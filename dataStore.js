import { 
    db, 
    isFirebaseConfigured, 
    signInAnonymouslyIfNeeded,
    onAuthChanged
} from './firebase.js';

import { 
    collection, 
    addDoc, 
    deleteDoc, 
    doc, 
    getDocs, 
    query, 
    where,
    orderBy,
    serverTimestamp,
    onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

const COLLECTION_NAME = 'calendar_entries';
const STORAGE_KEY = 'calendar_entries_local';

// サンプルデータ（Firebase未設定時のデモ用）
const SAMPLE_DATA = [
    {
        id: 'sample1',
        date: '2025-12-02',
        monthKey: '2025-12',
        userName: '田中',
        text: '午前休',
        createdAt: new Date('2025-12-01T10:00:00').toISOString()
    },
    {
        id: 'sample2',
        date: '2025-12-03',
        monthKey: '2025-12',
        userName: '関',
        text: 'やすみ',
        createdAt: new Date('2025-12-01T11:00:00').toISOString()
    },
    {
        id: 'sample3',
        date: '2025-12-03',
        monthKey: '2025-12',
        userName: '佐藤',
        text: '〇〇現場',
        createdAt: new Date('2025-12-01T12:00:00').toISOString()
    },
    {
        id: 'sample4',
        date: '2025-12-10',
        monthKey: '2025-12',
        userName: '鈴木',
        text: '△△現場',
        createdAt: new Date('2025-12-05T09:00:00').toISOString()
    },
    {
        id: 'sample5',
        date: '2025-12-15',
        monthKey: '2025-12',
        userName: '山田',
        text: 'やすみ',
        createdAt: new Date('2025-12-10T10:00:00').toISOString()
    },
    {
        id: 'sample6',
        date: '2025-12-17',
        monthKey: '2025-12',
        userName: '伊藤',
        text: '午後休',
        createdAt: new Date('2025-12-15T14:00:00').toISOString()
    },
    {
        id: 'sample7',
        date: '2025-12-17',
        monthKey: '2025-12',
        userName: '渡辺',
        text: 'やすみ',
        createdAt: new Date('2025-12-15T15:00:00').toISOString()
    },
    {
        id: 'sample8',
        date: '2025-12-17',
        monthKey: '2025-12',
        userName: '加藤',
        text: '□□現場',
        createdAt: new Date('2025-12-15T16:00:00').toISOString()
    },
    {
        id: 'sample9',
        date: '2025-12-25',
        monthKey: '2025-12',
        userName: '高橋',
        text: '◇◇現場',
        createdAt: new Date('2025-12-20T10:00:00').toISOString()
    }
];

class DataStore {
    constructor() {
        this.useFirestore = false;
        this.listeners = [];
        this.user = null;
        this.init();
    }

    async init() {
        // Firebase設定チェック
        if (isFirebaseConfigured) {
            console.log('🔥 Firestoreモードで起動');
            
            // 認証状態監視
            onAuthChanged(async (user) => {
                if (user) {
                    this.user = user;
                    this.useFirestore = true;
                    console.log('✅ 認証済み:', user.uid);
                    this.notifyListeners('connected');
                } else {
                    // 匿名ログイン試行
                    const loggedInUser = await signInAnonymouslyIfNeeded();
                    if (loggedInUser) {
                        this.user = loggedInUser;
                        this.useFirestore = true;
                        this.notifyListeners('connected');
                    } else {
                        this.fallbackToLocalStorage();
                    }
                }
            });
        } else {
            this.fallbackToLocalStorage();
        }
    }

    fallbackToLocalStorage() {
        console.log('💾 localStorageモードで起動');
        this.useFirestore = false;
        
        // 初回のみサンプルデータを設定
        const existing = localStorage.getItem(STORAGE_KEY);
        if (!existing) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(SAMPLE_DATA));
            console.log('📝 サンプルデータを読み込みました');
        }
        
        this.notifyListeners('offline');
    }

    // ステータス変更通知
    addListener(callback) {
        this.listeners.push(callback);
    }

    notifyListeners(status) {
        this.listeners.forEach(callback => callback(status));
    }

    // 特定月のエントリ取得
    async getEntriesByMonth(monthKey) {
        if (this.useFirestore) {
            return await this.getEntriesByMonthFromFirestore(monthKey);
        } else {
            return this.getEntriesByMonthFromLocalStorage(monthKey);
        }
    }

    async getEntriesByMonthFromFirestore(monthKey) {
        try {
            const q = query(
                collection(db, COLLECTION_NAME),
                where('monthKey', '==', monthKey),
                orderBy('date', 'asc'),
                orderBy('createdAt', 'asc')
            );
            const querySnapshot = await getDocs(q);
            
            const entries = [];
            querySnapshot.forEach((doc) => {
                const data = doc.data();
                entries.push({
                    id: doc.id,
                    ...data,
                    createdAt: data.createdAt?.toDate?.() ? data.createdAt.toDate().toISOString() : data.createdAt
                });
            });
            
            return entries;
        } catch (error) {
            console.error('Firestore取得エラー:', error);
            return [];
        }
    }

    getEntriesByMonthFromLocalStorage(monthKey) {
        const data = localStorage.getItem(STORAGE_KEY);
        const allEntries = data ? JSON.parse(data) : [];
        return allEntries.filter(entry => entry.monthKey === monthKey);
    }

    // リアルタイム更新監視
    subscribeToEntries(monthKey, callback) {
        if (this.useFirestore) {
            const q = query(
                collection(db, COLLECTION_NAME),
                where('monthKey', '==', monthKey),
                orderBy('date', 'asc'),
                orderBy('createdAt', 'asc')
            );
            return onSnapshot(q, (querySnapshot) => {
                const entries = [];
                querySnapshot.forEach((doc) => {
                    const data = doc.data();
                    entries.push({
                        id: doc.id,
                        ...data,
                        createdAt: data.createdAt?.toDate?.() ? data.createdAt.toDate().toISOString() : data.createdAt
                    });
                });
                callback(entries);
            });
        } else {
            // localStorageは手動更新のみ
            return null;
        }
    }

    // エントリ追加
    async addEntry(entryData) {
        if (this.useFirestore) {
            return await this.addEntryToFirestore(entryData);
        } else {
            return this.addEntryToLocalStorage(entryData);
        }
    }

    async addEntryToFirestore(entryData) {
        try {
            const docData = {
                ...entryData,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
            };
            
            const docRef = await addDoc(collection(db, COLLECTION_NAME), docData);
            console.log('✅ Firestoreに追加:', docRef.id);
            return docRef.id;
        } catch (error) {
            console.error('Firestore追加エラー:', error);
            throw error;
        }
    }

    addEntryToLocalStorage(entryData) {
        const data = localStorage.getItem(STORAGE_KEY);
        const entries = data ? JSON.parse(data) : [];
        
        const newEntry = {
            id: 'local_' + Date.now(),
            ...entryData,
            createdAt: new Date().toISOString()
        };
        
        entries.push(newEntry);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
        console.log('✅ localStorageに追加:', newEntry.id);
        return newEntry.id;
    }

    // エントリ削除
    async deleteEntry(entryId) {
        if (this.useFirestore) {
            return await this.deleteEntryFromFirestore(entryId);
        } else {
            return this.deleteEntryFromLocalStorage(entryId);
        }
    }

    async deleteEntryFromFirestore(entryId) {
        try {
            const docRef = doc(db, COLLECTION_NAME, entryId);
            await deleteDoc(docRef);
            console.log('✅ Firestore削除:', entryId);
            return true;
        } catch (error) {
            console.error('Firestore削除エラー:', error);
            throw error;
        }
    }

    deleteEntryFromLocalStorage(entryId) {
        const data = localStorage.getItem(STORAGE_KEY);
        const entries = data ? JSON.parse(data) : [];
        const filtered = entries.filter(e => e.id !== entryId);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
        console.log('✅ localStorage削除:', entryId);
        return true;
    }
}

// シングルトンインスタンス
const dataStore = new DataStore();

export default dataStore;