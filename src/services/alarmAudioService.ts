/**
 * Synthesizes an audible clinical bedside emergency alarm using the Web Audio API.
 * Does not require external audio assets or network requests.
 */
class AlarmAudioService {
  private audioCtx: AudioContext | null = null;
  private isAlarmPlaying = false;
  private intervalId: any = null;

  public startAlarm() {
    if (this.isAlarmPlaying) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;
      this.audioCtx = new AudioContextClass();
      this.isAlarmPlaying = true;

      const playBeep = () => {
        if (!this.audioCtx || !this.isAlarmPlaying) return;
        if (this.audioCtx.state === 'suspended') {
          this.audioCtx.resume();
        }
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(920, this.audioCtx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(580, this.audioCtx.currentTime + 0.3);

        gain.gain.setValueAtTime(0.25, this.audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.audioCtx.currentTime + 0.3);

        osc.connect(gain);
        gain.connect(this.audioCtx.destination);

        osc.start();
        osc.stop(this.audioCtx.currentTime + 0.32);
      };

      playBeep();
      this.intervalId = setInterval(playBeep, 750);
    } catch (e) {
      console.warn('Audio alarm notice (user gesture may be required):', e);
    }
  }

  public stopAlarm() {
    this.isAlarmPlaying = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.audioCtx) {
      try {
        this.audioCtx.close();
      } catch (e) {
        // ignore
      }
      this.audioCtx = null;
    }
  }

  public isPlaying(): boolean {
    return this.isAlarmPlaying;
  }
}

export const alarmAudio = new AlarmAudioService();
