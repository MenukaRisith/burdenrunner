(() => {
  // ---------- Constants ----------
  const ITEM_LABEL = { water: "Water Bucket", rope: "Rope", torch: "Torch", bow: "Bow" };
  const HEARTS_TOTAL = 4;
  const HP_PER_HEART = 25;
  const SMALL_HIT = 12.5;
  const BIG_HIT = 25;

  const TOTAL_TIME = 60;       // game duration (seconds)
  const AUTO_ROTATE_SECS = 15;  // territory auto-rotate (seconds)
  const FIXED_DT = 1 / 60;

  // Optimized obstacle spacing
  const LARGE_DEFS = [
    { type: "canyon",  w: 140, h: 40,  gap: [1400, 2200] },
    { type: "mountain", w: 100, h: 122, gap: [1400, 2200] },
    { type: "cave",     w: 180, h: 98,  gap: [1400, 2200] },
    { type: "hunger",   w: 40,  h: 40,  gap: [1400, 2200] },
  ];
  const SMALL_DEFS = [
    { type: "rock",   w: 60, h: 50, gap: [500, 900] },
    { type: "hurdle", w: 40, h: 60, gap: [500, 900] },
  ];

  const OBSTACLE_LIFT = 48;
  const MIDDLE_LARGE_EXTRA_LIFT = 24;
  const FIXED_ARROW_ANGLE = -(12 * Math.PI) / 180;

  // Physics tuned for feel
  const PHYS = {
    gravity: 95,
    sustainGravity: 62,
    jumpVel: 400,
    jumpCutVel: 200,
    terminalVy: 1200,
    airDrag: 0.988,
    groundEps: 1.5,
    coyoteTime: 0.05,
    jumpBuffer: 0.16,
    sustainTime: 0.26,
    apexAssist: 0.82,
    apexThreshold: 50,
  };

  // ---------- State / DOM ----------
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  const toastEl = document.getElementById("toast");
  const hotbarEl = document.getElementById("hotbar");
  const heartsEl = document.getElementById("hearts");
  const progressEl = document.getElementById("progress");
  const pauseBtn = document.getElementById("pauseBtn");
  const territoryBtn = document.getElementById("territoryBtn");
  const territoryNameEl = document.getElementById("territoryName");

  // Decision modal
  const modalRoot = document.getElementById("modalRoot");
  const modalTitle = document.getElementById("modalTitle");
  const modalText = document.getElementById("modalText");
  const modalPrimary = document.getElementById("modalPrimary");
  const modalAlt = document.getElementById("modalAlt");
  const modalHint = document.getElementById("modalHint");

  // Optional restart button
  const restartBtn = document.getElementById("restartBtn");

  let dpr = 1;
  const rng = mulberry32(Date.now() >>> 0);

  const state = {
    t: 0,
    elapsed: 0,
    alive: true,
    distance: 0,
    health: 100,
    waterBuckets: 3,
    items: new Set(["water", "rope", "torch", "bow"]),
    baseSpeed: 5.4,
    nextId: 1,
    spawnSmall: 2.2,
    spawnLarge: 5.0,
    darknessBase: 0.12,
    darknessSurge: 0,
  };

  const player = {
    x: 220,
    y: 0,
    yPrev: 0,
    w: 200,
    h: 260,
    vy: 0,
    vx: 0,
    onGround: true,
    coyote: 0,
    jumpTime: 0,
    jumping: false,
    landingRecovery: 0,
    airTime: -20,
    groundFrames: 0,
  };

  const input = {
    down: new Set(),
    pressed: new Set(),
    bufferJump: 0,
    poll(dt) { this.pressed.clear(); if (this.bufferJump > 0) this.bufferJump = Math.max(0, this.bufferJump - dt); },
    press(k) {
      this.down.add(k);
      this.pressed.add(k);
      if (k === " " || k === "ArrowUp" || k === "w" || k === "W") this.bufferJump = PHYS.jumpBuffer;
    },
    release(k) { this.down.delete(k); },
    clearAll() { this.down.clear(); this.pressed.clear(); this.bufferJump = 0; },
  };

  const arrows = [];
  const obstacles = [];
  const particles = [];
  const glitchEffects = [];

  let activeItem = "bow";
  let paused = false;
  let decisionOpen = false;
  let hardFreeze = false; // set true on game end to stop sim

  // territories: "start" | "mid" | "last"
  let territory = "start";
  let territoryStartedAt = 0;

  // background scroll & fade
  let bgScroll = 0;
  const bgFade = { active: false, fromIdx: 0, toIdx: 0, t: 0, dur: 1.0 };
  let animTime = 0;

  // darkness surge (Middle/Ice only)
  const surge = { nextAt: 8, endAt: 0, active: false };

  // decisions
  let decisionCtx = null;
  let processedDecisions = new Set();

  // toast timer
  let toastTimer;

  // ---------- Assets ----------
  const assets = {
    spriteFrames: [],
    territoryImgs: [],
    crowFrames: [],
    yetiFrames: [],
    fireFrames: [],
    midSmall: null,
    iceSmall: null,
    hud: { water: null, rope: null, torch: null, bow: null, heart: null },
  };

  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = async () => { try { await img.decode?.(); } catch (_) {} resolve(img); };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  async function loadAssets() {
    const charPaths = [
      "/img/character/Frame0.png",
      "/img/character/Frame1.png",
      "/img/character/Frame2.png",
      "/img/character/Frame3.png",
      "/img/character/Frame4.png",
      "/img/character/Frame5.png",
    ];
    assets.spriteFrames = (await Promise.all(charPaths.map(loadImage))).filter(Boolean);

    const terrPaths = ["/img/bg/firebg.jpg", "/img/bg/middlebg.jpg", "/img/bg/icebg.jpg"];
    assets.territoryImgs = (await Promise.all(terrPaths.map(loadImage))).filter(Boolean);

    const crowPaths = Array.from({ length: 9 }, (_, i) => `/img/crow/${i}.gif`);
    assets.crowFrames = (await Promise.all(crowPaths.map(loadImage))).filter(Boolean);

    const yetiPaths = Array.from({ length: 12 }, (_, i) => `/img/character/yeti/frame${i + 1}.png`);
    assets.yetiFrames = (await Promise.all(yetiPaths.map(loadImage))).filter(Boolean);

    const firePaths = Array.from({ length: 6 }, (_, i) => `/img/fire/frame_${i}_delay-0.1s.gif`);
    assets.fireFrames = (await Promise.all(firePaths.map(loadImage))).filter(Boolean);

    assets.midSmall = await loadImage("/img/obstacles/mid.png");
    assets.iceSmall = await loadImage("/img/obstacles/icecube.png");

    const hudPaths = [
      "/img/hud/waterbucket.png",
      "/img/hud/rope.png",
      "/img/hud/torch.png",
      "/img/hud/bow.png",
      "/img/hud/heart.png",
    ];
    const [water, rope, torch, bow, heart] = await Promise.all(hudPaths.map(loadImage));
    assets.hud = { water, rope, torch, bow, heart };
  }

  // ---------- Utils ----------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function isLarge(t) { return t === "canyon" || t === "mountain" || t === "cave" || t === "hunger"; }
  function territoryIndex(t) { return t === "start" ? 0 : t === "mid" ? 1 : 2; }
  function nextTerritory(t) { return t === "start" ? "mid" : t === "mid" ? "last" : "start"; }
  function sprinting() { return input.down.has("Shift") && (input.down.has("w") || input.down.has("W")); }

  function mulberry32(seed) {
    return function () {
      let s = (seed += 0x6d2b79f5);
      s = Math.imul(s ^ (s >>> 15), s | 1);
      s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
      return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
    };
  }

  function groundY() {
    const h = canvas.height / dpr;
    return Math.max(0, h - 4);
  }

  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 1500);
  }

  // ---------- Game control ----------
  function changeTerritory(next, withSmoke = true) {
    if (next === territory) return;
    bgFade.active = true; bgFade.t = 0;
    bgFade.fromIdx = territoryIndex(territory);
    bgFade.toIdx = territoryIndex(next);
    territory = next;
    if (territoryNameEl) territoryNameEl.textContent = territory;
    territoryStartedAt = state.elapsed;
    if (withSmoke) spawnSmokeBurst();
    processedDecisions.clear();
    toast(`→ ${territory === "start" ? "Fire" : territory === "mid" ? "Middle" : "Ice"}`);
  }

  function spawnSmokeBurst() {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    for (let i = 0; i < 150; i++) {
      const ang = rng() * Math.PI * 2;
      const sp = 1.2 + rng() * 2.8;
      particles.push({
        x: w * 0.5 + (rng() - 0.5) * 90,
        y: h * 0.5 + (rng() - 0.5) * 70,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp * 0.65,
        life: 0,
        max: 1.0 + rng() * 0.9,
        kind: "smoke",
      });
    }
  }

  function resetGame() {
    decisionOpen = false;
    hardFreeze = false;

    state.t = 0; state.elapsed = 0; state.alive = true;
    state.distance = 0; state.health = 100;
    state.waterBuckets = 3;
    state.items = new Set(["water", "rope", "torch", "bow"]);
    state.nextId = 1; state.spawnSmall = 2.2; state.spawnLarge = 5.0;
    state.darknessBase = 0.12; state.darknessSurge = 0;

    obstacles.length = 0;
    particles.length = 0;
    arrows.length = 0;
    glitchEffects.length = 0;
    decisionCtx = null;
    processedDecisions.clear();

    player.vy = 0; player.vx = 0; player.onGround = true; player.coyote = 0;
    player.jumping = false; player.jumpTime = 0; player.landingRecovery = 0;
    player.airTime = 0; player.groundFrames = 0;
    player.x = 220; player.y = groundY(); player.yPrev = player.y;

    activeItem = "bow";
    paused = false;
    animTime = 0;

    territory = "start";
    if (territoryNameEl) territoryNameEl.textContent = territory;
    territoryStartedAt = 0;

    surge.nextAt = 8; surge.endAt = 0; surge.active = false;

    renderHUD();
    toast("Game Start - Good Luck!");
  }

  // ---------- UI ----------
  function renderHotbar() {
    if (!hotbarEl) return;
    hotbarEl.innerHTML = "";
    const order = ["water", "rope", "torch", "bow"];
    const icon = { water: assets.hud.water, rope: assets.hud.rope, torch: assets.hud.torch, bow: assets.hud.bow };
    order.forEach((k, i) => {
      const owned = state.items.has(k);
      const el = document.createElement("div");
      el.className = "slot" + (activeItem === k ? " active" : "") + (owned ? "" : " dim");
      const num = document.createElement("div");
      num.className = "num"; num.textContent = String(i + 1);
      el.appendChild(num);
      const img = document.createElement("img");
      img.alt = k; if (icon[k]) img.src = icon[k].src;
      el.appendChild(img);
      if (k === "water") {
        const badge = document.createElement("div");
        badge.className = "badge"; badge.textContent = String(state.waterBuckets);
        el.appendChild(badge);
      }
      if (!owned) el.style.opacity = "0.4";
      hotbarEl.appendChild(el);
    });
  }

  function renderHearts() {
    if (!heartsEl || !assets.hud.heart) return;
    heartsEl.innerHTML = "";
    const heartSrc = assets.hud.heart.src;
    let hp = clamp(state.health, 0, 100);
    for (let i = 0; i < HEARTS_TOTAL; i++) {
      const wrap = document.createElement("div"); wrap.className = "heart";
      const empty = document.createElement("img"); empty.className = "empty"; empty.src = heartSrc; empty.alt = "heart-empty";
      const filled = document.createElement("img"); filled.className = "fill"; filled.src = heartSrc; filled.alt = "heart-filled";
      const thisHP = clamp(hp, 0, HP_PER_HEART);
      const pct = (thisHP / HP_PER_HEART) * 100;
      filled.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
      wrap.appendChild(empty); wrap.appendChild(filled);
      heartsEl.appendChild(wrap);
      hp -= HP_PER_HEART;
    }
  }

  function renderHUD() {
    if (progressEl) {
      const timeProgress = clamp(state.elapsed / TOTAL_TIME, 0, 1);
      progressEl.style.width = `${(timeProgress * 100).toFixed(2)}%`;
    }
    renderHotbar();
    renderHearts();
  }

  // ---------- Decisions ----------
  function openDecision(kind, obstacle) {
    if (processedDecisions.has(obstacle.id)) return;
    decisionCtx = { kind, obstacle };
    hardFreeze = true; input.clearAll(); decisionOpen = true;
    processedDecisions.add(obstacle.id);

    if (modalRoot) {
      modalRoot.classList.remove("hidden");
      modalRoot.setAttribute("aria-hidden", "false");
    }

    if (kind === "smallFire") {
      if (modalTitle) modalTitle.textContent = "Fire Obstacle Ahead!";
      if (modalText) modalText.innerHTML = `A fire obstacle blocks your path.<br><b>Use Water Bucket</b> to extinguish, or <b>Push Through</b> (−½ heart).`;
      if (modalPrimary) modalPrimary.textContent = "Use Water Bucket";
      if (modalAlt) modalAlt.textContent = "Push Through";
      if (modalHint) modalHint.textContent = state.waterBuckets > 0 ? `${state.waterBuckets} water buckets remaining` : "No water buckets left!";
      if (modalPrimary) modalPrimary.disabled = state.waterBuckets <= 0;
    } else {
      if (modalTitle) modalTitle.textContent = `${String(obstacle.type).toUpperCase()} Blocks Your Path!`;
      if (territory === "last") {
        if (modalText) modalText.textContent = "Ice Territory: Use your rope to trap the Yeti or push through taking damage.";
        if (modalPrimary) modalPrimary.textContent = "Use Rope";
        if (modalAlt) modalAlt.textContent = "Push Through (-25 HP)";
        if (modalHint) modalHint.textContent = "Rope is effective against Yetis in Ice Territory";
        if (modalPrimary) modalPrimary.disabled = !state.items.has("rope");
      } else {
        if (modalText) modalText.textContent = "Choose your approach: Shoot with your bow or push through taking damage.";
        if (modalPrimary) modalPrimary.textContent = "Shoot Bow (F)";
        if (modalAlt) modalAlt.textContent = "Push Through (-25 HP)";
        if (modalHint) modalHint.textContent = "Bow available in Fire & Middle territories";
        if (modalPrimary) modalPrimary.disabled = !state.items.has("bow");
      }
    }
  }

  function closeDecision() {
    if (modalRoot) {
      modalRoot.classList.add("hidden");
      modalRoot.setAttribute("aria-hidden", "true");
    }
    decisionOpen = false;
    hardFreeze = false;
    decisionCtx = null;
    renderHUD();
  }

  function resolveDecision(which) {
    const ctx = decisionCtx;
    if (!ctx) return;
    const obs = ctx.obstacle;

    if (ctx.kind === "smallFire") {
      if (which === "primary") {
        if (state.waterBuckets > 0) {
          state.waterBuckets -= 1;
          toast(`Water bucket used! ${state.waterBuckets} remaining`);
          removeObstacle(obs);
        } else {
          toast("No water buckets available!");
          return;
        }
      } else {
        state.health = Math.max(0, state.health - SMALL_HIT);
        toast("Pushed through fire (-½ heart)");
        removeObstacle(obs);
      }
      closeDecision();
      return;
    }

    if (which === "primary") {
      if (territory === "last" && activeItem === "rope" && state.items.has("rope")) {
        const gy = groundY();
        const lift = OBSTACLE_LIFT + MIDDLE_LARGE_EXTRA_LIFT;
        const drawH = Math.max(player.h * 1.35, (obs.h || 120) * 1.25);
        const drawY = gy - lift - drawH;
        spawnGlitchEffect(obs.x, drawY, obs.w * 1.5, drawH);
        toast("Rope trap successful! Yeti vanished!");
        removeObstacle(obs);
        closeDecision();
        return;
      } else if (territory !== "last" && activeItem === "bow" && state.items.has("bow")) {
        shootArrow(obs.id);
        closeDecision();
        return;
      } else {
        state.health = Math.max(0, state.health - BIG_HIT);
        toast("Pushed through obstacle (-25 HP)");
      }
    } else {
      state.health = Math.max(0, state.health - BIG_HIT);
      toast("Pushed through obstacle (-25 HP)");
    }
    removeObstacle(obs);
    closeDecision();
  }

  if (modalPrimary) modalPrimary.addEventListener("click", () => resolveDecision("primary"));
  if (modalAlt) modalAlt.addEventListener("click", () => resolveDecision("alt"));

  // ---------- Input ----------
  window.addEventListener("keydown", (e) => {
    const keys = [" ", "ArrowUp", "w", "W", "Shift", "1", "2", "3", "4", "f", "F", "p", "P", "r", "R"];
    if (keys.includes(e.key)) e.preventDefault();
    input.press(e.key);

    if (e.key === "p" || e.key === "P") {
      paused = !paused;
      if (pauseBtn) pauseBtn.textContent = (paused ? "Resume" : "Pause") + " (P)";
    }

    if ((e.key === "r" || e.key === "R")) {
      resetGame();
    }

    if (e.key >= "1" && e.key <= "4") {
      const idx = parseInt(e.key, 10) - 1;
      const mapping = ["water", "rope", "torch", "bow"];
      const chosen = mapping[idx];
      if (!chosen) return;
      activeItem = (activeItem === chosen ? null : chosen) || chosen;
      if (!state.items.has(chosen)) toast(`No ${ITEM_LABEL[chosen]} available`);
      else {
        if (chosen === "water") toast(`${ITEM_LABEL[chosen]} selected (${state.waterBuckets} remaining)`);
        else toast(`${ITEM_LABEL[chosen]} selected (${e.key})`);
      }
      renderHotbar();
    }

    if ((e.key === "f" || e.key === "F") && !hardFreeze && !paused) {
      if (activeItem === "bow" && territory !== "last") shootArrow();
    }
  });
  window.addEventListener("keyup", (e) => input.release(e.key));

  if (pauseBtn) {
    pauseBtn.addEventListener("click", () => {
      paused = !paused; pauseBtn.textContent = (paused ? "Resume" : "Pause") + " (P)";
    });
  }
  if (territoryBtn) {
    territoryBtn.addEventListener("click", () => {
      changeTerritory(nextTerritory(territory), true);
    });
  }
  if (restartBtn) restartBtn.addEventListener("click", resetGame);

  // ---------- Arrows ----------
  function shootArrow(targetId) {
    if (territory === "last") { toast("Bow frozen in Ice Territory!"); return; }
    if (activeItem !== "bow" || !state.items.has("bow")) { toast("Bow not selected"); return; }

    const sx = player.x + player.w * 0.75;
    const sy = player.y - player.h * 0.55;

    const speed = 35;
    const angle = FIXED_ARROW_ANGLE;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed;

    arrows.push({ x: sx, y: sy, vx, vy, life: 0, max: 1.2, radius: 4, targetId });
    toast("Arrow fired!");
  }

  // ---------- Particles / Glitch ----------
  function spawnDust(x, y) {
    for (let i = 0; i < 18; i++) {
      particles.push({
        x: x + (rng() - 0.5) * 25,
        y: y + (rng() - 0.5) * 12,
        vx: (rng() - 0.5) * 3.0,
        vy: -Math.random() * 3.2 - 1.2,
        life: 0,
        max: 0.7 + Math.random() * 0.7,
        kind: "dust",
      });
    }
  }
  function spawnTrail(x, y) {
    particles.push({ x, y, vx: -3.8 - Math.random() * 1.8, vy: (rng() - 0.5) * 1.3, life: 0, max: 0.35 + Math.random() * 0.35, kind: "trail" });
  }
  function spawnSnow() {
    if (territory !== "last") return;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    if (Math.random() < 0.7) {
      particles.push({
        x: Math.random() * w,
        y: Math.random() * (h - 60),
        vx: -0.45 - Math.random() * 0.45,
        vy: 0.4 + Math.random() * 0.4,
        life: 0,
        max: 2.4 + Math.random() * 0.6,
        kind: "snow",
      });
    }
  }
  function spawnGlitchEffect(x, y, w, h) {
    for (let i = 0; i < 25; i++) {
      glitchEffects.push({
        x: x + rng() * w,
        y: y + rng() * h,
        vx: (rng() - 0.5) * 8,
        vy: (rng() - 0.5) * 8,
        life: 0,
        max: 0.8 + rng() * 0.4,
        width: 2 + rng() * 8,
        height: 2 + rng() * 8,
        color: `hsl(${180 + rng() * 60}, 70%, ${50 + rng() * 40}%)`
      });
    }
  }

  // ---------- Obstacles ----------
  function removeObstacle(o) {
    const idx = obstacles.indexOf(o);
    if (idx >= 0) obstacles.splice(idx, 1);
  }

  // ---------- Resize ----------
  function resize() {
    dpr = window.devicePixelRatio || 1;
    const vw = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const vh = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    canvas.width = Math.floor(vw * dpr);
    canvas.height = Math.floor(vh * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    player.y = groundY();
    player.yPrev = player.y;
  }
  window.addEventListener("resize", resize);

  // ---------- Game Loop ----------
  let acc = 0;
  let last = performance.now();

  function scrollSpeed() {
    const sprintBoost = sprinting() ? 0.45 : 0;
    return state.baseSpeed + sprintBoost;
  }

  function spawn(dt) {
    if (hardFreeze || paused) return;
    state.spawnSmall -= dt;
    state.spawnLarge -= dt;

    const w = canvas.width / dpr;

    if (state.spawnSmall <= 0) {
      const def = SMALL_DEFS[(rng() * SMALL_DEFS.length) | 0];
      const x = w + (def.gap[0] + rng() * (def.gap[1] - def.gap[0]));
      obstacles.push({ type: def.type, x, w: def.w, h: def.h, id: state.nextId++ });
      state.spawnSmall = 2.0 + rng() * 1.4;
    }
    if (state.spawnLarge <= 0) {
      const def = LARGE_DEFS[(rng() * LARGE_DEFS.length) | 0];
      const x = w + (def.gap[0] + rng() * (def.gap[1] - def.gap[0]));
      obstacles.push({ type: def.type, x, w: def.w, h: def.h, id: state.nextId++ });
      state.spawnLarge = 4.5 + rng() * 2.5;
    }
  }

  function updateArrows(dt) {
    if (paused) return;
    for (let i = arrows.length - 1; i >= 0; i--) {
      const a = arrows[i];
      a.life += dt;
      a.x += a.vx;
      a.y += a.vy;
      a.vy += 0.24;

      if (a.life >= a.max) { arrows.splice(i, 1); continue; }

      if (territory !== "last") {
        for (let j = 0; j < obstacles.length; j++) {
          const o = obstacles[j];
          if (!isLarge(o.type)) continue;
          if (o.type === "canyon") continue;

          const gy = groundY();
          const extraLift = territory === "mid" ? MIDDLE_LARGE_EXTRA_LIFT : 0;
          const lift = OBSTACLE_LIFT + extraLift;

          let oy = gy - o.h - lift;
          let ow = o.w;
          let oh = o.h;

          if (o.type === "hunger") { ow = 24; oh = 30; oy = gy - oh - lift; }

          const r = a.radius;
          const hit = a.x + r > o.x && a.x - r < o.x + ow && a.y + r > oy && a.y - r < oy + oh;
          if (hit) {
            if (!a.targetId || a.targetId === o.id) {
              obstacles.splice(j, 1);
              arrows.splice(i, 1);
              toast("Direct hit! Obstacle destroyed!");
              for (let k = 0; k < 10; k++) {
                particles.push({ x: a.x, y: a.y, vx: (rng() - 0.5) * 5, vy: (rng() - 0.5) * 5, life: 0, max: 0.6, kind: "dust" });
              }
            }
            break;
          }
        }
      }
    }
  }

  function updateGlitchEffects(dt) {
    for (let i = glitchEffects.length - 1; i >= 0; i--) {
      const g = glitchEffects[i];
      g.life += dt;
      g.x += g.vx;
      g.y += g.vy;
      g.vx *= 0.96;
      g.vy *= 0.96;
      if (g.life >= g.max) glitchEffects.splice(i, 1);
    }
  }

  function checkLargeObstacleDecision(o) {
    const px = player.x + player.w / 2;
    const spd = scrollSpeed();
    const obstacleCenter = o.x + o.w / 2;
    const distanceToObstacle = obstacleCenter - px;
    const triggerDistance = 110 + spd * 5;
    if (distanceToObstacle > 0 && distanceToObstacle <= triggerDistance && !hardFreeze && !decisionOpen) {
      openDecision("large", o);
    }
  }

  function checkSmallObstacleCollision(o) {
    const px = player.x, py = player.y;
    const pw = player.w, ph = player.h;
    const FEET_PORTION = 0.3;
    const HORIZ_PAD = 14;
    const feetTop = py - ph * FEET_PORTION;
    const pLeft = px + HORIZ_PAD;
    const pRight = px + pw - HORIZ_PAD;

    const gyNow = groundY();
    const lift = OBSTACLE_LIFT;
    const ox = o.x;
    const topY = gyNow - o.h - lift;
    const ow = o.w, oh = o.h;

    const overlapHoriz = pLeft < ox + ow && pRight > ox;
    const prevBottom = player.yPrev;
    const falling = player.vy > 0;
    const crossedTop = prevBottom <= topY && py >= topY;

    if (overlapHoriz && falling && crossedTop && player.y - topY < 10) {
      player.y = topY;
      player.vy = 0;
      player.onGround = true;
      player.jumping = false;
      player.jumpTime = 0;
      player.landingRecovery = 0.06;
      player.groundFrames = 0;
      spawnDust(player.x + pw / 2, topY);
      return "landed";
    }

    const overlapFeet = feetTop < topY + oh && py > topY;
    const actualCollision = overlapHoriz && overlapFeet;

    if (actualCollision) {
      const playerCenter = px + pw / 2;
      const obstacleCenter = ox + ow / 2;
      const centerDistance = Math.abs(playerCenter - obstacleCenter);

      if (centerDistance < 35) {
        if (territory === "start") {
          return "decision";
        } else {
          state.health = Math.max(0, state.health - SMALL_HIT);
          toast("Hit by obstacle (-½ heart)");
          removeObstacle(o);
          return "damage";
        }
      }
    }
    return "none";
  }

  function update(dt) {
    if (!state.alive || decisionOpen || paused || hardFreeze) return;

    // Auto rotate territory
    if (state.elapsed - territoryStartedAt >= AUTO_ROTATE_SECS) {
      changeTerritory(nextTerritory(territory), true);
    }

    state.t++;
    state.elapsed += dt;
    input.poll(dt);

    // Darkness (not in Fire)
    if (territory !== "start") {
      if (!surge.active && state.elapsed >= surge.nextAt) {
        surge.active = true;
        surge.endAt = state.elapsed + (8 + Math.random() * 4);
        surge.nextAt = surge.endAt + (25 + Math.random() * 15);
      } else if (surge.active && state.elapsed >= surge.endAt) {
        surge.active = false;
      }
      state.darknessSurge = surge.active ? 0.45 : 0;
      const dayNight = (Math.sin(state.elapsed / 12) + 1) / 2;
      state.darknessBase = 0.12 + dayNight * 0.16;
    } else {
      state.darknessBase = 0; state.darknessSurge = 0;
    }

    const gy = groundY();

    if (player.landingRecovery > 0) player.landingRecovery = Math.max(0, player.landingRecovery - dt);

    if (player.onGround) { player.groundFrames++; player.airTime = 0; }
    else { player.groundFrames = 0; player.airTime += dt; }

    const wasOnGround = player.onGround;
    player.onGround = player.y >= gy - PHYS.groundEps;

    if (player.onGround) {
      player.coyote = PHYS.coyoteTime;
      if (!wasOnGround) { player.landingRecovery = 0.08; spawnDust(player.x + player.w / 2, gy); }
    } else {
      player.coyote = Math.max(0, player.coyote - dt);
    }

    const wantsJump = input.pressed.has(" ") || input.pressed.has("ArrowUp") || input.pressed.has("w") || input.pressed.has("W") || input.bufferJump > 0;
    const canJump = (player.onGround || player.coyote > 0) && player.landingRecovery <= 0 && player.groundFrames >= 2;

    if (wantsJump && canJump) {
      player.vy = -(PHYS.jumpVel * dt);
      player.onGround = false; player.jumping = true;
      player.jumpTime = 0; player.airTime = 0; player.groundFrames = 0;
      input.bufferJump = 0; player.coyote = 0;
    }

    const holdingJump = input.down.has(" ") || input.down.has("ArrowUp") || input.down.has("w") || input.down.has("W");
    player.yPrev = player.y;

    if (!player.onGround) {
      player.jumpTime += dt;
      const vyAbsPerSec = Math.abs(player.vy / dt);
      const nearApex = vyAbsPerSec < PHYS.apexThreshold;
      const inSustain = player.jumping && holdingJump && player.jumpTime <= PHYS.sustainTime;

      let g = PHYS.gravity;
      if (inSustain) g = PHYS.sustainGravity; else if (nearApex) g = PHYS.gravity * PHYS.apexAssist;

      player.vy += (g * dt) * dt;

      if (player.jumping && !holdingJump && player.vy < -(PHYS.jumpCutVel * dt)) {
        player.vy = -(PHYS.jumpCutVel * dt);
        player.jumping = false;
      }

      const termPerFrame = PHYS.terminalVy * dt;
      player.vy = clamp(player.vy * PHYS.airDrag, -99999, termPerFrame);

      const targetXAir = 242;
      const airLerp = nearApex ? 0.22 : (player.airTime > 0.3 ? 0.18 : 0.15);
      player.x += (targetXAir - player.x) * airLerp;
    } else {
      const targetXGround = 220;
      const groundLerp = player.groundFrames < 10 ? 0.35 : 0.3;
      player.x += (targetXGround - player.x) * groundLerp;
      player.vy = 0; player.jumping = false; player.jumpTime = 0;
    }

    player.y += player.vy;
    if (player.y >= gy) { player.y = gy; player.vy = 0; player.onGround = true; player.jumping = false; player.jumpTime = 0; }

    if (sprinting() && Math.random() < 0.35) spawnTrail(player.x - 8, player.y - 20);

    const spd = scrollSpeed();
    state.distance += spd / 8.0;

    for (const o of obstacles) {
      let factor = 1;
      if (territory === "last" && isLarge(o.type) && o.type !== "canyon") factor = 0.72;
      o.x -= spd * factor;
    }
    bgScroll -= spd * 0.7;

    animTime += (spd * 0.065 + 1.05) * dt;

    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];

      if (o.x + o.w < -120) { obstacles.splice(i, 1); i--; continue; }

      const isLargeObs = isLarge(o.type);

      if (isLargeObs) {
        checkLargeObstacleDecision(o);
      } else {
        const result = checkSmallObstacleCollision(o);
        if (result === "landed" || result === "damage") {
          if (result === "damage") i--;
          continue;
        } else if (result === "decision") {
          openDecision("smallFire", o);
          break;
        }
      }
    }

    spawn(dt);
    updateArrows(dt);
    updateGlitchEffects(dt);

    // End conditions → STOP simulation (no ending screen/background)
    if (state.health <= 0 || state.elapsed >= TOTAL_TIME) {
      state.alive = false;
      hardFreeze = true;         // freeze the game on the current scene
      toast("Run finished. Press R to restart.");
    }

    if (bgFade.active) {
      bgFade.t = Math.min(bgFade.t + dt, bgFade.dur);
      if (bgFade.t >= bgFade.dur) bgFade.active = false;
    }

    renderHUD();
  }

  // ---------- Drawing ----------
  function draw() {
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    const gy = groundY();

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    function drawBg(img, alpha) {
      if (!img) return;
      ctx.globalAlpha = alpha;
      const scale = Math.max(w / (img.width || w), h / (img.height || h));
      const dw = (img.width || w) * scale;
      const dh = (img.height || h) * scale;
      const scrollX = (bgScroll % dw) - dw;
      for (let x = scrollX; x < w + dw; x += dw) {
        ctx.drawImage(img, x, 0, dw, dh);
      }
      ctx.globalAlpha = 1;
    }

    // background (no ending bg ever)
    const curIdx = territoryIndex(territory);
    const from = bgFade.active ? assets.territoryImgs[bgFade.fromIdx] : assets.territoryImgs[curIdx];
    const to = assets.territoryImgs[bgFade.toIdx];

    if (bgFade.active) {
      const t = bgFade.t / bgFade.dur;
      drawBg(from, 1 - t);
      drawBg(to, t);
    } else {
      drawBg(assets.territoryImgs[curIdx], 1);
      if (!assets.territoryImgs[curIdx]) {
        ctx.fillStyle = "#1a1a1a";
        ctx.fillRect(0, 0, w, h);
      }
    }

    // ground line
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, gy + 1);
    ctx.lineTo(w, gy + 1);
    ctx.stroke();

    // Obstacles
    for (const o of obstacles) {
      const isLargeObs = isLarge(o.type);
      const isCanyon = isLargeObs && o.type === "canyon";
      const middleLift = (territory === "mid" && isLargeObs && !isCanyon) ? MIDDLE_LARGE_EXTRA_LIFT : 0;
      const lift = OBSTACLE_LIFT + middleLift;
      const ox = o.x;
      const gyNow = groundY();
      const oyBase = gyNow - lift;

      if (isLargeObs) {
        if (isCanyon) {
          const pitTop = gyNow - OBSTACLE_LIFT;
          ctx.clearRect(ox, pitTop, o.w, h - pitTop);
          ctx.fillStyle = "#0a0a0a";
          ctx.fillRect(ox - 2, pitTop, 2, 15);
          ctx.fillRect(ox + o.w, pitTop, 2, 15);
          continue;
        }

        if (territory === "last") {
          const baseW = o.w || 120, baseH = o.h || 120;
          const drawH = Math.max(player.h * 1.35, baseH * 1.25);
          const aspect = baseW / baseH || 1;
          const drawW = drawH * aspect;

          if (assets.yetiFrames.length) {
            const idx = Math.floor((animTime * 14) % assets.yetiFrames.length);
            const img = assets.yetiFrames[idx];
            ctx.drawImage(img, ox, oyBase - drawH, drawW, drawH);
          } else {
            ctx.fillStyle = "#bcd";
            ctx.fillRect(ox, oyBase - drawH, drawW, drawH);
          }
        } else {
          const middleScale = territory === "mid" ? 1.4 : 1.0;
          const extraRaise = territory === "mid" ? 20 : 0;
          const drawW = o.w * middleScale;
          const drawH = o.h * middleScale;
          const drawY = oyBase - drawH - extraRaise;

          if (assets.crowFrames.length > 0) {
            const frameIdx = Math.floor((animTime * 10) % assets.crowFrames.length);
            const crowImg = assets.crowFrames[frameIdx];
            if (crowImg) ctx.drawImage(crowImg, ox, drawY, drawW, drawH);
            else { ctx.fillStyle = "#333"; ctx.fillRect(ox, drawY, drawW, drawH); }
          } else {
            ctx.fillStyle = "#333"; ctx.fillRect(ox, drawY, drawW, drawH);
          }
        }
      } else {
        if (territory === "start") {
          if (assets.fireFrames.length > 0) {
            const fireIdx = Math.floor((animTime * 12) % assets.fireFrames.length);
            const fireImg = assets.fireFrames[fireIdx];
            if (fireImg) ctx.drawImage(fireImg, ox, oyBase - o.h, o.w, o.h);
            else { ctx.fillStyle = "#ff4400"; ctx.fillRect(ox, oyBase - o.h, o.w, o.h); }
          } else {
            ctx.fillStyle = "#ff4400"; ctx.fillRect(ox, oyBase - o.h, o.w, o.h);
          }
        } else if (territory === "mid") {
          const img = assets.midSmall;
          if (img) ctx.drawImage(img, ox, oyBase - o.h, o.w, o.h);
          else { ctx.fillStyle = "#666"; ctx.fillRect(ox, oyBase - o.h, o.w, o.h); }
        } else {
          const img = assets.iceSmall;
          if (img) ctx.drawImage(img, ox, oyBase - o.h, o.w, o.h);
          else { ctx.fillStyle = "#aaf"; ctx.fillRect(ox, oyBase - o.h, o.w, o.h); }
        }
      }
    }

    // player
    const px = player.x, py = player.y;
    if (assets.spriteFrames.length >= 6) {
      const cycle = Math.abs(Math.sin(animTime * 1.15)) * 5.999;
      const frameIndex = Math.floor(cycle) % 6;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(assets.spriteFrames[frameIndex], px, py - player.h, player.w, player.h);
    } else {
      ctx.fillStyle = "#fff";
      ctx.fillRect(px, py - player.h, player.w, player.h);
    }

    // arrows
    for (const a of arrows) {
      ctx.fillStyle = "#fff";
      ctx.beginPath(); ctx.arc(a.x, a.y, a.radius, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.8; ctx.fillRect(a.x - a.vx * 0.8, a.y - a.vy * 0.8, 5, 2);
      ctx.globalAlpha = 0.5; ctx.fillRect(a.x - a.vx * 1.3, a.y - a.vy * 1.3, 4, 2);
      ctx.globalAlpha = 0.2; ctx.fillRect(a.x - a.vx * 1.8, a.y - a.vy * 1.8, 3, 1);
      ctx.globalAlpha = 1;
    }

    // glitch effects
    for (const g of glitchEffects) {
      const alpha = Math.max(0, 1 - g.life / g.max);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g.color;
      ctx.fillRect(g.x, g.y, g.width, g.height);
      if (Math.random() < 0.3) {
        ctx.globalAlpha = alpha * 0.5;
        ctx.fillRect(g.x + (rng() - 0.5) * 4, g.y + (rng() - 0.5) * 4, g.width * 0.8, g.height * 0.8);
      }
      ctx.globalAlpha = 1;
    }

    // particles
    spawnSnow();
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.life += FIXED_DT; p.x += p.vx; p.y += p.vy;
      if (p.life >= p.max) { particles.splice(i, 1); continue; }
      if (p.kind === "smoke") {
        p.vy -= 0.035; p.vx *= 0.994;
        const al = 0.7 * (1 - p.life / p.max);
        ctx.globalAlpha = al;
        ctx.fillStyle = "#1a1a1a";
        ctx.beginPath(); ctx.arc(p.x, p.y, 22 * (0.2 + p.life / p.max), 0, Math.PI * 2); ctx.fill();
        ctx.globalAlpha = 1;
      } else if (p.kind === "snow") {
        ctx.globalAlpha = 0.92 * (1 - p.life / p.max);
        ctx.fillStyle = "#fff"; ctx.fillRect(p.x, p.y, 2, 2);
        ctx.globalAlpha = 1;
      } else if (p.kind === "dust") {
        p.vy += 0.05;
        const al = 1 - p.life / p.max;
        ctx.globalAlpha = al;
        ctx.fillStyle = "#e5e5e5"; ctx.fillRect(p.x, p.y, 3, 3);
        ctx.globalAlpha = 1;
      } else {
        const al = 1 - p.life / p.max;
        ctx.globalAlpha = al;
        ctx.fillStyle = "#fff"; ctx.fillRect(p.x, p.y, 2, 2);
        ctx.globalAlpha = 1;
      }
    }

    // darkness & torch
    const darkness = territory === "start" ? 0 : clamp(state.darknessBase + state.darknessSurge, 0, 0.7);
    if (darkness > 0.01) {
      ctx.fillStyle = `rgba(0,0,0,${darkness})`;
      ctx.fillRect(0, 0, w, h);

      if (activeItem === "torch" && state.items.has("torch")) {
        const cx = px + player.w * 0.45;
        const cy = py - player.h * 0.55;
        const r = Math.max(190, Math.min(320, player.h * 1.4));

        ctx.save();
        ctx.globalCompositeOperation = "destination-out";
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
        grad.addColorStop(0, "rgba(0,0,0,1.0)");
        grad.addColorStop(0.75, "rgba(0,0,0,0.8)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const egrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 0.75);
        egrad.addColorStop(0, "rgba(255,250,200,0.4)");
        egrad.addColorStop(1, "rgba(255,250,200,0)");
        ctx.fillStyle = egrad;
        ctx.beginPath(); ctx.arc(cx, cy, r * 0.75, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
      }
    }

    // pause overlay
    if (paused) {
      ctx.fillStyle = "rgba(0,0,0,0.65)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#fff";
      ctx.font = "52px Arial";
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", w / 2, h / 2);
      ctx.font = "24px Arial";
      ctx.fillText("Press P to resume", w / 2, h / 2 + 40);
      ctx.textAlign = "start";
    }

    // finished overlay hint
    if (hardFreeze) {
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#fff";
      ctx.font = "32px Arial";
      ctx.textAlign = "center";
      ctx.fillText("Run finished", w / 2, h / 2 - 10);
      ctx.font = "20px Arial";
      ctx.fillText("Press R to restart", w / 2, h / 2 + 24);
      ctx.textAlign = "start";
    }
  }

  function step(now) {
    const dtSec = (now - last) / 1000;
    last = now;

    if (!hardFreeze && !paused) {
      acc += dtSec;
      let iter = 0;
      while (acc >= FIXED_DT && iter < 10) {
        update(FIXED_DT);
        acc -= FIXED_DT;
        iter++;
      }
      if (iter >= 10) acc = 0;
    } else {
      acc = 0;
    }

    draw();
    requestAnimationFrame(step);
  }

  // ---------- Initialization ----------
  (async function init() {
    resize();
    await loadAssets();
    resetGame(); // start directly in Fire gameplay
    player.y = groundY(); player.yPrev = player.y;
    renderHUD();

    last = performance.now();
    requestAnimationFrame(step);
  })();
})();
