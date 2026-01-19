import { db } from '../firebase/config';
import { collection, doc, setDoc, getDoc, onSnapshot, serverTimestamp, query, where, orderBy } from 'firebase/firestore';
import { sendPushNotification } from '../firebase/functions';
import { Platform } from 'react-native';

export interface CallOffer {
  callId: string;
  callerId: string;
  callerName: string;
  callerPhoto?: string | null;
  receiverId: string;
  receiverName?: string;
  receiverPhoto?: string;
  callType: 'voice' | 'video';
  status: 'ringing' | 'answered' | 'rejected' | 'ended' | 'missed';
  createdAt: Date;
  answeredAt?: Date;
  endedAt?: Date;
  duration?: number;
}

export interface CallSignaling {
  callId: string;
  type: 'offer' | 'answer' | 'ice-candidate' | 'hangup';
  from: string;
  to: string;
  data?: any;
  timestamp?: number;
}

/**
 * خدمة إدارة المكالمات مع WebRTC و Firebase Signaling
 * مع إصلاح جميع مشاكل Race Condition و Audio Focus
 */
class CallService {
  // WebRTC State
  public peerConnection: any = null;
  public localStream: any = null;
  public remoteStream: any = null;

  // Signaling State Management - 🔧 نظام Queue
  private signalingQueue: CallSignaling[] = [];
  private isProcessingSignal = false;
  private isRemoteDescriptionSet = false;
  private pendingCandidates: any[] = [];

  // Callbacks
  private onRemoteStreamCallback: ((stream: any) => void) | null = null;
  private onLocalStreamCallback: ((stream: any) => void) | null = null;

  // Unsubscribe functions
  private signalingUnsubscribe: (() => void) | null = null;
  private currentCallId: string = '';

  /**
   * إنشاء مكالمة جديدة
   */
  async initiateCall(
    callerId: string,
    receiverId: string,
    callType: 'voice' | 'video',
    callerName: string,
    callerPhoto?: string
  ): Promise<{ success: boolean; callId?: string; error?: string }> {
    try {
      const callId = `call_${Date.now()}_${callerId}`;
      this.currentCallId = callId;

      const callOffer: CallOffer = {
        callId,
        callerId,
        callerName,
        callerPhoto: callerPhoto || null,
        receiverId,
        callType,
        status: 'ringing',
        createdAt: new Date(),
      };

      const callRef = doc(db, 'calls', callId);
      await setDoc(callRef, {
        ...callOffer,
        createdAt: serverTimestamp(),
      });

      await this.sendCallNotification(receiverId, callOffer);

      console.log('✅ Call initiated:', callId);
      return { success: true, callId };
    } catch (error: any) {
      console.error('❌ Error initiating call:', error);
      return {
        success: false,
        error: error.message || 'فشل بدء المكالمة'
      };
    }
  }

  /**
   * قبول المكالمة مع الحصول على نوع المكالمة
   */
  async acceptCall(callId: string, userId: string): Promise<{ success: boolean; error?: string }> {
    try {
      this.currentCallId = callId;
      const callRef = doc(db, 'calls', callId);
      const callSnap = await getDoc(callRef);

      if (!callSnap.exists()) {
        return { success: false, error: 'المكالمة غير موجودة' };
      }

      const callData = callSnap.data() as CallOffer;

      if (callData.status !== 'ringing') {
        return { success: false, error: 'المكالمة لم تعد نشطة' };
      }

      await setDoc(callRef, {
        status: 'answered',
        answeredAt: serverTimestamp(),
      }, { merge: true });

      // 🔧 تمرير callType بشكل صحيح (إصلاح المشكلة الأصلية)
      const isVideoCall = callData.callType === 'video';
      await this.startConnection(callId, userId, callData.callerId, false, isVideoCall);

      console.log('✅ Call accepted');
      return { success: true };
    } catch (error: any) {
      console.error('❌ Error accepting call:', error);
      return {
        success: false,
        error: error.message || 'فشل قبول المكالمة'
      };
    }
  }

