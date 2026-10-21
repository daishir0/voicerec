import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { AppProvider, useApp } from '@/contexts/AppContext';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AppProvider>
        <Shell />
      </AppProvider>
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
      </Stack>
      <StatusBar style={isDarkMode ? 'light' : 'dark'} />
    </ThemeProvider>
  );
}
