// 文字起こしが終わるまで、画面を触れないようにする覆い。
//
// 長い録音は止めたあとに時間がかかる（8時間でおよそ13分）。そのあいだ範囲を変えたり
// 送信を押したりできると、できかけの文字で送ってしまう。進み具合を見せて待ってもらう。
//
// ⚠️ **録音中は出さない。** 中断で区切られた断片が裏で処理されることがあるが、
//    録音を止める操作まで塞いでしまうと、録りたいものが録れなくなる。
// ⚠️ **閉じられる。** iOS はアプリを離れれば処理を止めるので、塞いでも引き止められない。
//    待ち行列は保存してあるので、戻ってくれば続きから進む。隠せるようにしておく。

import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '@/contexts/AppContext';

/** 「およそ3分」「およそ1時間20分」。秒まで出しても当たらない */
function roughly(sec: number): string {
  if (sec < 60) return 'まもなく終わります';
  const m = Math.round(sec / 60);
  if (m < 60) return `およそ${m}分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest > 0 ? `およそ${h}時間${rest}分` : `およそ${h}時間`;
}

export function TranscribingOverlay() {
  const { theme, transcribePending, transcribeEtaSec, activeRecorder } = useApp();
  const [hidden, setHidden] = useState(false);

  const busy = transcribePending > 0 && !activeRecorder;

  // 終わったら、次に始まったときまた出るように戻す。
  // ⚠️ 描画の途中で setState を呼ばない（警告が出るし、繰り返しになりうる）
  useEffect(() => {
    if (!busy) setHidden(false);
  }, [busy]);

  if (!busy || hidden) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => setHidden(true)}>
      <View style={styles.back}>
        <View style={[styles.card, { backgroundColor: theme.bg, borderColor: theme.border }]}>
          <ActivityIndicator size="large" color={theme.accent} />
          <Text style={[styles.title, { color: theme.text }]}>文字起こし中です</Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            {transcribePending > 1 ? `残り${transcribePending}件 ・ ` : ''}
            {roughly(transcribeEtaSec)}
          </Text>
          <Text style={[styles.body, { color: theme.textSecondary }]}>
            端末の中だけで処理しています。{'\n'}
            通信もAPIの費用もかかりません。
          </Text>
          <View style={[styles.note, { borderTopColor: theme.border }]}>
            <Ionicons name="information-circle-outline" size={16} color={theme.textSecondary} />
            <Text style={[styles.noteText, { color: theme.textSecondary }]}>
              ほかのアプリに移っても大丈夫です。{'\n'}
              戻ってきたら続きから進みます。
            </Text>
          </View>
          <Pressable onPress={() => setHidden(true)} hitSlop={8} style={styles.hide}>
            <Text style={{ color: theme.accent, fontSize: 14 }}>隠す（処理は続きます）</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  back: { flex: 1, backgroundColor: '#000a', alignItems: 'center', justifyContent: 'center', padding: 32 },
  card: {
    width: '100%', maxWidth: 340, alignItems: 'center', gap: 12,
    padding: 24, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 17, fontWeight: '600' },
  body: { fontSize: 13, lineHeight: 20, textAlign: 'center' },
  note: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    paddingTop: 12, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth,
  },
  noteText: { fontSize: 12, lineHeight: 18, flex: 1 },
  hide: { paddingTop: 8 },
});
