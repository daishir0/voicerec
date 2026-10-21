// 録音の中から時間の範囲を選ぶ。
//
// 30秒の録音でも8時間の録音でも同じ操作で選べることを狙っている。そのために:
//
//   ・**全体**（細い帯）と**拡大**（太い波形）の2段。全体では今どこを見ているかが分かり、
//     拡大では秒単位で詰められる。1つの波形で両方をやろうとすると、どちらかが使えなくなる。
//   ・**刻みを選べる**（1秒〜30分）。録音の長さから既定を決めるが、手で変えられる。
//     8時間の録音を1分刻みで動かすのも、30秒の録音を1分刻みで動かすのも無理がある。
//   ・**再生して確かめられる**。範囲の始まりと終わりだけを聴ければ、たいてい事足りる。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutChangeEvent, PanResponder, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { detectSpeechBlocks, downsample } from '@/services/level-track';

export type Range = { startSec: number; endSec: number };

export type PlayTarget = 'range' | 'head' | 'tail';

type Theme = {
  bg: string; bgSecondary: string; bgTertiary: string;
  text: string; textSecondary: string; border: string; accent: string; red: string;
};

type Props = {
  levels: Uint8Array;
  startedAt: Date;
  durationSec: number;
  value: Range;
  onChange: (next: Range) => void;
  theme: Theme;
  bytesPerSec?: number;
  /** 再生位置（秒）。再生していないときは null */
  playheadSec?: number | null;
  /** いま再生中の対象。ボタンの表示を切り替える */
  playing?: PlayTarget | null;
  onPlay?: (what: PlayTarget) => void;
  onStop?: () => void;
  /** 再生できない理由（録音中など）。あればボタンを無効にして出す */
  playDisabledReason?: string | null;
};

const DETAIL_H = 110;
const OVERVIEW_H = 28;
const HANDLE_W = 36;
const EDGE_PREVIEW_SEC = 3;

