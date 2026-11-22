'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Game, isOffensive, cleanDisplayName } = require('../public/engine.js');

const ROSE = { giftId: 5655, giftName: 'Rose', diamonds: 1, count: 1 };

test('gül atan oyuna katılır, başka hediye ile katılamaz', () => {
  const g = new Game({ minPlayers: 2 });
  assert.equal(g.handleGift({ id: 'a', name: 'ali' }, { giftId: 1, giftName: 'Finger Heart', diamonds: 5 }).ok, false);
  assert.equal(g.handleGift({ id: 'a', name: 'ali' }, ROSE).joined, true);
  assert.equal(g.players.size, 1);
});

test('güç hesabı: gül + hediye + beğeni', () => {
  const g = new Game({ giftMultiplier: 10, likePower: 1 });
  g.handleGift({ id: 'a', name: 'ali' }, ROSE);                                   // 10
  g.handleGift({ id: 'a' }, { giftId: 1, giftName: 'Finger Heart', diamonds: 5, count: 5 }); // +250
  g.handleLike({ id: 'a' }, 3);                                                     // +3
  assert.equal(g.players.get('a').power, 263);
});

test('süre minimum oyuncuya ulaşınca başlar ve savaş tek kazananla biter', () => {
  const g = new Game({ minPlayers: 2, roundSeconds: 10, fightSeconds: 1, winSeconds: 1 });
  let t = 1000;
  g.handleGift({ id: 'a', name: 'ali' }, ROSE, t);
  assert.equal(g.roundEndsAt, null);
  g.handleGift({ id: 'b', name: 'veli' }, ROSE, t);
  g.handleGift({ id: 'c', name: 'ayse' }, ROSE, t);
  g.handleGift({ id: 'b' }, { giftId: 2, giftName: 'Lion', diamonds: 100, count: 1 }, t);
  assert.ok(g.roundEndsAt);
  t += 10001; g.tick(t);
  assert.equal(g.phase, 'fight');
  for (let i = 0; i < 20 && g.phase === 'fight'; i++) { t += 3000; g.tick(t); }
  assert.equal(g.phase, 'win');
  assert.equal(g.winner.id, 'b');
  assert.equal(g.hall[0].name, 'veli');
  t += 2000; g.tick(t);
  assert.equal(g.phase, 'lobby');
  assert.equal(g.players.size, 0);
});

test('profil fotoğrafı oyun sırasında durumda yer almaz, sadece kazananda', () => {
  const g = new Game({ minPlayers: 1, roundSeconds: 10, winSeconds: 5 });
  g.handleGift({ id: 'a', name: 'ali', avatar: 'https://x/a.jpg' }, ROSE, 0);
  const snap = g.snapshot(0);
  assert.ok(!JSON.stringify(snap.players).includes('https://x/a.jpg'));
  g.startFight(0); g.tick(5000);
  assert.equal(g.snapshot(5000).winner.avatar, 'https://x/a.jpg');
  g.hideWinnerAvatar(true);
  assert.equal(g.snapshot(5000).winner.avatar, null);
});

test('kazanan fotoğrafı ayarla kapatılabilir', () => {
  const g = new Game({ minPlayers: 1, showWinnerAvatar: false });
  g.handleGift({ id: 'a', name: 'ali', avatar: 'https://x/a.jpg' }, ROSE, 0);
  g.startFight(0); g.tick(5000);
  assert.equal(g.snapshot(5000).winner.avatar, null);
});

test('savaş sırasında gelen gül sonraki tura sıraya alınır', () => {
  const g = new Game({ minPlayers: 1, winSeconds: 1 });
  g.handleGift({ id: 'a', name: 'ali' }, ROSE, 0);
  g.startFight(0);
  assert.equal(g.handleGift({ id: 'b', name: 'veli' }, ROSE, 0).queued, true);
  g.tick(5000); g.tick(7000);
  assert.equal(g.phase, 'lobby');
  assert.ok(g.players.has('b'));
});

test('isim filtresi', () => {
  for (const bad of ['orospu_cocu', 'or0spu', 'siiiktir', 'amk_123', 'xx.aq.xx', 'FUCKboy']) assert.ok(isOffensive(bad), bad);
  for (const ok of ['sikke_koleksiyon', 'aqua', 'kocaeli', 'gotham', 'ali.veli', 'zeynep_34']) assert.ok(!isOffensive(ok), ok);
  assert.equal(cleanDisplayName('orospu', 7), 'Kurbağa #7');
  assert.equal(cleanDisplayName('cok_uzun_bir_kullanici_adi_burada', 1, { maxNameLength: 16 }).length, 16);
});

test('kick ve test oyuncularını temizleme', () => {
  const g = new Game();
  g.handleGift({ id: 'a', name: 'ali' }, ROSE);
  g.handleGift({ id: 't', name: 'test', isTest: true }, ROSE);
  g.removeTestPlayers();
  assert.deepEqual([...g.players.keys()], ['a']);
  assert.ok(g.kick('a'));
  assert.equal(g.players.size, 0);
});

test('tur başına 50 oyuncu sınırı: fazlası sonraki tura sıraya girer', () => {
  const g = new Game({ minPlayers: 2, winSeconds: 1 });
  for (let i = 0; i < 55; i++) g.handleGift({ id: 'p' + i, name: 'oyuncu' + i }, ROSE, 0);
  assert.equal(g.players.size, 50);
  assert.equal(g.queue.length, 5);
  // sıradakilerin hediyesi bu turda güç vermez
  assert.equal(g.handleGift({ id: 'p52' }, { giftId: 1, giftName: 'Lion', diamonds: 100 }, 0).ok, false);
  assert.ok(!g.players.has('p52'));
  g.startFight(0);
  let t = 0;
  for (let i = 0; i < 200 && g.phase !== 'lobby'; i++) { t += 1000; g.tick(t); }
  assert.equal(g.phase, 'lobby');
  assert.equal(g.players.size, 5); // sıradakiler yeni tura otomatik girdi
});

test('savaş varsayılan olarak yaklaşık 20 saniye sürer ve hediyeyle kurtulunabilir', () => {
  const g = new Game({ minPlayers: 2 });
  for (let i = 0; i < 11; i++) g.handleGift({ id: 'p' + i, name: 'o' + i }, ROSE, 0);
  g.startFight(0);
  assert.equal(g.elimInterval, 2000);
  const danger = g.snapshot(0).dangerId;
  assert.ok(danger);
  g.handleGift({ id: danger }, { giftId: 1, giftName: 'Perfume', diamonds: 20 }, 100);
  assert.notEqual(g.snapshot(100).dangerId, danger);
  g.tick(3000);
  assert.ok(g.players.get(danger).alive, 'hediye atılan kurbağa kurtulmalı');
});
