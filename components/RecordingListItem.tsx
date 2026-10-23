import React from 'react';
import { View, Text, StyleSheet, Pressable, Alert } from 'react-native';
import { useRouter } from 'expo-router';
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
  const router = useRouter();
  const { theme, deleteRecording, retryUpload } = useApp();
  const isUploaded = recording.uploadStatus === 'uploaded';
  const isMaterial = recording.kind === 'long';
  const isFailed = recording.uploadStatus === 'failed';
  const isUploading = recording.uploadStatus === 'uploading';
  const progress = typeof recording.uploadProgress === 'number'
    ? Math.max(0, Math.min(1, recording.uploadProgress))
    : 0;

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

  // 長い録音は、押したら「切り出し」タブでその録音を開く。
  // 一覧は録音を探す場所なので、ここが範囲選択への自然な入口になる。
  const openInClip = recording.kind === 'long'
    ? () => router.navigate({ pathname: '/clip', params: { session: recording.id } })
    : undefined;

  return (
    <Pressable
      onPress={openInClip}
      disabled={!openInClip}
      style={[
        styles.container,
        { backgroundColor: isUploaded && !isMaterial ? theme.bgTertiary : theme.bgSecondary,
          borderColor: theme.border },
        isUploaded && !isMaterial && { opacity: 0.6 },
      ]}
    >
      <View style={styles.header}>
        <View style={[styles.nameRow, { opacity: isUploaded ? 0.8 : 1 }]}>
          <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>
            {recording.displayName}
          </Text>
          {!isUploaded && !isMaterial && (
            <Pressable onPress={() => onEditName(recording.id, recording.displayName)}>
              <Ionicons name="pencil" size={14} color={theme.textSecondary} style={{ marginLeft: 4 }} />
            </Pressable>
          )}
        </View>
        {(!isUploaded || isMaterial) && (
          <Pressable onPress={handleDelete} hitSlop={8}>
            <Ionicons name="trash-outline" size={20} color={theme.red} />
          </Pressable>
        )}
      </View>
      {openInClip && (
        <View style={styles.openRow}>
          <Ionicons name="cut-outline" size={13} color={theme.accent} />
          <Text style={{ color: theme.accent, fontSize: 12 }}>押すと範囲を選べます</Text>
        </View>
      )}
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
        {isUploading && (
          <Text style={[styles.progressText, { color: theme.textSecondary }]}>
            {Math.round(progress * 100)}%
          </Text>
        )}
        {isFailed && (
          <Pressable onPress={handleRetry} style={styles.retryButton} hitSlop={8}>
            <Ionicons name="refresh" size={14} color="#fff" />
            <Text style={styles.retryText}>再送信</Text>
          </Pressable>
        )}
      </View>
      {isUploading && (
        <View style={[styles.progressTrack, { backgroundColor: theme.bgTertiary }]}>
          <View
            style={[
              styles.progressFill,
              { width: `${progress * 100}%`, backgroundColor: theme.accent },
            ]}
          />
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  openRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
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
  progressText: {
    fontSize: 11,
    fontWeight: '600',
  },
  progressTrack: {
    height: 3,
    borderRadius: 2,
    marginTop: 6,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
  },
});
