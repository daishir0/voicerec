// 長時間録音から、選んだ範囲だけを切り出す。
//
//   文字起こし → 16kHz モノラル WAV に切って、端末内の音声認識にかける
//   サーバーへ    → m4a に切って、いつものアップロード経路に乗せる
//
// ⚠️ サーバーは**ファイル名の yyyymmdd-hhmmss を JST として recordedAt に採用する**
//    （srv18083 の app/api/recordings/upload/route.ts）。切り出しの開始時刻を名前に入れれば、
//    サーバー側の改修なしで「何時何分の録音か」が正しく入り、時刻からの逆引きも効く。
// ⚠️ 同じユーザー・同じ originalName は重複として弾かれるので、名前に範囲の長さを入れて
//    同じ秒に始まる別の範囲とぶつからないようにする。

import * as FileSystem from 'expo-file-system/legacy';
import VoicerecAudio, { type TranscribeResult } from '@/modules/voicerec-audio';
import { RecordingEntry } from '@/types/recording';
import {
  audioSecondsIn, piecesForRange, piecesForRangeHealthy, type PartHealth, type Session,
} from './session';

export const CLIPS_DIR = FileSystem.documentDirectory + 'clips/';

export type ClipRange = { startSec: number; endSec: number };

function two(n: number): string {
  return String(n).padStart(2, '0');
}

/** 絶対時刻を yyyymmdd-hhmmss にする（端末のローカル時刻。サーバーは JST として読む） */
export function stampOf(d: Date): string {
  return (
    `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}` +
    `-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`
  );
}

/** 切り出しの開始絶対時刻 */
export function clipStartedAt(session: Session, range: ClipRange): Date {
  return new Date(session.startedAt.getTime() + range.startSec * 1000);
}

export function clipFilename(session: Session, range: ClipRange, ext: string): string {
  const seconds = Math.max(1, Math.round(range.endSec - range.startSec));
  return `${stampOf(clipStartedAt(session, range))}_${seconds}s${ext}`;
}

function generateId(): string {
  const chars = 'abcdef0123456789';
  let id = '';
  for (let i = 0; i < 32; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
    if (i === 7 || i === 11 || i === 15 || i === 19) id += '-';
  }
  return id;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(CLIPS_DIR);
  if (!info.exists) await FileSystem.makeDirectoryAsync(CLIPS_DIR, { intermediates: true });
}

/**
 * 範囲を m4a に切り出して、アップロード待ちの録音として登録できる形にして返す。
 * 返り値をそのまま addRecording() → uploadPending() に渡せば、いつもの経路で送られる。
 */
export async function createClipForUpload(
  session: Session,
  range: ClipRange,
  health?: PartHealth[],
  /** この範囲を端末で文字起こし済みなら渡す。サーバーはこれを採用し、作り直さない */
  transcript?: RecordingEntry['transcript'],
  /** 書き出した形を残したいとき。実機では画面のログでしか確かめられない */
  log?: (msg: string) => void,
): Promise<RecordingEntry> {
  await ensureDir();
  const filename = clipFilename(session, range, '.m4a');
  const dest = CLIPS_DIR + filename;
  // 区切られていてもファイルの境目をまたいで1本に繋ぐ
  const pieces = health
    ? piecesForRangeHealthy(session, range.startSec, range.endSec, health)
    : piecesForRange(session, range.startSec, range.endSec);
  if (pieces.length === 0) throw new Error('選んだ範囲に、読める音声がありません');
  const trimmed = await VoicerecAudio.clipRangesToM4a(
    pieces.map(p => p.uri), pieces.map(p => p.startSec), pieces.map(p => p.endSec), dest);
  // 元の録音と同じ形で書けているかは、ここを見れば分かる
  log?.(`切り出し: ${(trimmed.fileSize / 1024 / 1024).toFixed(1)}MB `
    + `${((trimmed.bitRate ?? 0) / 1000).toFixed(0)}kbps `
    + `${((trimmed.sampleRate ?? 0) / 1000).toFixed(1)}kHz `
    + `${trimmed.partCount ?? 1}本 `
    // 実測が 0 なら元ファイルから読めず既定値に落ちている。how でどこから取れたか分かる
    + `(元の実測 ${((trimmed.sourceBps ?? 0) / 1000).toFixed(1)}kbps ${trimmed.sourceHow ?? '?'})`);
  const startedAt = clipStartedAt(session, range);

  return {
    id: generateId(),
    uri: dest,
    filename,
    displayName: filename.replace('.m4a', ''),
    duration: Math.round(trimmed.durationSec * 1000),
    fileSize: trimmed.fileSize,
    mimeType: 'audio/mp4',
    uploadStatus: 'waiting',
    createdAt: new Date().toISOString(),
    kind: 'clip',
    startedAt: startedAt.toISOString(),
    // 区間の秒は切り出した範囲の先頭から数えた値なので、そのまま渡せる
    ...(transcript ? { transcript } : {}),
    sourceId: session.parts[0].rec.id,
    clipStartSec: range.startSec,
    clipEndSec: range.endSec,
  };
}

