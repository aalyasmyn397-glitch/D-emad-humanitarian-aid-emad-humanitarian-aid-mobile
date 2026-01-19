import { Audio } from 'expo-av';
import { Platform } from 'react-native';

/**
 * خدمة إدارة الأصوات مع إصلاح Android Audio Focus
 */
class SoundService {
  private ringtoneSound: Audio.Sound | null = null;
  private outgoingSound: Audio.Sound | null = null;
  private endSound: Audio.Sound | null = null;
  private connectedSound: Audio.Sound | null = null;
  private isRingtoneActive = false;
  private isOutgoingActive = false;

  async loadSounds() {
    try {
      this.ringtoneSound = new Audio.Sound();
      this.outgoingSound = new Audio.Sound();
      this.endSound = new Audio.Sound();
      this.connectedSound = new Audio.Sound();

      // تحميل الأصوات
      try {
        await this.ringtoneSound.loadAsync(require('../../assets/sounds/ringtone.mp3'));
      } catch (e) {
        console.warn('⚠️ Ringtone sound not found, using default');
      }

      try {
        await this.outgoingSound.loadAsync(require('../../assets/sounds/outgoing.mp3'));
      } catch (e) {
        console.warn('⚠️ Outgoing sound not found, using default');
      }

      try {
        await this.endSound.loadAsync(require('../../assets/sounds/end.mp3'));
      } catch (e) {
        console.warn('⚠️ End sound not found, using default');
      }

      try {
        await this.connectedSound.loadAsync(require('../../assets/sounds/connected.mp3'));
      } catch (e) {
        console.warn('⚠️ Connected sound not found, using default');
      }

      console.log('✅ Sounds loaded');
    } catch (error) {
      console.error('❌ Error loading sounds:', error);
    }
  }

  /**
   * 🔧 إعدادات الصوت المحسّنة لـ Android و iOS
   */
  private async configureAudioMode() {
    try {
      if (Platform.OS === 'android') {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          interruptionModeAndroid: Audio.INTERRUPTION_MODE_ANDROID_DO_NOT_MIX,
          shouldDuckAndroid: false, // 🔧 مهم: تجنب خفض مستوى الصوت
          staysActiveInBackground: true,
          playsInSilentModeIOS: true,
        });
      } else {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: false,
          interruptionModeIOS: Audio.INTERRUPTION_MODE_IOS_DO_NOT_MIX,
          playsInSilentModeIOS: true,
          staysActiveInBackground: true,
        });
      }
    } catch (error) {
      console.error('❌ Error configuring audio mode:', error);
    }
  }

  async playRingtone() {
    try {
      if (!this.ringtoneSound) await this.loadSounds();

      // إيقاف أي أصوات أخرى
      await this.stopOutgoing();

      await this.configureAudioMode();

      // تشغيل الرنين بحلقة مستمرة
      await this.ringtoneSound?.setIsLoopingAsync(true);
      await this.ringtoneSound?.playAsync();

      this.isRingtoneActive = true;
      console.log('✅ Ringtone playing');
    } catch (error) {
      console.error('❌ Error playing ringtone:', error);
    }
  }

  async stopRingtone() {
    try {
      if (this.ringtoneSound) {
        await this.ringtoneSound.stopAsync();
        await this.ringtoneSound.setIsLoopingAsync(false);
      }
      this.isRingtoneActive = false;
      console.log('✅ Ringtone stopped');
    } catch (error) {
      console.error('❌ Error stopping ringtone:', error);
    }
  }

  async playOutgoing() {
    try {
      if (!this.outgoingSound) await this.loadSounds();

      // إيقاف الرنين إذا كان مشغلاً
      await this.stopRingtone();

      await this.configureAudioMode();

      // تشغيل صوت الانتظار بحلقة
      await this.outgoingSound?.setIsLoopingAsync(true);
      await this.outgoingSound?.playAsync();

      this.isOutgoingActive = true;
      console.log('✅ Outgoing sound playing');
    } catch (error) {
      console.error('❌ Error playing outgoing sound:', error);
    }
  }

  async stopOutgoing() {
    try {
      if (this.outgoingSound) {
        await this.outgoingSound.stopAsync();
        await this.outgoingSound.setIsLoopingAsync(false);
      }
      this.isOutgoingActive = false;
      console.log('✅ Outgoing sound stopped');
    } catch (error) {
      console.error('❌ Error stopping outgoing sound:', error);
    }
  }

  async playConnected() {
    try {
      if (!this.connectedSound) await this.loadSounds();

      // إيقاف الأصوات الأخرى
      await this.stopRingtone();
      await this.stopOutgoing();

      await this.configureAudioMode();

      // تشغيل صوت الاتصال
      await this.connectedSound?.playAsync();

      console.log('✅ Connected sound playing');
    } catch (error) {
      console.error('❌ Error playing connected sound:', error);
    }
  }

  async playEndSound() {
    try {
      if (!this.endSound) await this.loadSounds();

      // إيقاف جميع الأصوات الأخرى
      await this.stopRingtone();
      await this.stopOutgoing();

      await this.configureAudioMode();

      // تشغيل صوت النهاية
      await this.endSound?.playAsync();

      console.log('✅ End sound playing');
    } catch (error) {
      console.error('❌ Error playing end sound:', error);
    }
  }

  async stopAllSounds() {
    try {
      await this.stopRingtone();
      await this.stopOutgoing();

      if (this.connectedSound) {
        await this.connectedSound.stopAsync();
      }

      if (this.endSound) {
        await this.endSound.stopAsync();
      }

      console.log('✅ All sounds stopped');
    } catch (error) {
      console.error('❌ Error stopping all sounds:', error);
    }
  }

  async unloadSounds() {
    try {
      await this.ringtoneSound?.unloadAsync();
      await this.outgoingSound?.unloadAsync();
      await this.endSound?.unloadAsync();
      await this.connectedSound?.unloadAsync();

      this.ringtoneSound = null;
      this.outgoingSound = null;
      this.endSound = null;
      this.connectedSound = null;

      console.log('✅ Sounds unloaded');
    } catch (error) {
      console.error('❌ Error unloading sounds:', error);
    }
  }

  isRingtonePlayingNow() {
    return this.isRingtoneActive;
  }

  isOutgoingPlayingNow() {
    return this.isOutgoingActive;
  }
}

export const soundService = new SoundService();
