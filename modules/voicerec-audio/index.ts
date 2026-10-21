import { NativeModule, requireNativeModule } from 'expo';

/** 録音の中断（着信・他アプリのマイク奪取）。長時間録音では必ず当たる。 */
export type AudioInterruptionEvent = {
  type: 'began' | 'ended';
  reason?: number;
  /** ended のとき、そのまま録音を再開してよいか */
  shouldResume?: boolean;
};

/** 端末内の音声認識が使えるかどうか。 */
export type SpeechProbe = {
  osVersion: string;
  /** SFSpeechRecognizer（iOS 13+）。1セッション1分の上限があるので長時間は分割が要る */
  sfSupported: boolean;
  sfAvailable: boolean;
  sfOnDevice: boolean;
  sfAuthStatus: 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown';
  /** SpeechAnalyzer / SpeechTranscriber（iOS 26+）。長時間向けで、モデルは OS が持つ */
  analyzerAvailable: boolean;
  analyzerLocales: string[];
  analyzerInstalled: string[];
  analyzerSupportsLocale: boolean;
};

/** 録音中のファイルを今の時点で読めるか。 */
export type AudioFileInfo = {
  uri: string;
  fileSize: number;
  readable: boolean;
  durationSec?: number;
  trackCount?: number;
  sampleRate?: number;
  channels?: number;
  formatID?: string;
  error?: string;
};

export type TrimResult = {
  uri: string;
  fileSize: number;
  startSec: number;
  endSec: number;
  durationSec: number;
  elapsedMs: number;
};

type Events = {
  onAudioInterruption: (event: AudioInterruptionEvent) => void;
};

declare class VoicerecAudio extends NativeModule<Events> {
  probe(locale: string): Promise<SpeechProbe>;
  requestSpeechPermission(): Promise<SpeechProbe['sfAuthStatus']>;
  inspect(uri: string): Promise<AudioFileInfo>;
  trimToWav(uri: string, startSec: number, endSec: number, outUri: string): Promise<TrimResult>;
  trimToM4a(uri: string, startSec: number, endSec: number, outUri: string): Promise<TrimResult>;
  startInterruptionObserver(): boolean;
  stopInterruptionObserver(): boolean;
}

export default requireNativeModule<VoicerecAudio>('VoicerecAudio');
