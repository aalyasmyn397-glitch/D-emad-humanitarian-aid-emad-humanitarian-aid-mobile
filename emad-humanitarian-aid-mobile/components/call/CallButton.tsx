import React, { useRef, useState } from 'react';
import { TouchableOpacity, Text, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { useCall } from '../../contexts/CallContext';

interface CallButtonProps {
  remoteUserId: string;
  callType: 'voice' | 'video';
  disabled?: boolean;
  onCallStart?: () => void;
}

export const CallButton: React.FC<CallButtonProps> = ({
  remoteUserId,
  callType,
  disabled = false,
  onCallStart,
}) => {
  const { initiateManualCall, isCallRinging, isCallActive } = useCall();
  const lastPressTimeRef = useRef<number>(0);
  const [isLoading, setIsLoading] = useState(false);

  /**
   * 🔧 حماية من الضغط السريع المتكرر
   * debounce 1000ms لمنع محاولات اتصال متعددة
   */
  const handlePress = async () => {
    try {
      const now = Date.now();
      const lastPressTime = lastPressTimeRef.current;

      // تحقق من مدة الوقت بين الضغطات
      if (now - lastPressTime < 1000) {
        console.warn('⚠️ Button pressed too quickly, ignoring...');
        return;
      }

      // إذا كان الاتصال فعالاً أو قيد الرنين، تجاهل الضغط
      if (isCallActive || isCallRinging) {
        console.warn('⚠️ Call already active or ringing');
        return;
      }

      lastPressTimeRef.current = now;
      setIsLoading(true);

      await initiateManualCall(remoteUserId, callType === 'video');

      onCallStart?.();

      console.log(`✅ Call initiated: ${callType} to ${remoteUserId}`);
    } catch (error) {
      console.error('❌ Error initiating call:', error);
      setIsLoading(false);
    }
  };

  const isDisabled = disabled || isLoading || isCallActive || isCallRinging;

  // اختيار الأيقونة والنص بناءً على حالة الاتصال
  let displayText = callType === 'video' ? '📹 فيديو' : '☎️ صوت';
  let statusText = '';

  if (isCallRinging) {
    statusText = 'جاري الاتصال...';
  } else if (isCallActive) {
    statusText = 'متصل';
  }

  return (
    <TouchableOpacity
      style={[
        styles.button,
        isDisabled && styles.disabledButton,
        isCallActive && styles.activeButton,
      ]}
      onPress={handlePress}
      disabled={isDisabled}
      activeOpacity={isDisabled ? 1 : 0.7}
    >
      {isLoading ? (
        <ActivityIndicator size="small" color="#fff" />
      ) : (
        <>
          <Text style={styles.buttonText}>{displayText}</Text>
          {statusText && <Text style={styles.statusText}>{statusText}</Text>}
        </>
      )}
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  button: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    backgroundColor: '#10B981', // أخضر
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.25,
        shadowRadius: 3,
      },
      android: {
        elevation: 4,
      },
    }),
  },
  disabledButton: {
    backgroundColor: '#D1D5DB', // رمادي
    opacity: 0.6,
  },
  activeButton: {
    backgroundColor: '#EF4444', // أحمر لإنهاء الاتصال
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
  },
  statusText: {
    color: '#fff',
    fontSize: 12,
    marginTop: 2,
    opacity: 0.9,
  },
});
