import React, { useState } from 'react';
import { View, Text, FlatList, StyleSheet, Alert, Pressable, Linking, ActivityIndicator } from 'react-native';
import { useApp } from '@/contexts/AppContext';
import { RecordingListItem } from '@/components/RecordingListItem';
import { loginAndGetToken } from '@/services/upload-service';

export default function RecordingsScreen() {
  const { theme, recordings, updateRecording, settings } = useApp();
  const [openingServer, setOpeningServer] = useState(false);

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
      <FlatList
        data={recordings}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <RecordingListItem recording={item} onEditName={handleEditName} />
        )}
        contentContainerStyle={{ paddingVertical: 8 }}
        ListFooterComponent={serverLinkButton}
      />
    </View>
  );
}

const styles = StyleSheet.create({
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
