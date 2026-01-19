import React, { createContext, useContext, ReactNode, useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from '@/services/firebase/config';
import { Alert, Platform } from 'react-native';
import * as Device from 'expo-device';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useAuth } from './AuthContext';
import { streamTokenProvider } from '@/services/stream/tokenProvider';
import { Config } from '@/constants/Config';
import { soundService } from '@/services/SoundService';
import { callService, CallOffer } from '@/services/calls';
import { ManualCallScreen } from '@/components/call/ManualCallScreen';
import { sendMessage } from '@/services/firebase/messaging';
import { useRouter } from 'expo-router';

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

type StreamVideoClient = any;
type Call = any;

let StreamVideo: any = null;
let StreamVideoClientSDK: any = null;

try {
  if (Platform.OS !== 'web' && !isExpoGo) {
    // Safe to load
  }
} catch (e) {
  console.log('Stream SDK not available');
}

interface CallContextType {
  client: StreamVideoClient | null;
  activeCall: Call | null;
  startCall: (callId: string, type?: 'default' | 'audio_room', memberIds?: string[]) => Promise<void>;
  joinCall: (callId: string) => Promise<void>;
  endCall: () => Promise<void>;

  // Manual WebRTC
  manualCall: CallOffer | null;
  initiateManualCall: (receiverId: string, callType: 'voice' | 'video', receiverName: string, receiverPhoto?: string) => Promise<void>;
  acceptManualCall: (callId: string) => Promise<void>;
  rejectManualCall: (callId: string) => Promise<void>;
  endManualCall: () => Promise<void>;
  localStream: any;
  remoteStream: any;
}

const CallContext = createContext<CallContextType>({
  client: null,
  activeCall: null,
  startCall: async () => {},
  joinCall: async () => {},
  endCall: async () => {},
  manualCall: null,
  initiateManualCall: async () => {},
  acceptManualCall: async () => {},
  rejectManualCall: async () => {},
  endManualCall: async () => {},
  localStream: null,
  remoteStream: null,
});

export const useCall = () => useContext(CallContext);

