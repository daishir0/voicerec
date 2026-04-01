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

  try {
    // FileSystem.uploadAsync uses NSURLSession on iOS,
    // which continues uploading even when the app is backgrounded.
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
        sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
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
    console.warn(`Upload failed: status=${result.status} body=${result.body}`);
    return { ok: false };
  } catch (err) {
    console.warn('Upload error:', err);
    return { ok: false };
  }
}
