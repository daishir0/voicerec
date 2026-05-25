import React, { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View, Animated } from 'react-native';
import { useApp } from '@/contexts/AppContext';

interface RecordButtonProps {
  isRecording: boolean;
  onPress: () => void;
  metering?: number;
}

// expo-audio の RecorderState.metering は dB 値。
// SILENCE_DB 以下を「無音」、PEAK_DB 以上を「最大強度」として 0..1 に正規化する。
const SILENCE_DB = -60;
const PEAK_DB = -10;

function levelFromMetering(db: number | undefined): number {
  if (db === undefined || !isFinite(db)) return 0;
  const clamped = Math.max(SILENCE_DB, Math.min(PEAK_DB, db));
  return (clamped - SILENCE_DB) / (PEAK_DB - SILENCE_DB);
}

export function RecordButton({ isRecording, onPress, metering }: RecordButtonProps) {
  const { theme } = useApp();
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const smoothedRef = useRef(0);

  useEffect(() => {
    if (!isRecording) {
      smoothedRef.current = 0;
      Animated.timing(pulseAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: true,
      }).start();
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 200,
        useNativeDriver: true,
      }).start();
      return;
    }

    // EMA で急変動を抑制（alpha=0.4）
    const level = levelFromMetering(metering);
    smoothedRef.current = smoothedRef.current * 0.6 + level * 0.4;
    const s = smoothedRef.current;

    Animated.spring(pulseAnim, {
      toValue: 1 + s * 0.4,
      friction: 6,
      tension: 80,
      useNativeDriver: true,
    }).start();
    Animated.spring(opacityAnim, {
      toValue: s * 0.5,
      friction: 6,
      tension: 80,
      useNativeDriver: true,
    }).start();
  }, [isRecording, metering]);

  return (
    <View style={styles.container}>
      <Animated.View
        style={[
          styles.pulseRing,
          {
            backgroundColor: theme.red,
            transform: [{ scale: pulseAnim }],
            opacity: opacityAnim,
          },
        ]}
      />
      <Pressable
        onPress={onPress}
        style={[
          styles.button,
          {
            backgroundColor: theme.red,
            borderWidth: isRecording ? 4 : 0,
            borderColor: theme.bg,
          },
        ]}
      >
        {isRecording && (
          <View style={[styles.stopIcon, { backgroundColor: theme.bg }]} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: 100,
    height: 100,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pulseRing: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  button: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopIcon: {
    width: 28,
    height: 28,
    borderRadius: 4,
  },
});
