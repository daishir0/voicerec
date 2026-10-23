// 録音の「セッション」。
//
// 「ここまでを確定する」を押すと、1回の録音が2つ以上のファイルに分かれる。
// だが**利用者にとっては1本の録音**なので、13:00〜14:10 と 14:10〜14:40 をまたいで
// 14:00〜14:30 を選べなければならない。ファイルの境目は実装の都合であって、
// 画面に出すべきものではない。
//
// ここでは「連続した録音のまとまり」をセッションとして扱い、
// 絶対時刻（壁時計）を基準に範囲を決め、それを各ファイルの位置に割り直す。

import { RecordingEntry } from '@/types/recording';
import { loadLevels } from './level-track';

/** 区切り直しで生まれる隙間。これ以内なら「続き」とみなす */
const GAP_TOLERANCE_SEC = 3;

export type SessionPart = {
  rec: RecordingEntry;
  /** セッション開始からの秒（壁時計基準） */
  offsetSec: number;
  durationSec: number;
};

export type Session = {
  id: string;
  parts: SessionPart[];
  startedAt: Date;
  /** 壁時計での全体の長さ（区切りの隙間を含む） */
  totalSec: number;
  /** 実際に音がある長さの合計 */
  audioSec: number;
  fileSize: number;
  /** 区切られた回数（0 なら1本もの） */
  splits: number;
  /** どれかが保護されていれば保護扱い */
  protected: boolean;
  /** 最後に文字起こしした結果（どれかが持っていれば） */
  transcript?: RecordingEntry['transcript'];
};

function startOf(r: RecordingEntry): number {
  return new Date(r.startedAt ?? r.createdAt).getTime();
}

function endOf(r: RecordingEntry): number {
  return startOf(r) + r.duration;
}

/**
 * 長時間録音をセッションにまとめる。新しい順に返す。
 *
 * ⚠️ sessionId があればそれを信じる。無い録音（この仕組みより前に録ったもの）は、
 *    前の録音の終わりと次の録音の始まりが連続しているかで判断する。
 */
export function buildSessions(recordings: RecordingEntry[]): Session[] {
  const longs = recordings
    .filter(r => r.kind === 'long')
    .sort((a, b) => startOf(a) - startOf(b));

  const groups: RecordingEntry[][] = [];
  for (const r of longs) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    const continues =
      prev &&
      (r.sessionId && prev.sessionId
        ? r.sessionId === prev.sessionId
        : Math.abs(startOf(r) - endOf(prev)) <= GAP_TOLERANCE_SEC * 1000);
    if (continues) g.push(r);
    else groups.push([r]);
  }

  return groups
    .map(parts => {
      const base = startOf(parts[0]);
      const last = parts[parts.length - 1];
      return {
        id: parts[0].sessionId ?? parts[0].id,
        parts: parts.map(rec => ({
          rec,
          offsetSec: (startOf(rec) - base) / 1000,
          durationSec: rec.duration / 1000,
        })),
        startedAt: new Date(base),
        totalSec: (endOf(last) - base) / 1000,
        audioSec: parts.reduce((s, r) => s + r.duration, 0) / 1000,
        fileSize: parts.reduce((s, r) => s + (r.fileSize || 0), 0),
        splits: parts.length - 1,
        protected: parts.some(r => r.protected),
        transcript: parts.map(r => r.transcript).filter(Boolean).pop(),
      };
    })
    .reverse();
}

export type ClipPiece = {
  uri: string;
  /** そのファイルの中での位置 */
  startSec: number;
  endSec: number;
  /** セッション全体（壁時計）での開始位置。再生位置の表示に使う */
  sessionStartSec: number;
};

/**
 * セッション上の範囲を、各ファイルの中の位置に割り直す。
 *
 * ⚠️ 区切りの隙間（0.3秒ほど）は音が存在しないので、繋いだ結果は壁時計より僅かに短くなる。
 *    長さは「実際に取れた長さ」で表示すること。
 */
export function piecesForRange(session: Session, startSec: number, endSec: number): ClipPiece[] {
  const out: ClipPiece[] = [];
  for (const p of session.parts) {
    const from = Math.max(startSec, p.offsetSec);
    const to = Math.min(endSec, p.offsetSec + p.durationSec);
    if (to - from <= 0.05) continue;
    out.push({
      uri: p.rec.uri,
      startSec: from - p.offsetSec,
      endSec: to - p.offsetSec,
      sessionStartSec: from,
    });
  }
  return out;
}

/** 選んだ範囲に実際に音がある秒数（隙間を除いた長さ） */
export function audioSecondsIn(session: Session, startSec: number, endSec: number): number {
  return piecesForRange(session, startSec, endSec)
    .reduce((s, p) => s + (p.endSec - p.startSec), 0);
}

/**
 * セッション全体の波形。各ファイルの波形を壁時計の位置に並べ、隙間は 0 で埋める。
 */
export async function loadSessionLevels(session: Session): Promise<Uint8Array> {
  const total = Math.max(1, Math.ceil(session.totalSec));
  const out = new Uint8Array(total);
  for (const p of session.parts) {
    if (!p.rec.levelsUri) continue;
    const lv = await loadLevels(p.rec.levelsUri);
    const at = Math.floor(p.offsetSec);
    for (let i = 0; i < lv.length && at + i < total; i++) out[at + i] = lv[i];
  }
  return out;
}

/** 画面に出す1行。区切りがあっても「1本の録音」として見せる */
export function describeSession(s: Session): string {
  const h = Math.floor(s.totalSec / 3600);
  const m = Math.floor((s.totalSec % 3600) / 60);
  const len = h > 0 ? `${h}時間${String(m).padStart(2, '0')}分` : `${m}分`;
  return `${s.startedAt.toLocaleString('ja-JP')} から ${len}`;
}
