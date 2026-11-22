/*
 * Kurbağa Prens — Oyun Motoru
 * ----------------------------------------------------------------
 * Hem sunucuda (Node.js) hem tarayıcıda (demo modu) çalışan,
 * oyunun bütün kurallarını içeren saf mantık katmanı.
 * Çizim yapmaz; sadece durum (state) tutar ve olay (event) üretir.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrogGame = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_SETTINGS = {
    roundSeconds: 180,       // Tur süresi (oyuncu sayısı minPlayers'a ulaşınca başlar)
    minPlayers: 2,           // Savaşın başlaması için en az oyuncu
    likePower: 1,            // Her beğeni = +1 güç
    giftMultiplier: 10,      // Hediye gücü = elmas değeri × adet × çarpan
    fightSeconds: 10,        // Savaş sahnesinin yaklaşık süresi
    winSeconds: 15,          // Kazanan sahnesinin süresi
    showWinnerAvatar: true,  // Finalde kazananın profil fotoğrafı gösterilsin mi
    joinGiftIds: [5655],     // Katılım hediyesi ID'leri (5655 = Gül / Rose)
    joinGiftNames: ['rose', 'gül', 'gul'],
    maxNameLength: 16,
    hallSize: 10
  };

  /* ---------------- İsim filtresi ---------------- */

  // Uzun kelimeler isim içinde herhangi bir yerde geçerse yakalanır.
  const BAD_SUBSTRINGS = [
    'orospu', 'orspu', 'siktir', 'sikerim', 'sikik', 'sikis', 'yarrak', 'yarak',
    'pezevenk', 'kahpe', 'amcik', 'gavat', 'ibne', 'pust', 'kaltak', 'anani',
    'fuck', 'bitch', 'nigger', 'nigga', 'faggot', 'whore', 'porn', 'pussy', 'dick', 'hitler', 'nazi'
  ];
  // Kısa kelimeler sadece ayrı bir parça olarak geçerse yakalanır (ör. "sikke" serbest).
  const BAD_TOKENS = ['amk', 'aq', 'oc', 'sik', 'got', 'pic', 'sg', 'mk', 'sex', 'cum'];

  function normalizeForFilter(s) {
    return String(s || '')
      .toLocaleLowerCase('tr-TR')
      .replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u')
      .replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
      .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
      .replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
      .replace(/@/g, 'a').replace(/\$/g, 's');
  }

  function isOffensive(name, extraWords) {
    const n = normalizeForFilter(name);
    const squashed = n.replace(/[^a-z]/g, '');
    const deduped = squashed.replace(/(.)\1+/g, '$1'); // "siiiktir" -> "siktir"
    const subs = BAD_SUBSTRINGS.concat((extraWords || []).map(normalizeForFilter));
    for (const w of subs) {
      if (!w) continue;
      if (squashed.includes(w) || deduped.includes(w)) return true;
    }
    const tokens = n.split(/[^a-z]+/).filter(Boolean);
    for (const t of tokens) if (BAD_TOKENS.includes(t)) return true;
    return false;
  }

  function cleanDisplayName(raw, fallbackNo, settings, extraWords) {
    let name = String(raw || '').replace(/[\u0000-\u001f​-‏‪-‮]/g, '').trim();
    if (!name || isOffensive(name, extraWords)) return 'Kurbağa #' + fallbackNo;
    const max = (settings && settings.maxNameLength) || 16;
    if ([...name].length > max) name = [...name].slice(0, max - 1).join('') + '…';
    return name;
  }

  /* ---------------- Yardımcılar ---------------- */

  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  function isJoinGift(gift, settings) {
    if (settings.joinGiftIds.includes(Number(gift.giftId))) return true;
    const n = String(gift.giftName || '').toLocaleLowerCase('tr-TR');
    return settings.joinGiftNames.includes(n);
  }

  /* ---------------- Oyun ---------------- */

  class Game {
    constructor(settings, hooks) {
      this.settings = Object.assign({}, DEFAULT_SETTINGS, settings || {});
      this.hooks = hooks || {};
      this.extraBadWords = [];
      this.listeners = [];
      this.hall = [];          // Günün prensleri
      this.curtain = false;    // Acil durum perdesi
      this.reset(Date.now(), true);
    }

    on(fn) { this.listeners.push(fn); }
    emit(ev) { ev.t = Date.now(); for (const fn of this.listeners) { try { fn(ev); } catch (e) { /* yut */ } } }

    reset(now, silent) {
      this.round = (this.round || 0) + 1;
      this.phase = 'lobby';
      this.players = new Map();
      this.joinCounter = 0;
      this.roundEndsAt = null;
      this.nextElimAt = null;
      this.elimInterval = 0;
      this.winner = null;
      this.winEndsAt = null;
      this.fightStartedAt = null;
      const queued = this.queue || [];
      this.queue = [];
      if (!silent) this.emit({ type: 'phase', phase: 'lobby', round: this.round });
      for (const u of queued) this._addPlayer(u, now, 0);
    }

    _addPlayer(user, now, bonusPower) {
      this.joinCounter++;
      const p = {
        id: String(user.id),
        uniqueId: String(user.uniqueId || user.name || ''),
        name: cleanDisplayName(user.name, this.joinCounter, this.settings, this.extraBadWords),
        avatar: user.avatar || null,
        power: this.settings.giftMultiplier + (bonusPower || 0),
        alive: true,
        joinedAt: now,
        order: this.joinCounter,
        hue: hashStr(String(user.id)) % 360,
        isTest: !!user.isTest
      };
      this.players.set(p.id, p);
      this.emit({ type: 'join', id: p.id, name: p.name, power: p.power });
      this._checkStart(now);
      return p;
    }

    _checkStart(now) {
      if (this.phase === 'lobby' && !this.roundEndsAt && this.aliveCount() >= this.settings.minPlayers) {
        this.roundEndsAt = now + this.settings.roundSeconds * 1000;
        this.emit({ type: 'timerStart', endsAt: this.roundEndsAt });
      }
    }

    aliveCount() { let c = 0; for (const p of this.players.values()) if (p.alive) c++; return c; }

    /** Hediye geldiğinde çağrılır. gift: {giftId, giftName, diamonds, count} */
    handleGift(user, gift, now) {
      if (now == null) now = Date.now();
      const id = String(user.id);
      const count = Math.max(1, Number(gift.count) || 1);
      const diamonds = Math.max(1, Number(gift.diamonds) || 1);
      const power = diamonds * count * this.settings.giftMultiplier;
      let p = this.players.get(id);

      if (!p) {
        if (!isJoinGift(gift, this.settings)) return { ok: false, reason: 'not-joined' };
        if (this.phase !== 'lobby') {
          // Savaş/final sırasında gelen gül: bir sonraki tura sıraya alınır
          if (!this.queue.find(q => String(q.id) === id)) this.queue.push(Object.assign({}, user));
          this.emit({ type: 'queued', id, name: cleanDisplayName(user.name, '?', this.settings, this.extraBadWords) });
          return { ok: true, queued: true };
        }
        p = this._addPlayer(user, now, power - this.settings.giftMultiplier);
        return { ok: true, joined: true };
      }
      if (!p.alive || this.phase === 'win') return { ok: false, reason: 'not-active' };
      if (user.avatar) p.avatar = user.avatar;
      p.power += power;
      this.emit({ type: 'power', id, name: p.name, add: power, power: p.power, gift: gift.giftName || 'Hediye', count, big: power >= 100 * this.settings.giftMultiplier / 10 });
      return { ok: true };
    }

    handleLike(user, likeCount, now) {
      const p = this.players.get(String(user.id));
      if (!p || !p.alive || this.phase === 'win') return { ok: false };
      const add = Math.max(1, Number(likeCount) || 1) * this.settings.likePower;
      p.power += add;
      this.emit({ type: 'like', id: p.id, add, power: p.power });
      return { ok: true };
    }

    kick(id, reason) {
      id = String(id);
      const p = this.players.get(id);
      this.queue = this.queue.filter(q => String(q.id) !== id);
      if (!p) return false;
      this.players.delete(id);
      this.emit({ type: 'kick', id, reason: reason || 'kick' });
      if (this.winner && this.winner.id === id) { this.winner.hidden = true; }
      return true;
    }

    removeTestPlayers() {
      for (const p of [...this.players.values()]) if (p.isTest) this.kick(p.id, 'test');
      this.queue = this.queue.filter(q => !q.isTest);
    }

    startFight(now) {
      if (now == null) now = Date.now();
      if (this.phase !== 'lobby') return false;
      const n = this.aliveCount();
      if (n === 0) return false;
      this.phase = 'fight';
      this.fightStartedAt = now;
      this.elimInterval = n > 1 ? Math.max(250, Math.min(1500, (this.settings.fightSeconds * 1000) / (n - 1))) : 0;
      this.nextElimAt = now + 2200; // "SAVAŞ!" yazısı için kısa bekleme
      this.emit({ type: 'phase', phase: 'fight', round: this.round });
      return true;
    }

    _ranked() {
      // Güç büyükten küçüğe; eşitlikte önce gelen önde
      return [...this.players.values()].filter(p => p.alive)
        .sort((a, b) => (b.power - a.power) || (a.order - b.order));
    }

    tick(now) {
      if (now == null) now = Date.now();
      if (this.phase === 'lobby') {
        if (this.roundEndsAt && now >= this.roundEndsAt) {
          if (this.aliveCount() >= this.settings.minPlayers) this.startFight(now);
          else { this.roundEndsAt = null; }
        } else if (!this.roundEndsAt) {
          this._checkStart(now);
        }
      } else if (this.phase === 'fight') {
        if (now >= this.nextElimAt) {
          const ranked = this._ranked();
          if (ranked.length <= 1) return this._crown(ranked[0], now);
          const victim = ranked[ranked.length - 1];
          const stronger = ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 3)));
          const attacker = stronger[Math.floor(Math.random() * stronger.length)];
          victim.alive = false;
          this.emit({ type: 'eliminate', id: victim.id, by: attacker.id, left: ranked.length - 1 });
          this.nextElimAt = now + this.elimInterval;
          if (ranked.length - 1 <= 1) this.nextElimAt = now + 1300;
        }
      } else if (this.phase === 'win') {
        if (now >= this.winEndsAt) this.reset(now);
      }
    }

    _crown(p, now) {
      if (!p) { this.reset(now); return; }
      this.phase = 'win';
      this.winner = {
        id: p.id, name: p.name, power: p.power,
        avatar: this.settings.showWinnerAvatar ? p.avatar : null,
        hidden: false, at: now, round: this.round, players: this.players.size
      };
      this.winEndsAt = now + this.settings.winSeconds * 1000;
      this.hall.unshift({ name: p.name, power: p.power, at: now });
      this.hall = this.hall.slice(0, this.settings.hallSize);
      this.emit({ type: 'phase', phase: 'win', round: this.round });
      this.emit({ type: 'winner', id: p.id, name: p.name, power: p.power });
      if (this.hooks.onWinner) this.hooks.onWinner(this.winner, this.hall);
    }

    hideWinnerAvatar(hidden) {
      if (this.winner) this.winner.hidden = hidden !== false;
    }

    snapshot(now) {
      if (now == null) now = Date.now();
      const players = [...this.players.values()].map(p => ({
        id: p.id, uniqueId: p.uniqueId, name: p.name, power: p.power, alive: p.alive, order: p.order, hue: p.hue, isTest: p.isTest
      }));
      let winner = null;
      if (this.winner) {
        winner = Object.assign({}, this.winner);
        if (winner.hidden || !this.settings.showWinnerAvatar) winner.avatar = null;
        delete winner.hidden;
      }
      return {
        phase: this.phase,
        round: this.round,
        now,
        timeLeft: this.roundEndsAt ? Math.max(0, this.roundEndsAt - now) : null,
        winLeft: this.winEndsAt ? Math.max(0, this.winEndsAt - now) : null,
        minPlayers: this.settings.minPlayers,
        players,
        queued: this.queue.length,
        winner,
        hall: this.hall,
        curtain: this.curtain,
        settings: {
          roundSeconds: this.settings.roundSeconds, likePower: this.settings.likePower,
          giftMultiplier: this.settings.giftMultiplier, minPlayers: this.settings.minPlayers,
          fightSeconds: this.settings.fightSeconds, winSeconds: this.settings.winSeconds,
          showWinnerAvatar: this.settings.showWinnerAvatar
        }
      };
    }

    updateSettings(patch) {
      const allowed = ['roundSeconds', 'minPlayers', 'likePower', 'giftMultiplier', 'fightSeconds', 'winSeconds', 'showWinnerAvatar'];
      for (const k of allowed) {
        if (patch[k] === undefined) continue;
        if (k === 'showWinnerAvatar') this.settings[k] = !!patch[k];
        else {
          const v = Number(patch[k]);
          if (Number.isFinite(v) && v >= 0) this.settings[k] = v;
        }
      }
      this.settings.minPlayers = Math.max(1, Math.round(this.settings.minPlayers));
      this.settings.roundSeconds = Math.max(10, this.settings.roundSeconds);
    }
  }

  return { Game, DEFAULT_SETTINGS, isOffensive, cleanDisplayName, hashStr };
});
