// 「切り出し」タブ。
//
// 録音ボタンを押したら、止めるまで録り続ける。全部を聞き返す必要はなく、
// 開始と終了の時刻を選べば、その範囲だけを文字起こし／サーバー送信できる。
//
// 録音そのものは「録音」タブと同じ仕組み（同じ expo-audio の録音機）。違うのは
// 止めたときに自動送信しないことと、毎秒の音量を記録して波形を描けるようにすることだけ。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View,
} from 'react-native';
import {
  requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState,
} from 'expo-audio';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '@/contexts/AppContext';
import RangeTimeline, { formatClock, formatDuration, type Range } from '@/components/RangeTimeline';
import { CAF_PRESET, CAF_HIGH_QUALITY_PRESET } from '@/services/audio-recorder';
import { LevelTrackWriter, loadLevels, meteringToLevel } from '@/services/level-track';
import { createClipForUpload, transcribeRange } from '@/services/clip-service';
import { formatBytes } from '@/services/retention';
import { log } from '@/services/logger';
import VoicerecAudio from '@/modules/voicerec-audio';
import { RecordingEntry } from '@/types/recording';

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

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export default function ClipScreen() {
  const {
    theme, recordings, addRecording, updateRecording, uploadPending, recordingQuality,
    transcribeLocale, activeRecorder, setActiveRecorder, addDebugLog, runRetention,
  } = useApp();

  const recorder = useAudioRecorder(
    recordingQuality === 'high' ? CAF_HIGH_QUALITY_PRESET : CAF_PRESET,
  );
  const state = useAudioRecorderState(recorder, 1000);

  const [sourceId, setSourceId] = useState<string | null>(null);
  const [levels, setLevels] = useState<Uint8Array>(new Uint8Array(0));
  const [range, setRange] = useState<Range>({ startSec: 0, endSec: 0 });
  const [busy, setBusy] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<{ text: string; engine: string; ms: number } | null>(null);

  const writerRef = useRef<LevelTrackWriter | null>(null);
  const startedAtRef = useRef<Date | null>(null);
  const filenameRef = useRef<string>('');
  const lastSecondRef = useRef(-1);

  const longRecordings = useMemo(
    () => recordings.filter(r => r.kind === 'long').slice(0, 20),
    [recordings],
  );
  const source = useMemo(
    () => longRecordings.find(r => r.id === sourceId) ?? longRecordings[0] ?? null,
    [longRecordings, sourceId],
  );

  // 中断（着信・他アプリのマイク奪取）を拾う。8時間録っていれば必ず当たる。
  useEffect(() => {
    VoicerecAudio.startInterruptionObserver();
    const sub = VoicerecAudio.addListener('onAudioInterruption', e => {
      addDebugLog(`録音の中断: ${e.type}${e.shouldResume ? '（再開可）' : ''}`);
      if (e.type === 'began') {
        Alert.alert('録音が中断されました', '通話などで録音が止まりました。画面に戻ったら再開してください。');
      }
    });
    return () => { sub.remove(); VoicerecAudio.stopInterruptionObserver(); };
  }, [addDebugLog]);

  // 毎秒の音量を記録する（波形タイムラインの元データ）
  useEffect(() => {
    if (!state.isRecording || !writerRef.current || !startedAtRef.current) return;
    const sec = Math.floor((state.durationMillis || 0) / 1000);
    if (sec === lastSecondRef.current) return;
    lastSecondRef.current = sec;
    writerRef.current.push(meteringToLevel(state.metering), sec);
    void writerRef.current.flush();
  }, [state.isRecording, state.durationMillis, state.metering]);

  // 選んだ録音が変わったら波形を読み直す
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!source?.levelsUri) { setLevels(new Uint8Array(0)); return; }
      const lv = await loadLevels(source.levelsUri);
      if (!alive) return;
      setLevels(lv);
      const total = source.duration / 1000;
      setRange({ startSec: Math.max(0, total - 300), endSec: total });
      setTranscript(null);
    })();
    return () => { alive = false; };
  }, [source?.id, source?.levelsUri, source?.duration]);

  const startRecording = useCallback(async () => {
    if (activeRecorder === 'quick') {
      Alert.alert('録音中です', '「録音」タブで録音しています。先にそちらを停止してください。');
      return;
    }
    const { status } = await requestRecordingPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('マイク権限', 'マイクへのアクセスを許可してください。');
      return;
    }
    await setAudioModeAsync({
      allowsRecording: true, playsInSilentMode: true,
      shouldPlayInBackground: true, allowsBackgroundRecording: true,
    });
    const dir = await FileSystem.getInfoAsync(RECORDINGS_DIR);
    if (!dir.exists) await FileSystem.makeDirectoryAsync(RECORDINGS_DIR, { intermediates: true });

    const now = new Date();
    startedAtRef.current = now;
    filenameRef.current = `${stamp(now)}.caf`;
    lastSecondRef.current = -1;
    writerRef.current = new LevelTrackWriter(stamp(now));

    try {
      await recorder.prepareToRecordAsync();
      recorder.record();
      setActiveRecorder('long');
    } catch (err: any) {
      startedAtRef.current = null;
      writerRef.current = null;
      Alert.alert('エラー', '録音を開始できませんでした。\n' + (err?.message ?? ''));
    }
  }, [recorder, activeRecorder, setActiveRecorder]);

  /** いま録っているものを確定して保存する。返り値がその録音。 */
  const finalizeRecording = useCallback(async (): Promise<RecordingEntry | null> => {
    const startedAt = startedAtRef.current;
    const writer = writerRef.current;
    try {
      const durationMs = state.durationMillis || 0;
      await recorder.stop();
      setActiveRecorder(null);
      await writer?.flush(true);

      const uri = recorder.uri;
      if (!uri || !startedAt) return null;
      const filename = filenameRef.current || `${stamp(new Date())}.caf`;
      const dest = RECORDINGS_DIR + filename;
      await FileSystem.moveAsync({ from: uri, to: dest });

      let fileSize = 0;
      const info = await FileSystem.getInfoAsync(dest);
      if (info.exists && 'size' in info) fileSize = info.size ?? 0;

      const entry: RecordingEntry = {
        id: generateId(),
        uri: dest,
        filename,
        displayName: filename.replace('.caf', ''),
        duration: durationMs,
        fileSize,
        mimeType: 'audio/x-caf',
        // 長時間録音は自動送信しない。範囲を選んでから送る。
        uploadStatus: 'uploaded',
        createdAt: new Date().toISOString(),
        kind: 'long',
        startedAt: startedAt.toISOString(),
        levelsUri: writer?.uri,
      };
      await addRecording(entry);
      setSourceId(entry.id);
      await log(`Long recording saved: ${filename} ${fileSize}B ${durationMs}ms`);
      void runRetention();
      return entry;
    } catch (err: any) {
      Alert.alert('エラー', '録音の停止に失敗しました。\n' + (err?.message ?? ''));
      return null;
    } finally {
      startedAtRef.current = null;
      writerRef.current = null;
    }
  }, [recorder, state.durationMillis, addRecording, setActiveRecorder, runRetention]);

  /**
   * いったん区切って、すぐ録音を続ける。
   *
   * 録音中のファイルは長さが未確定なので、範囲を選ぶにはいったん閉じる必要がある。
   * 閉じたらその場で録り直すので、止まるのは 1 秒に満たない。
   */
  const splitAndContinue = useCallback(async () => {
    setBusy('区切っています…');
    try {
      const entry = await finalizeRecording();
      if (entry) await startRecording();
    } finally {
      setBusy(null);
    }
  }, [finalizeRecording, startRecording]);

  const stopRecording = useCallback(async () => {
    await finalizeRecording();
  }, [finalizeRecording]);

  const doTranscribe = useCallback(async () => {
    if (!source) return;
    setBusy('文字起こし中…');
    setTranscript(null);
    try {
      const r = await transcribeRange(source, range, transcribeLocale);
      setTranscript({ text: r.text, engine: r.engine, ms: r.elapsedMs });
      if (!r.text) Alert.alert('文字起こし', '音声から文字を取り出せませんでした。');
    } catch (e: any) {
      Alert.alert('文字起こしに失敗しました', e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }, [source, range, transcribeLocale]);

  const doUpload = useCallback(async () => {
    if (!source) return;
    setBusy('切り出してアップロード中…');
    try {
      const clip = await createClipForUpload(source, range);
      await addRecording(clip);
      uploadPending();
      Alert.alert('送信しました',
        `${clip.displayName}（${formatDuration((range.endSec - range.startSec))} / ${formatBytes(clip.fileSize)}）\n` +
        'サーバー側で文字起こしされます。');
    } catch (e: any) {
      Alert.alert('切り出しに失敗しました', e?.message ?? String(e));
    } finally {
      setBusy(null);
    }
  }, [source, range, addRecording, uploadPending]);

  const elapsed = Math.floor((state.durationMillis || 0) / 1000);
  const totalSec = source ? source.duration / 1000 : 0;

  return (
    <ScrollView style={{ backgroundColor: theme.bg }} contentContainerStyle={styles.content}>
      {/* 録音 */}
      <Pressable
        onPress={state.isRecording ? stopRecording : startRecording}
        style={[styles.recordBtn, {
          backgroundColor: state.isRecording ? theme.red : theme.bgSecondary,
          borderColor: state.isRecording ? theme.red : theme.border,
        }]}
      >
        <Ionicons
          name={state.isRecording ? 'stop' : 'mic'}
          size={22}
          color={state.isRecording ? '#fff' : theme.accent}
        />
        <Text style={[styles.recordLabel, { color: state.isRecording ? '#fff' : theme.text }]}>
          {state.isRecording
            ? `録音中 ${formatDuration(elapsed)} ・ タップで停止`
            : '録音を始める（止めるまで録り続けます）'}
        </Text>
      </Pressable>

      {state.isRecording && (
        <>
          <Pressable
            onPress={splitAndContinue}
            disabled={!!busy}
            style={[styles.splitBtn, { borderColor: theme.accent, opacity: busy ? 0.5 : 1 }]}
          >
            <Ionicons name="cut-outline" size={18} color={theme.accent} />
            <Text style={{ color: theme.accent, fontSize: 14, fontWeight: '600' }}>
              ここまでを区切って範囲を選ぶ
            </Text>
          </Pressable>
          <Text style={[styles.note, { color: theme.textSecondary }]}>
            区切ったあとも録音は続きます（止まるのは1秒未満）。
          </Text>
        </>
      )}

      {/* 切り出し元 */}
      {longRecordings.length > 1 && (
        <View style={styles.sourceRow}>
          {longRecordings.map(r => {
            const on = r.id === source?.id;
            return (
              <Pressable
                key={r.id}
                onPress={() => setSourceId(r.id)}
                style={[styles.chip, {
                  backgroundColor: on ? theme.accent : theme.bgSecondary,
                  borderColor: on ? theme.accent : theme.border,
                }]}
              >
                <Text style={{ color: on ? '#fff' : theme.text, fontSize: 12 }}>
                  {new Date(r.startedAt ?? r.createdAt).toLocaleString('ja-JP', {
                    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
                  })}
                </Text>
              </Pressable>
            );
          })}
        </View>
      )}

      {!source && !state.isRecording && (
        <Text style={[styles.empty, { color: theme.textSecondary }]}>
          まだ長い録音がありません。{'\n'}
          上のボタンで録音を始めてください。止めたあと、時間の範囲を選んで{'\n'}
          その部分だけを文字起こし・送信できます。
        </Text>
      )}

      {source && (
        <>
          <View style={[styles.card, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}>
            <Text style={[styles.cardTitle, { color: theme.textSecondary }]}>
              {new Date(source.startedAt ?? source.createdAt).toLocaleString('ja-JP')} から
              {' '}{formatDuration(totalSec)} ・ {formatBytes(source.fileSize)}
            </Text>
            <RangeTimeline
              levels={levels}
              startedAt={new Date(source.startedAt ?? source.createdAt)}
              durationSec={totalSec}
              value={range}
              onChange={setRange}
              theme={theme}
              bytesPerSec={source.duration > 0 ? source.fileSize / (source.duration / 1000) : 2048}
            />
          </View>

          <View style={styles.actions}>
            <Pressable
              onPress={doTranscribe}
              disabled={!!busy}
              style={[styles.action, { backgroundColor: theme.bgTertiary, opacity: busy ? 0.5 : 1 }]}
            >
              <Ionicons name="document-text-outline" size={20} color={theme.text} />
              <Text style={[styles.actionLabel, { color: theme.text }]}>この範囲を文字起こし</Text>
              <Text style={[styles.actionHint, { color: theme.textSecondary }]}>端末内で処理します</Text>
            </Pressable>
            <Pressable
              onPress={doUpload}
              disabled={!!busy}
              style={[styles.action, { backgroundColor: theme.accent, opacity: busy ? 0.5 : 1 }]}
            >
              <Ionicons name="cloud-upload-outline" size={20} color="#fff" />
              <Text style={[styles.actionLabel, { color: '#fff' }]}>この範囲をサーバーへ</Text>
              <Text style={[styles.actionHint, { color: '#fff' }]}>送信後に自動で文字起こし</Text>
            </Pressable>
          </View>

          {busy && (
            <View style={styles.busyRow}>
              <ActivityIndicator color={theme.accent} />
              <Text style={{ color: theme.textSecondary, marginLeft: 8 }}>{busy}</Text>
            </View>
          )}

          {transcript && (
            <View style={[styles.card, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}>
              <View style={styles.transcriptHeader}>
                <Text style={[styles.cardTitle, { color: theme.textSecondary }]}>
                  文字起こし（{transcript.engine === 'analyzer' ? '端末内・長文対応' : '端末内'} /
                  {' '}{(transcript.ms / 1000).toFixed(1)}秒）
                </Text>
                <Pressable
                  onPress={async () => {
                    await Clipboard.setStringAsync(transcript.text);
                    Alert.alert('コピーしました');
                  }}
                >
                  <Text style={{ color: theme.accent, fontSize: 13 }}>コピー</Text>
                </Pressable>
              </View>
              <Text style={[styles.transcript, { color: theme.text }]}>
                {transcript.text || '（音声から文字を取り出せませんでした）'}
              </Text>
            </View>
          )}
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  recordBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    paddingVertical: 18, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
  },
  recordLabel: { fontSize: 15, fontWeight: '600' },
  splitBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 12, borderRadius: 10, borderWidth: 1,
  },
  note: { fontSize: 12, textAlign: 'center' },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  empty: { fontSize: 13, lineHeight: 22, textAlign: 'center', marginTop: 32 },
  card: { padding: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 10 },
  cardTitle: { fontSize: 12 },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 16, borderRadius: 12 },
  actionLabel: { fontSize: 13, fontWeight: '600' },
  actionHint: { fontSize: 10 },
  busyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  transcriptHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  transcript: { fontSize: 14, lineHeight: 22 },
});
