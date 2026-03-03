// Whisper最低ライン録音プリセット
// M4A (AAC), 12kHz, モノラル, 16kbps — Whisper最小サイズ (~120KB/分)
// フォールバック: HIGH_QUALITY (44.1kHz, ステレオ, 128kbps)

import { RecordingPresets, IOSOutputFormat, AudioQuality } from 'expo-audio';
import type { RecordingOptions } from 'expo-audio';

export const WHISPER_PRESET: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 12000,
  numberOfChannels: 1,
  bitRate: 16000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MIN,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/mp4',
    bitsPerSecond: 16000,
  },
};

export const FALLBACK_PRESET = RecordingPresets.HIGH_QUALITY;

export function getFileExtension(): string {
  return '.m4a';
}

export function getMimeType(): string {
  return 'audio/mp4';
}
