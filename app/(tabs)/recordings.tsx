import { useState } from 'react';
import {
  ActivityIndicator, Alert, Linking, Pressable, SectionList, StyleSheet, Text, View,
} from 'react-native';
import { useApp } from '@/contexts/AppContext';
import { RecordingListItem } from '@/components/RecordingListItem';
import { formatBytes, retentionLabel, totalBytes } from '@/services/retention';
import React, { useMemo } from 'react';
import { loginAndGetToken } from '@/services/upload-service';

export default function RecordingsScreen() {
  const { theme, recordings, updateRecording, settings, retentionDays } = useApp();
  const [openingServer, setOpeningServer] = useState(false);

  // ⚠️ 一覧には性質の違うものが並ぶ。**素材**（切り出し元の長い録音）と
  //    **成果**（サーバーへ送ったもの）を混ぜると、「なぜこれは送られていないのか」が
  //    分からなくなる。意味で分けて見せる。
  const sections = useMemo(() => {
    const material = recordings.filter(r => r.kind === 'long');
    const sent = recordings.filter(r => r.kind !== 'long');
    const out: { title: string; hint: string; data: typeof recordings }[] = [];
    if (material.length) {
      out.push({
        title: '録音（ここから切り出す）',
        hint: 'サーバーには送りません。押すと範囲を選べます',
        data: material,
      });
    }
    if (sent.length) {
      out.push({
        title: 'サーバーへ送ったもの',
        hint: '送った音声はサーバー側で文字起こしされます',
        data: sent,
      });
    }
    return out;
  }, [recordings]);

  const handleEditName = (id: string, currentName: string) => {
    Alert.prompt(
      '表示名を編集',
      '新しい表示名を入力してください',
      [
        { text: 'キャンセル', style: 'cancel' },
        {
          text: '保存',
          onPress: (newName?: string) => {
            if (newName && newName.trim()) {
              updateRecording(id, { displayName: newName.trim() });
            }
          },
        },
      ],
      'plain-text',
      currentName
    );
  };

  const handleOpenServer = async () => {
    if (!settings.serverUrl || openingServer) return;
    setOpeningServer(true);
    try {
      // Bearer token を取得 (保存済み or 新規ログイン)
      let bearerToken = settings.token ?? null;
      if (!bearerToken) {
        const login = await loginAndGetToken(settings.serverUrl, settings.username, settings.password);
        if (login) bearerToken = login.token;
      }

      if (bearerToken) {
        const res = await fetch(`${settings.serverUrl}/api/auth/ott`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearerToken}` },
        });
        if (res.ok) {
          const { token } = await res.json();
          await Linking.openURL(`${settings.serverUrl}/user/api/auto-login?token=${token}`);
          setOpeningServer(false);
          return;
        }
      }
    } catch {}
    await Linking.openURL(settings.serverUrl);
    setOpeningServer(false);
  };

  const serverLinkButton = settings.serverUrl ? (
    <Pressable
      style={[styles.serverLink, { borderColor: theme.border }]}
      onPress={handleOpenServer}
      disabled={openingServer}
    >
      {openingServer ? (
        <View style={styles.serverLinkLoading}>
          <ActivityIndicator size="small" color={theme.accent} />
          <Text style={[styles.serverLinkText, { color: theme.textSecondary }]}>
            接続中...
          </Text>
        </View>
      ) : (
        <Text style={[styles.serverLinkText, { color: theme.accent }]}>
          管理サーバーへ →
        </Text>
      )}
    </Pressable>
  ) : null;

  if (recordings.length === 0) {
    return (
      <View style={[styles.empty, { backgroundColor: theme.bg }]}>
        <Text style={[styles.emptyText, { color: theme.textSecondary }]}>録音がありません</Text>
        {serverLinkButton}
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: theme.bg }]}>
      {/* 何件たまっていて、いつ消えるのかが一覧で分かるようにする */}
      <View style={[styles.summary, { borderBottomColor: theme.border }]}>
        <Text style={[styles.summaryText, { color: theme.textSecondary }]}>
          {recordings.length}件 ・ {formatBytes(totalBytes(recordings))}
        </Text>
        <Text style={[styles.summaryText, { color: theme.textSecondary }]}>
          {retentionDays ? `${retentionLabel(retentionDays)}より古い録音は自動で削除` : '自動削除しない設定です'}
        </Text>
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <RecordingListItem recording={item} onEditName={handleEditName} />
        )}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHead}>
            <Text style={[styles.sectionTitle, { color: theme.text }]}>{section.title}</Text>
            <Text style={[styles.sectionHint, { color: theme.textSecondary }]}>{section.hint}</Text>
          </View>
        )}
        stickySectionHeadersEnabled={false}
        contentContainerStyle={{ paddingVertical: 8 }}
        ListFooterComponent={serverLinkButton}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  summaryText: { fontSize: 12 },
  sectionHead: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 6 },
  sectionTitle: { fontSize: 14, fontWeight: '600' },
  sectionHint: { fontSize: 11, marginTop: 2 },
  container: {
    flex: 1,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {
    fontSize: 16,
  },
  serverLink: {
    marginHorizontal: 16,
    marginTop: 12,
    marginBottom: 24,
    paddingVertical: 14,
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  serverLinkText: {
    fontSize: 15,
    fontWeight: '600',
  },
  serverLinkLoading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
});
