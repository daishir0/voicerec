import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

// フォアグラウンドでも通知を表示する
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

export type NotificationPermissionStatus = 'granted' | 'denied' | 'undetermined';

export async function getPermissionStatus(): Promise<NotificationPermissionStatus> {
  const { status } = await Notifications.getPermissionsAsync();
  if (status === 'granted') return 'granted';
  if (status === 'denied') return 'denied';
  return 'undetermined';
}

/** 許可が未取得なら OS プロンプトを出す。結果を返す。 */
export async function requestPermission(): Promise<NotificationPermissionStatus> {
  const existing = await getPermissionStatus();
  if (existing === 'granted') return 'granted';
  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted' ? 'granted' : 'denied';
}

export async function notifyUploadSuccess(displayName: string, recordingId: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: '録音をアップロードしました',
        body: displayName,
        data: { type: 'upload-success', recordingId },
      },
      trigger: null,
    });
  } catch {}
}

export async function notifyUploadFailed(displayName: string, recordingId: string): Promise<void> {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'アップロードに失敗しました',
        body: `${displayName}（タップで再試行）`,
        data: { type: 'upload-failed', recordingId },
      },
      trigger: null,
    });
  } catch {}
}

/** 未処理件数をアプリアイコンのバッジに反映 (iOS のみ意味を持つ)。 */
export async function setBadgeCount(count: number): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    await Notifications.setBadgeCountAsync(Math.max(0, count));
  } catch {}
}
