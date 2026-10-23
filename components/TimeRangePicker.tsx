// 録音の中から時間の範囲を選ぶ。iOS のタイマーと同じ、上下に回すダイヤル。
//
// 前の版は波形のドラッグ・拡大・刻みの切り替えと盛りすぎて、短い録音ほど使いづらかった。
// 選ぶ操作はダイヤル1つに絞り、波形は「どこで話していたか」を見るためだけに残す。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, PanResponder, Pressable,
  ScrollView, StyleSheet, Text, View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { downsample } from '@/services/level-track';

export type Range = { startSec: number; endSec: number };
/** どちらの端から鳴らすか。どちらも**止めるまで鳴り続ける**（聴きたい長さは人による） */
/** 'segment' は文字起こしの行から鳴らしたとき。端の切替とは別扱いにする */
export type PlayTarget = 'start' | 'end' | 'segment';
export type PlayRequest = { what: PlayTarget; fromSec: number; toSec: number | null };

type Theme = {
  bg: string; bgSecondary: string; bgTertiary: string;
  text: string; textSecondary: string; border: string; accent: string; red: string;
};

const WAVE_H = 72;
const HANDLE_W = 36;
const ITEM_H = 38;
const VISIBLE = 3;   // 上下1つずつ見えれば回せる。5段は場所を取りすぎる
const WHEEL_H = ITEM_H * VISIBLE;

