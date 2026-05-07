import * as FileSystem from 'expo-file-system/legacy';
import { ServerSettings, RecordingEntry } from '@/types/recording';
import { log } from './logger';

const UPLOAD_TIMEOUT_MS = 180000;
const RECORDINGS_DIR = FileSystem.documentDirectory + 'recordings/';

export type UploadProgressCallback = (progress: number) => void;

/**
 * iOSのコンテナUUID変更に対応: 保存済みURIが無効な場合、
 * ファイル名を抽出して現在のdocumentDirectoryから再構築する
 */
async function resolveRecordingUri(storedUri: string): Promise<{ uri: string; resolved: boolean }> {
  // まず保存済みURIでチェック
  try {
    const info = await FileSystem.getInfoAsync(storedUri);
    if (info.exists) return { uri: storedUri, resolved: false };
  } catch {}

  // URIが無効 → ファイル名を抽出して現在のディレクトリで再構築
  const filename = storedUri.split('/').pop();
  if (!filename) return { uri: storedUri, resolved: false };

  const newUri = RECORDINGS_DIR + filename;
  try {
    const info = await FileSystem.getInfoAsync(newUri);
    if (info.exists) {
      await log(`URI resolved: ${storedUri} → ${newUri}`);
      return { uri: newUri, resolved: true };
    }
  } catch {}

  return { uri: storedUri, resolved: false };
}

/**
 * username + password でログインして Bearer token を取得する。
 * 成功すると { token, userId, username, role } を返す。
 */
export async function loginAndGetToken(
  serverUrl: string,
  username: string,
  password: string
): Promise<{ token: string; userId: string; username: string; role: string } | null> {
  try {
    const res = await fetch(`${serverUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, deviceLabel: 'rec18082' }),
    });
    if (!res.ok) {
      await log(`Login failed: status=${res.status}`);
      return null;
    }
    const data = await res.json();
    if (!data?.token) return null;
    return data;
  } catch (err) {
    await log(`Login error: ${err}`);
    return null;
  }
}

export async function testConnection(settings: ServerSettings): Promise<boolean> {
  // 新方式: 既存 token があれば /api/auth/test を Bearer で叩く
  // token がなければ username/password でログインして token を取得
  const { serverUrl, username, password, token } = settings;

  const tryBearer = async (bearerToken: string): Promise<boolean> => {
    try {
      const response = await fetch(`${serverUrl}/api/auth/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearerToken}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  if (token) {
    const ok = await tryBearer(token);
    if (ok) return true;
  }

  // トークンがない or 無効 → ログインして取得
  const login = await loginAndGetToken(serverUrl, username, password);
  if (!login) return false;
  return tryBearer(login.token);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export async function uploadRecording(
  settings: ServerSettings,
  recording: RecordingEntry,
  onProgress?: UploadProgressCallback
): Promise<{ ok: boolean; serverId?: string; fileMissing?: boolean; resolvedUri?: string; newToken?: string }> {
  const { serverUrl, username, password } = settings;
  const t0 = Date.now();
  const ms = () => Date.now() - t0;

  await log(`[diag] upload begin: ${recording.filename} (${recording.fileSize}B, ${recording.duration}ms)`);
  await log(`[diag] target: ${serverUrl}`);

  // Bearer token を取得 (既存 or 新規ログイン)
  let token = settings.token ?? null;
  let newToken: string | undefined;
  if (!token) {
    await log(`[diag] +${ms()}ms login start (no token)`);
    const login = await loginAndGetToken(serverUrl, username, password);
    if (!login) {
      await log(`[diag] +${ms()}ms upload abort: login failed`);
      return { ok: false };
    }
    token = login.token;
    newToken = login.token;
    await log(`[diag] +${ms()}ms login ok`);
  } else {
    await log(`[diag] +${ms()}ms using existing token`);
  }
  const authHeader = `Bearer ${token}`;

  // ファイル存在チェック（iOSコンテナUUID変更に対応）
  await log(`[diag] +${ms()}ms resolving uri: ${recording.uri}`);
  const { uri: resolvedUri, resolved } = await resolveRecordingUri(recording.uri);
  if (resolved) {
    recording = { ...recording, uri: resolvedUri };
  }

  try {
    const fileInfo = await FileSystem.getInfoAsync(resolvedUri);
    if (!fileInfo.exists) {
      await log(`[diag] +${ms()}ms file not found: ${recording.uri} (resolved=${resolvedUri})`);
      return { ok: false, fileMissing: true };
    }
    await log(`[diag] +${ms()}ms file confirmed: ${resolvedUri} (size=${fileInfo.size ?? 'unknown'})`);
  } catch (err) {
    await log(`[diag] +${ms()}ms file check error: ${resolvedUri} ${err}`);
    return { ok: false, fileMissing: true };
  }

  // FOREGROUND only: シンプルに fetch() で multipart アップロード
  //
  // 設計判断:
  //   - createUploadTask は内部で iOS NSURLSession の挙動が不透明 (FOREGROUND 指定でも
  //     失敗する事象を確認したため、純粋な fetch() のみに切り替え)
  //   - 録音ファイルはローカルに永続化されているため、アプリがスリープして転送が
  //     中断されても、次回起動時の uploadPending() で自動リトライされる
  //   - ユーザーがアプリを開いている前提のアップロード = foreground のみ
  //   - 進捗バイト単位は失われる (fetch には progress コールバックがない)
  //     → UI 側は「Uploading...」の状態表示のみ
  //
  // onProgress は呼び出し互換のため残置 (送信開始/完了時に 0 / 1 を1度ずつ通知)
  void onProgress;

  try {
    await log(`[diag] +${ms()}ms upload start (fetch, FOREGROUND): ${recording.filename}`);
    const formData = new FormData();
    formData.append('file', {
      uri: resolvedUri,
      name: recording.filename,
      type: recording.mimeType,
    } as any);
    formData.append('originalName', recording.filename);
    formData.append('displayName', recording.displayName);
    formData.append('duration', String(recording.duration));

    onProgress?.(0);
    const response = await withTimeout(
      fetch(`${serverUrl}/api/recordings/upload`, {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: formData,
      }),
      UPLOAD_TIMEOUT_MS,
      'fetch'
    );

    await log(`[diag] +${ms()}ms response received: status=${response.status} ok=${response.ok}`);

    if (response.ok) {
      const data = await response.json();
      onProgress?.(1);
      await log(`[diag] +${ms()}ms upload SUCCESS: ${recording.filename} serverId=${data.id}`);
      return { ok: true, serverId: data.id, resolvedUri: resolved ? resolvedUri : undefined, newToken };
    }
    const errBody = await response.text().catch(() => '');
    await log(`[diag] +${ms()}ms upload FAILED: status=${response.status} body=${errBody.slice(0, 300)}`);
  } catch (err) {
    await log(`[diag] +${ms()}ms fetch error: ${err}`);
  }

  await log(`[diag] +${ms()}ms upload abandoned`);
  return { ok: false };
}
