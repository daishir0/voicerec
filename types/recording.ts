/**
 * `local` は「サーバーに送らないもの」。長時間録音は切り出しの**素材**なので、
 * そのままでは送らない。以前は送信対象から外すために 'uploaded' を流用していて、
 * 一度も送っていない録音に「アップロード済み」と出ていた（2026-10-23 に直した）。
 */
export type UploadStatus = 'local' | 'waiting' | 'uploading' | 'uploaded' | 'failed';

/**
 * 録音の種類。
 *  quick … 1ボタンで録って、停止したらそのままサーバーへ（従来どおり）
 *  long  … 止めるまで録り続ける。あとから範囲を選んで切り出す
 *  clip  … long から切り出したもの
 */
export type RecordingKind = 'quick' | 'long' | 'clip';

export interface RecordingEntry {
  id: string;
  uri: string;
  filename: string;
  displayName: string;
  duration: number;
  fileSize: number;
  mimeType: string;
  uploadStatus: UploadStatus;
  serverId?: string;
  createdAt: string;
  /** アップロード中の進捗 (0.0〜1.0)。uploading 状態の時のみ意味を持つ。 */
  uploadProgress?: number;

  /** 省略時は 'quick'（この項目が無い既存データとの互換のため） */
  kind?: RecordingKind;
  /**
   * 録音を**開始**した絶対時刻。createdAt は停止時刻なので、長時間録音では別物になる。
   * 範囲選択はこれを基準に「何時何分」を秒オフセットへ直す。
   */
  startedAt?: string;
  /** 毎秒の音量（波形タイムライン）を書いたファイル。無ければ波形は出ない */
  levelsUri?: string;
  /**
   * 「ここまでを確定する」で区切られた録音は、同じセッションIDを持つ。
   * 利用者にとっては1本の録音なので、範囲選択はファイルの境目をまたげる。
   * この仕組みより前の録音には無いので、その場合は時刻の連続性で判断する。
   */
  sessionId?: string;
  /**
   * 端末内で文字起こしした結果。画面を離れても消えないように録音に持たせる。
   * 範囲を選び直したら作り直す。
   */
  transcript?: {
    text: string;
    /** 'analyzer'（iOS26+）か 'sf' */
    engine: string;
    /** どの範囲を起こしたか（秒） */
    startSec: number;
    endSec: number;
    at: string;
  };

  /** kind === 'clip' のとき、切り出し元と範囲 */
  sourceId?: string;
  clipStartSec?: number;
  clipEndSec?: number;
}

export interface ServerSettings {
  serverUrl: string;
  username: string;
  password: string;
  /** 初回ログイン後にサーバーが発行する Bearer token。以降の通信はこれを使用。 */
  token?: string | null;
}
