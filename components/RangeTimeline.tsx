// 録音の中から時間の範囲を選ぶ。
//
// 主役は**時刻の直接指定**。波形は「選んだ場所が合っているか」を目で確かめるためのもので、
// ドラッグはその補助。どれを触っても同じ値を編集する。
//
// 波形は毎秒1バイトの音量（level-track.ts）から描く。音声はデコードしない。

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  LayoutChangeEvent,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { detectSpeechBlocks, downsample } from '@/services/level-track';

export type Range = { startSec: number; endSec: number };

type Props = {
  /** 毎秒の音量（0〜100） */
  levels: Uint8Array;
  /** 録音を開始した絶対時刻 */
  startedAt: Date;
  /** 録音全体の長さ（秒） */
  durationSec: number;
  value: Range;
  onChange: (next: Range) => void;
  theme: {
    bg: string; bgSecondary: string; bgTertiary: string;
    text: string; textSecondary: string; border: string; accent: string;
  };
  /** 1秒あたりのバイト数の目安。選択範囲の容量表示に使う */
  bytesPerSec?: number;
};

const BAR_GAP = 1;
const BAR_WIDTH = 2;
const TRACK_HEIGHT = 96;
const HANDLE_W = 28;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export function formatClock(base: Date, offsetSec: number): string {
  const d = new Date(base.getTime() + offsetSec * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}時間${String(m).padStart(2, '0')}分`;
  if (m > 0) return `${m}分${String(r).padStart(2, '0')}秒`;
  return `${r}秒`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export default function RangeTimeline({
  levels, startedAt, durationSec, value, onChange, theme, bytesPerSec = 2048,
}: Props) {
  const [width, setWidth] = useState(0);
  // ドラッグ中は親に値を返しつつ、掴んだ時点の範囲を覚えておく
  const dragBase = useRef<Range>(value);
  const valueRef = useRef(value);
  valueRef.current = value;
  const widthRef = useRef(0);
  widthRef.current = width;

  const barCount = width > 0 ? Math.floor(width / (BAR_WIDTH + BAR_GAP)) : 0;
  const bars = useMemo(() => downsample(levels, barCount), [levels, barCount]);
  const blocks = useMemo(() => detectSpeechBlocks(levels), [levels]);

  const secToX = useCallback(
    (sec: number) => (durationSec > 0 ? (sec / durationSec) * widthRef.current : 0),
    [durationSec],
  );
  const xToSec = useCallback(
    (x: number) => (widthRef.current > 0 ? (x / widthRef.current) * durationSec : 0),
    [durationSec],
  );

  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  const makeHandle = (which: 'start' | 'end') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { dragBase.current = valueRef.current; },
      onPanResponderMove: (_, g) => {
        const deltaSec = xToSec(g.dx);
        const base = dragBase.current;
        if (which === 'start') {
          onChange({ ...base, startSec: clamp(base.startSec + deltaSec, 0, base.endSec - 1) });
        } else {
          onChange({ ...base, endSec: clamp(base.endSec + deltaSec, base.startSec + 1, durationSec) });
        }
      },
    });

  const startPan = useRef(makeHandle('start')).current;
  const endPan = useRef(makeHandle('end')).current;

  const setPreset = (sec: number) => {
    const end = durationSec;
    onChange({ startSec: Math.max(0, end - sec), endSec: end });
  };

  const nudge = (which: 'start' | 'end', deltaSec: number) => {
    const v = valueRef.current;
    if (which === 'start') {
      onChange({ ...v, startSec: clamp(v.startSec + deltaSec, 0, v.endSec - 1) });
    } else {
      onChange({ ...v, endSec: clamp(v.endSec + deltaSec, v.startSec + 1, durationSec) });
    }
  };

  const selectedSec = Math.max(0, value.endSec - value.startSec);
  const selLeft = secToX(value.startSec);
  const selWidth = Math.max(2, secToX(value.endSec) - selLeft);

  return (
    <View>
      {/* 時刻（主役）*/}
      <View style={styles.clockRow}>
        <TimeField
          label="開始"
          clock={formatClock(startedAt, value.startSec)}
          onMinus={() => nudge('start', -60)}
          onPlus={() => nudge('start', 60)}
          theme={theme}
        />
        <View style={styles.middle}>
          <Text style={[styles.duration, { color: theme.text }]}>{formatDuration(selectedSec)}</Text>
          <Text style={[styles.hint, { color: theme.textSecondary }]}>
            約 {formatSize(selectedSec * bytesPerSec)}
          </Text>
        </View>
        <TimeField
          label="終了"
          clock={formatClock(startedAt, value.endSec)}
          onMinus={() => nudge('end', -60)}
          onPlus={() => nudge('end', 60)}
          theme={theme}
        />
      </View>

      {/* 波形 */}
      <View style={[styles.track, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]} onLayout={onLayout}>
        <View style={styles.bars}>
          {bars.map((v, i) => {
            const sec = durationSec * (i / Math.max(1, bars.length));
            const inRange = sec >= value.startSec && sec <= value.endSec;
            return (
              <View
                key={i}
                style={{
                  width: BAR_WIDTH,
                  marginRight: BAR_GAP,
                  height: Math.max(2, (v / 100) * (TRACK_HEIGHT - 16)),
                  backgroundColor: inRange ? theme.accent : theme.bgTertiary,
                  borderRadius: 1,
                }}
              />
            );
          })}
        </View>

        {width > 0 && (
          <>
            <View pointerEvents="none" style={[styles.selection, {
              left: selLeft, width: selWidth, borderColor: theme.accent,
            }]} />
            <View {...startPan.panHandlers} style={[styles.handle, { left: selLeft - HANDLE_W / 2 }]}>
              <View style={[styles.handleBar, { backgroundColor: theme.accent }]} />
            </View>
            <View {...endPan.panHandlers} style={[styles.handle, { left: selLeft + selWidth - HANDLE_W / 2 }]}>
              <View style={[styles.handleBar, { backgroundColor: theme.accent }]} />
            </View>
          </>
        )}
      </View>

      {/* 目盛り */}
      <View style={styles.scaleRow}>
        <Text style={[styles.hint, { color: theme.textSecondary }]}>{formatClock(startedAt, 0)}</Text>
        <Text style={[styles.hint, { color: theme.textSecondary }]}>{formatClock(startedAt, durationSec)}</Text>
      </View>

      {/* プリセット */}
      <View style={styles.presetRow}>
        {[[300, '直近5分'], [900, '直近15分'], [3600, '直近1時間']].map(([sec, label]) => (
          <Pressable
            key={label as string}
            onPress={() => setPreset(sec as number)}
            style={[styles.chip, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}
          >
            <Text style={{ color: theme.text, fontSize: 13 }}>{label as string}</Text>
          </Pressable>
        ))}
        <Pressable
          onPress={() => onChange({ startSec: 0, endSec: durationSec })}
          style={[styles.chip, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}
        >
          <Text style={{ color: theme.text, fontSize: 13 }}>全体</Text>
        </Pressable>
      </View>

      {/* 声のかたまり（タップでその会話だけを選ぶ）*/}
      {blocks.length > 0 && (
        <View style={styles.presetRow}>
          <Text style={[styles.hint, { color: theme.textSecondary, width: '100%' }]}>
            声のかたまり（タップで選択）
          </Text>
          {blocks.slice(0, 12).map((b, i) => (
            <Pressable
              key={i}
              onPress={() => onChange({ startSec: b.startSec, endSec: b.endSec })}
              style={[styles.chip, { backgroundColor: theme.bgTertiary, borderColor: theme.border }]}
            >
              <Text style={{ color: theme.text, fontSize: 12 }}>
                {formatClock(startedAt, b.startSec)}〜 {formatDuration(b.endSec - b.startSec)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function TimeField({ label, clock, onMinus, onPlus, theme }: {
  label: string; clock: string; onMinus: () => void; onPlus: () => void;
  theme: Props['theme'];
}) {
  return (
    <View style={styles.timeField}>
      <Text style={[styles.hint, { color: theme.textSecondary }]}>{label}</Text>
      <Text style={[styles.clock, { color: theme.text }]}>{clock}</Text>
      <View style={styles.nudgeRow}>
        <Pressable onPress={onMinus} hitSlop={8} style={[styles.nudge, { borderColor: theme.border }]}>
          <Text style={{ color: theme.accent, fontSize: 13 }}>−1分</Text>
        </Pressable>
        <Pressable onPress={onPlus} hitSlop={8} style={[styles.nudge, { borderColor: theme.border }]}>
          <Text style={{ color: theme.accent, fontSize: 13 }}>+1分</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  clockRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  timeField: { alignItems: 'center', minWidth: 96 },
  middle: { alignItems: 'center', flex: 1 },
  clock: { fontSize: 30, fontWeight: '300', fontVariant: ['tabular-nums'] },
  duration: { fontSize: 17, fontWeight: '600' },
  hint: { fontSize: 11, textAlign: 'center' },
  nudgeRow: { flexDirection: 'row', gap: 6, marginTop: 4 },
  nudge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth },
  track: {
    height: TRACK_HEIGHT, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center', overflow: 'hidden',
  },
  bars: { flexDirection: 'row', alignItems: 'center', height: TRACK_HEIGHT, paddingHorizontal: 1 },
  selection: { position: 'absolute', top: 0, bottom: 0, borderLeftWidth: 2, borderRightWidth: 2 },
  handle: {
    position: 'absolute', top: 0, bottom: 0, width: HANDLE_W,
    alignItems: 'center', justifyContent: 'center',
  },
  handleBar: { width: 4, height: TRACK_HEIGHT - 24, borderRadius: 2 },
  scaleRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
});
