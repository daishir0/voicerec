import * as FileSystem from 'expo-file-system/legacy';
import { ServerSettings, RecordingEntry } from '@/types/recording';

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

export async function uploadRecording(
  settings: ServerSettings,
  recording: RecordingEntry
): Promise<{ ok: boolean; serverId?: string }> {
  const { serverUrl, username, password } = settings;
  const auth = btoa(`${username}:${password}`);

  // Try FileSystem.uploadAsync first (foreground session for reliability)
  try {
    const result = await FileSystem.uploadAsync(
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
        sessionType: FileSystem.FileSystemSessionType.FOREGROUND,
      }
    );

    if (result.status >= 200 && result.status < 300) {
      try {
        const data = JSON.parse(result.body);
        return { ok: true, serverId: data.id };
      } catch {
        return { ok: true };
      }
    }
    console.warn(`Upload failed (uploadAsync): status=${result.status} body=${result.body}`);
  } catch (err) {
    console.warn('uploadAsync error, falling back to fetch:', err);
  }

  // Fallback: use fetch with FormData
  try {
    const formData = new FormData();
    formData.append('file', {
      uri: recording.uri,
      name: recording.filename,
      type: recording.mimeType,
    } as any);
    formData.append('originalName', recording.filename);
    formData.append('displayName', recording.displayName);
    formData.append('duration', String(recording.duration));

    const response = await fetch(`${serverUrl}/api/recordings/upload`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: formData,
    });

    if (response.ok) {
      const data = await response.json();
      return { ok: true, serverId: data.id };
    }
    console.warn(`Upload failed (fetch): status=${response.status}`);
  } catch (err) {
    console.warn('Upload fetch error:', err);
  }

  return { ok: false };
}
