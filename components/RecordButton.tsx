import React, { useEffect, useRef } from 'react';
import { Pressable, StyleSheet, View, Animated, Easing } from 'react-native';
import { useApp } from '@/contexts/AppContext';

interface RecordButtonProps {
  isRecording: boolean;
  onPress: () => void;
}

export function RecordButton({ isRecording, onPress }: RecordButtonProps) {
  const { theme } = useApp();
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (isRecording) {
      opacityAnim.setValue(0.3);
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.3,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      ).start();
    } else {
      pulseAnim.stopAnimation();
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
    }
  }, [isRecording]);

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
