import Phaser from 'phaser';
import { SpeechManager, normalizeSpanish } from '../systems/SpeechManager.js';
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
  }

  async create() {
    // Entities
    this.player = this.add.sprite(120, 420, 'player');
    this.monster = this.add.sprite(640, 400, 'monster');
    this.bullets = this.add.group();

    // Top UI text
    this.uiText = this.add.text(20, 16, '', { fontFamily: 'monospace', fontSize: '18px', color: '#ffffff' });
    this.wordText = this.add.text(20, 44, '', { fontFamily: 'monospace', fontSize: '22px', color: '#ffd166' });
    this.updateUI();

    // Mic button (toggle)
    this.micButton = this.add.text(400, 560, '🎤 Tap to start game', { fontFamily: 'monospace', fontSize: '20px', color: '#ffffff' })
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });

    this.speech = new SpeechManager('es-ES');

    // Initialize levels from bundled JSON to avoid fetch failures
    this.initLevels();

    // Input behavior: toggle continuous listening
    this.listening = false;
    this.micButton.on('pointerdown', () => this.toggleListening());
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
      const { transcript } = await this.speech.startOnce();
      const said = normalizeSpanish(transcript.trim());
      const target = normalizeSpanish(this.currentWord);
      if (said === target) {
        this.playerShoot();
      } else {
        this.monsterAdvance();
      }
    } catch (e) {
      this.flashInfo('Mic error');
      this.monsterAdvance();
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
      this.speech.startContinuous(({ transcript, isFinal }) => {
        const said = normalizeSpanish(transcript.trim());
        const target = normalizeSpanish(this.currentWord);
        if (!isFinal) {
          // Optional: show interim hypothesis subtly (no gameplay effect)
          const cur = (this.wordObjects || []).find(o => normalizeSpanish(o.text) === normalizeSpanish(this.currentWord)) || { translation: '' };
          const tr = cur.translation ? ` (${cur.translation})` : '';
          this.wordText.setText(`Word: "${this.currentWord}"${tr}  (you said: ${said})`);
          return;
        }
        // Final: resolve combat
        if (said === target) this.playerShoot(); else this.monsterAdvance();
        const obj = (this.wordObjects || []).find(o => normalizeSpanish(o.text) === normalizeSpanish(this.currentWord)) || { translation: '' };
        const tr2 = obj.translation ? ` (${obj.translation})` : '';
        this.wordText.setText(`Word: "${this.currentWord}"${tr2}`);
      });
    } else {
      this.micButton.setText('🎤 Tap to start game');
      this.speech.stopContinuous();
    }
  }

  playerShoot() {
    const bullet = this.add.sprite(this.player.x + 20, this.player.y - 10, 'bullet');
    this.bullets.add(bullet);
    this.tweens.add({
      targets: bullet,
      x: this.monster.x - 24,
      y: this.monster.y - 12,
      duration: this.tuning.bulletDurationMs,
      onComplete: () => {
        bullet.destroy();
        this.monsterFlashAndRecoil();
        this.advanceWord();
      }
    });
  }

  monsterFlashAndRecoil() {
    const orgX = this.monster.x;
    this.monster.setTint(0xffffff);
    this.time.delayedCall(60, () => this.monster.clearTint());
    this.tweens.add({ targets: this.monster, x: orgX + this.tuning.recoilPushbackPx, duration: 100, yoyo: true, ease: 'Sine.easeOut' });
  }

  monsterAdvance() {
    const targetX = Math.max(this.player.x + 60, this.monster.x - this.tuning.monsterStepPx);
    this.tweens.add({ targets: this.monster, x: targetX, duration: this.tuning.advanceDurationMs, ease: 'Sine.easeIn', onComplete: () => {
      if (this.monster.x <= this.player.x + 80) {
        this.hp = Math.max(0, this.hp - 1);
        this.cameras.main.shake(100, 0.004);
        if (this.hp === 0) {
          this.gameOver();
        }
        this.updateUI();
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