/**
 * 範囲を端末内で文字起こしする。
 *
 * ⚠️ **中間ファイルは m4a にする。** 以前は 16kHz/16bit の WAV に展開していたが、
 *    1時間19分で 145MB になり、書き出しに失敗していた（2026-10-23）。
 *    同じ内容が m4a なら 18MB。SpeechAnalyzer は AVAudioFile 経由で m4a を読めるし、
 *    SFSpeech に落ちる場合もネイティブ側が55秒ずつ WAV に割り直すので支障はない。
 */
export async function transcribeRange(
  session: Session,
  range: ClipRange,
  locale: string,
  engine: 'auto' | 'analyzer' | 'sf' = 'auto',
  health?: PartHealth[],
): Promise<TranscribeResult> {
  await ensureDir();
  const tmp = CLIPS_DIR + `tmp-${Date.now()}.m4a`;
  try {
    const pieces = health
      ? piecesForRangeHealthy(session, range.startSec, range.endSec, health)
      : piecesForRange(session, range.startSec, range.endSec);
    if (pieces.length === 0) throw new Error('選んだ範囲に、読める音声がありません');
    const cut = await VoicerecAudio.clipRangesToM4a(
      pieces.map(p => p.uri), pieces.map(p => p.startSec), pieces.map(p => p.endSec), tmp);
    if (!cut.fileSize) throw new Error('切り出した音声が空でした');
    return await VoicerecAudio.transcribe(tmp, locale, engine);
  } finally {
    try {
      await FileSystem.deleteAsync(tmp, { idempotent: true });
    } catch {
      // 消せなくても致命的ではない
    }
  }
}

/** 選んだ範囲に実際に音がある秒数（区切りの隙間を除く） */
export function clipAudioSeconds(session: Session, range: ClipRange): number {
  return audioSecondsIn(session, range.startSec, range.endSec);
}

/** 端末内の音声認識に出せる言語。SpeechTranscriber が対応しているもののうち実用的な範囲。 */
export const TRANSCRIBE_LOCALES: { id: string; label: string }[] = [
  { id: 'ja-JP', label: '日本語' },
  { id: 'en-US', label: '英語（米国）' },
  { id: 'en-GB', label: '英語（英国）' },
  { id: 'zh-CN', label: '中国語（簡体）' },
  { id: 'ko-KR', label: '韓国語' },
  { id: 'fr-FR', label: 'フランス語' },
  { id: 'de-DE', label: 'ドイツ語' },
  { id: 'es-ES', label: 'スペイン語' },
  { id: 'it-IT', label: 'イタリア語' },
  { id: 'pt-BR', label: 'ポルトガル語（ブラジル）' },
];
