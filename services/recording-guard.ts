// 長時間録音を黙って失わないための見張り。
//
// 8時間録っていれば、着信も、イヤホンの抜き差しも、空き容量の枯渇も必ず当たる。
// どれも「気づかないまま録れていなかった」が最悪なので、検知して知らせ、拾えるものは拾う。

import * as FileSystem from 'expo-file-system/legacy';
import { RecordingEntry } from '@/types/recording';
import VoicerecAudio from '@/modules/voicerec-audio';

/** これを下回ったら録音を止める。録音し続けて静かに壊れるより、止めて知らせる方がよい */
export const MIN_FREE_BYTES = 500 * 1024 * 1024;
/** 録音中に空き容量を見る間隔 */
export const FREE_SPACE_CHECK_MS = 60_000;

export async function freeDiskBytes(): Promise<number> {
  try {
    return await FileSystem.getFreeDiskStorageAsync();
  } catch {
    return Number.MAX_SAFE_INTEGER; // 取れないときは止めない
  }
}

export function formatHours(bytes: number, bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '—';
  const hours = bytes / bytesPerSec / 3600;
  if (hours >= 100) return '100時間以上';
  if (hours >= 1) return `約${Math.floor(hours)}時間`;
  return `約${Math.max(1, Math.floor(hours * 60))}分`;
}

/**
 * 録音中にアプリが落ちると、ファイルだけが残って一覧に出てこない。
 * CAF は索引を後置しないので中身は読める。起動時に拾い上げて一覧に戻す。
 *
 * ⚠️ m4a ではこれができない（停止時にしか索引を書かないため、落ちると全損する）。
 *    長時間録音を CAF にしている理由がこれ。
 */
export async function recoverOrphanRecordings(
  dir: string,
  known: RecordingEntry[],
  makeId: () => string,
): Promise<RecordingEntry[]> {
  const info = await FileSystem.getInfoAsync(dir);
  if (!info.exists) return [];

  const knownNames = new Set(known.map(r => r.uri.split('/').pop()));
  let names: string[] = [];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return [];
  }

  const found: RecordingEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.caf') || knownNames.has(name)) continue;
    const uri = dir + name;
    const probe = await VoicerecAudio.inspect(uri).catch(() => null);
    if (!probe?.readable || !probe.durationSec || probe.durationSec < 1) continue;

    // ファイル名の yyyymmdd-hhmmss を開始時刻として読む（録音開始時に付けている）
    const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
    const startedAt = m
      ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
      : new Date();

    found.push({
      id: makeId(),
      uri,
      filename: name,
      displayName: name.replace('.caf', '') + '（復元）',
      duration: Math.round(probe.durationSec * 1000),
      fileSize: probe.fileSize,
      mimeType: 'audio/x-caf',
      uploadStatus: 'uploaded', // 長時間録音はそのままでは送らない
      createdAt: new Date(startedAt.getTime() + probe.durationSec * 1000).toISOString(),
      kind: 'long',
      startedAt: startedAt.toISOString(),
    });
  }
  return found;
}
