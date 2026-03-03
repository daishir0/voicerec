import AsyncStorage from '@react-native-async-storage/async-storage';
import { ServerSettings, RecordingEntry } from '@/types/recording';

const SETTINGS_KEY = 'rec18082_settings';
const RECORDINGS_KEY = 'rec18082_recordings';

export async function loadSettings(): Promise<ServerSettings | null> {
  try {
    const json = await AsyncStorage.getItem(SETTINGS_KEY);
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

export async function saveSettings(settings: ServerSettings): Promise<void> {
  await AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export async function loadRecordings(): Promise<RecordingEntry[]> {
  try {
    const json = await AsyncStorage.getItem(RECORDINGS_KEY);
    return json ? JSON.parse(json) : [];
  } catch {
    return [];
  }
}

export async function saveRecordings(recordings: RecordingEntry[]): Promise<void> {
  await AsyncStorage.setItem(RECORDINGS_KEY, JSON.stringify(recordings));
}
