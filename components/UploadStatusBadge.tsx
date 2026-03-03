import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { UploadStatus } from '@/types/recording';

const STATUS_CONFIG: Record<UploadStatus, { label: string; bg: string; text: string }> = {
  waiting: { label: '待機中', bg: '#8e8e93', text: '#fff' },
  uploading: { label: 'アップロード中', bg: '#007AFF', text: '#fff' },
  uploaded: { label: 'アップロード済み', bg: '#34C759', text: '#fff' },
  failed: { label: '失敗', bg: '#FF3B30', text: '#fff' },
};

interface UploadStatusBadgeProps {
  status: UploadStatus;
}

export function UploadStatusBadge({ status }: UploadStatusBadgeProps) {
  const config = STATUS_CONFIG[status];

  return (
    <View style={[styles.badge, { backgroundColor: config.bg }]}>
      <Text style={[styles.text, { color: config.text }]}>{config.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 10,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: 11,
    fontWeight: '600',
  },
});
