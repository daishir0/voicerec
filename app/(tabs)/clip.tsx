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
  requestRecordingPermissionsAsync, setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus,
  useAudioRecorder, useAudioRecorderState,
} from 'expo-audio';
import * as Clipboard from 'expo-clipboard';
import * as FileSystem from 'expo-file-system/legacy';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '@/contexts/AppContext';
import RangeTimeline, {
  EDGE_PREVIEW_SEC, formatDuration, type PlayTarget, type Range,
} from '@/components/RangeTimeline';
import { CAF_PRESET, CAF_HIGH_QUALITY_PRESET } from '@/services/audio-recorder';
import { LevelTrackWriter, loadLevels, meteringToLevel } from '@/services/level-track';
import { createClipForUpload, transcribeRange } from '@/services/clip-service';
import { deleteLevels } from '@/services/level-track';
import { formatBytes } from '@/services/retention';
import {
  freeDiskBytes, formatHours, FREE_SPACE_CHECK_MS, MIN_FREE_BYTES,
} from '@/services/recording-guard';
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
    theme, recordings, addRecording, deleteRecording, toggleProtected, uploadPending,
    recordingQuality, transcribeLocale, activeRecorder, setActiveRecorder, addDebugLog,
    runRetention, coexistWithOtherApps, recordingAudioMode,
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
  const [notice, setNotice] = useState<string | null>(null);
  const [inputName, setInputName] = useState<string>('');
  const [freeBytes, setFreeBytes] = useState<number | null>(null);

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

  // 再生して確かめる。範囲の端だけ聴ければ、たいていの確認は足りる。
  const playSource = useMemo(() => (source ? { uri: source.uri } : undefined), [source?.uri]);
  const player = useAudioPlayer(playSource, { updateInterval: 150 });
  const playerStatus = useAudioPlayerStatus(player);
  const [playing, setPlaying] = useState<PlayTarget | null>(null);
  const stopAtRef = useRef<number | null>(null);


  // 中断と経路変更を見張る。録り直しは下で定義する関数に任せる（ref 経由）。
  const breakAndResumeRef = useRef<(why: string) => Promise<void>>(async () => {});
  const wasRecordingRef = useRef(false);
  wasRecordingRef.current = state.isRecording;

  useEffect(() => {
    VoicerecAudio.startInterruptionObserver();
    const subInt = VoicerecAudio.addListener('onAudioInterruption', e => {
      addDebugLog(`録音の中断: ${e.type}${e.shouldResume ? '（再開可）' : ''}`);
      if (e.type === 'began') {
        setNotice('通話などで録音が中断されました。終わり次第、自動で録り直します。');
      } else if (e.type === 'ended' && wasRecordingRef.current) {
        // ⚠️ 背面からは録音を開始できない（OS の制限）。失敗したらそう伝える。
        void breakAndResumeRef.current('中断から復帰');
      }
    });
    const subRoute = VoicerecAudio.addListener('onAudioRouteChange', e => {
      setInputName(e.isBluetooth ? `${e.inputName}（Bluetooth・音質が落ちます）` : e.inputName);
      if (!e.inputChanged || !wasRecordingRef.current) return;
      // 入力が変わるとサンプルレートまで変わる。1本の途中で形式が変わらないよう区切る。
      addDebugLog(`入力が変わりました: ${e.inputName} (${e.reason})`);
      void breakAndResumeRef.current(`入力が${e.inputName}に変わった`);
    });
    try {
      const cur = VoicerecAudio.currentInput();
      setInputName(cur.isBluetooth ? `${cur.name}（Bluetooth・音質が落ちます）` : cur.name);
    } catch { /* 取れなくても困らない */ }
    return () => { subInt.remove(); subRoute.remove(); VoicerecAudio.stopInterruptionObserver(); };
  }, [addDebugLog]);

  // 空き容量を定期的に見る。足りなくなったら止めて知らせる（静かに壊れるより良い）
  useEffect(() => {
    if (!state.isRecording) return;
    let alive = true;
    const timer = setInterval(async () => {
      const free = await freeDiskBytes();
      if (!alive) return;
      setFreeBytes(free);
      if (free < MIN_FREE_BYTES) {
        await stopRecordingRef.current();
        Alert.alert('空き容量が足りないので録音を止めました',
          `残り ${formatBytes(free)}。ここまでの録音は保存されています。`);
      }
    }, FREE_SPACE_CHECK_MS);
    return () => { alive = false; clearInterval(timer); };
  }, [state.isRecording]);

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

  const stopPlay = useCallback(() => {
    stopAtRef.current = null;
    setPlaying(null);
    try { player.pause(); } catch { /* 解放済みなら何もしない */ }
  }, [player]);

  const startPlay = useCallback(async (what: PlayTarget) => {
    if (!source) return;
    // 録音用のモードのままだと受話口から鳴る。再生の前に切り替える。
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    const { startSec, endSec } = range;
    const from = what === 'tail' ? Math.max(startSec, endSec - EDGE_PREVIEW_SEC) : startSec;
    const to = what === 'head' ? Math.min(endSec, startSec + EDGE_PREVIEW_SEC) : endSec;
    stopAtRef.current = to;
    setPlaying(what);
    try {
      await player.seekTo(from);
      player.play();
    } catch (e: any) {
      stopPlay();
      Alert.alert('再生できませんでした', e?.message ?? String(e));
    }
  }, [source, range, player, stopPlay]);

  // 範囲の終わりまで来たら止める
  useEffect(() => {
    if (playing == null || stopAtRef.current == null) return;
    if (playerStatus.currentTime >= stopAtRef.current) stopPlay();
    else if (playerStatus.didJustFinish) stopPlay();
  }, [playing, playerStatus.currentTime, playerStatus.didJustFinish, stopPlay]);

  // 選ぶ録音を変えたら再生は止める
  useEffect(() => { stopPlay(); }, [source?.id, stopPlay]);

  const startRecording = useCallback(async () => {
    if (activeRecorder === 'quick') {
      Alert.alert('録音中です', '「録音」タブで録音しています。先にそちらを停止してください。');
      return;
    }
    stopPlay();
    const { status } = await requestRecordingPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('マイク権限', 'マイクへのアクセスを許可してください。');
      return;
    }
    const free = await freeDiskBytes();
    setFreeBytes(free);
    if (free < MIN_FREE_BYTES) {
      Alert.alert('空き容量が足りません',
        `残り ${formatBytes(free)} です。録音すると書き込みに失敗します。\n` +
        '設定の自動削除を短くするか、不要なデータを消してください。');
      return;
    }
    await setAudioModeAsync(recordingAudioMode);
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
  }, [recorder, activeRecorder, setActiveRecorder, stopPlay]);

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

  const stopRecordingRef = useRef<() => Promise<void>>(async () => {});
  stopRecordingRef.current = stopRecording;

  /**
   * 中断や入力の切り替わりで、いったん区切って録り直す。
   * 背面では録音を開始できない（OS の制限）ので、失敗したらその旨を残す。
   */
  breakAndResumeRef.current = async (why: string) => {
    try {
      await finalizeRecording();
      await startRecording();
      setNotice(`${why}ため、いったん区切って録音を続けています。`);
      addDebugLog(`自動で録り直しました（${why}）`);
    } catch (e: any) {
      setNotice(`${why}ため録音が止まりました。「録音を始める」で再開してください。`);
      addDebugLog(`自動の録り直しに失敗: ${e?.message ?? e}`);
    }
  };

  const doDelete = useCallback(() => {
    if (!source) return;
    Alert.alert(
      'この録音を削除しますか',
      `${new Date(source.startedAt ?? source.createdAt).toLocaleString('ja-JP')} から ` +
      `${formatDuration(source.duration / 1000)}\n切り出し済みのクリップは残ります。`,
      [
        { text: 'やめる', style: 'cancel' },
        {
          text: '削除', style: 'destructive',
          onPress: async () => {
            stopPlay();
            try {
              await FileSystem.deleteAsync(source.uri, { idempotent: true });
            } catch { /* ファイルが無くても一覧からは消す */ }
            await deleteLevels(source.levelsUri);
            await deleteRecording(source.id);
            setSourceId(null);
          },
        },
      ],
    );
  }, [source, deleteRecording, stopPlay]);

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

      {notice && (
        <Pressable onPress={() => setNotice(null)}
          style={[styles.notice, { backgroundColor: theme.bgTertiary, borderColor: theme.border }]}>
          <Ionicons name="information-circle-outline" size={16} color={theme.accent} />
          <Text style={{ color: theme.text, fontSize: 12, flex: 1 }}>{notice}</Text>
          <Ionicons name="close" size={14} color={theme.textSecondary} />
        </Pressable>
      )}

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
            {inputName ? `\nマイク: ${inputName}` : ''}
            {freeBytes != null ? `\n空き ${formatBytes(freeBytes)}（${formatHours(freeBytes, 2048)}ぶん）` : ''}
            {coexistWithOtherApps ? '' : '\n他アプリが音を鳴らすと録音が止まります（設定で変えられます）'}
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
            <View style={styles.sourceHeader}>
              <Text style={[styles.cardTitle, { color: theme.textSecondary, flex: 1 }]}>
                {new Date(source.startedAt ?? source.createdAt).toLocaleString('ja-JP')} から
                {' '}{formatDuration(totalSec)} ・ {formatBytes(source.fileSize)}
              </Text>
              <Pressable onPress={() => toggleProtected(source.id)} hitSlop={10} style={styles.iconBtn}>
                <Ionicons
                  name={source.protected ? 'star' : 'star-outline'}
                  size={18}
                  color={source.protected ? theme.accent : theme.textSecondary}
                />
              </Pressable>
              <Pressable onPress={doDelete} hitSlop={10} style={styles.iconBtn}>
                <Ionicons name="trash-outline" size={18} color={theme.red} />
              </Pressable>
            </View>
            {source.protected && (
              <Text style={[styles.cardTitle, { color: theme.textSecondary }]}>
                ★ 自動削除の対象から外しています
              </Text>
            )}
            <RangeTimeline
              levels={levels}
              startedAt={new Date(source.startedAt ?? source.createdAt)}
              durationSec={totalSec}
              value={range}
              onChange={setRange}
              theme={theme}
              bytesPerSec={source.duration > 0 ? source.fileSize / (source.duration / 1000) : 2048}
              playheadSec={playing ? playerStatus.currentTime : null}
              playing={playing}
              onPlay={startPlay}
              onStop={stopPlay}
              playDisabledReason={state.isRecording ? '録音中は再生できません' : null}
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
  note: { fontSize: 12, textAlign: 'center', lineHeight: 18 },
  notice: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    padding: 10, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
  },
  sourceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
  empty: { fontSize: 13, lineHeight: 22, textAlign: 'center', marginTop: 32 },
  card: { padding: 14, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, gap: 10 },
  cardTitle: { fontSize: 12 },
  sourceHeader: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  iconBtn: { padding: 4 },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1, alignItems: 'center', gap: 4, paddingVertical: 16, borderRadius: 12 },
  actionLabel: { fontSize: 13, fontWeight: '600' },
  actionHint: { fontSize: 10 },
  busyRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  transcriptHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  transcript: { fontSize: 14, lineHeight: 22 },
});
