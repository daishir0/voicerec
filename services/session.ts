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
import VoicerecAudio from '@/modules/voicerec-audio';
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
  /** 文字起こしの処理が済んだ断片の数（無音で文字が出なかったものも含む） */
  transcribed: number;
  /** しおり。セッションの先頭からの秒。小さい順 */
  marks: number[];
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
  // ⚠️ 'quick' も混ぜる。1ボタン録音だった頃の録音も、1ファイルのセッションとして
  //    扱えば範囲を選べるし文字起こしもできる。別物にしておく理由がない。
  const longs = recordings
    .filter(r => r.kind === 'long' || r.kind === 'quick')
    .sort((a, b) => startOf(a) - startOf(b));

  const groups: RecordingEntry[][] = [];
  for (const r of longs) {
    const g = groups[groups.length - 1];
    const prev = g?.[g.length - 1];
    const continues =
      prev &&
      // 1ボタン録音は、たまたま時刻が続いていても別の録音。繋げない
      r.kind === 'long' && prev.kind === 'long' &&
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
        transcribed: parts.filter(r => r.transcript).length,
        // しおりは断片ごとに「その断片の先頭から」で持っているので、
        // セッションの先頭からの秒に直してから1本にまとめる
        marks: parts
          .flatMap(rec => (rec.marks ?? []).map(sec => (startOf(rec) - base) / 1000 + sec))
          .sort((a, b) => a - b),
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

export type PartHealth = {
  uri: string;
  filename: string;
  offsetSec: number;
  durationSec: number;
  readable: boolean;
  fileSize: number;
  error?: string;
};

/**
 * セッションの各ファイルが本当に読めるかを確かめる。
 *
 * ⚠️ アプリが持っている長さは**録音中に数えた値**で、ファイルの中身とは別物。
 *    録音中にアプリが落ちると、長さは残っているのにファイルは解析できない、という
 *    食い違いが起きる（2026-10-23、74分のファイルが AVFoundation で開けず
 *    OSStatus -17913 になった）。処理を始める前に確かめる。
 */
export async function checkParts(session: Session): Promise<PartHealth[]> {
  return Promise.all(session.parts.map(async (p) => {
    const base = {
      uri: p.rec.uri,
      filename: p.rec.filename,
      offsetSec: p.offsetSec,
      durationSec: p.durationSec,
    };
    try {
      const info = await VoicerecAudio.inspect(p.rec.uri);
      return {
        ...base,
        readable: !!info.readable && (info.durationSec ?? 0) > 0,
        fileSize: info.fileSize,
        error: info.error,
      };
    } catch (e: any) {
      return { ...base, readable: false, fileSize: 0, error: e?.message ?? String(e) };
    }
  }));
}

/** 読めないファイルを除いた範囲を返す。何も残らなければ空。 */
export function piecesForRangeHealthy(
  session: Session,
  startSec: number,
  endSec: number,
  health: PartHealth[],
): ClipPiece[] {
  const broken = new Set(health.filter(h => !h.readable).map(h => h.uri));
  return piecesForRange(session, startSec, endSec).filter(p => !broken.has(p.uri));
}

/** 範囲ぶんの文字起こし。断片ごとの結果をつないだもの */
export type ComposedTranscript = {
  text: string;
  /** 秒は **範囲の先頭から**。送信時の Segment がこの形を要求する */
  segments: { text: string; startSec: number; endSec: number }[];
  engine: string;
  /** この範囲に関わる断片のうち、文字起こしが終わっている数 */
  done: number;
  total: number;
};

/**
 * 断片ごとの文字起こしを、選んだ範囲に合わせて1本につなぐ。
 *
 * 各断片の segments は **その断片の先頭から** の秒なので、
 * セッション上の位置（offsetSec）を足してから範囲で切り、
 * 最後に範囲の先頭を引いて返す。
 *
 * ⚠️ 切り出してから文字起こしするのではなく、**録った断片をそのつど文字にしておいて、
 *    選ぶときはつなぐだけ**にしてある。範囲を変えるたびに待たされない。
 */
export function transcriptForRange(
  session: Session, startSec: number, endSec: number,
): ComposedTranscript | null {
  const out: ComposedTranscript['segments'] = [];
  let engine = '';
  let done = 0;
  let total = 0;

  for (const part of session.parts) {
    const partStart = part.offsetSec;
    const partEnd = part.offsetSec + part.durationSec;
    // 範囲にかすりもしない断片は数にも入れない
    if (partEnd <= startSec || partStart >= endSec) continue;
    total++;

    const tr = part.rec.transcript;
    // 処理が済んでいない断片はまだ数に入れない（画面の「○/○ まで」の分母になる）
    if (!tr) continue;
    done++;
    if (!tr.text) continue;
    if (!engine) engine = tr.engine;

    for (const s of tr.segments ?? []) {
      const at = partStart + s.startSec;
      const to = partStart + s.endSec;
      if (to <= startSec || at >= endSec) continue;
      out.push({ text: s.text, startSec: at - startSec, endSec: to - startSec });
    }
    // 区間が無い（古い形式の）結果は、断片まるごとが範囲に入るときだけ本文を使う
    if (!tr.segments?.length && partStart >= startSec && partEnd <= endSec) {
      out.push({ text: tr.text, startSec: partStart - startSec, endSec: partEnd - startSec });
    }
  }

  if (total === 0) return null;
  out.sort((a, b) => a.startSec - b.startSec);
  return { text: out.map(s => s.text).join(''), segments: out, engine: engine || 'analyzer', done, total };
}
