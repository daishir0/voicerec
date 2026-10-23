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
  /** 実際に書けた長さ。録音中のファイルからだと頼んだ範囲より短いことがある */
  durationSec: number;
  /** 頼んだ範囲の長さ */
  requestedSec?: number;
  /** 繋いだファイルの数（clipRanges* のとき） */
  partCount?: number;
  elapsedMs: number;
};

export type TranscribeResult = {
  text: string;
  /** 実際に使ったエンジン */
  engine: 'analyzer' | 'sf';
  /** SFSpeech のときの分割数（1セッション1分の上限があるため） */
  chunks: number;
  elapsedMs: number;
  /** analyzer を試して落ちたときの理由 */
  fallbackReason?: string;
};

export type PrepareLocaleResult = {
  installed: boolean;
  downloaded?: boolean;
  reason?: string;
};

/** 経路の変化。イヤホンや Bluetooth の抜き差しで入力が変わると録音が壊れうる。 */
export type AudioRouteChangeEvent = {
  reason: string;
  /** 入力そのものが変わったか。true なら録り直しを検討する */
  inputChanged: boolean;
  inputName: string;
  inputType: string;
  /** 機器を見分けるための id。同じ機器なら録り直さない */
  inputUID: string;
  isBluetooth: boolean;
  sampleRate: number;
};

export type AudioInput = {
  name: string;
  type: string;
  uid: string;
  isBluetooth: boolean;
  sampleRate: number;
};

type Events = {
  onAudioInterruption: (event: AudioInterruptionEvent) => void;
  onAudioRouteChange: (event: AudioRouteChangeEvent) => void;
};

declare class VoicerecAudio extends NativeModule<Events> {
  probe(locale: string): Promise<SpeechProbe>;
  requestSpeechPermission(): Promise<SpeechProbe['sfAuthStatus']>;
  inspect(uri: string): Promise<AudioFileInfo>;
  trimToWav(uri: string, startSec: number, endSec: number, outUri: string): Promise<TrimResult>;
  trimToM4a(uri: string, startSec: number, endSec: number, outUri: string): Promise<TrimResult>;
  /**
   * 複数ファイルの一部ずつを時間順に繋いで1本に切り出す。
   * 「ここまでを確定する」で分かれた録音をまたいだ範囲に使う。
   * 引数は平行な配列（uris[i] の startSec[i]〜endSec[i] を順に繋ぐ）。
   */
  clipRangesToWav(uris: string[], starts: number[], ends: number[], outUri: string): Promise<TrimResult>;
  clipRangesToM4a(uris: string[], starts: number[], ends: number[], outUri: string): Promise<TrimResult>;
  /** engine: 'auto'（既定・iOS26+なら SpeechAnalyzer）/ 'analyzer' / 'sf' */
  transcribe(uri: string, locale: string, engine: 'auto' | 'analyzer' | 'sf'): Promise<TranscribeResult>;
  prepareLocale(locale: string): Promise<PrepareLocaleResult>;
  currentInput(): AudioInput;
  /** 中断と経路変更の両方を見張る */
  startInterruptionObserver(): boolean;
  stopInterruptionObserver(): boolean;
}

export default requireNativeModule<VoicerecAudio>('VoicerecAudio');