function two(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}時間${two(m)}分${two(r)}秒`;
  if (m > 0) return `${m}分${two(r)}秒`;
  return `${r}秒`;
}

export function formatClock(base: Date, offsetSec: number): string {
  const d = new Date(base.getTime() + offsetSec * 1000);
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 1本のダイヤル。スクロールを項目の高さに吸着させるだけの軽い作り。 */
function Wheel({ values, value, onChange, theme, suffix }: {
  values: number[];
  value: number;
  onChange: (v: number) => void;
  theme: Theme;
  suffix: string;
}) {
  const ref = useRef<ScrollView>(null);
  const index = Math.max(0, values.indexOf(value));
  const settling = useRef(false);
  // ⚠️ **人が回したときだけ値を変える。**
  //    外から値を合わせるための scrollTo でも onMomentumScrollEnd は飛んでくる。
  //    それを「人が選んだ」と解釈すると、画面を開いただけで値が書き換わる。
  //    2026-10-23、全体が選ばれるはずの場所で 1秒 だけが選ばれていたのがこれ。
  //    時のダイヤルが起動時に発火 → 範囲の外の時刻になり → 開始が終了-1秒へ丸められていた。
  const touched = useRef(false);

  // 外から値が変わったとき（範囲の丸めなど）は、ダイヤルも合わせる。
  // ⚠️ 自分でスクロールしている最中は触らない。触ると指と競合して引っかかる。
  useEffect(() => {
    if (settling.current) return;
    ref.current?.scrollTo({ y: index * ITEM_H, animated: true });
  }, [index]);

  const onEnd = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    settling.current = false;
    if (!touched.current) return;   // 自分で合わせたスクロールは無視する
    touched.current = false;
    const i = Math.round(e.nativeEvent.contentOffset.y / ITEM_H);
    const v = values[Math.min(values.length - 1, Math.max(0, i))];
    if (v !== undefined && v !== value) onChange(v);
  }, [values, value, onChange]);

  return (
    <View style={{ height: WHEEL_H, flex: 1 }}>
      <ScrollView
        ref={ref}
        showsVerticalScrollIndicator={false}
        snapToInterval={ITEM_H}
        decelerationRate="fast"
        contentContainerStyle={{ paddingVertical: ITEM_H * Math.floor(VISIBLE / 2) }}
        onScrollBeginDrag={() => { settling.current = true; touched.current = true; }}
        onMomentumScrollEnd={onEnd}
        onScrollEndDrag={onEnd}
      >
        {values.map((v, i) => (
          <View key={v} style={styles.item}>
            <Text style={[
              styles.itemText,
              { color: i === index ? theme.text : theme.textSecondary,
                fontSize: i === index ? 24 : 20 },
            ]}>
              {two(v)}
            </Text>
          </View>
        ))}
      </ScrollView>
      <Text style={[styles.suffix, { color: theme.textSecondary }]}>{suffix}</Text>
    </View>
  );
}

type Props = {
  levels: Uint8Array;
  startedAt: Date;
  durationSec: number;
  value: Range;
  onChange: (next: Range) => void;
  theme: Theme;
  bytesPerSec?: number;
  playheadSec?: number | null;
  playing?: PlayTarget | null;
  onPlay?: (req: PlayRequest) => void;
  onStop?: () => void;
  /** 録音中など、再生できないとき。ボタンを押せなくするだけで、文言は出さない */
  playDisabled?: boolean;
};

export default function TimeRangePicker({
  levels, startedAt, durationSec, value, onChange, theme, bytesPerSec = 2048,
  playheadSec = null, playing = null, onPlay, onStop, playDisabled = false,
}: Props) {
  const [edge, setEdge] = useState<'start' | 'end'>('start');
  const [width, setWidth] = useState(0);
  // ⚠️ **ドラッグ中は親に渡さない。** 毎フレーム渡すと、ダイヤルが animated で
  //    追いかけ始め、指の動きと競合して引っかかる（2026-10-23 の指摘）。
  //    指を離したときに1回だけ確定する。数字の表示はこの一時値から出すので、
  //    動かしている最中もリアルタイムに見える。
  const [dragging, setDragging] = useState<Range | null>(null);
  const shown = dragging ?? value;

  // 波形のドラッグとダイヤルは同じ値を編集する。どちらを動かしても他方が追従する。
  const widthRef = useRef(0);
  widthRef.current = width;
  const durationRef = useRef(durationSec);
  durationRef.current = durationSec;
  const valueRef = useRef(value);
  valueRef.current = value;
  const draggingRef = useRef<Range | null>(null);
  const dragBase = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const dxToSec = useCallback(
    (dx: number) => (dx / Math.max(1, widthRef.current)) * durationRef.current, []);

  const commitDrag = useCallback(() => {
    const d = draggingRef.current;
    draggingRef.current = null;
    setDragging(null);
    if (d) onChangeRef.current(d);
  }, []);

  const makeHandle = useCallback((which: 'start' | 'end') => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 2,
    onPanResponderGrant: () => {
      dragBase.current = valueRef.current;
      draggingRef.current = valueRef.current;
      setDragging(valueRef.current);
    },
    onPanResponderMove: (_, g) => {
      const d = dxToSec(g.dx);
      const base = dragBase.current;
      const total = durationRef.current;
      const next = which === 'start'
        ? { startSec: Math.min(Math.max(0, base.startSec + d), base.endSec - 1), endSec: base.endSec }
        : { startSec: base.startSec, endSec: Math.max(Math.min(total, base.endSec + d), base.startSec + 1) };
      draggingRef.current = next;
      setDragging(next);
    },
    onPanResponderRelease: commitDrag,
    onPanResponderTerminate: commitDrag,
  }), [dxToSec, commitDrag]);

  const startPan = useRef(makeHandle('start')).current;
  const endPan = useRef(makeHandle('end')).current;

  const endAt = useMemo(() => new Date(startedAt.getTime() + durationSec * 1000), [startedAt, durationSec]);
  // ⚠️ **ダイヤルは確定済みの値だけを見る。**
  //    ここを shown（ドラッグ中の値）にすると、いま編集している側の端をつまんだときだけ、
  //    毎フレーム index が変わって scrollTo(animated) が走り、指と競合して引っかかる。
  //    もう一方の端は index が変わらないので滑らかに見え、症状が片側だけに出ていた
  //    （2026-10-23 の指摘）。上の時刻表示は shown から出しているので、
  //    動かしている最中の数字はリアルタイムに変わる。
  const editing = edge === 'start' ? value.startSec : value.endSec;
  const at = useMemo(() => new Date(startedAt.getTime() + editing * 1000), [startedAt, editing]);
  // 候補の作り直しを「時・分が変わったときだけ」に限る
  const atH = at.getHours();
  const atM = at.getMinutes();

  /** 録音が収まっている範囲でだけ回せるようにする（30秒の録音で24時間ぶん回しても意味がない） */
  const hours = useMemo(() => {
    const out: number[] = [];
    for (let h = startedAt.getHours(); h <= endAt.getHours(); h++) out.push(h);
    return out.length ? out : [startedAt.getHours()];
  }, [startedAt, endAt]);

  const minutes = useMemo(() => {
    const lo = atH === startedAt.getHours() ? startedAt.getMinutes() : 0;
    const hi = atH === endAt.getHours() ? endAt.getMinutes() : 59;
    const out: number[] = [];
    for (let m = lo; m <= hi; m++) out.push(m);
    return out.length ? out : [lo];
  }, [atH, startedAt, endAt]);

  const seconds = useMemo(() => {
    const atStart = atH === startedAt.getHours() && atM === startedAt.getMinutes();
    const atEnd = atH === endAt.getHours() && atM === endAt.getMinutes();
    const lo = atStart ? startedAt.getSeconds() : 0;
    const hi = atEnd ? endAt.getSeconds() : 59;
    const out: number[] = [];
    for (let s = lo; s <= hi; s++) out.push(s);
    return out.length ? out : [lo];
  }, [atH, atM, startedAt, endAt]);

  /** ダイヤルの値から秒オフセットに直し、範囲が裏返らないように整える */
  const setPart = useCallback((part: 'h' | 'm' | 's', v: number) => {
    const d = new Date(at);
    if (part === 'h') d.setHours(v);
    if (part === 'm') d.setMinutes(v);
    if (part === 's') d.setSeconds(v);
    let sec = (d.getTime() - startedAt.getTime()) / 1000;
    sec = Math.min(Math.max(0, sec), durationSec);
    if (edge === 'start') {
      onChange({ startSec: Math.min(sec, value.endSec - 1), endSec: value.endSec });
    } else {
      onChange({ startSec: value.startSec, endSec: Math.max(sec, value.startSec + 1) });
    }
  }, [at, startedAt, durationSec, edge, value, onChange]);

  const selectedSec = Math.max(0, shown.endSec - shown.startSec);
  const bars = useMemo(
    () => downsample(levels, Math.max(1, Math.floor(width / 3))),
    [levels, width],
  );

  // 棒は選択範囲に依存させない。こうしておけば、ドラッグ中に作り直されない
  const barViews = useMemo(() => (
    <View style={styles.bars}>
      {bars.map((v, i) => (
        <View key={i} style={{
          width: 2, marginRight: 1,
          height: Math.max(2, (v / 100) * (WAVE_H - 20)),
          backgroundColor: theme.bgTertiary,
          borderRadius: 1,
        }} />
      ))}
    </View>
  ), [bars, theme.bgTertiary]);

  return (
    <View>
      {/* いま選んでいる範囲 */}
      <View style={styles.summary}>
        <Text style={[styles.range, { color: theme.text }]}>
          {formatClock(startedAt, shown.startSec)}
          <Text style={{ color: theme.textSecondary }}> → </Text>
          {formatClock(startedAt, shown.endSec)}
        </Text>
        <Text style={[styles.hint, { color: theme.textSecondary }]}>
          {formatDuration(selectedSec)} ・ 約 {formatSize(selectedSec * bytesPerSec)}
        </Text>
      </View>

      {/* 波形。見るだけでなく、両端をつまんで範囲を決められる（ダイヤルと同期する） */}
      <View
        style={[styles.wave, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}
        onLayout={(e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width)}
      >
        {barViews}
        {/* 選択範囲は**上に重ねた1枚**で表す。棒そのものの色を変えると、
            ドラッグのたびに数百個を作り直すことになって重い */}
        {width > 0 && durationSec > 0 && (
          <View pointerEvents="none" style={[styles.selection, {
            left: (shown.startSec / durationSec) * width,
            width: Math.max(2, ((shown.endSec - shown.startSec) / durationSec) * width),
            backgroundColor: theme.accent + '44',
            borderColor: theme.accent,
          }]} />
        )}
        {playheadSec != null && durationSec > 0 && (
          <View pointerEvents="none" style={[styles.playhead, {
            left: (playheadSec / durationSec) * width, backgroundColor: theme.red,
          }]} />
        )}
        {width > 0 && durationSec > 0 && (
          <>
            <View {...startPan.panHandlers}
              style={[styles.handle, { left: (shown.startSec / durationSec) * width - HANDLE_W / 2 }]}>
              <View style={[styles.handleBar, { backgroundColor: theme.accent }]} />
            </View>
            <View {...endPan.panHandlers}
              style={[styles.handle, { left: (shown.endSec / durationSec) * width - HANDLE_W / 2 }]}>
              <View style={[styles.handleBar, { backgroundColor: theme.accent }]} />
            </View>
          </>
        )}
      </View>

      {/* どちらの端を動かすか。その端を聴くボタンも同じ場所に置く
          （「どちらの端か」と「その端を聴く」は同じ関心事） */}
      <View style={[styles.segment, { borderColor: theme.border }]}>
        {(['start', 'end'] as const).map(e => {
          const on = edge === e;
          const sec = e === 'start' ? shown.startSec : shown.endSec;
          const sounding = playing === e;
          return (
            <Pressable
              key={e}
              onPress={() => setEdge(e)}
              style={[styles.segmentItem, { backgroundColor: on ? theme.accent : 'transparent' }]}
            >
              <Text style={{ color: on ? '#fff' : theme.text, fontSize: 14, fontWeight: '600' }}>
                {e === 'start' ? '開始' : '終了'}
              </Text>
              <Pressable
                onPress={() => (sounding ? onStop?.() : onPlay?.({ what: e, fromSec: sec, toSec: null }))}
                disabled={playDisabled}
                hitSlop={10}
                style={{ opacity: playDisabled ? 0.35 : 1 }}
              >
                <Ionicons
                  name={sounding ? 'stop-circle' : 'play-circle'}
                  size={22}
                  color={on ? '#fff' : theme.accent}
                />
              </Pressable>
            </Pressable>
          );
        })}
      </View>

      {/* ダイヤル */}
      <View style={[styles.wheels, { borderColor: theme.border }]}>
        <View pointerEvents="none" style={[styles.selectionBand, {
          top: ITEM_H * Math.floor(VISIBLE / 2),
          backgroundColor: theme.bgTertiary,
        }]} />
        <Wheel values={hours} value={at.getHours()} onChange={v => setPart('h', v)} theme={theme} suffix="時" />
        <Wheel values={minutes} value={at.getMinutes()} onChange={v => setPart('m', v)} theme={theme} suffix="分" />
        <Wheel values={seconds} value={at.getSeconds()} onChange={v => setPart('s', v)} theme={theme} suffix="秒" />
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  summary: { alignItems: 'center', marginBottom: 8 },
  range: { fontSize: 22, fontWeight: '500', fontVariant: ['tabular-nums'] },
  hint: { fontSize: 12, textAlign: 'center', marginTop: 2 },
  wave: {
    height: WAVE_H, borderRadius: 8, borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center', overflow: 'hidden',
  },
  handle: {
    position: 'absolute', top: 0, bottom: 0, width: HANDLE_W,
    alignItems: 'center', justifyContent: 'center',
  },
  handleBar: { width: 5, height: WAVE_H - 16, borderRadius: 3 },
  bars: { flexDirection: 'row', alignItems: 'center', height: '100%', paddingHorizontal: 2 },
  playhead: { position: 'absolute', top: 0, bottom: 0, width: 2, zIndex: 2 },
  selection: {
    position: 'absolute', top: 0, bottom: 0,
    borderLeftWidth: 2, borderRightWidth: 2,
  },
  segment: {
    flexDirection: 'row', marginTop: 10, borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden',
  },
  segmentItem: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 8, paddingVertical: 8,
  },
  wheels: {
    flexDirection: 'row', marginTop: 8, height: WHEEL_H,
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden',
  },
  selectionBand: { position: 'absolute', left: 0, right: 0, height: ITEM_H, borderRadius: 8 },
  item: { height: ITEM_H, alignItems: 'center', justifyContent: 'center' },
  itemText: { fontVariant: ['tabular-nums'] },
  suffix: { position: 'absolute', right: 6, top: WHEEL_H / 2 - 9, fontSize: 12 },
});
