import React, { createContext, useContext, useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useColorScheme, AppState } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { ServerSettings, RecordingEntry } from '@/types/recording';
import { loadSettings, saveSettings, loadRecordings, saveRecordings } from '@/services/storage-service';
import { uploadRecording } from '@/services/upload-service';
import { log, registerLogListener } from '@/services/logger';
import type { RecordingQuality } from '@/services/audio-recorder';
import { recoverOrphanRecordings } from '@/services/recording-guard';
import {
  applyRetention,
  DEFAULT_RETENTION_DAYS,
  RETENTION_CHOICES,
  type RetentionDays,
} from '@/services/retention';
import {
  getPermissionStatus as getNotificationPermissionStatus,
  requestPermission as requestNotificationPermission,
  notifyUploadSuccess,
  notifyUploadFailed,
  setBadgeCount,
} from '@/services/notification-service';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DARK_MODE_KEY = 'rec18082_darkMode';
const DEBUG_MODE_KEY = 'rec18082_debugMode';
const RECORDING_QUALITY_KEY = 'rec18082_recordingQuality';
const NOTIFICATIONS_ENABLED_KEY = 'rec18082_notificationsEnabled';
const RETENTION_DAYS_KEY = 'rec18082_retentionDays';
const KEEP_UNUPLOADED_KEY = 'rec18082_keepUnuploaded';
const TRANSCRIBE_LOCALE_KEY = 'rec18082_transcribeLocale';
const COEXIST_KEY = 'rec18082_coexistWithOtherApps';
const START_TAB_KEY = 'rec18082_startTab';
const RECORDINGS_DIR = FileSystem.documentDirectory + 'recordings/';
const LEVELS_DIR = FileSystem.documentDirectory + 'levels/';

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
  isDebugMode: boolean;
  debugLogs: string[];
  recordingQuality: RecordingQuality;
  notificationsEnabled: boolean;
  /** 何日より古い録音を自動削除するか。0 は削除しない */
  retentionDays: RetentionDays;
  /** 未アップロードのものを自動削除から守るか */
  keepUnuploaded: boolean;
  /** 端末内の文字起こしに使う言語 */
  transcribeLocale: string;
  /**
   * 他アプリの音を止めずに録り続けるか。
   * true なら動画や音楽が始まっても録音が中断されない代わりに、スピーカーから出た音を拾う。
   */
  coexistWithOtherApps: boolean;
  /** 録音を始めるときに渡す音声モード。設定を1箇所にまとめる */
  recordingAudioMode: {
    allowsRecording: true;
    playsInSilentMode: true;
    shouldPlayInBackground: true;
    allowsBackgroundRecording: true;
    interruptionMode: 'mixWithOthers' | 'doNotMix';
  };
  /** いまどちらのタブが録音しているか。録音機は1つしか動かせない */
  activeRecorder: 'quick' | 'long' | null;
  /** 起動したときに開くタブ */
  startTab: 'index' | 'clip' | 'recordings';
  /** 保存してある設定を読み終えたか。読む前に画面を組むと既定値で固まる項目がある */
  settingsLoaded: boolean;
  theme: Theme;
  updateSettings: (settings: ServerSettings) => Promise<void>;
  addRecording: (recording: RecordingEntry) => Promise<void>;
  updateRecording: (id: string, updates: Partial<RecordingEntry>) => Promise<void>;
  deleteRecording: (id: string) => Promise<void>;
  uploadPending: () => void;
  retryUpload: (id: string) => void;
  toggleDarkMode: () => void;
  toggleDebugMode: () => void;
  clearDebugLogs: () => void;
  addDebugLog: (message: string) => void;
  setRecordingQuality: (quality: RecordingQuality) => void;
  setNotificationsEnabled: (enabled: boolean) => Promise<boolean>;
  setRetentionDays: (days: RetentionDays) => void;
  setTranscribeLocale: (locale: string) => void;
  setCoexistWithOtherApps: (on: boolean) => void;
  setStartTab: (tab: 'index' | 'clip' | 'recordings') => void;
  setActiveRecorder: (who: 'quick' | 'long' | null) => void;
  setKeepUnuploaded: (keep: boolean) => void;
  /** いますぐ自動削除を走らせる */
  runRetention: () => Promise<void>;
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
  const [isDebugMode, setIsDebugMode] = useState(false);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [recordingQuality, setRecordingQualityState] = useState<RecordingQuality>('standard');
  const [notificationsEnabled, setNotificationsEnabledState] = useState(false);
  const [retentionDays, setRetentionDaysState] = useState<RetentionDays>(DEFAULT_RETENTION_DAYS);
  const [keepUnuploaded, setKeepUnuploadedState] = useState(true);
  const [transcribeLocale, setTranscribeLocaleState] = useState('ja-JP');
  const [coexistWithOtherApps, setCoexistState] = useState(true);
  const [startTab, setStartTabState] = useState<'index' | 'clip' | 'recordings'>('index');
  const [activeRecorder, setActiveRecorder] = useState<'quick' | 'long' | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Refs で常に最新の値を参照できるようにする
  const recordingsRef = useRef(recordings);
  recordingsRef.current = recordings;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const uploadingRef = useRef(false);
  const uploadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const debugModeRef = useRef(isDebugMode);
  debugModeRef.current = isDebugMode;
  const notificationsEnabledRef = useRef(notificationsEnabled);
  notificationsEnabledRef.current = notificationsEnabled;
  const retentionRef = useRef({ days: retentionDays, keepUnuploaded });
  retentionRef.current = { days: retentionDays, keepUnuploaded };

  // デバッグログ追加（最新200件を保持）
  // 診断用 progress callback が 1 秒間隔で多数のログを出すため上限を拡張
  const addDebugLog = useCallback((message: string) => {
    const ts = new Date().toLocaleTimeString('ja-JP');
    const line = `[${ts}] ${message}`;
    console.log(`[DEBUG] ${message}`);
    setDebugLogs(prev => [line, ...prev].slice(0, 200));
  }, []);

  // logger.ts (services/logger.ts) の log() 出力を UI のデバッグログにも橋渡し
  // upload-service.ts などからの diag ログがそのまま表示される
  useEffect(() => {
    const unregister = registerLogListener((msg) => addDebugLog(msg));
    return () => unregister();
  }, [addDebugLog]);

  useEffect(() => {
    (async () => {
      const [savedSettings, savedRecordings, savedDark, savedDebug, savedQuality, savedNotify,
             savedRetention, savedKeepUnuploaded] = await Promise.all([
        loadSettings(),
        loadRecordings(),
        AsyncStorage.getItem(DARK_MODE_KEY),
        AsyncStorage.getItem(DEBUG_MODE_KEY),
        AsyncStorage.getItem(RECORDING_QUALITY_KEY),
        AsyncStorage.getItem(NOTIFICATIONS_ENABLED_KEY),
        AsyncStorage.getItem(RETENTION_DAYS_KEY),
        AsyncStorage.getItem(KEEP_UNUPLOADED_KEY),
      ]);
      const savedLocale = await AsyncStorage.getItem(TRANSCRIBE_LOCALE_KEY);
      if (savedLocale) setTranscribeLocaleState(savedLocale);
      const savedCoexist = await AsyncStorage.getItem(COEXIST_KEY);
      if (savedCoexist === 'false') setCoexistState(false);
      const savedTab = await AsyncStorage.getItem(START_TAB_KEY);
      if (savedTab === 'clip' || savedTab === 'recordings' || savedTab === 'index') {
        setStartTabState(savedTab);
      }
      const days = Number(savedRetention);
      if ((RETENTION_CHOICES as readonly number[]).includes(days)) {
        setRetentionDaysState(days as RetentionDays);
        retentionRef.current.days = days as RetentionDays;
      }
      if (savedKeepUnuploaded === 'false') {
        setKeepUnuploadedState(false);
        retentionRef.current.keepUnuploaded = false;
      }
      if (savedSettings) setSettings(savedSettings);
      if (savedDebug !== null) setIsDebugMode(savedDebug === 'true');
      if (savedDark !== null) setIsDarkMode(savedDark === 'true');
      if (savedQuality === 'high' || savedQuality === 'standard') {
        setRecordingQualityState(savedQuality);
      }
      if (savedNotify === 'true') {
        // 永続化 ON でも OS で拒否されていたら OFF に倒す
        const perm = await getNotificationPermissionStatus();
        const effective = perm === 'granted';
        setNotificationsEnabledState(effective);
        notificationsEnabledRef.current = effective;
        if (!effective) await AsyncStorage.setItem(NOTIFICATIONS_ENABLED_KEY, 'false');
      }

      // URI修復: iOSコンテナUUID変更に対応
      if (savedRecordings.length) {
        const fixed = await repairRecordingUris(savedRecordings);
        setRecordings(fixed);
        recordingsRef.current = fixed;
      }
      setLoaded(true);
    })();
  }, []);

  // 起動時: 落ちて残ったファイルの回収 → 自動削除 → 中断アップロードのリセット → 再送信
  useEffect(() => {
    if (loaded) {
      recoverOrphans()
        .then(() => runRetention())
        .then(() => resetStaleUploads())
        .then(() => doUploadPending());
    }
  }, [loaded]);

  /**
   * 録音中にアプリが落ちると、ファイルだけが残って一覧に出てこない。
   * CAF は録音中でも中身が読めるので、起動時に拾い上げる。
   */
  const recoverOrphans = useCallback(async () => {
    const found = await recoverOrphanRecordings(RECORDINGS_DIR, recordingsRef.current, () => {
      const chars = 'abcdef0123456789';
      let id = '';
      for (let i = 0; i < 32; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
        if (i === 7 || i === 11 || i === 15 || i === 19) id += '-';
      }
      return id;
    });
    if (found.length === 0) return;
    const next = [...found, ...recordingsRef.current];
    recordingsRef.current = next;
    setRecordings(next);
    await saveRecordings(next);
    const msg = `録音中に中断された${found.length}件を復元しました`;
    addDebugLog(msg);
    await log(msg);
  }, [addDebugLog]);

  // URI修復: iOSコンテナUUID変更で保存済み絶対パスが無効になった場合に再構築
  async function repairRecordingUris(recs: RecordingEntry[]): Promise<RecordingEntry[]> {
    let changed = false;
    const repaired = await Promise.all(
      recs.map(async (rec) => {
        // 送信済みは修復不要。素材（local）は読めないと困るので修復する
        if (rec.uploadStatus === 'uploaded') return rec;

        // 現在のURIが有効ならそのまま
        try {
          const info = await FileSystem.getInfoAsync(rec.uri);
          if (info.exists) return rec;
        } catch {}

        // ファイル名を抽出して現在のdocumentDirectoryで再構築
        const filename = rec.uri.split('/').pop();
        if (!filename) return rec;

        const newUri = RECORDINGS_DIR + filename;
        try {
          const info = await FileSystem.getInfoAsync(newUri);
          if (info.exists) {
            await log(`URI repaired: ${rec.uri} → ${newUri}`);
            addDebugLog(`URI修復: ${filename}`);
            changed = true;
            // ⚠️ **波形のファイルも一緒に直す。** 音声だけ直して波形を放置していたため、
            //    アプリを入れ直したあと（コンテナのUUIDが変わったあと）、
            //    波形が出なくなっていた（2026-10-23 のログで判明）。
            const lvName = rec.levelsUri?.split('/').pop();
            const newLevels = lvName ? LEVELS_DIR + lvName : undefined;
            return { ...rec, uri: newUri, ...(newLevels ? { levelsUri: newLevels } : {}) };
          }
        } catch {}

        addDebugLog(`URI修復失敗: ${filename} (ファイルが見つかりません)`);
        return rec;
      })
    );

    if (changed) {
      await saveRecordings(repaired);
    }
    return repaired;
  }

  // Retry failed uploads when app returns to foreground
  const doUploadRef = useRef<() => Promise<void>>(undefined);

  /**
   * 保持日数より古い録音を消す。起動時・前面復帰時・録音停止時に走る。
   * 「容量を気にせず録りっぱなしにできる」ためには、放っておいても減ることが要る。
   */
  const runRetention = useCallback(async () => {
    const { days, keepUnuploaded: keep } = retentionRef.current;
    if (!days) return;
    const { kept, result } = await applyRetention(
      recordingsRef.current,
      { days, keepUnuploaded: keep },
      (msg) => { addDebugLog(msg); void log(msg); },
    );
    if (result.deleted.length === 0) return;
    recordingsRef.current = kept;
    setRecordings(kept);
    await saveRecordings(kept);
  }, [addDebugLog]);

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
        await log(`uploadPending: 設定未完了のためスキップ url=${s.serverUrl} user=${s.username}`);
        return;
      }

      const pending = recordingsRef.current.filter(
        r => (r.uploadStatus === 'waiting' || r.uploadStatus === 'failed') && !r.serverId
      );
      await log(`uploadPending: ${pending.length}件のアップロード待ち`);

      for (const rec of pending) {
        // uploading に更新（進捗 0 から開始）
        const updating = recordingsRef.current.map(r =>
          r.id === rec.id ? { ...r, uploadStatus: 'uploading' as const, uploadProgress: 0 } : r
        );
        recordingsRef.current = updating;
        setRecordings([...updating]);
        await saveRecordings(updating);

        addDebugLog(`アップロード開始: ${rec.filename}`);

        // 進捗コールバックでリストを更新（過度な再レンダーを避けて 5% 以上変化したときだけ）
        let lastReported = 0;
        const result = await uploadRecording(s, rec, (progress) => {
          if (progress - lastReported < 0.05 && progress < 1) return;
          lastReported = progress;
          const next = recordingsRef.current.map(r =>
            r.id === rec.id ? { ...r, uploadProgress: progress } : r
          );
          recordingsRef.current = next;
          setRecordings([...next]);
        });

        if (result.fileMissing) {
          await log(`Upload: ファイル消失のため失敗 ${rec.filename} uri=${rec.uri}`);
          addDebugLog(`ファイル消失: ${rec.filename} uri=${rec.uri}`);
        }

        if (result.ok) {
          addDebugLog(`アップロード成功: ${rec.filename}`);
          if (notificationsEnabledRef.current) {
            await notifyUploadSuccess(rec.displayName, rec.id);
          }
        } else if (!result.fileMissing) {
          addDebugLog(`アップロード失敗: ${rec.filename}`);
          if (notificationsEnabledRef.current) {
            await notifyUploadFailed(rec.displayName, rec.id);
          }
        }

        // 新規発行された token があれば settings に保存
        if (result.newToken) {
          const nextSettings = { ...settingsRef.current, token: result.newToken };
          settingsRef.current = nextSettings;
          setSettings(nextSettings);
          await saveSettings(nextSettings);
          addDebugLog('Bearer token を更新しました');
        }

        // 結果を反映（URI解決された場合はURIも更新、進捗はクリア）
        const updated = recordingsRef.current.map(r =>
          r.id === rec.id
            ? {
                ...r,
                uploadStatus: result.ok ? ('uploaded' as const) : ('failed' as const),
                serverId: result.serverId ?? r.serverId,
                uploadProgress: undefined,
                ...(result.resolvedUri ? { uri: result.resolvedUri } : {}),
              }
            : r
        );
        recordingsRef.current = updated;
        setRecordings([...updated]);
        await saveRecordings(updated);
      }
    } finally {
      uploadingRef.current = false;
      if (notificationsEnabledRef.current) {
        const pendingCount = recordingsRef.current.filter(
          r => r.uploadStatus === 'waiting' || r.uploadStatus === 'failed'
        ).length;
        await setBadgeCount(pendingCount);
      }
    }
  }, []);

  // stale な 'uploading' を 'waiting' にリセットして再アップロード対象にする
  // アップロードループ実行中は実行しない（in-flightのアップロードを誤ってリセットしないため）
  const resetStaleUploads = useCallback(async () => {
    if (uploadingRef.current) return;
    const stale = recordingsRef.current.filter(r => r.uploadStatus === 'uploading');
    if (stale.length === 0) return;

    await log(`resetStaleUploads: ${stale.length}件の中断アップロードをリセット`);
    const staleIds = new Set(stale.map(r => r.id));
    const next = recordingsRef.current.map(r =>
      staleIds.has(r.id) ? { ...r, uploadStatus: 'waiting' as const } : r
    );
    recordingsRef.current = next;
    setRecordings([...next]);
    await saveRecordings(next);
  }, []);

  // doUploadRefに最新の関数を保持
  doUploadRef.current = doUploadPending;

  // フォアグラウンド復帰時に、staleリセット→リトライ
  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && loaded) {
        runRetention()
          .then(() => resetStaleUploads())
          .then(() => doUploadRef.current?.());
      }
    });
    return () => sub.remove();
  }, [loaded, resetStaleUploads, runRetention]);

  // uploadPending は常に最新のref値を使うので依存配列空でOK
  // タイマーをキャンセル可能にして重複トリガーを防止
  const uploadPending = useCallback(() => {
    if (uploadTimerRef.current) clearTimeout(uploadTimerRef.current);
    uploadTimerRef.current = setTimeout(() => {
      uploadTimerRef.current = null;
      doUploadPending();
    }, 500);
  }, [doUploadPending]);

  // 個別の録音を手動リトライ
  const retryUpload = useCallback((id: string) => {
    const rec = recordingsRef.current.find(r => r.id === id);
    if (!rec || rec.uploadStatus === 'uploading' || rec.uploadStatus === 'uploaded') return;

    // waitingに戻し、serverIdもクリアしてからアップロード実行
    const next = recordingsRef.current.map(r =>
      r.id === id ? { ...r, uploadStatus: 'waiting' as const, serverId: undefined } : r
    );
    recordingsRef.current = next;
    setRecordings([...next]);
    saveRecordings(next);

    uploadPending();
  }, [uploadPending]);

  const toggleDarkMode = useCallback(() => {
    setIsDarkMode(prev => {
      const next = !prev;
      AsyncStorage.setItem(DARK_MODE_KEY, String(next));
      return next;
    });
  }, []);

  const toggleDebugMode = useCallback(() => {
    setIsDebugMode(prev => {
      const next = !prev;
      AsyncStorage.setItem(DEBUG_MODE_KEY, String(next));
      return next;
    });
  }, []);

  const clearDebugLogs = useCallback(() => {
    setDebugLogs([]);
  }, []);

  const setRecordingQuality = useCallback((quality: RecordingQuality) => {
    setRecordingQualityState(quality);
    AsyncStorage.setItem(RECORDING_QUALITY_KEY, quality);
  }, []);

  const setRetentionDays = useCallback((days: RetentionDays) => {
    setRetentionDaysState(days);
    retentionRef.current.days = days;
    AsyncStorage.setItem(RETENTION_DAYS_KEY, String(days));
  }, []);

  const setTranscribeLocale = useCallback((locale: string) => {
    setTranscribeLocaleState(locale);
    AsyncStorage.setItem(TRANSCRIBE_LOCALE_KEY, locale);
  }, []);

  const setStartTab = useCallback((tab: 'index' | 'clip' | 'recordings') => {
    setStartTabState(tab);
    AsyncStorage.setItem(START_TAB_KEY, tab);
  }, []);

  const setCoexistWithOtherApps = useCallback((on: boolean) => {
    setCoexistState(on);
    AsyncStorage.setItem(COEXIST_KEY, String(on));
  }, []);

  const recordingAudioMode = useMemo(() => ({
    allowsRecording: true as const,
    playsInSilentMode: true as const,
    shouldPlayInBackground: true as const,
    allowsBackgroundRecording: true as const,
    // ⚠️ 既定（doNotMix）だと、他アプリが動画や音楽を再生した瞬間に録音が中断される。
    //    mixWithOthers なら録り続けられる代わりに、スピーカーの音をマイクが拾う。
    interruptionMode: (coexistWithOtherApps ? 'mixWithOthers' : 'doNotMix') as 'mixWithOthers' | 'doNotMix',
  }), [coexistWithOtherApps]);

  const setKeepUnuploaded = useCallback((keep: boolean) => {
    setKeepUnuploadedState(keep);
    retentionRef.current.keepUnuploaded = keep;
    AsyncStorage.setItem(KEEP_UNUPLOADED_KEY, String(keep));
  }, []);

  // 通知を有効化する際は OS の許可を取得。拒否された場合は false を返す。
  const setNotificationsEnabled = useCallback(async (enabled: boolean): Promise<boolean> => {
    if (enabled) {
      const perm = await requestNotificationPermission();
      if (perm !== 'granted') {
        setNotificationsEnabledState(false);
        notificationsEnabledRef.current = false;
        await AsyncStorage.setItem(NOTIFICATIONS_ENABLED_KEY, 'false');
        return false;
      }
      setNotificationsEnabledState(true);
      notificationsEnabledRef.current = true;
      await AsyncStorage.setItem(NOTIFICATIONS_ENABLED_KEY, 'true');
      return true;
    } else {
      setNotificationsEnabledState(false);
      notificationsEnabledRef.current = false;
      await AsyncStorage.setItem(NOTIFICATIONS_ENABLED_KEY, 'false');
      await setBadgeCount(0);
      return true;
    }
  }, []);

  return (
    <AppContext.Provider
      value={{
        settings,
        recordings,
        isDarkMode,
        isDebugMode,
        debugLogs,
        recordingQuality,
        notificationsEnabled,
        retentionDays,
        keepUnuploaded,
        transcribeLocale,
        coexistWithOtherApps,
        recordingAudioMode,
        activeRecorder,
        startTab,
        settingsLoaded: loaded,
        theme,
        updateSettings: updateSettingsHandler,
        addRecording,
        updateRecording,
        deleteRecording,
        uploadPending,
        retryUpload,
        toggleDarkMode,
        toggleDebugMode,
        clearDebugLogs,
        addDebugLog,
        setRecordingQuality,
        setNotificationsEnabled,
        setRetentionDays,
        setKeepUnuploaded,
        setTranscribeLocale,
        setCoexistWithOtherApps,
        setStartTab,
        setActiveRecorder,
        runRetention,
      }}
    >
      {children}
    </AppContext.Provider>
  );
}
