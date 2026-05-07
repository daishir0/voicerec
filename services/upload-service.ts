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

  // FOREGROUND only: FileSystem.uploadAsync (MULTIPART) で iOS ネイティブの multipart 実装を使用
  //
  // 設計判断:
  //   - RN の fetch() + FormData は iOS で multipart 最終 boundary が欠落する事象が再現
  //     (Apache 側で AH02608 / "Final boundary missing" エラー → 400)
  //   - FileSystem.uploadAsync(MULTIPART) は iOS NSURLSession のネイティブ multipart を使うため
  //     boundary 問題が発生しない
  //   - createUploadTask とは異なり同期 Promise で完了するため挙動が透明
  //   - 録音ファイルはローカルに永続化されているため、転送中断時も次回起動時の
  //     uploadPending() で自動リトライされる
  //
  // onProgress は呼び出し互換のため残置 (送信開始/完了時に 0 / 1 を1度ずつ通知)
  void onProgress;

  try {
    await log(`[diag] +${ms()}ms upload start (uploadAsync, FOREGROUND): ${recording.filename}`);

    onProgress?.(0);
    const result = await withTimeout(
      FileSystem.uploadAsync(
        `${serverUrl}/api/recordings/upload`,
        resolvedUri,
        {
          httpMethod: 'POST',
          uploadType: FileSystem.FileSystemUploadType.MULTIPART,
          fieldName: 'file',
          mimeType: recording.mimeType,
          parameters: {
            originalName: recording.filename,
            displayName: recording.displayName,
            duration: String(recording.duration),
          },
          headers: {
            Authorization: authHeader,
          },
        }
      ),
      UPLOAD_TIMEOUT_MS,
      'uploadAsync'
    );

    await log(`[diag] +${ms()}ms response received: status=${result.status}`);

    if (result.status >= 200 && result.status < 300) {
      const data = JSON.parse(result.body);
      onProgress?.(1);
      await log(`[diag] +${ms()}ms upload SUCCESS: ${recording.filename} serverId=${data.id}`);
      return { ok: true, serverId: data.id, resolvedUri: resolved ? resolvedUri : undefined, newToken };
    }
    await log(`[diag] +${ms()}ms upload FAILED: status=${result.status} body=${result.body.slice(0, 300)}`);
  } catch (err) {
    await log(`[diag] +${ms()}ms uploadAsync error: ${err}`);
  }

  await log(`[diag] +${ms()}ms upload abandoned`);
  return { ok: false };
}
