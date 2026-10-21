import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { Colors } from '@/constants/theme';
import { useApp } from '@/contexts/AppContext';

export default function TabLayout() {
  const { isDarkMode, startTab, settingsLoaded } = useApp();
  const router = useRouter();
  const tint = Colors[isDarkMode ? 'dark' : 'light'].tint;

  // ⚠️ initialRouteName は**最初に組み立てたときの値しか見ない**。設定は AsyncStorage から
  //    非同期に読むので、読み終える前に組むと必ず既定の「録音」で固まる。
  //    読み終えるまで出さず、startTab を key にして、設定を変えたらその場で組み直す。
  if (!settingsLoaded) return null;

  return (
    <Tabs
      key={startTab}
      // 起動時にどのタブを開くか。切り出しを主に使う人は、ここを変えると1タップ減る
      initialRouteName={startTab}
      screenOptions={{
        tabBarActiveTintColor: tint,
        headerRight: () => (
          <Pressable onPress={() => router.push('/settings')} style={{ marginRight: 16 }}>
            <Ionicons name="settings-outline" size={24} color={tint} />
          </Pressable>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '録音',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="mic" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="clip"
        options={{
          title: '切り出し',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="cut" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="recordings"
        options={{
          title: '録音一覧',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="list" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
