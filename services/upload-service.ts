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

  // Bearer token を取得 (既存 or 新規ログイン)
  let token = settings.token ?? null;
  let newToken: string | undefined;
  if (!token) {
    const login = await loginAndGetToken(serverUrl, username, password);
    if (!login) {
      await log('Upload abort: login failed');
      return { ok: false };
    }
    token = login.token;
    newToken = login.token;
  }
  const authHeader = `Bearer ${token}`;

  // ファイル存在チェック（iOSコンテナUUID変更に対応）
  const { uri: resolvedUri, resolved } = await resolveRecordingUri(recording.uri);
  if (resolved) {
    // URI が解決された場合、呼び出し元に通知するためにrecordingを更新
    recording = { ...recording, uri: resolvedUri };
  }

  try {
    const fileInfo = await FileSystem.getInfoAsync(resolvedUri);
    if (!fileInfo.exists) {
      await log(`Upload skip: file not found: ${recording.uri} (resolved=${resolvedUri})`);
      return { ok: false, fileMissing: true };
    }
    await log(`Upload: file confirmed at ${resolvedUri} (resolved=${resolved})`);
  } catch (err) {
    await log(`Upload skip: file check error: ${resolvedUri} ${err}`);
    return { ok: false, fileMissing: true };
  }

  // Try createUploadTask first (background session + progress callback)
  try {
    await log(`Upload start (uploadTask): ${recording.filename} → ${serverUrl}`);
    const task = FileSystem.createUploadTask(
      `${serverUrl}/api/recordings/upload`,
      resolvedUri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        fieldName: 'file',
        parameters: {
          originalName: recording.filename,
          displayName: recording.displayName,
          duration: String(recording.duration),
        },
        headers: {
          Authorization: authHeader,
        },
        sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
      },
      (data) => {
        if (onProgress && data.totalBytesExpectedToSend > 0) {
          onProgress(data.totalBytesSent / data.totalBytesExpectedToSend);
        }
      }
    );
    const result = await withTimeout(task.uploadAsync(), UPLOAD_TIMEOUT_MS, 'uploadTask');
    if (!result) throw new Error('Upload task returned no result');

    if (result.status >= 200 && result.status < 300) {
      try {
        const data = JSON.parse(result.body);
        await log(`Upload success (uploadTask): ${recording.filename} serverId=${data.id}`);
        return { ok: true, serverId: data.id, resolvedUri: resolved ? resolvedUri : undefined, newToken };
      } catch {
        await log(`Upload success (uploadTask): ${recording.filename} (no body parse)`);
        return { ok: true, resolvedUri: resolved ? resolvedUri : undefined, newToken };
      }
    }
    await log(`Upload failed (uploadTask): status=${result.status} body=${result.body}`);
  } catch (err) {
    await log(`uploadTask error: ${err}, falling back to fetch`);
  }

  // Fallback: use fetch with FormData
  try {
    await log(`Upload start (fetch fallback): ${recording.filename}`);
    const formData = new FormData();
    formData.append('file', {
      uri: resolvedUri,
      name: recording.filename,
      type: recording.mimeType,
    } as any);
    formData.append('originalName', recording.filename);
    formData.append('displayName', recording.displayName);
    formData.append('duration', String(recording.duration));

    const response = await withTimeout(
      fetch(`${serverUrl}/api/recordings/upload`, {
        method: 'POST',
        headers: { Authorization: authHeader },
        body: formData,
      }),
      UPLOAD_TIMEOUT_MS,
      'fetch'
    );

    if (response.ok) {
      const data = await response.json();
      await log(`Upload success (fetch): ${recording.filename} serverId=${data.id}`);
      return { ok: true, serverId: data.id, resolvedUri: resolved ? resolvedUri : undefined, newToken };
    }
    await log(`Upload failed (fetch): status=${response.status}`);
  } catch (err) {
    await log(`Upload fetch error: ${err}`);
  }

  return { ok: false };
}
