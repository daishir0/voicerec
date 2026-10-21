// 長時間録音まわりの「実機でしか分からないこと」を1画面で確かめる。
//
//   1. CAF/AAC で録りながら、そのファイルを読めるか（＝範囲切り出しの前提）
//   2. 端末内の音声認識（SpeechAnalyzer / SFSpeechRecognizer）が使えるか
//   3. 範囲の切り出しが何秒で終わるか
//   4. 録音の中断（着信など）を拾えるか
//
// 結果はまとめてコピーできる。EC2 側に貼って方式を確定する。
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import {
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { useApp } from '@/contexts/AppContext';
import { CAF_PRESET, getPresetForQuality } from '@/services/audio-recorder';
import VoicerecAudio, { type SpeechProbe } from '@/modules/voicerec-audio';

const WORK_DIR = FileSystem.documentDirectory + 'diag/';

export default function DiagnosticsScreen() {
  const { theme, recordingQuality } = useApp();
  const router = useRouter();
  const [lines, setLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [useCaf, setUseCaf] = useState(true);
  const recordedUri = useRef<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const cafRecorder = useAudioRecorder(CAF_PRESET);
  const m4aRecorder = useAudioRecorder(getPresetForQuality(recordingQuality));
  const recorder = useCaf ? cafRecorder : m4aRecorder;
  const state = useAudioRecorderState(recorder, 500);

  const log = useCallback((s: string) => {
    const ts = new Date().toLocaleTimeString('ja-JP');
    setLines(prev => [...prev, `[${ts}] ${s}`]);
  }, []);

  useEffect(() => {
    VoicerecAudio.startInterruptionObserver();
    const sub = VoicerecAudio.addListener('onAudioInterruption', e => {
      log(`🔔 中断イベント type=${e.type} shouldResume=${e.shouldResume ?? '-'} reason=${e.reason ?? '-'}`);
    });
    return () => {
      sub.remove();
      VoicerecAudio.stopInterruptionObserver();
      if (pollTimer.current) clearInterval(pollTimer.current);
    };
  }, [log]);

  // ── 1. 端末の音声認識の棚卸し ────────────────────────
  const runProbe = useCallback(async () => {
    setBusy(true);
    try {
      const auth = await VoicerecAudio.requestSpeechPermission();
      log(`音声認識の許可: ${auth}`);
      const p: SpeechProbe = await VoicerecAudio.probe('ja-JP');
      log(`iOS ${p.osVersion}`);
      log(`SpeechAnalyzer(iOS26+): ${p.analyzerAvailable ? '使える' : '使えない'}  日本語=${p.analyzerSupportsLocale}`);
      if (p.analyzerAvailable) {
        log(`  対応ロケール ${p.analyzerLocales.length}件: ${p.analyzerLocales.slice(0, 8).join(', ')}…`);
        log(`  導入済み ${p.analyzerInstalled.length}件: ${p.analyzerInstalled.join(', ') || 'なし'}`);
      }
      log(`SFSpeechRecognizer: 対応=${p.sfSupported} 利用可=${p.sfAvailable} 端末内=${p.sfOnDevice}`);
    } catch (e: any) {
      log(`❌ probe 失敗: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }, [log]);

  // ── 2. 録りながら読めるか ────────────────────────────
  const startRecording = useCallback(async () => {
    const { status } = await requestRecordingPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('マイク権限', 'マイクへのアクセスを許可してください。');
      return;
    }
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      allowsBackgroundRecording: true,
    });
    const info = await FileSystem.getInfoAsync(WORK_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(WORK_DIR, { intermediates: true });

    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      log(`▶️ 録音開始（${useCaf ? 'CAF/AAC' : 'M4A/AAC'}）`);
    } catch (e: any) {
      log(`❌ 録音開始に失敗: ${e?.message ?? e}`);
      return;
    }

    // 5秒ごとに「いま読めるか」を確かめる。これが通れば録音を止めずに切り出せる。
    pollTimer.current = setInterval(async () => {
      const uri = recorder.uri ?? null;
      if (!uri) { log('… まだ URI が無い'); return; }
      recordedUri.current = uri;
      try {
        const r = await VoicerecAudio.inspect(uri);
        log(`  読める=${r.readable} 長さ=${(r.durationSec ?? 0).toFixed(1)}秒 ` +
            `サイズ=${(r.fileSize / 1024).toFixed(0)}KB ${r.formatID ?? ''} ` +
            `${r.sampleRate ?? '?'}Hz/${r.channels ?? '?'}ch${r.error ? ' err=' + r.error : ''}`);
      } catch (e: any) {
        log(`  inspect 失敗: ${e?.message ?? e}`);
      }
    }, 5000);
  }, [recorder, useCaf, log]);

  const stopRecording = useCallback(async () => {
    if (pollTimer.current) { clearInterval(pollTimer.current); pollTimer.current = null; }
    try {
      const uri = recorder.uri ?? recordedUri.current;
      await recorder.stop();
      recordedUri.current = recorder.uri ?? uri;
      log(`⏹ 録音停止: ${recordedUri.current?.split('/').pop()}`);
      if (recordedUri.current) {
        const r = await VoicerecAudio.inspect(recordedUri.current);
        log(`  停止後: 読める=${r.readable} 長さ=${(r.durationSec ?? 0).toFixed(1)}秒 ` +
            `サイズ=${(r.fileSize / 1024).toFixed(0)}KB`);
      }
    } catch (e: any) {
      log(`❌ 停止に失敗: ${e?.message ?? e}`);
    }
  }, [recorder, log]);

  // ── 3. 切り出し ──────────────────────────────────────
  const runTrim = useCallback(async () => {
    const src = recordedUri.current;
    if (!src) { Alert.alert('先に録音してください'); return; }
    setBusy(true);
    try {
      const wav = await VoicerecAudio.trimToWav(src, 2, 12, WORK_DIR + 'clip.wav');
      log(`✂️ WAV 切り出し: ${wav.durationSec.toFixed(1)}秒 → ${(wav.fileSize / 1024).toFixed(0)}KB / ${wav.elapsedMs}ms`);
      const m4a = await VoicerecAudio.trimToM4a(src, 2, 12, WORK_DIR + 'clip.m4a');
      log(`✂️ M4A 切り出し: ${m4a.durationSec.toFixed(1)}秒 → ${(m4a.fileSize / 1024).toFixed(0)}KB / ${m4a.elapsedMs}ms`);
    } catch (e: any) {
      log(`❌ 切り出し失敗: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }, [log]);

  // ── 4. 録音を止めずに切り出せるか ────────────────────
  // CAF は録音中でも「読める」が、長さは 0 と返ってくる（実機で確認）。
  // 範囲を自分で指定すれば中身を取り出せるのか、を確かめる。
  const runLiveTrim = useCallback(async () => {
    const src = recorder.uri ?? recordedUri.current;
    if (!src) { Alert.alert('先に録音を開始してください'); return; }
    if (!state.isRecording) { Alert.alert('録音中に押してください'); return; }
    setBusy(true);
    try {
      const r = await VoicerecAudio.trimToWav(src, 0, 5, WORK_DIR + 'live.wav');
      log(`🔴 録音中の切り出し: 成功 要求${(r.requestedSec ?? 0).toFixed(1)}秒 → ` +
          `実際${r.durationSec.toFixed(1)}秒 ${(r.fileSize / 1024).toFixed(0)}KB / ${r.elapsedMs}ms`);
    } catch (e: any) {
      log(`🔴 録音中の切り出し: 失敗 ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }, [recorder, state.isRecording, log]);

  // ── 5. 端末内で文字起こし ────────────────────────────
  const runTranscribe = useCallback(async () => {
    const src = recordedUri.current;
    if (!src) { Alert.alert('先に録音してください'); return; }
    setBusy(true);
    try {
      const r = await VoicerecAudio.transcribe(src, 'ja-JP', 'auto');
      log(`🗣 文字起こし[${r.engine}] ${r.elapsedMs}ms 分割${r.chunks}`);
      if (r.fallbackReason) log(`   （analyzer が落ちた理由: ${r.fallbackReason}）`);
      log(`   「${r.text || '(空)'}」`);
    } catch (e: any) {
      log(`❌ 文字起こし失敗: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }, [log]);

  const copyAll = useCallback(async () => {
    await Clipboard.setStringAsync(lines.join('\n'));
    Alert.alert('コピーしました', `${lines.length} 行をクリップボードに入れました。`);
  }, [lines]);

  const Btn = ({ label, onPress, tone = 'normal' }: {
    label: string;
    onPress: () => void;
    tone?: 'normal' | 'danger';
  }) => (
    <Pressable
      onPress={onPress}
      disabled={busy}
      style={[styles.btn, {
        backgroundColor: tone === 'danger' ? theme.red : theme.bgTertiary,
        opacity: busy ? 0.5 : 1,
      }]}
    >
      <Text style={{ color: tone === 'danger' ? '#fff' : theme.text, fontWeight: '600' }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <Ionicons name="close" size={26} color={theme.text} />
        </Pressable>
        <Text style={[styles.title, { color: theme.text }]}>検証</Text>
        <Pressable onPress={copyAll} hitSlop={12}>
          <Text style={{ color: theme.accent }}>コピー</Text>
        </Pressable>
      </View>

      <View style={styles.controls}>
        <Btn label="① 音声認識を調べる" onPress={runProbe} />
        <Pressable
          onPress={() => setUseCaf(v => !v)}
          disabled={state.isRecording}
          style={[styles.btn, { backgroundColor: theme.bgSecondary, opacity: state.isRecording ? 0.5 : 1 }]}
        >
          <Text style={{ color: theme.text }}>形式: {useCaf ? 'CAF/AAC' : 'M4A/AAC'}（タップで切替）</Text>
        </Pressable>
        {state.isRecording ? (
          <Btn label={`② 停止（${Math.floor((state.durationMillis || 0) / 1000)}秒）`} onPress={stopRecording} tone="danger" />
        ) : (
          <Btn label="② 録りながら読めるか試す" onPress={startRecording} />
        )}
        <Btn label="③ 2〜12秒を切り出す" onPress={runTrim} />
        <Btn label="④ 録音中のまま切り出す（録音中に押す）" onPress={runLiveTrim} />
        <Btn label="⑤ 端末内で文字起こし" onPress={runTranscribe} />
      </View>

      <ScrollView style={[styles.logBox, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}>
        {lines.length === 0 ? (
          <Text style={[styles.logText, { color: theme.textSecondary }]}>
            ①→②→③ の順に押してください。②は録音したまま30秒ほど置いてから停止します。{'\n'}
            録音中にホームに戻る・電話をかけてもらうと、その挙動も記録されます。
          </Text>
        ) : (
          lines.map((l, i) => (
            <Text key={i} style={[styles.logText, { color: theme.text }]}>{l}</Text>
          ))
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingTop: 60 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600' },
  controls: { padding: 16, gap: 10 },
  btn: { paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  logBox: { flex: 1, margin: 16, marginTop: 0, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, padding: 12 },
  logText: { fontSize: 11, fontFamily: 'Courier', lineHeight: 16 },
});
