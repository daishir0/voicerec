import * as FileSystem from 'expo-file-system/legacy';
import { ServerSettings, RecordingEntry } from '@/types/recording';
import { log } from './logger';

const UPLOAD_TIMEOUT_MS = 30000;
const RECORDINGS_DIR = FileSystem.documentDirectory + 'recordings/';

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

export async function testConnection(settings: ServerSettings): Promise<boolean> {
  const { serverUrl, username, password } = settings;
  const auth = btoa(`${username}:${password}`);

  try {
    const response = await fetch(`${serverUrl}/api/auth/test`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
    });
    return response.ok;
  } catch {
    return false;
  }
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
  recording: RecordingEntry
): Promise<{ ok: boolean; serverId?: string; fileMissing?: boolean; resolvedUri?: string }> {
  const { serverUrl, username, password } = settings;
  const auth = btoa(`${username}:${password}`);

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

  // Try FileSystem.uploadAsync first (foreground session)
  try {
    await log(`Upload start (uploadAsync): ${recording.filename} → ${serverUrl}`);
    const result = await withTimeout(
      FileSystem.uploadAsync(
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
            Authorization: `Basic ${auth}`,
          },
          sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
        }
      ),
      UPLOAD_TIMEOUT_MS,
      'uploadAsync'
    );

    if (result.status >= 200 && result.status < 300) {
      try {
        const data = JSON.parse(result.body);
        await log(`Upload success (uploadAsync): ${recording.filename} serverId=${data.id}`);
        return { ok: true, serverId: data.id, resolvedUri: resolved ? resolvedUri : undefined };
      } catch {
        await log(`Upload success (uploadAsync): ${recording.filename} (no body parse)`);
        return { ok: true, resolvedUri: resolved ? resolvedUri : undefined };
      }
    }
    await log(`Upload failed (uploadAsync): status=${result.status} body=${result.body}`);
  } catch (err) {
    await log(`uploadAsync error: ${err}, falling back to fetch`);
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
        headers: { Authorization: `Basic ${auth}` },
        body: formData,
      }),
      UPLOAD_TIMEOUT_MS,
      'fetch'
    );

    if (response.ok) {
      const data = await response.json();
      await log(`Upload success (fetch): ${recording.filename} serverId=${data.id}`);
      return { ok: true, serverId: data.id, resolvedUri: resolved ? resolvedUri : undefined };
    }
    await log(`Upload failed (fetch): status=${response.status}`);
  } catch (err) {
    await log(`Upload fetch error: ${err}`);
  }

  return { ok: false };
}
