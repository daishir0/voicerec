import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useColorScheme } from 'react-native';
import * as FileSystem from 'expo-file-system';
import { ServerSettings, RecordingEntry } from '@/types/recording';
import { loadSettings, saveSettings, loadRecordings, saveRecordings } from '@/services/storage-service';
import { uploadRecording } from '@/services/upload-service';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DARK_MODE_KEY = 'rec18082_darkMode';

interface Theme {
  bg: string;
  bgSecondary: string;
  bgTertiary: string;
  text: string;
  textSecondary: string;
  border: string;
  accent: string;
  red: string;
}

interface AppContextType {
  settings: ServerSettings;
  recordings: RecordingEntry[];
  isDarkMode: boolean;
  theme: Theme;
  updateSettings: (settings: ServerSettings) => Promise<void>;
  addRecording: (recording: RecordingEntry) => Promise<void>;
  updateRecording: (id: string, updates: Partial<RecordingEntry>) => Promise<void>;
  deleteRecording: (id: string) => Promise<void>;
  uploadPending: () => void;
  toggleDarkMode: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const systemColorScheme = useColorScheme();
  const [settings, setSettings] = useState<ServerSettings>({
    serverUrl: process.env.EXPO_PUBLIC_SERVER_URL || '',
    username: '',
    password: '',
  });
  const [recordings, setRecordings] = useState<RecordingEntry[]>([]);
  const [isDarkMode, setIsDarkMode] = useState(systemColorScheme === 'dark');
  const [loaded, setLoaded] = useState(false);

  // Refs で常に最新の値を参照できるようにする
  const recordingsRef = useRef(recordings);
  recordingsRef.current = recordings;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const uploadingRef = useRef(false);

  useEffect(() => {
    (async () => {
      const [savedSettings, savedRecordings, savedDark] = await Promise.all([
        loadSettings(),
        loadRecordings(),
        AsyncStorage.getItem(DARK_MODE_KEY),
      ]);
      if (savedSettings) setSettings(savedSettings);
      if (savedRecordings.length) setRecordings(savedRecordings);
      if (savedDark !== null) setIsDarkMode(savedDark === 'true');
      setLoaded(true);
    })();
  }, []);

  // Cleanup old uploaded recordings (24h+) and auto-upload on mount
  useEffect(() => {
    if (loaded) {
      cleanupOldRecordings().then(() => doUploadPending());
    }
  }, [loaded]);

  const cleanupOldRecordings = useCallback(async () => {
    const now = Date.now();
    const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
    const current = recordingsRef.current;

    const toDelete = current.filter(
      r => r.uploadStatus === 'uploaded' && now - new Date(r.createdAt).getTime() > TWENTY_FOUR_HOURS
    );

    if (toDelete.length === 0) return;

    // 物理ファイル削除
    for (const rec of toDelete) {
      try {
        const info = await FileSystem.getInfoAsync(rec.uri);
        if (info.exists) {
          await FileSystem.deleteAsync(rec.uri, { idempotent: true });
        }
      } catch (e) {
        console.warn(`cleanup: ファイル削除失敗 ${rec.uri}`, e);
      }
    }

    // リストから除外して保存
    const deleteIds = new Set(toDelete.map(r => r.id));
    const next = current.filter(r => !deleteIds.has(r.id));
    recordingsRef.current = next;
    setRecordings(next);
    await saveRecordings(next);
    console.log(`cleanup: ${toDelete.length}件の古い録音を削除しました`);
  }, []);

  const theme: Theme = {
    bg: isDarkMode ? '#000' : '#fff',
    bgSecondary: isDarkMode ? '#1c1c1e' : '#f2f2f7',
    bgTertiary: isDarkMode ? '#2c2c2e' : '#e5e5ea',
    text: isDarkMode ? '#fff' : '#000',
    textSecondary: isDarkMode ? '#8e8e93' : '#6c6c70',
    border: isDarkMode ? '#38383a' : '#c6c6c8',
    accent: '#FF3B30',
    red: '#FF3B30',
  };

  const updateSettingsHandler = useCallback(async (newSettings: ServerSettings) => {
    setSettings(newSettings);
    await saveSettings(newSettings);
  }, []);

  const addRecording = useCallback(async (recording: RecordingEntry) => {
    const next = [recording, ...recordingsRef.current];
    recordingsRef.current = next;
    setRecordings(next);
    await saveRecordings(next);
  }, []);

  const updateRecording = useCallback(async (id: string, updates: Partial<RecordingEntry>) => {
    const next = recordingsRef.current.map(r => (r.id === id ? { ...r, ...updates } : r));
    recordingsRef.current = next;
    setRecordings(next);
    await saveRecordings(next);
  }, []);

  const deleteRecording = useCallback(async (id: string) => {
    const next = recordingsRef.current.filter(r => r.id !== id);
    recordingsRef.current = next;
    setRecordings(next);
    await saveRecordings(next);
  }, []);

  // アップロード処理 — ref経由で常に最新のsettings/recordingsを使う
  const doUploadPending = useCallback(async () => {
    if (uploadingRef.current) return; // 二重実行防止
    uploadingRef.current = true;

    try {
      const s = settingsRef.current;
      if (!s.serverUrl || !s.username || !s.password) {
        console.log('uploadPending: 設定未完了のためスキップ', { url: s.serverUrl, user: s.username });
        return;
      }

      const pending = recordingsRef.current.filter(
        r => r.uploadStatus === 'waiting' || r.uploadStatus === 'failed'
      );
      console.log(`uploadPending: ${pending.length}件のアップロード待ち`);

      for (const rec of pending) {
        // uploading に更新
        const updating = recordingsRef.current.map(r =>
          r.id === rec.id ? { ...r, uploadStatus: 'uploading' as const } : r
        );
        recordingsRef.current = updating;
        setRecordings([...updating]);
        saveRecordings(updating);

        console.log(`uploading: ${rec.filename} → ${s.serverUrl}`);
        const result = await uploadRecording(s, rec);
        console.log(`upload result: ${rec.filename} → ok=${result.ok}`);

        // 結果を反映
        const updated = recordingsRef.current.map(r =>
          r.id === rec.id
            ? {
                ...r,
                uploadStatus: result.ok ? ('uploaded' as const) : ('failed' as const),
                serverId: result.serverId ?? r.serverId,
              }
            : r
        );
        recordingsRef.current = updated;
        setRecordings([...updated]);
        saveRecordings(updated);
      }
    } finally {
      uploadingRef.current = false;
    }
  }, []);

  // uploadPending は常に最新のref値を使うので依存配列空でOK
  const uploadPending = useCallback(() => {
    // 少し遅延させて、addRecordingのstate反映を待つ
    setTimeout(() => doUploadPending(), 500);
  }, [doUploadPending]);

  const toggleDarkMode = useCallback(() => {
    setIsDarkMode(prev => {
      const next = !prev;
      AsyncStorage.setItem(DARK_MODE_KEY, String(next));
      return next;
    });
  }, []);

  return (
    <AppContext.Provider
      value={{
        settings,
        recordings,
        isDarkMode,
        theme,
        updateSettings: updateSettingsHandler,
        addRecording,
        updateRecording,
        deleteRecording,
        uploadPending,
        toggleDarkMode,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