export const CallProvider = ({ children }: { children: ReactNode }) => {
  const { user } = useAuth();
  const router = useRouter();
  const [client, setClient] = useState<StreamVideoClient | null>(null);
  const [activeCall, setActiveCall] = useState<Call | null>(null);
  const [manualCall, setManualCall] = useState<CallOffer | null>(null);
  const [localStream, setLocalStream] = useState<any>(null);
  const [remoteStream, setRemoteStream] = useState<any>(null);

  // 🔧 طلب الصلاحيات في البداية
  useEffect(() => {
    if (!user) return;

    const requestPermissions = async () => {
      if (Platform.OS === 'web') return;

      try {
        const { Audio } = require('expo-av');
        const { Camera } = require('expo-camera');

        // طلب صلاحية الميكروفون
        const audioPerm = await Audio.requestPermissionsAsync?.();
        if (audioPerm?.status !== 'granted') {
          console.warn('⚠️ Audio permission denied');
        }

        // طلب صلاحية الكاميرا
        const cameraPerm = await Camera.requestCameraPermissionsAsync?.();
        if (cameraPerm?.status !== 'granted') {
          console.warn('⚠️ Camera permission denied');
        }

        console.log('✅ Permissions requested');
      } catch (error) {
        console.error('❌ Error requesting permissions:', error);
      }
    };

    requestPermissions();
  }, [user]);

  // Initialize Stream Video Client
  useEffect(() => {
    if (!user || !Config.streamApiKey) return;

    if (!StreamVideoClientSDK || !StreamVideo) {
      try {
        if (Platform.OS !== 'web' && !isExpoGo) {
          const SDK = require('@stream-io/video-react-native-sdk');
          StreamVideoClientSDK = SDK.StreamVideoClient;
          StreamVideo = SDK.StreamVideo;
          console.log('✅ Stream Video SDK loaded successfully');
        } else {
          console.log('ℹ️ Stream Video SDK not available in this environment');
        }
      } catch (error) {
        console.warn('⚠️ Stream Video SDK components not available:', error);
      }
    }

    if (!StreamVideoClientSDK || !user || !Config.streamApiKey) return;

    const userObj = {
      id: user.uid,
      name: user.displayName || 'User',
      image: user.photoURL || undefined,
    };

    try {
      const newClient = new StreamVideoClientSDK({
        apiKey: Config.streamApiKey,
        user: userObj,
        tokenProvider: () => streamTokenProvider(user.uid),
      });

      setClient(newClient);

      return () => {
        if (newClient) {
          newClient.disconnectUser();
        }
        setClient(null);
      };
    } catch (error) {
      console.error('❌ Failed to initialize Stream Video client:', error);
    }
  }, [user]);

  // Listen for incoming calls
  useEffect(() => {
    if (!client) return;

    try {
      const unsubscribe = client.on('call.ring', (event: any) => {
        const call = event.call;
        setActiveCall((current: Call | null) => {
          if (!current) {
            soundService.playRingtone();
            return call;
          }
          return current;
        });
      });

      return () => {
        unsubscribe();
        soundService.stopRingtone();
      };
    } catch (err) {
      console.warn('⚠️ Error setting up Stream call listener:', err);
    }
  }, [client]);

  const startCall = async (callId: string, type: 'default' | 'audio_room' = 'default', memberIds: string[] = []) => {
    if (!client) {
      let reason = 'تأكد من الاتصال بالإنترنت.';
      if (isExpoGo) reason = 'خدمة المكالمات تعمل فقط في النسخة النهائية (APK/IPA) وليس في Expo Go.';
      if (Platform.OS === 'web') reason = 'خدمة المكالمات غير مدعومة على المتصفح الويب.';
      Alert.alert('خدمة غير متوفرة', `لم يتم تهيئة خدمة الاتصال. ${reason}`);
      return;
    }

    try {
      const call = client.call(type, callId);

      const members = [
        { user_id: user!.uid, role: 'host' },
        ...memberIds.map(id => ({ user_id: id }))
      ];

      await call.join({ create: true, data: { members: members as any } });
      setActiveCall(call);
    } catch (error: any) {
      console.error('❌ Error starting call:', error);
      Alert.alert('خطأ', 'تعذر بدء المكالمة: ' + error.message);
    }
  };

  const joinCall = async (callId: string) => {
    if (!client) return;
    try {
      soundService.stopRingtone();
      const call = client.call('default', callId);
      await call.join();
      setActiveCall(call);
    } catch (error: any) {
      console.error('❌ Error joining call:', error);
      Alert.alert('خطأ', 'تعذر الانضمام للمكالمة');
    }
  };

  const endCall = async () => {
    soundService.stopRingtone();
    if (activeCall) {
      await activeCall.leave();
      setActiveCall(null);
    }
  };

  // Manual WebRTC Subscription
  useEffect(() => {
    if (!user) return;

    // Stream Listeners
    callService.setOnLocalStream(setLocalStream);
    callService.setOnRemoteStream(setRemoteStream);

    // Call Listeners
    const unsubscribeCalls = callService.subscribeToIncomingCalls(user.uid, (call) => {
      console.log('📞 Incoming manual call:', call);

      const isManualBusy = manualCall && (manualCall.status === 'ringing' || manualCall.status === 'answered') && manualCall.callId !== call.callId;
      if (activeCall || isManualBusy) {
        console.log('⚠️ User already in a call, rejecting incoming manual call');
        callService.rejectCall(call.callId);
        return;
      }

      soundService.playRingtone();
      setManualCall(call);

      // Set timeout for incoming call (45 seconds)
      setTimeout(() => {
        setManualCall(current => {
          if (current?.callId === call.callId && current.status === 'ringing') {
            console.log('⏰ Incoming call timed out, marking as missed');
            callService.endCall(call.callId);
            soundService.stopRingtone();
            return null;
          }
          return current;
        });
      }, 45000);
    });

    soundService.stopAllSounds?.();
    setManualCall(null);

    return () => {
      unsubscribeCalls();
      callService.setOnLocalStream(() => {});
      callService.setOnRemoteStream(() => {});
      soundService.stopAllSounds?.();
    };
  }, [user]);

  // Signaling Subscription when in a manual call
  useEffect(() => {
    if (!user || !manualCall || manualCall.status !== 'answered') return;

    const unsubscribeSignaling = callService.subscribeToSignaling(
      manualCall.callId,
      user.uid,
      (signaling) => {
        console.log('📨 Received signaling:', signaling.type);
        callService.handleSignalingMessage(signaling);
      }
    );

    return () => {
      unsubscribeSignaling();
    };
  }, [manualCall?.callId, manualCall?.status, user]);

  // Manual Call Methods
  const initiateManualCall = async (
    receiverId: string,
    callType: 'voice' | 'video',
    receiverName: string,
    receiverPhoto?: string
  ) => {
    if (!user) return;

    // 🔧 Check permissions before starting
    if (Platform.OS !== 'web') {
      try {
        const { Audio } = require('expo-av');
        const audioPerm = await Audio.requestPermissionsAsync?.();
        if (audioPerm?.status !== 'granted') {
          Alert.alert('صلاحية مرفوضة', 'نحتاج لصلاحية الميكروفون لإجراء المكالمة');
          return;
        }

        if (callType === 'video') {
          const { Camera } = require('expo-camera');
          const videoPerm = await Camera.requestCameraPermissionsAsync?.();
          if (videoPerm?.status !== 'granted') {
            Alert.alert('صلاحية مرفوضة', 'نحتاج لصلاحية الكاميرا لإجراء مكالمة الفيديو');
            return;
          }
        }
      } catch (e) {
        console.warn('⚠️ Permission check failed, proceeding anyway:', e);
      }
    }

    try {
      soundService.stopRingtone();
      soundService.stopOutgoing?.();
      soundService.playOutgoing();

      const result = await callService.initiateCall(
        user.uid,
        receiverId,
        callType,
        user.displayName || 'User',
        user.photoURL || undefined
      );

      if (result.success && result.callId) {
        setManualCall({
          callId: result.callId,
          callerId: user.uid,
          callerName: user.displayName || 'User',
          callerPhoto: user.photoURL || undefined,
          receiverId: receiverId,
          callType: callType,
          status: 'ringing',
          createdAt: new Date(),
        });

        // Ensure conversation exists
        const sortedIds = [user.uid, receiverId].sort();
        const conversationId = `private_${sortedIds[0]}_${sortedIds[1]}`;

        await sendMessage(conversationId, user.uid, user.displayName || 'User', user.photoURL || '', {
          type: 'call',
          callType: callType,
          callStatus: 'ongoing',
          text: callType === 'video' ? '📹 مكالمة فيديو جارية' : '☎️ مكالمة صوتية جارية'
        });

        console.log('✅ Manual call initiated:', result.callId);

        // 🔧 Start connection immediately for caller
        await callService.startConnection(
          result.callId,
          user.uid,
          receiverId,
          true,
          callType === 'video'
        );

      } else {
        Alert.alert('خطأ', result.error || 'فشل بدء المكالمة');
      }
    } catch (error: any) {
      console.error('❌ Error initiating manual call:', error);
      Alert.alert('خطأ', 'فشل بدء المكالمة');
    }
  };

  // Synchronize call status
  useEffect(() => {
    if (!user || !manualCall) return;

    const callRef = doc(db, 'calls', manualCall.callId);
    const unsubscribe = onSnapshot(callRef, (docSnap) => {
      if (docSnap.exists()) {
        const data = docSnap.data();

        // Handle Answer (for Caller)
        if (data.status === 'answered' && manualCall.status === 'ringing' && manualCall.callerId === user.uid) {
          console.log('✅ Call was answered by receiver!');
          soundService.stopOutgoing?.();
          soundService.playConnected?.();

          setManualCall((prev: CallOffer | null) =>
            prev ? { ...prev, status: 'answered', answeredAt: data.answeredAt } : null
          );

          const sortedIds = [user.uid, manualCall.receiverId].sort();
          const conversationId = `private_${sortedIds[0]}_${sortedIds[1]}`;
          sendMessage(conversationId, user.uid, user.displayName || 'User', user.photoURL || '', {
            type: 'call',
            callType: manualCall.callType,
            callStatus: 'completed',
            text: manualCall.callType === 'video' ? '✅ مكالمة فيديو (تم الرد)' : '✅ مكالمة صوتية (تم الرد)'
          });
        }
        // Handle End/Reject/Missed
        else if (data.status === 'rejected' || data.status === 'ended' || data.status === 'missed') {
          console.log(`🔴 Call state changed to ${data.status}`);

          if (manualCall.status === 'ringing') {
            const otherId = manualCall.callerId === user.uid ? manualCall.receiverId : manualCall.callerId;
            const sortedIds = [user.uid, otherId].sort();
            const conversationId = `private_${sortedIds[0]}_${sortedIds[1]}`;

            sendMessage(conversationId, user.uid, user.displayName || 'User', user.photoURL || '', {
              type: 'call',
              callType: manualCall.callType,
              callStatus: data.status === 'rejected' ? 'rejected' : 'missed',
              text: data.status === 'rejected' ? '❌ مكالمة مرفوضة' : '📞 مكالمة فائتة'
            });
          }

          soundService.stopOutgoing?.();
          soundService.stopRingtone();

          setManualCall((prev: CallOffer | null) => prev ? { ...prev, status: data.status } : null);

          // Clear after a delay
          setTimeout(() => {
            setManualCall((current: CallOffer | null) => (current?.callId === manualCall.callId ? null : current));
          }, 4000);
        }
      } else {
        if (manualCall.status === 'ringing' || manualCall.status === 'answered') {
          setManualCall(null);
        }
      }
    });

    // Set timeout for outgoing call (45 seconds)
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    if (manualCall.status === 'ringing' && manualCall.callerId === user.uid) {
      timeoutId = setTimeout(() => {
        if (manualCall.status === 'ringing') {
          console.log('⏰ Outgoing call timed out');
          endManualCall();
          Alert.alert('لم يتم الرد', 'المستخدم الآخر لا يرد حالياً.');
        }
      }, 45000);
    }

    return () => {
      if (unsubscribe) unsubscribe();
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [manualCall?.callId, manualCall?.status, user?.uid]);

  const acceptManualCall = async (callId: string) => {
    if (!user || !manualCall) return;
    try {
      soundService.stopRingtone();
      soundService.stopOutgoing?.();

      const result = await callService.acceptCall(callId, user.uid);

      if (result.success) {
        soundService.playConnected?.();

        setManualCall(prev => prev ? { ...prev, status: 'answered' } : null);

        // 🔧 Start WebRTC Connection as Callee
        await callService.startConnection(
          callId,
          user.uid,
          manualCall.callerId,
          false,
          manualCall.callType === 'video'
        );

        router.push({
          pathname: '/messages/call',
          params: {
            conversationId: callId,
            otherUserId: manualCall.callerId,
            otherUserName: manualCall.callerName,
            otherUserPhoto: manualCall.callerPhoto || undefined,
            callType: manualCall.callType
          }
        });

        setManualCall(prev => prev ? { ...prev, status: 'answered' } : null);

      } else {
        Alert.alert('خطأ', result.error || 'فشل قبول المكالمة');
      }
    } catch (error) {
      console.error('❌ Error accepting manual call:', error);
    }
  };

  const rejectManualCall = async (callId: string) => {
    try {
      soundService.stopRingtone();
      await callService.rejectCall(callId);
      setManualCall(null);
    } catch (error) {
      console.error('❌ Error rejecting manual call:', error);
    }
  };

  const endManualCall = async () => {
    if (!manualCall) return;
    try {
      soundService.stopRingtone();
      soundService.stopOutgoing?.();

      let duration = 0;
      if (manualCall.status === 'answered' && manualCall.answeredAt) {
        const now = new Date();
        const start = manualCall.answeredAt instanceof Date
          ? manualCall.answeredAt
          : (manualCall.answeredAt as any).toDate
          ? (manualCall.answeredAt as any).toDate()
          : now;
        duration = Math.floor((now.getTime() - start.getTime()) / 1000);
      }

      await callService.endCall(manualCall.callId, duration);

      // Log ended call
      const sortedIds = [user?.uid, manualCall.receiverId === user?.uid ? manualCall.callerId : manualCall.receiverId].sort();
      const conversationId = `private_${sortedIds[0]}_${sortedIds[1]}`;

      if (manualCall.status === 'answered') {
        const mins = Math.floor(duration / 60);
        const secs = duration % 60;
        const durationStr = `${mins}:${secs.toString().padStart(2, '0')}`;

        await sendMessage(conversationId, user?.uid || 'system', user?.displayName || 'User', user?.photoURL || '', {
          type: 'call',
          callType: manualCall.callType,
          callStatus: 'completed',
          text: `📵 انتهت المكالمة (${durationStr})`
        });
      }

      setManualCall(null);
    } catch (error) {
      console.error('❌ Error ending manual call:', error);
    }
  };

  return (
    <CallContext.Provider
      value={{
        client,
        activeCall,
        startCall,
        joinCall,
        endCall,
        manualCall,
        initiateManualCall,
        acceptManualCall,
        rejectManualCall,
        endManualCall,
        localStream,
        remoteStream,
      }}
    >
      {client && StreamVideo && Platform.OS !== 'web' ? (
        <StreamVideo client={client}>
          {children}
        </StreamVideo>
      ) : (
        <>{children}</>
      )}
    </CallContext.Provider>
  );
};
