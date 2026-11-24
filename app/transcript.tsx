// 文字起こしだけの画面。
//
// 録音の見出しを押すと開く。録音画面に本文を置くと、長い録音ほど縦に伸びて
// 下の操作が遠くなっていた（2026-11-19 だいしろーさんの指摘）。読む場所を分ける。
//
// ⚠️ **ここにも再生の仕組みが要る。** 時刻を押してその地点から聴けることが
//    文字起こしの value なので、読む画面に無いと意味がない。
//    ⚠️ 録音画面の再生と二重に鳴らさないため、**この画面を離れるとき必ず止める**。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useApp } from '@/contexts/AppContext';
import { formatClock, formatDuration } from '@/components/TimeRangePicker';
import { buildSessions, piecesForRange, transcriptForRange } from '@/services/session';

/** 近い区切りはまとめる。1語ずつ改行すると読めない */
const LINE_GAP_SEC = 20;

export default function TranscriptScreen() {
  const { theme, recordings, transcribePending } = useApp();
  const params = useLocalSearchParams<{ session?: string }>();
  const router = useRouter();
  // ⚠️ この画面はナビゲーションのヘッダーを出していないので、上端の余白は自分で取る
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<'time' | 'plain'>('time');
  const [playingAt, setPlayingAt] = useState<number | null>(null);

  const player = useAudioPlayer();
  const status = useAudioPlayerStatus(player);
  const loadedUriRef = useRef<string | null>(null);

  const session = useMemo(() => {
    const all = buildSessions(recordings);
    return all.find(s => s.id === params.session) ?? all[0] ?? null;
  }, [recordings, params.session]);

  const transcript = useMemo(
    () => (session ? transcriptForRange(session, 0, session.totalSec) : null),
    [session],
  );

  /** 時刻つきの行。秒は録音の先頭からの値 */
  const lines = useMemo(() => {
    const segs = transcript?.segments;
    if (!segs?.length) return null;
    const out: { at: number; text: string }[] = [];
    for (const s of segs) {
      const last = out[out.length - 1];
      if (last && s.startSec - last.at < LINE_GAP_SEC) last.text += s.text;
      else out.push({ at: s.startSec, text: s.text });
    }
    return out;
  }, [transcript?.segments]);

  const stop = useCallback(() => {
    setPlayingAt(null);
    if (!loadedUriRef.current) return;
    try { player.pause(); } catch { /* 解放済みなら何もしない */ }
  }, [player]);

  // ⚠️ 画面を離れるときに必ず止める。録音画面の再生と二重に鳴らさないため
  useEffect(() => () => { try { player.pause(); } catch { /* noop */ } }, [player]);

  const playFrom = useCallback(async (sec: number) => {
    if (!session) return;
    try {
      await setAudioModeAsync({
        allowsRecording: false, playsInSilentMode: true, interruptionMode: 'mixWithOthers',
      });
      const pieces = piecesForRange(session, sec, session.totalSec);
      if (pieces.length === 0) return;
      if (loadedUriRef.current !== pieces[0].uri) {
        player.replace({ uri: pieces[0].uri });
        loadedUriRef.current = pieces[0].uri;
        for (let i = 0; i < 30 && !player.isLoaded; i++) {
          await new Promise(r => setTimeout(r, 50));
        }
      }
      await player.seekTo(pieces[0].startSec);
      player.play();
      setPlayingAt(sec);
    } catch (e: any) {
      stop();
      Alert.alert('再生できませんでした', e?.message ?? String(e));
    }
  }, [session, player, stop]);

  useEffect(() => {
    if (playingAt != null && status.didJustFinish) stop();
  }, [playingAt, status.didJustFinish, stop]);

  const copy = useCallback(async () => {
    if (!transcript?.text) return;
    await Clipboard.setStringAsync(transcript.text);
    Alert.alert('コピーしました', `${transcript.text.length.toLocaleString()}字`);
  }, [transcript]);

  const coverage = useMemo(() => {
    const segs = transcript?.segments;
    if (!segs?.length || !session || session.totalSec <= 0) return null;
    const voiced = segs.reduce((s, x) => s + Math.max(0, x.endSec - x.startSec), 0);
    return { voiced, percent: Math.min(100, Math.round((voiced / session.totalSec) * 100)) };
  }, [transcript?.segments, session]);

  if (!session) {
    return (
      <View style={[styles.wrap, { backgroundColor: theme.bg }]}>
        <Text style={{ color: theme.textSecondary }}>録音が見つかりません。</Text>
      </View>
    );
  }

  const waiting = !!transcript && transcript.done < transcript.total;

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.bar, {
        borderBottomColor: theme.border, paddingTop: insets.top + 10,
      }]}>
        <Pressable onPress={() => { stop(); router.back(); }} hitSlop={10} style={styles.back}>
          <Ionicons name="chevron-back" size={22} color={theme.accent} />
          <Text style={{ color: theme.accent, fontSize: 16 }}>戻る</Text>
        </Pressable>
        <Text style={[styles.barTitle, { color: theme.text }]} numberOfLines={1}>
          {session.startedAt.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}
          {' '}
          {formatClock(session.startedAt, 0, false)} の録音
        </Text>
        <Pressable onPress={copy} hitSlop={10} disabled={!transcript?.text}>
          <Text style={{ color: transcript?.text ? theme.accent : theme.textSecondary, fontSize: 15 }}>
            コピー
          </Text>
        </Pressable>
      </View>

      <View style={[styles.meta, { borderBottomColor: theme.border }]}>
        <Text style={[styles.metaText, { color: theme.textSecondary, flex: 1 }]}>
          {formatDuration(session.totalSec)}
          {coverage ? ` のうち ${formatDuration(coverage.voiced)}（${coverage.percent}%）が文字に` : ''}
          {transcript?.text ? ` ・ ${transcript.text.length.toLocaleString()}字` : ''}
        </Text>
        {lines && (
          <Pressable onPress={() => setMode(m => (m === 'time' ? 'plain' : 'time'))} hitSlop={8}>
            <Text style={{ color: theme.accent, fontSize: 13 }}>
              {mode === 'time' ? 'そのまま' : '時刻つき'}
            </Text>
          </Pressable>
        )}
      </View>

      {waiting && (
        <View style={[styles.waiting, { backgroundColor: theme.bgTertiary }]}>
          <Ionicons name="hourglass-outline" size={15} color={theme.accent} />
          <Text style={{ color: theme.text, fontSize: 12, flex: 1 }}>
            残り{transcript!.total - transcript!.done}件は、まだ文字にしています
            {transcribePending > 0 ? '' : '（止まっています）'}
          </Text>
        </View>
      )}

      <ScrollView contentContainerStyle={styles.body}>
        {!transcript?.text ? (
          <Text style={[styles.empty, { color: theme.textSecondary }]}>
            まだ文字になっていません。
          </Text>
        ) : mode === 'time' && lines ? (
          lines.map((line, i) => (
            <View key={i} style={styles.line}>
              {/* 時刻を押すと、その地点から鳴らす */}
              <Pressable onPress={() => playFrom(line.at)} hitSlop={6}>
                <Text
                  numberOfLines={1}
                  style={[styles.time, {
                    color: playingAt === line.at ? theme.red : theme.accent,
                    fontWeight: playingAt === line.at ? '700' : '400',
                  }]}
                >
                  {formatClock(session.startedAt, line.at, false)}
                </Text>
              </Pressable>
              <Text style={[styles.text, { color: theme.text }]}>{line.text}</Text>
            </View>
          ))
        ) : (
          <Text style={[styles.text, { color: theme.text }]}>{transcript.text}</Text>
        )}
      </ScrollView>

      {playingAt != null && (
        <Pressable onPress={stop} style={[styles.playing, { backgroundColor: theme.accent }]}>
          <Ionicons name="volume-high" size={16} color="#fff" />
          <Text style={{ color: '#fff', fontSize: 13, flex: 1 }}>
            {formatClock(session.startedAt, playingAt, false)} から再生中
          </Text>
          <Ionicons name="stop-circle" size={22} color="#fff" />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  bar: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingHorizontal: 12, paddingTop: 14, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  back: { flexDirection: 'row', alignItems: 'center' },
  barTitle: { flex: 1, fontSize: 15, fontWeight: '600', textAlign: 'center' },
  meta: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  metaText: { fontSize: 12, lineHeight: 18 },
  waiting: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    marginHorizontal: 16, marginTop: 10, padding: 10, borderRadius: 10,
  },
  body: { padding: 16, paddingBottom: 48 },
  empty: { fontSize: 13, textAlign: 'center', marginTop: 40 },
  line: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  time: {
    // ⚠️ 幅が足りないと時刻の途中で折り返す。5文字ぶん + 余白
    fontSize: 13, fontVariant: ['tabular-nums'], paddingTop: 3, width: 46,
  },
  text: { fontSize: 15, lineHeight: 25, flex: 1 },
  playing: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    margin: 16, paddingHorizontal: 14, paddingVertical: 12, borderRadius: 10,
  },
});
