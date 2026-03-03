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

  const formData = new FormData();
  formData.append('file', {
    uri: recording.uri,
    name: recording.filename,
    type: recording.mimeType,
  } as any);
  formData.append('originalName', recording.filename);
  formData.append('displayName', recording.displayName);
  formData.append('duration', String(recording.duration));

  try {
    const response = await fetch(`${serverUrl}/api/recordings/upload`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: formData,
    });

    if (response.ok) {
      const data = await response.json();
      return { ok: true, serverId: data.id };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}