  /**
   * رفض المكالمة
   */
  async rejectCall(callId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const callRef = doc(db, 'calls', callId);
      await setDoc(callRef, {
        status: 'rejected',
        endedAt: serverTimestamp(),
      }, { merge: true });

      console.log('✅ Call rejected');
      return { success: true };
    } catch (error: any) {
      console.error('❌ Error rejecting call:', error);
      return {
        success: false,
        error: error.message || 'فشل رفض المكالمة'
      };
    }
  }

  /**
   * إنهاء المكالمة
   */
  async endCall(callId: string, duration?: number): Promise<{ success: boolean; error?: string }> {
    try {
      const callRef = doc(db, 'calls', callId);
      await setDoc(callRef, {
        status: 'ended',
        endedAt: serverTimestamp(),
        duration: duration || 0,
      }, { merge: true });

      await this.closeWebRTCConnection(callId);

      console.log('✅ Call ended');
      return { success: true };
    } catch (error: any) {
      console.error('❌ Error ending call:', error);
      return {
        success: false,
        error: error.message || 'فشل إنهاء المكالمة'
      };
    }
  }

  /**
   * الاستماع للمكالمات الواردة
   */
  subscribeToIncomingCalls(
    userId: string,
    callback: (call: CallOffer) => void
  ): () => void {
    const callsRef = collection(db, 'calls');

    const unsubscribe = onSnapshot(callsRef, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const callData = change.doc.data() as CallOffer;

          if (callData.receiverId === userId && callData.status === 'ringing') {
            callback({
              ...callData,
              createdAt: callData.createdAt && (callData.createdAt as any).toDate
                ? (callData.createdAt as any).toDate()
                : new Date(),
            });
          }
        }
      });
    });

    return unsubscribe;
  }

  /**
   * الحصول على تفاصيل مكالمة
   */
  async getCallDetails(callId: string): Promise<CallOffer | null> {
    try {
      const callRef = doc(db, 'calls', callId);
      const callSnap = await getDoc(callRef);

      if (!callSnap.exists()) {
        return null;
      }

      const data = callSnap.data() as CallOffer;
      return {
        ...data,
        createdAt: data.createdAt && (data.createdAt as any).toDate
          ? (data.createdAt as any).toDate()
          : new Date(),
      };
    } catch (error) {
      console.error('❌ Error getting call details:', error);
      return null;
    }
  }

  /**
   * إرسال إشعار مكالمة
   */
  private async sendCallNotification(receiverId: string, callOffer: CallOffer): Promise<void> {
    try {
      const response = await sendPushNotification(
        receiverId,
        'مكالمة واردة',
        `مكالمة ${callOffer.callType === 'video' ? 'فيديو' : 'صوتية'} من ${callOffer.callerName}`,
        {
          type: 'call_offer',
          callId: callOffer.callId,
          callerName: callOffer.callerName,
          callType: callOffer.callType,
          screen: 'call_incoming'
        }
      );

      if (!response.success) {
        console.warn('⚠️ Failed to send push notification');
      }
    } catch (error) {
      console.error('❌ Error sending call notification:', error);
    }
  }

  // --- Stream Callbacks ---

  public setOnRemoteStream(callback: (stream: any) => void) {
    this.onRemoteStreamCallback = callback;
  }

  public setOnLocalStream(callback: (stream: any) => void) {
    this.onLocalStreamCallback = callback;
  }

  // --- Audio/Video Controls ---

  public toggleAudio(enabled: boolean) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track: any) => {
        track.enabled = enabled;
      });
    }
  }

  public toggleVideo(enabled: boolean) {
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach((track: any) => {
        track.enabled = enabled;
      });
    }
  }

  public async toggleSpeaker(enabled: boolean) {
    try {
      const { Audio } = require('expo-av');
      await Audio.setAudioModeAsync({
        playsInSilentModeIOS: true,
        allowsRecordingIOS: true,
        staysActiveInBackground: true,
        interruptionModeIOS: 1,
        shouldDuckAndroid: false, // 🔧 تم التغيير لتجنب فقدان الصوت
        interruptionModeAndroid: 1,
        playThroughEarpieceAndroid: !enabled,
      });
      console.log(`🔊 Speaker ${enabled ? 'enabled' : 'disabled'}`);
    } catch (error) {
      console.error('❌ Error toggling speaker:', error);
    }
  }

  public switchCamera() {
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach((track: any) => {
        if (track._switchCamera && track.readyState === 'live') {
          try {
            track._switchCamera();
            console.log('✅ Camera switched');
          } catch (e) {
            console.error('❌ Error switching camera:', e);
          }
        }
      });
    }
  }

  /**
   * Start WebRTC Connection - تم تحسينه
   */
  async startConnection(
    callId: string,
    userId: string,
    otherUserId: string,
    isCaller: boolean,
    isVideoCall: boolean = false
  ): Promise<void> {
    if (this.peerConnection) {
      console.warn('⚠️ Call already initialized. Skipping...');
      return;
    }

    try {
      console.log(`Starting WebRTC connection as ${isCaller ? 'Caller' : 'Callee'}`);

      const {
        RTCPeerConnection,
        RTCIceCandidate,
        RTCSessionDescription,
        mediaDevices,
      } = require('@stream-io/react-native-webrtc');

      // 🔧 إعدادات محسّنة للـ STUN servers
      const configuration = {
        iceServers: [
          { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
          { urls: ['stun:stun2.l.google.com:19302', 'stun:stun3.l.google.com:19302'] },
        ],
      };

      // 🔧 إعدادات الصوت والفيديو (محسّن لـ Android و iOS)
      if (Platform.OS !== 'web') {
        try {
          const { Audio } = require('expo-av');
          await Audio.setAudioModeAsync({
            playsInSilentModeIOS: true,
            allowsRecordingIOS: true,
            staysActiveInBackground: true,
            interruptionModeIOS: 1,
            shouldDuckAndroid: false, // 🔧 مهم: تجنب خفض مستوى الصوت
            interruptionModeAndroid: 1,
            playThroughEarpieceAndroid: false, // افتراضياً: استخدام السماعة الخارجية
          });
          console.log('✅ Audio mode configured');
        } catch (e) {
          console.warn('⚠️ Failed to set audio mode:', e);
        }
      }

      // الحصول على Local Stream
      console.log(`📹 Requesting media (Video: ${isVideoCall})`);
      let stream;

      try {
        stream = await mediaDevices.getUserMedia({
          audio: true,
          video: isVideoCall ? {
            facingMode: 'user',
            width: { min: 640, ideal: 1280 },
            height: { min: 480, ideal: 720 },
          } : false,
        });
      } catch (e) {
        console.error('❌ getUserMedia failed with constraints:', e);
        // Fallback: audio only
        stream = await mediaDevices.getUserMedia({ audio: true, video: false });
        console.warn('⚠️ Fallback to audio only');
      }

      this.localStream = stream;
      if (this.onLocalStreamCallback) {
        this.onLocalStreamCallback(stream);
      }

      // إنشاء PeerConnection
      this.peerConnection = new RTCPeerConnection(configuration);

      // إضافة الـ Tracks
      stream.getTracks().forEach((track: any) => {
        this.peerConnection!.addTrack(track, stream);
      });

      // معالجة ICE Candidates
      this.peerConnection.onicecandidate = (event: any) => {
        if (event.candidate) {
          this.sendSignaling({
            callId,
            type: 'ice-candidate',
            from: userId,
            to: otherUserId,
            data: event.candidate,
          });
        }
      };

      // معالجة Remote Stream
      this.peerConnection.ontrack = (event: any) => {
        console.log('✅ Remote track received');
        if (event.streams && event.streams[0]) {
          this.remoteStream = event.streams[0];
          if (this.onRemoteStreamCallback) {
            this.onRemoteStreamCallback(this.remoteStream);
          }
        }
      };

      // الاستماع للرسائل
      this.subscribeToSignalingMessages(callId, userId);

      // إنشاء Offer إذا كان المتصل
      if (isCaller) {
        const offer = await this.peerConnection.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: isVideoCall,
        });
        await this.peerConnection.setLocalDescription(offer);

        await this.sendSignaling({
          callId,
          type: 'offer',
          from: userId,
          to: otherUserId,
          data: offer,
        });
        console.log('✅ Offer sent');
      }

      console.log('✅ WebRTC connection started');
    } catch (error) {
      console.error('❌ Failed to start WebRTC connection:', error);
      this.cleanup();
    }
  }

  /**
   * 🔧 معالجة الرسائل بالترتيب الصحيح (إصلاح Race Condition)
   */
  private async handleSignalingMessage(message: CallSignaling) {
    // إضافة الرسالة إلى الـ Queue
    this.signalingQueue.push(message);

    // معالجة الـ Queue واحدة تلو الأخرى
    if (!this.isProcessingSignal) {
      await this.processSignalingQueue();
    }
  }

  private async processSignalingQueue() {
    while (this.signalingQueue.length > 0 && !this.isProcessingSignal) {
      this.isProcessingSignal = true;
      const message = this.signalingQueue.shift();

      if (message) {
        try {
          await this.processSignalingMessage(message);
        } catch (error) {
          console.error('❌ Error processing signaling:', error);
        }
      }

      this.isProcessingSignal = false;

      // تأخير صغير بين الرسائل
      if (this.signalingQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }

  private async processSignalingMessage(message: CallSignaling) {
    if (!this.peerConnection) {
      console.warn('⚠️ PeerConnection not initialized');
      return;
    }

    const { RTCSessionDescription, RTCIceCandidate } = require('@stream-io/react-native-webrtc');

    try {
      if (message.type === 'offer') {
        console.log('📨 Received Offer');
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(message.data));
        this.isRemoteDescriptionSet = true;

        // معالجة المرشحات المعلقة
        await this.processPendingCandidates();

        // إنشاء Answer
        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        // إرسال Answer
        await this.sendSignaling({
          callId: message.callId,
          type: 'answer',
          from: message.to,
          to: message.from,
          data: answer,
        });
        console.log('✅ Answer sent');

      } else if (message.type === 'answer') {
        console.log('📨 Received Answer');
        // 🔧 التحقق من الحالة الصحيحة
        if (this.peerConnection.signalingState === 'have-local-offer') {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(message.data));
          this.isRemoteDescriptionSet = true;

          // معالجة المرشحات المعلقة
          await this.processPendingCandidates();
          console.log('✅ Answer processed');
        } else {
          console.warn(`⚠️ Ignoring Answer: signalingState is ${this.peerConnection.signalingState}`);
        }

      } else if (message.type === 'ice-candidate') {
        // 🔧 إضافة المرشح فقط بعد تعيين RemoteDescription
        if (this.isRemoteDescriptionSet) {
          try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(message.data));
            console.log('✅ ICE candidate added');
          } catch (e) {
            console.error('⚠️ Error adding ICE candidate:', e);
          }
        } else {
          console.log('⏳ Queueing ICE candidate (waiting for RemoteDescription)');
          this.pendingCandidates.push(new RTCIceCandidate(message.data));
        }
      }
    } catch (error) {
      console.error('❌ Error processing signaling message:', error);
    }
  }

  private async processPendingCandidates() {
    if (this.pendingCandidates.length === 0) return;

    console.log(`⏳ Processing ${this.pendingCandidates.length} pending ICE candidates`);
    for (const candidate of this.pendingCandidates) {
      try {
        await this.peerConnection!.addIceCandidate(candidate);
      } catch (e) {
        console.error('⚠️ Error adding pending ICE candidate:', e);
      }
    }
    this.pendingCandidates = [];
  }

  /**
   * الاستماع لرسائل الـ Signaling (محسّن)
   */
  private subscribeToSignalingMessages(callId: string, userId: string) {
    try {
      // 🔧 استماع فقط للرسائل الموجهة لهذا المستخدم
      const q = query(
        collection(db, 'signaling'),
        where('callId', '==', callId),
        where('to', '==', userId),
        orderBy('timestamp', 'asc')
      );

      this.signalingUnsubscribe = onSnapshot(q, (snapshot) => {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const message = change.doc.data() as CallSignaling;
            this.handleSignalingMessage(message);
          }
        });
      });

      console.log('✅ Subscribed to signaling');
    } catch (error) {
      console.error('❌ Error subscribing to signaling:', error);
    }
  }

  /**
   * إرسال رسالة الـ Signaling
   */
  async sendSignaling(signaling: CallSignaling): Promise<{ success: boolean; error?: string }> {
    try {
      const signalingRef = doc(db, 'signaling', `${signaling.callId}_${Date.now()}_${Math.random()}`);

      // تسلسل البيانات بشكل آمن
      const safeData = signaling.data ? JSON.parse(JSON.stringify(signaling.data)) : null;

      await setDoc(signalingRef, {
        ...signaling,
        data: safeData,
        timestamp: serverTimestamp(),
      });

      return { success: true };
    } catch (error: any) {
      console.error('❌ Error sending signaling:', error);
      return {
        success: false,
        error: error.message || 'فشل إرسال الإشارة'
      };
    }
  }

  /**
   * Handle Incoming Signaling Message
   */
  async handleSignalingMessage(message: CallSignaling) {
    await this.handleSignalingMessage(message);
  }

  /**
   * إغلاق WebRTC Connection
   */
  async closeWebRTCConnection(callId: string): Promise<void> {
    console.log('🔴 Closing WebRTC connection');

    // إيقاف الاستماع للرسائل
    if (this.signalingUnsubscribe) {
      this.signalingUnsubscribe();
      this.signalingUnsubscribe = null;
    }

    // إيقاف Local Stream
    if (this.localStream) {
      this.localStream.getTracks().forEach((track: any) => track.stop());
      if (this.localStream.release) {
        this.localStream.release();
      }
      this.localStream = null;
      if (this.onLocalStreamCallback) this.onLocalStreamCallback(null);
    }

    // إغلاق PeerConnection
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }

    // تنظيف الحالة
    this.remoteStream = null;
    this.isRemoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.signalingQueue = [];

    if (this.onRemoteStreamCallback) this.onRemoteStreamCallback(null);

    console.log('✅ WebRTC connection closed');
  }

  /**
   * تنظيف الموارد
   */
  private cleanup() {
    this.closeWebRTCConnection(this.currentCallId);
  }
}

export const callService = new CallService();
