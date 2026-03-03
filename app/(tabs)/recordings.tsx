import React from 'react';
import { View, Text, FlatList, StyleSheet, Alert, TextInput } from 'react-native';
import { useApp } from '@/contexts/AppContext';
import { RecordingListItem } from '@/components/RecordingListItem';

export default function RecordingsScreen() {
  const { theme, recordings, updateRecording } = useApp();

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

  if (recordings.length === 0) {
    return (
      <View style={[styles.empty, { backgroundColor: theme.bg }]}>
        <Text style={[styles.emptyText, { color: theme.textSecondary }]}>録音がありません</Text>
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
});
