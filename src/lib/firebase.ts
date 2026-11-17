import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth, signInWithEmailAndPassword, signInAnonymously } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getDatabase, type Database } from 'firebase/database';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyBcFoCsAdYWk9jsRfwbhm1Qepv5k1EdvvM',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'greenminds-2e90e.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'greenminds-2e90e',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'greenminds-2e90e.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '397125716933',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:397125716933:web:eddcb983a6b785d89e99ac',
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL || 'https://greenminds-2e90e-default-rtdb.firebaseio.com',
};

export const isFirebaseConfigured = (): boolean => {
  return Boolean(
    firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    firebaseConfig.databaseURL
  );
};

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;
let rtdb: Database | null = null;

if (isFirebaseConfigured()) {
  try {
    if (!getApps().length) {
      app = initializeApp(firebaseConfig);
    } else {
      app = getApps()[0];
    }
    auth = getAuth(app);
    db = getFirestore(app);
    rtdb = getDatabase(app);
    console.log('✅ Firebase initialized successfully with project:', firebaseConfig.projectId);
  } catch (err) {
    console.error('⚠️ Firebase initialization error:', err);
  }
} else {
  console.info('ℹ️ Firebase environment variables missing or incomplete.');
}

/**
 * Ensures Firebase Auth session is active before RTDB operations execute.
 * Uses Arduino device credentials from config or falls back to anonymous authentication.
 */
let authPromise: Promise<boolean> | null = null;

export const ensureFirebaseAuth = async (): Promise<boolean> => {
  if (!auth) return false;
  if (auth.currentUser) return true;
  if (authPromise) return authPromise;

  authPromise = (async () => {
    const defaultEmail = import.meta.env.VITE_FIREBASE_DEFAULT_EMAIL || 'krishnatheking07@gmail.com';
    const defaultPassword = import.meta.env.VITE_FIREBASE_DEFAULT_PASSWORD || '88888888';

    try {
      const cred = await signInWithEmailAndPassword(auth!, defaultEmail, defaultPassword);
      console.log('✅ Firebase Auth authenticated as:', cred.user.email);
      return true;
    } catch (err: any) {
      console.warn('⚠️ Firebase email/password auth failed, trying anonymous auth:', err?.message || err);
      try {
        const anonCred = await signInAnonymously(auth!);
        console.log('✅ Firebase Auth authenticated anonymously:', anonCred.user.uid);
        return true;
      } catch (anonErr: any) {
        console.error('❌ Firebase Auth failed completely:', anonErr?.message || anonErr);
        return false;
      }
    } finally {
      authPromise = null;
    }
  })();

  return authPromise;
};

// Initiate auto-auth in background
if (auth) {
  ensureFirebaseAuth().catch((e) => console.warn('Background auto-auth notice:', e));
}

const database = rtdb;

export { app, auth, db, rtdb, database };
