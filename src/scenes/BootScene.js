import Phaser from 'phaser';

export default class BootScene extends Phaser.Scene {
  constructor() { super('BootScene'); }

  preload() {}

  create() {
    // Generate simple textures for placeholders
    const g = this.make.graphics({ x: 0, y: 0, add: false });

    // Player (blue circle 32x32)
    g.clear();
    g.fillStyle(0x4fc3f7, 1);
    g.fillCircle(16, 16, 16);
    g.generateTexture('player', 32, 32);

    // Monster (pink square 48x48)
    g.clear();
    g.fillStyle(0xff6fa1, 1);
    g.fillRect(0, 0, 48, 48);
    g.generateTexture('monster', 48, 48);

    // Bullet (cyan rectangle 20x8)
    g.clear();
    g.fillStyle(0x00e5ff, 1);
    g.fillRect(0, 0, 20, 8);
    g.generateTexture('bullet', 20, 8);

    this.scene.start('GameScene');
  }
}


