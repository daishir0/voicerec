import React, { useState, useRef, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import {
  useAudioRecorder,
  useAudioRecorderState,
  setAudioModeAsync,
  requestRecordingPermissionsAsync,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { useApp } from '@/contexts/AppContext';
import { RecordButton } from '@/components/RecordButton';
import { getFileExtension, getMimeType, getPresetForQuality, FALLBACK_PRESET } from '@/services/audio-recorder';
import { log } from '@/services/logger';

const RECORDINGS_DIR = FileSystem.documentDirectory + 'recordings/';

function generateId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 32; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
    if (i === 7 || i === 11 || i === 15 || i === 19) id += '-';
  }
  return id;
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function generateFilename(ext: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const se = String(now.getSeconds()).padStart(2, '0');
  return `${y}${mo}${d}-${h}${mi}${se}${ext}`;
}

export default function RecordScreen() {
  const { theme, addRecording, uploadPending, recordingQuality, addDebugLog,
          activeRecorder, setActiveRecorder, recordingAudioMode } = useApp();
  const [isRecording, setIsRecording] = useState(false);
  const [useFallback, setUseFallback] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [audioModeReady, setAudioModeReady] = useState(false);
  const filenameRef = useRef<string>('');

  // マウント時に録音モードを有効化（useAudioRecorderより先に実行）
  useEffect(() => {
    (async () => {
      try {
        await setAudioModeAsync(recordingAudioMode);
        setAudioModeReady(true);
      } catch (err) {
        console.error('setAudioModeAsync error:', err);
      }
    })();
  }, []);

  const primaryPreset = getPresetForQuality(recordingQuality);
  const recorder = useAudioRecorder(primaryPreset);
  const recorderState = useAudioRecorderState(recorder, 100);
  const fallbackRecorder = useAudioRecorder(FALLBACK_PRESET);
  const fallbackState = useAudioRecorderState(fallbackRecorder, 100);

  const activeState = useFallback ? fallbackState : recorderState;
  const elapsedSeconds = Math.floor((activeState.durationMillis || 0) / 1000);

  const requestPermission = async (): Promise<boolean> => {
    if (hasPermission === true) return true;
    const { status } = await requestRecordingPermissionsAsync();
    const granted = status === 'granted';
    setHasPermission(granted);
    if (!granted) {
      Alert.alert('マイク権限', 'マイクへのアクセスを許可してください。');
    }
    return granted;
  };

  const startRecording = async () => {
    // 録音機は1つしか動かせない。「切り出し」タブが使っていたら、黙って奪わない。
    if (activeRecorder === 'long') {
      Alert.alert('長い録音をしています', '「切り出し」タブで録音中です。先にそちらを停止してください。');
      return;
    }
    const permitted = await requestPermission();
    if (!permitted) return;

    // 録音開始ごとにフォールバック状態をリセット（前回の失敗を引きずらない）
    setUseFallback(false);

    try {
      // 録音モードが未準備なら再度設定
      // 再生で allowsRecording:false にしていることがあるので、毎回入れ直す
      await setAudioModeAsync(recordingAudioMode);

      filenameRef.current = generateFilename(getFileExtension());

      await recorder.prepareToRecordAsync();
      recorder.record();
      setIsRecording(true);
      setActiveRecorder('quick');
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      addDebugLog(`Primary preset (${recordingQuality}) failed: ${errMsg}`);
      await log(`Primary preset failed (quality=${recordingQuality}): ${errMsg}\n${err?.stack ?? ''}`);

      Alert.alert(
        '音質低下',
        `選択中の録音品質で開始できなかったため、フォールバック設定で録音を継続します。\n\n原因: ${errMsg}`
      );

      try {
        setUseFallback(true);
        await fallbackRecorder.prepareToRecordAsync();
        fallbackRecorder.record();
        setIsRecording(true);
        setActiveRecorder('quick');
        return;
      } catch (err2: any) {
        const err2Msg = err2?.message ?? String(err2);
        addDebugLog(`Fallback also failed: ${err2Msg}`);
        await log(`Fallback also failed: ${err2Msg}\n${err2?.stack ?? ''}`);
        setUseFallback(false);
        Alert.alert('エラー', '録音を開始できませんでした。\n' + err2Msg);
      }
    }
  };

  const stopRecording = useCallback(async () => {
    if (!isRecording) return;

    const rec = useFallback ? fallbackRecorder : recorder;
    const state = useFallback ? fallbackState : recorderState;

    try {
      const durationMs = state.durationMillis || 0;
      await rec.stop();

      setIsRecording(false);
      setActiveRecorder(null);

      const finalState = rec.getStatus();
      const uri = finalState.url || state.url;

      if (!uri) {
        await log('stopRecording: No URI from recorder');
        return;
      }

      const ext = getFileExtension();
      const filename = filenameRef.current || generateFilename(ext);

      // Documentsディレクトリに移動（キャッシュからの保全）
      const dirInfo = await FileSystem.getInfoAsync(RECORDINGS_DIR);
      if (!dirInfo.exists) {
        await FileSystem.makeDirectoryAsync(RECORDINGS_DIR, { intermediates: true });
      }
      const destUri = RECORDINGS_DIR + filename;
      await FileSystem.moveAsync({ from: uri, to: destUri });
      await log(`Recording moved: ${uri} → ${destUri}`);

      let fileSize = 0;
      try {
        const info = await FileSystem.getInfoAsync(destUri);
        if (info.exists && 'size' in info) {
          fileSize = info.size ?? 0;
        }
      } catch {}

      const entry = {
        id: generateId(),
        uri: destUri,
        filename,
        displayName: filename.replace(ext, ''),
        duration: durationMs,
        fileSize,
        mimeType: getMimeType(),
        uploadStatus: 'waiting' as const,
        createdAt: new Date().toISOString(),
        kind: 'quick' as const,
        startedAt: new Date(Date.now() - durationMs).toISOString(),
      };

      await addRecording(entry);
      await log(`Recording added: ${filename} size=${fileSize} duration=${durationMs}ms`);
      uploadPending();
    } catch (err: any) {
      console.error('stopRecording error:', err);
      Alert.alert('エラー', '録音の停止に失敗しました。\n' + (err?.message ?? ''));
      setIsRecording(false);
      setActiveRecorder(null);
    }
  }, [isRecording, useFallback, recorderState, fallbackState, recorder, fallbackRecorder,
      addRecording, uploadPending, setActiveRecorder]);

  const handlePress = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={styles.timerContainer}>
        <Text style={[styles.timer, { color: isRecording ? theme.red : theme.textSecondary }]}>
          {formatElapsed(elapsedSeconds)}
        </Text>
        <Text style={[styles.status, { color: theme.textSecondary }]}>
          {isRecording ? '録音中...' : 'タップして録音開始'}
        </Text>
      </View>
      <RecordButton isRecording={isRecording} onPress={handlePress} metering={activeState.metering} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  timerContainer: {
    alignItems: 'center',
    marginBottom: 48,
  },
  timer: {
    fontSize: 64,
    fontWeight: '200',
    fontVariant: ['tabular-nums'],
  },
  status: {
    fontSize: 16,
    marginTop: 8,
  },
});
