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
  const { theme, deleteRecording, retryUpload } = useApp();
  const isUploaded = recording.uploadStatus === 'uploaded';
  const isFailed = recording.uploadStatus === 'failed';

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

  const handleRetry = () => {
    retryUpload(recording.id);
  };

  return (
    <View style={[
      styles.container,
      { backgroundColor: isUploaded ? theme.bgTertiary : theme.bgSecondary, borderColor: theme.border },
      isUploaded && { opacity: 0.6 },
    ]}>
      <View style={styles.header}>
        <View style={[styles.nameRow, { opacity: isUploaded ? 0.8 : 1 }]}>
          <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
            {recording.displayName}
          </Text>
          {!isUploaded && (
            <Pressable onPress={() => onEditName(recording.id, recording.displayName)}>
              <Ionicons name="pencil" size={14} color={theme.textSecondary} style={{ marginLeft: 4 }} />
            </Pressable>
          )}
        </View>
        {!isUploaded && (
          <Pressable onPress={handleDelete} hitSlop={8}>
            <Ionicons name="trash-outline" size={20} color={theme.red} />
          </Pressable>
        )}
      </View>
      <View style={styles.meta}>
        <Text style={[styles.metaText, { color: theme.textSecondary }]}>
          {formatDuration(recording.duration)} ・ {formatFileSize(recording.fileSize)}
        </Text>
        <Text style={[styles.metaText, { color: theme.textSecondary }]}>
          {formatDate(recording.createdAt)}
        </Text>
      </View>
      <View style={styles.statusRow}>
        <UploadStatusBadge status={recording.uploadStatus} />
        {isFailed && (
          <Pressable onPress={handleRetry} style={styles.retryButton} hitSlop={8}>
            <Ionicons name="refresh" size={14} color="#fff" />
            <Text style={styles.retryText}>再送信</Text>
          </Pressable>
        )}
      </View>
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
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  retryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#007AFF',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
  },
  retryText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
});
