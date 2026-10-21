// 毎秒の音量を1バイトずつ記録する（波形タイムライン）。
//
// 長時間録音から「どこで話していたか」を探すのに、音声そのものをデコードするのは重すぎる。
// 録音中に取れるメーター値を1秒に1個だけ保存しておけば、1日分でも 86KB にしかならず、
// 一覧を開いた瞬間に波形を描ける。
//
//   -160dB（無音）→ 0 ／ 0dB（最大）→ 100
//
// ⚠️ 保存は base64。JSON の数値配列だと同じ内容で3倍になる。

import * as FileSystem from 'expo-file-system/legacy';

export const LEVELS_DIR = FileSystem.documentDirectory + 'levels/';
/** 1秒に1サンプル。これを変えると既存ファイルの解釈が変わるので注意 */
export const SAMPLES_PER_SEC = 1;
const FLUSH_INTERVAL_MS = 60_000;
/** メーターがこの dB を下回ったら無音とみなす */
const SILENCE_DB = -45;

/** メーター値(dBFS) を 0〜100 に畳む。null/NaN は無音として 0。 */
export function meteringToLevel(db: number | null | undefined): number {
  if (db == null || Number.isNaN(db)) return 0;
  if (db <= -60) return 0;
  if (db >= 0) return 100;
  // -60dB〜0dB を 0〜100 に。人の耳に合うよう低い側を持ち上げる
  return Math.round(Math.pow((db + 60) / 60, 0.6) * 100);
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return global.btoa ? global.btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
}

function fromBase64(b64: string): Uint8Array {
  const bin = global.atob ? global.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 録音中に音量を溜めて、ときどきファイルへ書く。
 * 書き込みは全文の置き換え（1日分でも 86KB なので、追記より単純で壊れにくい）。
 */
export class LevelTrackWriter {
  readonly uri: string;
  private levels: number[] = [];
  private lastFlush = 0;
  private flushing = false;

  constructor(recordingId: string) {
    this.uri = LEVELS_DIR + `${recordingId}.lv`;
  }

  get count(): number {
    return this.levels.length;
  }

  /** 1秒ぶんの値を足す。足りない秒は 0 で埋める（アプリが止まっていた区間） */
  push(level: number, atSecond?: number): void {
    if (atSecond != null) {
      while (this.levels.length < atSecond) this.levels.push(0);
      this.levels[atSecond] = level;
    } else {
      this.levels.push(level);
    }
  }

  async flush(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - this.lastFlush < FLUSH_INTERVAL_MS) return;
    if (this.flushing || this.levels.length === 0) return;
    this.flushing = true;
    try {
      const info = await FileSystem.getInfoAsync(LEVELS_DIR);
      if (!info.exists) await FileSystem.makeDirectoryAsync(LEVELS_DIR, { intermediates: true });
      await FileSystem.writeAsStringAsync(this.uri, toBase64(Uint8Array.from(this.levels)), {
        encoding: FileSystem.EncodingType.Base64,
      });
      this.lastFlush = now;
    } finally {
      this.flushing = false;
    }
  }
}

export async function loadLevels(uri: string): Promise<Uint8Array> {
  try {
    const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    return fromBase64(b64);
  } catch {
    return new Uint8Array(0);
  }
}

export async function deleteLevels(uri?: string): Promise<void> {
  if (!uri) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // 消せなくても致命的ではない
  }
}

/** 画面の横幅に合わせて間引く。max 本の棒にまとめ、各区間の最大値を採る。 */
export function downsample(levels: Uint8Array, max: number): number[] {
  if (levels.length === 0 || max <= 0) return [];
  if (levels.length <= max) return Array.from(levels);
  const step = levels.length / max;
  const out: number[] = new Array(max);
  for (let i = 0; i < max; i++) {
    const from = Math.floor(i * step);
    const to = Math.min(levels.length, Math.floor((i + 1) * step));
    let peak = 0;
    for (let j = from; j < to; j++) if (levels[j] > peak) peak = levels[j];
    out[i] = peak;
  }
  return out;
}

export type SpeechBlock = { startSec: number; endSec: number };

/**
 * 声のかたまりを拾う。タップで会話単位を選べるようにするための下ごしらえ。
 *
 * @param minSilenceSec これ以上の無音が続いたら区切る
 * @param minBlockSec   これより短いかたまりは捨てる（咳やドアの音を拾わない）
 */
export function detectSpeechBlocks(
  levels: Uint8Array,
  minSilenceSec = 8,
  minBlockSec = 10,
): SpeechBlock[] {
  const threshold = meteringToLevel(SILENCE_DB);
  const blocks: SpeechBlock[] = [];
  let start = -1;
  let silence = 0;

  for (let i = 0; i < levels.length; i++) {
    if (levels[i] > threshold) {
      if (start < 0) start = i;
      silence = 0;
    } else if (start >= 0) {
      silence++;
      if (silence >= minSilenceSec) {
        const end = i - silence + 1;
        if (end - start >= minBlockSec) blocks.push({ startSec: start, endSec: end });
        start = -1;
        silence = 0;
      }
    }
  }
  if (start >= 0 && levels.length - start >= minBlockSec) {
    blocks.push({ startSec: start, endSec: levels.length });
  }
  return blocks;
}
