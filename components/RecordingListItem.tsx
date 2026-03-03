import React from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { RecordingEntry } from '@/types/recording';
import { UploadStatusBadge } from './UploadStatusBadge';
import { useApp } from '@/contexts/AppContext';

interface RecordingListItemProps {
  recording: RecordingEntry;
  onEditName: (id: string, currentName: string) => void;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(isoString: string): string {
  const d = new Date(isoString);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function RecordingListItem({ recording, onEditName }: RecordingListItemProps) {
  const { theme, deleteRecording } = useApp();

  const handleDelete = () => {
    Alert.alert('削除確認', `「${recording.displayName}」を削除しますか？`, [
      { text: 'キャンセル', style: 'cancel' },
      {
        text: '削除',
        style: 'destructive',
        onPress: () => deleteRecording(recording.id),
      },
    ]);
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.bgSecondary, borderColor: theme.border }]}>
      <View style={styles.header}>
        <Pressable style={styles.nameRow} onPress={() => onEditName(recording.id, recording.displayName)}>
          <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
            {recording.displayName}
          </Text>
          <Ionicons name="pencil" size={14} color={theme.textSecondary} style={{ marginLeft: 4 }} />
        </Pressable>
        <Pressable onPress={handleDelete} hitSlop={8}>
          <Ionicons name="trash-outline" size={20} color={theme.red} />
        </Pressable>
      </View>
      <View style={styles.meta}>
        <Text style={[styles.metaText, { color: theme.textSecondary }]}>
          {formatDuration(recording.duration)} ・ {formatFileSize(recording.fileSize)}
        </Text>
        <Text style={[styles.metaText, { color: theme.textSecondary }]}>
          {formatDate(recording.createdAt)}
        </Text>
      </View>
      <UploadStatusBadge status={recording.uploadStatus} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginHorizontal: 16,
    marginVertical: 4,
    padding: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 8,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    flexShrink: 1,
  },
  meta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  metaText: {
    fontSize: 12,
  },
});
