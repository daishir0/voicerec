import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppProvider, useApp } from '@/contexts/AppContext';

export default function RootLayout() {
  return (
    // ⚠️ **SafeAreaProvider は自分で置く。** SDK 54 までは暗黙に入っていたが、
    //    58 では入らない。無いと余白が全て 0 になり、タブバーが画面の上端に出て
    //    ステータスバーに重なる（2026-11-24、ストア用スクショで気づいた）。
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppProvider>
          <Shell />
        </AppProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * ⚠️ ヘッダーとタブバーは @react-navigation のテーマで塗られる。
 *    ここを端末の設定（useColorScheme）で決めていたので、アプリの「ダークモード」を
 *    切り替えても画面の縁だけ明るいまま、ということが起きていた。設定に従わせる。
 */
function Shell() {
  const { isDarkMode } = useApp();
  return (
    <ThemeProvider value={isDarkMode ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="diagnostics" options={{ presentation: 'modal', headerShown: false }} />
        <Stack.Screen name="transcript" options={{ headerShown: false }} />
      </Stack>
      {/* ⚠️ ステータスバーの文字色は、**その画面の背景**に合わせる。
          ヘッダーのある画面は白地なので濃い色で固定する。アプリのダークモードに
          合わせると、白地に白文字になって時刻も電波も消える（2026-11-24）。
          背景が暗い画面（文字起こし）は、その画面の中で上書きする。 */}
      <StatusBar style="dark" />
    </ThemeProvider>
  );
}
