import Phaser from 'phaser';
import { SpeechManager, normalizeSpanish, scorePronunciation, AudioMeter } from '../systems/SpeechManager.js';
import levelsData from '../data/words_es.json';

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
    this.player = null;
    this.monster = null;
    this.bullets = null;
    this.hp = 5;
    this.level = 1;
    this.currentWord = 'hola';
    this.words = ['hola', 'adiós', 'gracias', 'por favor'];
    this.levels = [];
    this.levelIndex = 0;
    this.levelName = '';
    this.tuning = { monsterStepPx: 26, recoilPushbackPx: 26, advanceDurationMs: 160, bulletDurationMs: 260 };
    this.correctHits = 0;
    this.correctUnique = new Set();
    this.uniqueNeeded = 0;
    this.isResolving = false;
    this.audioMeter = null;
    this.grading = { perfect: 0.85, good: 0.7, okay: 0.55 };
    this.practiceMode = false;
    this.comboStreak = 0;
    this.bestCombo = 0;
    this.totalAttempts = 0;
    this.totalHits = 0;
    this.baseTuning = null;
  }

  monsterMissFeedback() {
    // Quick red flash on monster for practice miss
    this.monster.setTint(0xff4444);
    this.time.delayedCall(80, () => this.monster.clearTint());
  }

  togglePractice() {
    this.practiceMode = !this.practiceMode;
    this.flashInfo(this.practiceMode ? 'Practice Mode ON' : 'Practice Mode OFF');
    this.updateUI();
  }

  onGradedFinal(weighted, label) {
    this.totalAttempts = (this.totalAttempts || 0) + 1;
    if (weighted >= this.grading.okay) {
      this.totalHits = (this.totalHits || 0) + 1;
      this.comboStreak = (this.comboStreak || 0) + 1;
      this.bestCombo = Math.max(this.bestCombo || 0, this.comboStreak);
      this.recomputeDifficulty();
      this.playerShoot(weighted, label);
    } else {
      this.comboStreak = 0;
      this.recomputeDifficulty();
      if (this.practiceMode) {
        this.monsterMissFeedback();
      } else {
        this.monsterAdvance();
      }
    }
    this.updateUI();
  }

  recomputeDifficulty() {
    if (!this.baseTuning) return;
    const c = this.comboStreak || 0;
    const bt = this.baseTuning;
    const scale = (x) => Math.max(1, Math.round(x));
    if (c >= 8) {
      this.tuning.monsterStepPx = scale(bt.monsterStepPx * 1.4);
      this.tuning.advanceDurationMs = scale(bt.advanceDurationMs * 0.85);
      this.tuning.recoilPushbackPx = scale(bt.recoilPushbackPx * 1.3);
      this.tuning.bulletDurationMs = scale(bt.bulletDurationMs * 0.9);
    } else if (c >= 4) {
      this.tuning.monsterStepPx = scale(bt.monsterStepPx * 1.2);
      this.tuning.advanceDurationMs = scale(bt.advanceDurationMs * 0.9);
      this.tuning.recoilPushbackPx = scale(bt.recoilPushbackPx * 1.15);
      this.tuning.bulletDurationMs = scale(bt.bulletDurationMs * 0.95);
    } else {
      this.tuning = Object.assign({}, bt);
    }
  }

  async create() {
    // Entities
    this.player = this.add.sprite(120, 420, 'player');
    this.monster = this.add.sprite(640, 400, 'monster');
    this.bullets = this.add.group();

    // Idle breathing tweens (simple procedural animation)
    this.tweens.add({ targets: this.player, scaleY: 1.04, yoyo: true, duration: 1200, repeat: -1, ease: 'Sine.easeInOut' });
    this.tweens.add({ targets: this.monster, scaleX: 1.02, yoyo: true, duration: 1600, repeat: -1, ease: 'Sine.easeInOut' });

    // Top UI text
    this.uiText = this.add.text(20, 16, '', { fontFamily: 'monospace', fontSize: '18px', color: '#ffffff' });
    this.wordText = this.add.text(20, 44, '', { fontFamily: 'monospace', fontSize: '22px', color: '#ffd166' });
    this.comboText = this.add.text(780, 16, 'Combo: 0', { fontFamily: 'monospace', fontSize: '16px', color: '#7CFC00' }).setOrigin(1, 0);
    this.accText = this.add.text(780, 36, 'Acc: 0%', { fontFamily: 'monospace', fontSize: '14px', color: '#a0aec0' }).setOrigin(1, 0);
    this.updateUI();

    // Mic button (toggle)
    this.micButton = this.add.text(400, 560, '🎤 Tap to start game', { fontFamily: 'monospace', fontSize: '20px', color: '#ffffff' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    // Practice toggle
    this.practiceToggle = this.add.text(250, 560, 'Practice: OFF', { fontFamily: 'monospace', fontSize: '16px', color: '#cccccc' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.speech = new SpeechManager('es-ES');
    this.audioMeter = new AudioMeter();

    // Audio meter UI (volume bar + pitch readout)
    this.meterBg = this.add.rectangle(560, 560, 200, 12, 0x20232a).setOrigin(0, 0.5);
    this.meterFill = this.add.rectangle(560, 560, 2, 10, 0x31e981).setOrigin(0, 0.5);
    this.pitchText = this.add.text(770, 548, '— Hz', { fontFamily: 'monospace', fontSize: '12px', color: '#a0aec0' }).setOrigin(1, 0);

    // Initialize levels from bundled JSON to avoid fetch failures
    this.initLevels();

    // Input behavior: toggle continuous listening
    this.listening = false;
    this.micButton.on('pointerdown', () => this.toggleListening());
    this.practiceToggle.on('pointerdown', () => this.togglePractice());
    this.input.keyboard?.on('keydown-P', () => this.togglePractice());
  }

  initLevels() {
    try {
      const data = levelsData || {};
      this.levels = Array.isArray(data.levels) ? data.levels : [];
      if (this.levels.length > 0) {
        this.levelIndex = 0;
        this.applyLevel(this.levels[this.levelIndex]);
      }
    } catch (_) { /* keep defaults */ }
  }

  applyLevel(levelDef) {
    this.level = levelDef.id || (this.levelIndex + 1);
    this.levelName = String(levelDef.name || '');
    this.wordObjects = Array.isArray(levelDef.words) ? levelDef.words.map(w => ({
      text: String(w.text),
      hint: String(w.hint || ''),
      translation: String(w.translation || '')
    })) : [];
    this.words = this.shuffleArray(this.wordObjects.map(w => w.text.toLowerCase()));
    this.currentWord = this.words[0] || this.currentWord;
    this.tuning = Object.assign({}, this.tuning, levelDef.tuning || {});
    this.baseTuning = Object.assign({}, this.tuning);
    this.correctNeeded = levelDef?.winCondition?.correctNeeded || this.words.length;
    this.correctHits = 0;
    this.correctUnique = new Set();
    this.uniqueNeeded = Math.min(this.words.length, this.correctNeeded);
    this.monster.x = 640;
    this.updateUI();
  }

  updateUI() {
    const hearts = '♥'.repeat(this.hp);
    const progress = `${this.correctUnique.size || 0}/${this.uniqueNeeded || 0}`;
    const levelLabel = this.levelName ? `Level: ${this.level} - ${this.levelName}` : `Level: ${this.level}`;
    this.uiText.setText(`HP: ${hearts}   |   ${levelLabel}   |   ${progress}`);
    const currentObj = (this.wordObjects || []).find(o => normalizeSpanish(o.text) === normalizeSpanish(this.currentWord)) || { translation: '' };
    const translation = currentObj.translation ? ` (${currentObj.translation})` : '';
    this.wordText.setText(`Word: "${this.currentWord}"${translation}`);
    const acc = this.totalAttempts > 0 ? Math.round((this.totalHits / this.totalAttempts) * 100) : 0;
    this.comboText.setText(`Combo: ${this.comboStreak}`);
    this.accText.setText(`Acc: ${acc}%`);
    this.practiceToggle.setText(`Practice: ${this.practiceMode ? 'ON' : 'OFF'}`);
    this.practiceToggle.setColor(this.practiceMode ? '#7CFC00' : '#cccccc');
  }

  async captureOnce() {
    if (this.isResolving) return;
    if (!this.speech.available) {
      this.flashInfo('Speech not available');
      return;
    }
    this.isResolving = true;
    this.micButton.setText('🎤 Listening...');
    try {
      const { transcript, confidence } = await this.speech.startOnce();
      const said = normalizeSpanish(String(transcript || '').trim());
      const target = normalizeSpanish(this.currentWord);
      const { weighted, label } = scorePronunciation(said, target, confidence || 0);
      if (weighted >= this.grading.okay) {
        this.playerShoot(weighted, label);
      } else {
        this.monsterAdvance();
      }
    } catch (e) {
      this.flashInfo('Mic error');
      if (!this.practiceMode) this.monsterAdvance(); else this.monsterMissFeedback();
    } finally {
      this.micButton.setText(this.listening ? '🎤 Listening (tap to stop)' : '🎤 Tap to start game');
      this.isResolving = false;
    }
  }

  toggleListening() {
    if (!this.speech.available) {
      this.flashInfo('Speech not available');
      return;
    }
    this.listening = !this.listening;
    if (this.listening) {
      this.micButton.setText('🎤 Listening (tap to stop)');
      // Start continuous listening and handle interim + final results
      this.speech.startContinuous(({ transcript, confidence, isFinal }) => {
        const said = normalizeSpanish(String(transcript || '').trim());
        const target = normalizeSpanish(this.currentWord);
        const { weighted, score100, label } = scorePronunciation(said, target, confidence || 0);
        if (!isFinal) {
          const cur = (this.wordObjects || []).find(o => normalizeSpanish(o.text) === normalizeSpanish(this.currentWord)) || { translation: '' };
          const tr = cur.translation ? ` (${cur.translation})` : '';
          this.wordText.setText(`Word: "${this.currentWord}"${tr}  (you said: ${said} • ${score100})`);
          return;
        }
        // Final: resolve combat with graded thresholds
        this.onGradedFinal(weighted, label);
        const obj = (this.wordObjects || []).find(o => normalizeSpanish(o.text) === normalizeSpanish(this.currentWord)) || { translation: '' };
        const tr2 = obj.translation ? ` (${obj.translation})` : '';
        this.wordText.setText(`Word: "${this.currentWord}"${tr2}`);
      });
      // Start audio visualization
      this.audioMeter.start(({ rms, pitchHz }) => {
        // Clamp and map RMS to bar width
        const clamped = Math.min(0.35, Math.max(0, rms));
        const pct = clamped / 0.35;
        const width = Math.max(2, Math.floor(200 * pct));
        this.meterFill.width = width;
        const shownPitch = pitchHz && pitchHz > 40 && pitchHz < 1000 ? `${Math.round(pitchHz)} Hz` : '— Hz';
        this.pitchText.setText(shownPitch);
      }).catch?.(() => {/* ignore */});
    } else {
      this.micButton.setText('🎤 Tap to start game');
      this.speech.stopContinuous();
      this.audioMeter.stop();
      this.meterFill.width = 2;
      this.pitchText.setText('— Hz');
    }
  }

  playerShoot(weighted = 1, label = 'perfect') {
    const bullet = this.add.sprite(this.player.x + 20, this.player.y - 10, 'bullet');
    this.bullets.add(bullet);
    // Faster projectile for higher score
    const speedScale = 1 - Math.min(0.6, Math.max(0, weighted)) * 0.4; // 1..0.76
    this.tweens.add({
      targets: bullet,
      x: this.monster.x - 24,
      y: this.monster.y - 12,
      duration: Math.max(120, Math.floor(this.tuning.bulletDurationMs * speedScale)),
      onComplete: () => {
        bullet.destroy();
        this.monsterFlashAndRecoil(weighted, label);
        // Spark hit effect
        const spark = this.add.sprite(this.monster.x - 16, this.monster.y - 16, 'spark').setScale(0.6).setAlpha(1);
        this.tweens.add({ targets: spark, scale: 1.6, alpha: 0, duration: 220, onComplete: () => spark.destroy() });
        this.advanceWord();
      }
    });
    // Attack squash for player
    this.tweens.add({ targets: this.player, scaleY: 0.92, duration: 80, yoyo: true, ease: 'Sine.easeInOut' });
  }

  monsterFlashAndRecoil(weighted = 0.6, label = 'hit') {
    const orgX = this.monster.x;
    this.monster.setTint(0xffffff);
    this.time.delayedCall(60, () => this.monster.clearTint());
    const push = Math.floor(this.tuning.recoilPushbackPx * (0.4 + (weighted * 0.6)));
    this.tweens.add({ targets: this.monster, x: orgX + push, duration: 100, yoyo: true, ease: 'Sine.easeOut' });
    // Floating grade label
    const color = label === 'perfect' ? '#7CFC00' : label === 'good' ? '#a0ff7a' : label === 'okay' ? '#e6ff8f' : '#ffffff';
    const t = this.add.text(this.monster.x, this.monster.y - 50, label.toUpperCase(), { fontFamily: 'monospace', fontSize: '16px', color }).setOrigin(0.5);
    this.tweens.add({ targets: t, y: t.y - 24, alpha: 0, duration: 700, onComplete: () => t.destroy() });
  }

  monsterAdvance() {
    const targetX = Math.max(this.player.x + 60, this.monster.x - this.tuning.monsterStepPx);
    this.tweens.add({ targets: this.monster, x: targetX, duration: this.tuning.advanceDurationMs, ease: 'Sine.easeIn', onComplete: () => {
      if (this.monster.x <= this.player.x + 80) {
        if (!this.practiceMode) {
          this.hp = Math.max(0, this.hp - 1);
          this.cameras.main.shake(100, 0.004);
          if (this.hp === 0) {
            this.gameOver();
          }
          this.updateUI();
        } else {
          // In practice, just indicate a miss
          this.cameras.main.shake(60, 0.002);
          const t = this.add.text(this.player.x, this.player.y - 40, 'MISS', { fontFamily: 'monospace', fontSize: '14px', color: '#ff6b6b' }).setOrigin(0.5);
          this.tweens.add({ targets: t, y: t.y - 20, alpha: 0, duration: 600, onComplete: () => t.destroy() });
        }
      }
    }});
  }

  advanceWord() {
    const idx = this.words.indexOf(this.currentWord);
    const nextIdx = (idx + 1) % this.words.length;
    this.correctHits = Math.min(this.correctNeeded, (this.correctHits || 0) + 1);
    this.correctUnique.add(normalizeSpanish(this.currentWord));
    if (this.correctUnique.size >= this.uniqueNeeded) {
      // advance to next level or finish game
      if (this.levels.length > 0) {
        if (this.levelIndex + 1 < this.levels.length) {
          this.levelIndex += 1;
          const nextLevel = this.levels[this.levelIndex];
          this.applyLevel(nextLevel);
          this.flashInfo(`Level ${this.level} - ${nextLevel.name}`);
        } else {
          this.flashInfo('Dungeon cleared!');
          this.time.delayedCall(1000, () => this.scene.restart());
        }
        return;
      }
    } else if (nextIdx === 0) {
      // loop words within level until win condition
      this.monster.x = 640;
    }
    this.currentWord = this.words[nextIdx] || this.currentWord;
    this.updateUI();
  }

  shuffleArray(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = a[i];
      a[i] = a[j];
      a[j] = tmp;
    }
    return a;
  }

  gameOver() {
    this.flashInfo('Game Over');
    this.scene.restart();
  }

  flashInfo(msg) {
    const t = this.add.text(400, 300, msg, { fontFamily: 'monospace', fontSize: '22px', color: '#ffffff', backgroundColor: '#00000088', padding: { x: 8, y: 6 } }).setOrigin(0.5);
    this.tweens.add({ targets: t, alpha: 0, duration: 900, onComplete: () => t.destroy() });
  }
}


