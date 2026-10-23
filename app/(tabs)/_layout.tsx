import React, { useEffect, useRef } from 'react';
import { Tabs, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';
import { Colors } from '@/constants/theme';
import { useApp } from '@/contexts/AppContext';

export default function TabLayout() {
  const { isDarkMode, startTab, settingsLoaded } = useApp();
  const router = useRouter();
  const tint = Colors[isDarkMode ? 'dark' : 'light'].tint;

  // ⚠️ **`<Tabs initialRouteName=…>` は効かない。** expo-router は経路表を
  //    `unstable_settings`（静的なエクスポート）から組み立てるので、プロップに渡しても
  //    無視される。設定で選ばせる以上、読み終えてから自分で移動するしかない。
  //    2026-10-21、プロップで効くと思い込み、同じ画面の写真を3回撮った。
  const jumped = useRef(false);
  useEffect(() => {
    if (!settingsLoaded || jumped.current) return;
    jumped.current = true;
    if (startTab !== 'index') router.replace(`/${startTab}`);
  }, [settingsLoaded, startTab, router]);

  // 読み終える前に出すと「録音」が一瞬見えてから飛ぶので、それまで出さない
  if (!settingsLoaded) return null;

  return (
    <Tabs
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
          title: 'クイック録音',
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
