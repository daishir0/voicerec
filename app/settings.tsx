import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useApp } from '@/contexts/AppContext';
import { testConnection } from '@/services/upload-service';

export default function SettingsScreen() {
  const { theme, settings, updateSettings } = useApp();
  const router = useRouter();

  const [serverUrl, setServerUrl] = useState(settings.serverUrl);
  const [username, setUsername] = useState(settings.username);
  const [password, setPassword] = useState(settings.password);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<boolean | null>(null);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const ok = await testConnection({ serverUrl, username, password });
    setTestResult(ok);
    setTesting(false);
  };

  const handleSave = async () => {
    await updateSettings({ serverUrl, username, password });
    router.back();
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        style={[styles.container, { backgroundColor: theme.bg }]}
        contentContainerStyle={styles.content}
      >
        <Text style={[styles.label, { color: theme.textSecondary }]}>サーバーURL</Text>
        <TextInput
          style={[styles.input, { backgroundColor: theme.bgSecondary, color: theme.text, borderColor: theme.border }]}
          value={serverUrl}
          onChangeText={setServerUrl}
          placeholder="http://your-server:18083"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />

        <Text style={[styles.label, { color: theme.textSecondary }]}>ユーザー名</Text>
        <TextInput
          style={[styles.input, { backgroundColor: theme.bgSecondary, color: theme.text, borderColor: theme.border }]}
          value={username}
          onChangeText={setUsername}
          placeholder="ユーザー名"
          placeholderTextColor={theme.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={[styles.label, { color: theme.textSecondary }]}>パスワード</Text>
        <TextInput
          style={[styles.input, { backgroundColor: theme.bgSecondary, color: theme.text, borderColor: theme.border }]}
          value={password}
          onChangeText={setPassword}
          placeholder="パスワード"
          placeholderTextColor={theme.textSecondary}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Pressable
          style={[styles.button, { backgroundColor: theme.bgTertiary }]}
          onPress={handleTest}
          disabled={testing}
        >
          {testing ? (
            <ActivityIndicator size="small" color={theme.text} />
          ) : (
            <View style={styles.buttonContent}>
              <Text style={[styles.buttonText, { color: theme.text }]}>接続テスト</Text>
              {testResult !== null && (
                <Ionicons
                  name={testResult ? 'checkmark-circle' : 'close-circle'}
                  size={20}
                  color={testResult ? '#34C759' : '#FF3B30'}
                  style={{ marginLeft: 8 }}
                />
              )}
            </View>
          )}
        </Pressable>

        <Pressable
          style={[styles.button, { backgroundColor: theme.accent, marginTop: 24 }]}
          onPress={handleSave}
        >
          <Text style={[styles.buttonText, { color: '#fff', fontWeight: '600' }]}>保存</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    padding: 20,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 6,
    marginTop: 16,
  },
  input: {
    height: 44,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  button: {
    height: 44,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 16,
  },
  buttonContent: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  buttonText: {
    fontSize: 16,
  },
});
