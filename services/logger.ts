import * as FileSystem from 'expo-file-system/legacy';

const LOG_DIR = FileSystem.documentDirectory + 'logs/';

function getLogFileName(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}.log`;
}

function timestamp(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

// UI のデバッグログ表示と橋渡しするためのリスナ
type LogListener = (message: string) => void;
const listeners: LogListener[] = [];

export function registerLogListener(fn: LogListener): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

export async function log(message: string): Promise<void> {
  const line = `[${timestamp()}] ${message}\n`;
  console.log(message);

  // UI 側のリスナへも通知 (例: AppContext の addDebugLog)
  for (const fn of listeners) {
    try {
      fn(message);
    } catch {
      /* ignore listener error */
    }
  }

  try {
    const dirInfo = await FileSystem.getInfoAsync(LOG_DIR);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(LOG_DIR, { intermediates: true });
    }
    const filePath = LOG_DIR + getLogFileName();
    const fileInfo = await FileSystem.getInfoAsync(filePath);
    if (fileInfo.exists) {
      const existing = await FileSystem.readAsStringAsync(filePath);
      await FileSystem.writeAsStringAsync(filePath, existing + line);
    } else {
      await FileSystem.writeAsStringAsync(filePath, line);
    }
  } catch (err) {
    console.warn('Logger write failed:', err);
  }
}
