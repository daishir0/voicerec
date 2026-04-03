import * as FileSystem from 'expo-file-system/legacy';
import { ServerSettings, RecordingEntry } from '@/types/recording';
import { log } from './logger';

const UPLOAD_TIMEOUT_MS = 30000;

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
): Promise<{ ok: boolean; serverId?: string; fileMissing?: boolean }> {
  const { serverUrl, username, password } = settings;
  const auth = btoa(`${username}:${password}`);

  // ファイル存在チェック
  try {
    const fileInfo = await FileSystem.getInfoAsync(recording.uri);
    if (!fileInfo.exists) {
      await log(`Upload skip: file not found: ${recording.uri}`);
      return { ok: false, fileMissing: true };
    }
  } catch (err) {
    await log(`Upload skip: file check error: ${recording.uri} ${err}`);
    return { ok: false, fileMissing: true };
  }

  // Try FileSystem.uploadAsync first (foreground session)
  try {
    await log(`Upload start (uploadAsync): ${recording.filename} → ${serverUrl}`);
    const result = await withTimeout(
      FileSystem.uploadAsync(
        `${serverUrl}/api/recordings/upload`,
        recording.uri,
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
        return { ok: true, serverId: data.id };
      } catch {
        await log(`Upload success (uploadAsync): ${recording.filename} (no body parse)`);
        return { ok: true };
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
      uri: recording.uri,
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
      return { ok: true, serverId: data.id };
    }
    await log(`Upload failed (fetch): status=${response.status}`);
  } catch (err) {
    await log(`Upload fetch error: ${err}`);
  }

  return { ok: false };
}
