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
import { getFileExtension, getMimeType, WHISPER_PRESET, FALLBACK_PRESET } from '@/services/audio-recorder';
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
  const { theme, addRecording, uploadPending } = useApp();
  const [isRecording, setIsRecording] = useState(false);
  const [useFallback, setUseFallback] = useState(false);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [audioModeReady, setAudioModeReady] = useState(false);
  const filenameRef = useRef<string>('');

  // マウント時に録音モードを有効化（useAudioRecorderより先に実行）
  useEffect(() => {
    (async () => {
      try {
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          allowsBackgroundRecording: true,
        });
        setAudioModeReady(true);
      } catch (err) {
        console.error('setAudioModeAsync error:', err);
      }
    })();
  }, []);

  const recorder = useAudioRecorder(WHISPER_PRESET);
  const recorderState = useAudioRecorderState(recorder, 500);
  const fallbackRecorder = useAudioRecorder(FALLBACK_PRESET);
  const fallbackState = useAudioRecorderState(fallbackRecorder, 500);

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

  const activeRecorder = () => useFallback ? fallbackRecorder : recorder;

  const startRecording = async () => {
    const permitted = await requestPermission();
    if (!permitted) return;

    try {
      // 録音モードが未準備なら再度設定
      if (!audioModeReady) {
        await setAudioModeAsync({
          allowsRecording: true,
          playsInSilentMode: true,
          shouldPlayInBackground: true,
          allowsBackgroundRecording: true,
        });
      }

      filenameRef.current = generateFilename(getFileExtension());

      const rec = activeRecorder();
      await rec.prepareToRecordAsync();
      rec.record();
      setIsRecording(true);
    } catch (err: any) {
      // Whisperプリセットが失敗したらHIGH_QUALITYにフォールバック
      if (!useFallback) {
        console.warn('Whisper preset failed, falling back to HIGH_QUALITY:', err?.message);
        setUseFallback(true);
        try {
          await fallbackRecorder.prepareToRecordAsync();
          fallbackRecorder.record();
          setIsRecording(true);
          return;
        } catch (err2: any) {
          console.error('Fallback also failed:', err2);
        }
      }
      console.error('startRecording error:', err);
      Alert.alert('エラー', '録音を開始できませんでした。\n' + (err?.message ?? ''));
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
      };

      await addRecording(entry);
      await log(`Recording added: ${filename} size=${fileSize} duration=${durationMs}ms`);
      uploadPending();
    } catch (err: any) {
      console.error('stopRecording error:', err);
      Alert.alert('エラー', '録音の停止に失敗しました。\n' + (err?.message ?? ''));
      setIsRecording(false);
    }
  }, [isRecording, useFallback, recorderState, fallbackState, recorder, fallbackRecorder, addRecording, uploadPending]);

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
      <RecordButton isRecording={isRecording} onPress={handlePress} />
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