const STEPS: { sec: number; label: string }[] = [
  { sec: 1, label: '1秒' },
  { sec: 10, label: '10秒' },
  { sec: 60, label: '1分' },
  { sec: 600, label: '10分' },
  { sec: 1800, label: '30分' },
];

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** 刻みが1分未満なら秒まで出す。長い録音で秒を出しても読みにくいだけ。 */
export function formatClock(base: Date, offsetSec: number, withSeconds = false): string {
  const d = new Date(base.getTime() + offsetSec * 1000);
  const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return withSeconds ? `${hm}:${two(d.getSeconds())}` : hm;
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}時間${two(m)}分`;
  if (m > 0) return `${m}分${two(r)}秒`;
  return `${r}秒`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 録音の長さから、ちょうどいい刻みを選ぶ */
function defaultStep(durationSec: number): number {
  if (durationSec <= 120) return 1;
  if (durationSec <= 1800) return 10;
  if (durationSec <= 10800) return 60;
  return 600;
}

export default function RangeTimeline({
  levels, startedAt, durationSec, value, onChange, theme, bytesPerSec = 2048,
  playheadSec = null, playing = null, onPlay, onStop, playDisabledReason = null,
}: Props) {
  const [width, setWidth] = useState(0);
  const [step, setStep] = useState(() => defaultStep(durationSec));
  const [stepTouched, setStepTouched] = useState(false);
  // 拡大表示が今どこを映しているか
  const [view, setView] = useState({ from: 0, to: Math.max(1, durationSec) });

  const dragging = useRef(false);
  const dragBase = useRef<Range>(value);
  const viewBase = useRef(view);
  const valueRef = useRef(value);
  valueRef.current = value;
  const viewRef = useRef(view);
  viewRef.current = view;
  const widthRef = useRef(0);
  widthRef.current = width;

  // 録音が変わったら刻みと表示範囲を選び直す（手で刻みを変えていたら尊重する）
  useEffect(() => {
    if (!stepTouched) setStep(defaultStep(durationSec));
    setView({ from: 0, to: Math.max(1, durationSec) });
  }, [durationSec, stepTouched]);

  /** 選択が画面の外に出たら、見える位置に寄せる（ドラッグ中はしない） */
  const reframe = useCallback((next: Range) => {
    if (dragging.current) return;
    const span = Math.max(next.endSec - next.startSec, step * 4, 10);
    const margin = span * 0.35;
    const from = clamp(next.startSec - margin, 0, Math.max(0, durationSec - 1));
    const to = clamp(next.endSec + margin, from + 1, durationSec);
    setView({ from, to });
  }, [durationSec, step]);

  const change = useCallback((next: Range, keepView = false) => {
    const fixed = {
      startSec: clamp(next.startSec, 0, Math.max(0, durationSec - 0.5)),
      endSec: clamp(next.endSec, 0, durationSec),
    };
    if (fixed.endSec <= fixed.startSec) fixed.endSec = Math.min(durationSec, fixed.startSec + 0.5);
    onChange(fixed);
    if (!keepView) reframe(fixed);
  }, [durationSec, onChange, reframe]);

  const viewSpan = Math.max(0.5, view.to - view.from);
  const secToX = useCallback((sec: number) => ((sec - viewRef.current.from) / Math.max(0.5, viewRef.current.to - viewRef.current.from)) * widthRef.current, []);
  const dxToSec = useCallback((dx: number) => (dx / Math.max(1, widthRef.current)) * Math.max(0.5, viewRef.current.to - viewRef.current.from), []);

  const barCount = width > 0 ? Math.floor(width / 3) : 0;
  const detailBars = useMemo(() => {
    if (levels.length === 0 || barCount === 0) return [];
    const from = Math.floor((view.from / Math.max(1, durationSec)) * levels.length);
    const to = Math.ceil((view.to / Math.max(1, durationSec)) * levels.length);
    return downsample(levels.subarray(Math.max(0, from), Math.max(from + 1, to)), barCount);
  }, [levels, barCount, view.from, view.to, durationSec]);
  const overviewBars = useMemo(() => downsample(levels, Math.max(1, Math.floor(width / 2))), [levels, width]);
  const blocks = useMemo(() => detectSpeechBlocks(levels), [levels]);

  const makeHandle = (which: 'start' | 'end' | 'move') =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 2,
      onPanResponderGrant: () => { dragging.current = true; dragBase.current = valueRef.current; },
      onPanResponderMove: (_, g) => {
        const d = dxToSec(g.dx);
        const base = dragBase.current;
        if (which === 'start') {
          change({ ...base, startSec: Math.min(base.startSec + d, base.endSec - 0.5) }, true);
        } else if (which === 'end') {
          change({ ...base, endSec: Math.max(base.endSec + d, base.startSec + 0.5) }, true);
        } else {
          const len = base.endSec - base.startSec;
          const from = clamp(base.startSec + d, 0, durationSec - len);
          change({ startSec: from, endSec: from + len }, true);
        }
      },
      onPanResponderRelease: () => { dragging.current = false; },
      onPanResponderTerminate: () => { dragging.current = false; },
    });

  const startPan = useRef(makeHandle('start')).current;
  const endPan = useRef(makeHandle('end')).current;
  const movePan = useRef(makeHandle('move')).current;

  // 全体の帯をなぞると、拡大表示がその場所へ移る
  const overviewPan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => { viewBase.current = viewRef.current; },
      onPanResponderMove: (e, g) => {
        const x = e.nativeEvent.locationX ?? g.moveX;
        const center = (x / Math.max(1, widthRef.current)) * durationSec;
        const span = viewBase.current.to - viewBase.current.from;
        const from = clamp(center - span / 2, 0, Math.max(0, durationSec - span));
        setView({ from, to: from + span });
      },
    }),
  ).current;

  const zoom = (factor: number) => {
    const center = (view.from + view.to) / 2;
    const span = clamp(viewSpan * factor, Math.max(2, step * 2), durationSec);
    const from = clamp(center - span / 2, 0, Math.max(0, durationSec - span));
    setView({ from, to: Math.min(durationSec, from + span) });
  };

  const nudge = (which: 'start' | 'end', dir: 1 | -1) => {
    const v = valueRef.current;
    const d = step * dir;
    if (which === 'start') change({ ...v, startSec: Math.min(v.startSec + d, v.endSec - 0.5) });
    else change({ ...v, endSec: Math.max(v.endSec + d, v.startSec + 0.5) });
  };

  const selectedSec = Math.max(0, value.endSec - value.startSec);
  const withSec = step < 60;
  const selLeft = secToX(value.startSec);
  const selRight = secToX(value.endSec);
  const selWidth = Math.max(3, selRight - selLeft);
  const playX = playheadSec != null ? secToX(playheadSec) : null;

  const PlayBtn = ({ what, icon, label }: { what: PlayTarget; icon: any; label: string }) => {
    const on = playing === what;
    const disabled = !!playDisabledReason;
    return (
      <Pressable
        onPress={() => (on ? onStop?.() : onPlay?.(what))}
        disabled={disabled}
        style={[styles.playBtn, {
          backgroundColor: on ? theme.accent : theme.bgSecondary,
          borderColor: on ? theme.accent : theme.border,
          opacity: disabled ? 0.4 : 1,
        }]}
      >
        <Ionicons name={on ? 'stop' : icon} size={15} color={on ? '#fff' : theme.accent} />
        <Text style={{ color: on ? '#fff' : theme.text, fontSize: 12 }}>{label}</Text>
      </Pressable>
    );
  };

  return (
    <View>
      {/* 選択中の長さ */}
      <View style={styles.summary}>
        <Text style={[styles.duration, { color: theme.text }]}>{formatDuration(selectedSec)}</Text>
        <Text style={[styles.hint, { color: theme.textSecondary }]}>
          {formatClock(startedAt, value.startSec, withSec)} 〜 {formatClock(startedAt, value.endSec, withSec)}
          {'  ・  '}約 {formatSize(selectedSec * bytesPerSec)}
        </Text>
      </View>

      {/* 拡大（ここで詰める）*/}
      <View
        style={[styles.detail, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      >
        <View style={styles.bars}>
          {detailBars.map((v, i) => {
            const sec = view.from + viewSpan * (i / Math.max(1, detailBars.length));
            const inRange = sec >= value.startSec && sec <= value.endSec;
            return (
              <View key={i} style={{
                width: 2, marginRight: 1,
                height: Math.max(2, (v / 100) * (DETAIL_H - 28)),
                backgroundColor: inRange ? theme.accent : theme.bgTertiary,
                borderRadius: 1,
              }} />
            );
          })}
        </View>

        {width > 0 && (
          <>
            <View {...movePan.panHandlers} style={[styles.selection, {
              left: selLeft, width: selWidth,
              borderColor: theme.accent, backgroundColor: theme.accent + '22',
            }]} />
            {playX != null && playX >= 0 && playX <= width && (
              <View pointerEvents="none" style={[styles.playhead, { left: playX, backgroundColor: theme.red }]} />
            )}
            <View {...startPan.panHandlers} style={[styles.handle, { left: selLeft - HANDLE_W / 2 }]}>
              <View style={[styles.handleBar, { backgroundColor: theme.accent }]} />
            </View>
            <View {...endPan.panHandlers} style={[styles.handle, { left: selRight - HANDLE_W / 2 }]}>
              <View style={[styles.handleBar, { backgroundColor: theme.accent }]} />
            </View>
          </>
        )}
      </View>
      <View style={styles.scaleRow}>
        <Text style={[styles.hint, { color: theme.textSecondary }]}>{formatClock(startedAt, view.from, withSec)}</Text>
        <View style={styles.zoomRow}>
          <Pressable onPress={() => zoom(0.5)} hitSlop={8} style={[styles.zoomBtn, { borderColor: theme.border }]}>
            <Ionicons name="add" size={14} color={theme.accent} />
          </Pressable>
          <Pressable onPress={() => zoom(2)} hitSlop={8} style={[styles.zoomBtn, { borderColor: theme.border }]}>
            <Ionicons name="remove" size={14} color={theme.accent} />
          </Pressable>
        </View>
        <Text style={[styles.hint, { color: theme.textSecondary }]}>{formatClock(startedAt, view.to, withSec)}</Text>
      </View>

      {/* 全体（今どこを見ているか）*/}
      {durationSec > 0 && viewSpan < durationSec - 0.5 && (
        <View {...overviewPan.panHandlers}
          style={[styles.overview, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}>
          <View style={styles.bars}>
            {overviewBars.map((v, i) => (
              <View key={i} style={{
                width: 1, marginRight: 1,
                height: Math.max(1, (v / 100) * (OVERVIEW_H - 8)),
                backgroundColor: theme.bgTertiary,
              }} />
            ))}
          </View>
          <View pointerEvents="none" style={[styles.viewWindow, {
            left: (view.from / durationSec) * width,
            width: Math.max(4, (viewSpan / durationSec) * width),
            borderColor: theme.accent,
          }]} />
          <View pointerEvents="none" style={[styles.overviewSel, {
            left: (value.startSec / durationSec) * width,
            width: Math.max(2, ((value.endSec - value.startSec) / durationSec) * width),
            backgroundColor: theme.accent,
          }]} />
        </View>
      )}

      {/* 刻み */}
      <View style={styles.stepRow}>
        <Text style={[styles.hint, { color: theme.textSecondary }]}>刻み</Text>
        {STEPS.filter(s => s.sec <= Math.max(60, durationSec)).map(s => {
          const on = step === s.sec;
          return (
            <Pressable
              key={s.sec}
              onPress={() => { setStep(s.sec); setStepTouched(true); }}
              style={[styles.stepChip, {
                backgroundColor: on ? theme.accent : theme.bgSecondary,
                borderColor: on ? theme.accent : theme.border,
              }]}
            >
              <Text style={{ color: on ? '#fff' : theme.text, fontSize: 12 }}>{s.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* 開始 / 終了 */}
      <View style={styles.edgeRow}>
        <EdgeField
          label="開始" clock={formatClock(startedAt, value.startSec, withSec)} theme={theme}
          onMinus={() => nudge('start', -1)} onPlus={() => nudge('start', 1)}
        />
        <EdgeField
          label="終了" clock={formatClock(startedAt, value.endSec, withSec)} theme={theme}
          onMinus={() => nudge('end', -1)} onPlus={() => nudge('end', 1)}
        />
      </View>

      {/* 聴いて確かめる */}
      <View style={styles.playRow}>
        <PlayBtn what="range" icon="play" label="範囲を再生" />
        <PlayBtn what="head" icon="play-skip-forward-outline" label={`始まり${EDGE_PREVIEW_SEC}秒`} />
        <PlayBtn what="tail" icon="play-skip-back-outline" label={`終わり${EDGE_PREVIEW_SEC}秒`} />
      </View>
      {playDisabledReason && (
        <Text style={[styles.hint, { color: theme.textSecondary, marginTop: 4 }]}>{playDisabledReason}</Text>
      )}

      {/* よく使う範囲 */}
      <View style={styles.presetRow}>
        {([[60, '直近1分'], [300, '直近5分'], [900, '直近15分'], [3600, '直近1時間']] as const)
          .filter(([sec]) => sec < durationSec)
          .map(([sec, label]) => (
            <Pressable key={label} onPress={() => change({ startSec: durationSec - sec, endSec: durationSec })}
              style={[styles.chip, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}>
              <Text style={{ color: theme.text, fontSize: 12 }}>{label}</Text>
            </Pressable>
          ))}
        <Pressable onPress={() => change({ startSec: 0, endSec: durationSec })}
          style={[styles.chip, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}>
          <Text style={{ color: theme.text, fontSize: 12 }}>全体</Text>
        </Pressable>
      </View>

      {/* 声のかたまり */}
      {blocks.length > 0 && (
        <View style={styles.presetRow}>
          <Text style={[styles.hint, { color: theme.textSecondary, width: '100%', textAlign: 'left' }]}>
            声のかたまり
          </Text>
          {blocks.slice(0, 12).map((b, i) => (
            <Pressable key={i} onPress={() => change({ startSec: b.startSec, endSec: b.endSec })}
              style={[styles.chip, { backgroundColor: theme.bgTertiary, borderColor: theme.border }]}>
              <Text style={{ color: theme.text, fontSize: 12 }}>
                {formatClock(startedAt, b.startSec, withSec)} ・ {formatDuration(b.endSec - b.startSec)}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

function EdgeField({ label, clock, onMinus, onPlus, theme }: {
  label: string; clock: string; onMinus: () => void; onPlus: () => void; theme: Theme;
}) {
  return (
    <View style={styles.edgeField}>
      <Text style={[styles.hint, { color: theme.textSecondary }]}>{label}</Text>
      <View style={styles.edgeControls}>
        <Pressable onPress={onMinus} hitSlop={10} style={[styles.edgeBtn, { borderColor: theme.border }]}>
          <Ionicons name="remove" size={18} color={theme.accent} />
        </Pressable>
        <Text style={[styles.clock, { color: theme.text }]}>{clock}</Text>
        <Pressable onPress={onPlus} hitSlop={10} style={[styles.edgeBtn, { borderColor: theme.border }]}>
          <Ionicons name="add" size={18} color={theme.accent} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { alignItems: 'center', marginBottom: 10 },
  duration: { fontSize: 26, fontWeight: '600', fontVariant: ['tabular-nums'] },
  hint: { fontSize: 11, textAlign: 'center' },
  detail: {
    height: DETAIL_H, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center', overflow: 'hidden',
  },
  bars: { flexDirection: 'row', alignItems: 'center', height: '100%', paddingHorizontal: 1 },
  selection: { position: 'absolute', top: 0, bottom: 0, borderLeftWidth: 2, borderRightWidth: 2 },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2 },
  handle: { position: 'absolute', top: 0, bottom: 0, width: HANDLE_W, alignItems: 'center', justifyContent: 'center' },
  handleBar: { width: 5, height: DETAIL_H - 30, borderRadius: 3 },
  scaleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 },
  zoomRow: { flexDirection: 'row', gap: 6 },
  zoomBtn: {
    width: 28, height: 22, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
  },
  overview: {
    height: OVERVIEW_H, borderRadius: 6, borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center', overflow: 'hidden', marginTop: 6,
  },
  viewWindow: { position: 'absolute', top: 0, bottom: 0, borderWidth: 1.5, borderRadius: 3 },
  overviewSel: { position: 'absolute', bottom: 0, height: 3 },
  stepRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  stepChip: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  edgeRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, marginTop: 10 },
  edgeField: { flex: 1, alignItems: 'center' },
  edgeControls: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  edgeBtn: {
    width: 36, height: 32, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
  },
  clock: { fontSize: 20, fontWeight: '400', fontVariant: ['tabular-nums'], minWidth: 74, textAlign: 'center' },
  playRow: { flexDirection: 'row', gap: 8, marginTop: 12 },
  playBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingVertical: 9, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
  },
  presetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth },
});

export { EDGE_PREVIEW_SEC };
