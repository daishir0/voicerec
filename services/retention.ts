// 古い録音を自動で消す。
//
// 「容量を気にせず録りっぱなしにできる」ためには、放っておいても減ることが要る。
// 既定は2日。起動のたび・前面復帰のたび・録音停止のたびに走らせる。
//
// 安全弁（既定で有効）:
//   - まだサーバーへ送れていないものは消さない（送る前に消えたら復元できない）
//   - ★（protected）を付けたものは消さない

import * as FileSystem from 'expo-file-system/legacy';
import { RecordingEntry } from '@/types/recording';
import { deleteLevels } from './level-track';

/** 設定で選べる保持日数。0 は「自動削除しない」 */
export const RETENTION_CHOICES = [1, 2, 3, 7, 14, 0] as const;
export type RetentionDays = (typeof RETENTION_CHOICES)[number];
export const DEFAULT_RETENTION_DAYS: RetentionDays = 2;

export function retentionLabel(days: RetentionDays): string {
  return days === 0 ? '自動削除しない' : `${days}日`;
}

export type RetentionOptions = {
  days: RetentionDays;
  /** 未アップロードを守る（既定 true） */
  keepUnuploaded?: boolean;
};

export type RetentionResult = {
  deleted: RecordingEntry[];
  keptProtected: number;
  keptUnuploaded: number;
  freedBytes: number;
};

/** 消す対象を決める。ファイル操作はしない（この関数だけ単体で試せるように分けてある）。 */
export function selectExpired(
  recordings: RecordingEntry[],
  opts: RetentionOptions,
  now: number = Date.now(),
): RetentionResult {
  const result: RetentionResult = { deleted: [], keptProtected: 0, keptUnuploaded: 0, freedBytes: 0 };
  if (!opts.days) return result;

  const keepUnuploaded = opts.keepUnuploaded !== false;
  const limit = now - opts.days * 24 * 60 * 60 * 1000;

  for (const r of recordings) {
    // 基準は「録り終えた時刻」。長時間録音は開始が何日も前のことがある。
    const at = new Date(r.createdAt).getTime();
    if (!Number.isFinite(at) || at >= limit) continue;
    if (r.protected) { result.keptProtected++; continue; }
    if (keepUnuploaded && r.uploadStatus !== 'uploaded') { result.keptUnuploaded++; continue; }
    result.deleted.push(r);
    result.freedBytes += r.fileSize || 0;
  }
  return result;
}

/** 実際に消す。残った一覧を返す。 */
export async function applyRetention(
  recordings: RecordingEntry[],
  opts: RetentionOptions,
  onLog?: (msg: string) => void,
): Promise<{ kept: RecordingEntry[]; result: RetentionResult }> {
  const result = selectExpired(recordings, opts);
  if (result.deleted.length === 0) return { kept: recordings, result };

  for (const r of result.deleted) {
    try {
      const info = await FileSystem.getInfoAsync(r.uri);
      if (info.exists) await FileSystem.deleteAsync(r.uri, { idempotent: true });
    } catch (e) {
      onLog?.(`自動削除: ファイルを消せませんでした ${r.filename}`);
    }
    await deleteLevels(r.levelsUri);
  }
  const ids = new Set(result.deleted.map(r => r.id));
  const kept = recordings.filter(r => !ids.has(r.id));
  onLog?.(
    `自動削除: ${result.deleted.length}件 / ${(result.freedBytes / 1024 / 1024).toFixed(1)}MB を解放` +
    (result.keptUnuploaded ? `（未送信 ${result.keptUnuploaded}件は残した）` : '') +
    (result.keptProtected ? `（★ ${result.keptProtected}件は残した）` : ''),
  );
  return { kept, result };
}

/** 端末に残っている録音の合計サイズ。設定画面に出す。 */
export function totalBytes(recordings: RecordingEntry[]): number {
  return recordings.reduce((sum, r) => sum + (r.fileSize || 0), 0);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}
