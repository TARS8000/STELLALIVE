(() => {
  const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php";
  const CACHE_MS = 6 * 60 * 60 * 1000;
  const HFOV_DEG = 62;

  const els = {
    camera: document.getElementById("camera"),
    canvas: document.getElementById("sky"),
    gate: document.getElementById("gate"),
    start: document.getElementById("start-btn"),
    gateError: document.getElementById("gate-error"),
    hud: document.getElementById("hud-top"),
    status: document.getElementById("status-line"),
    catalog: document.getElementById("catalog"),
    compass: document.getElementById("compass"),
    heading: document.getElementById("heading-readout"),
    elev: document.getElementById("elev-readout"),
    list: document.getElementById("sat-list"),
    listEmpty: document.getElementById("list-empty"),
    visible: document.getElementById("visible-sats"),
    toast: document.getElementById("toast"),
  };

  const ctx = els.canvas.getContext("2d");
  const state = {
    observer: null,
    sats: [],
    look: { az: 0, el: 20, roll: 0 },
    hasOrientation: false,
    visible: [],
    running: false,
  };

  function toast(message) {
    els.toast.hidden = false;
    els.toast.textContent = message;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      els.toast.hidden = true;
    }, 4200);
  }

  function setStatus(text) {
    els.status.textContent = text;
  }

  function wrap360(deg) {
    return ((deg % 360) + 360) % 360;
  }

  function wrap180(deg) {
    let x = wrap360(deg);
    if (x > 180) x -= 360;
    return x;
  }

  function toRad(d) {
    return (d * Math.PI) / 180;
  }

  function toDeg(r) {
    return (r * 180) / Math.PI;
  }

  /**
   * Rear-camera look direction from DeviceOrientation.
   * Earth: X east, Y north, Z up. Device +Z is out of the screen.
   * Matrix from the W3C DeviceOrientation worked example.
   */
  function lookFromOrientation(alpha, beta, gamma) {
    const x = toRad(beta || 0);
    const y = toRad(gamma || 0);
    const z = toRad(alpha || 0);

    const cX = Math.cos(x);
    const cY = Math.cos(y);
    const cZ = Math.cos(z);
    const sX = Math.sin(x);
    const sY = Math.sin(y);
    const sZ = Math.sin(z);

    const m13 = cY * sZ * sX + cZ * sY;
    const m23 = sZ * sY - cZ * cY * sX;
    const m33 = cX * cY;

    const east = -m13;
    const north = -m23;
    const up = -m33;

    return {
      az: wrap360(toDeg(Math.atan2(east, north))),
      el: toDeg(Math.asin(Math.max(-1, Math.min(1, up)))),
      roll: gamma || 0,
    };
  }

  function projectAr(satAz, satEl, cam, width, height) {
    const hfov = toRad(HFOV_DEG);
    const aspect = width / Math.max(height, 1);
    const vfov = 2 * Math.atan(Math.tan(hfov / 2) / aspect);

    const daz = toRad(wrap180(satAz - cam.az));
    const del = toRad(satEl - cam.el);
    const meanEl = toRad((satEl + cam.el) / 2);
    let nx = (daz * Math.cos(meanEl)) / (hfov / 2);
    let ny = del / (vfov / 2);

    const roll = toRad(cam.roll || 0);
    const c = Math.cos(-roll);
    const s = Math.sin(-roll);
    const rx = nx * c - ny * s;
    const ry = nx * s + ny * c;

    return {
      x: width / 2 + rx * (width / 2),
      y: height / 2 - ry * (height / 2),
      onScreen: Math.abs(rx) < 1.2 && Math.abs(ry) < 1.2,
    };
  }

  function projectPolar(satAz, satEl, width, height) {
    const size = Math.min(width, height) * 0.72;
    const r = ((90 - satEl) / 90) * (size / 2);
    const theta = toRad(satAz);
    return {
      x: width / 2 + r * Math.sin(theta),
      y: height / 2 - r * Math.cos(theta),
    };
  }

  async function requestMotionPermission() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === "function") {
      const res = await DOE.requestPermission();
      if (res !== "granted") {
        throw new Error("モーションセンサーが拒否されました（設定から Safari のモーションを許可してください）");
      }
    }
  }

  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(label)), ms);
      }),
    ]);
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) {
      toast("カメラ非対応のため、全天マップで表示します。");
      return false;
    }
    try {
      const stream = await withTimeout(
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        }),
        4000,
        "camera-timeout"
      );
      els.camera.srcObject = stream;
      await els.camera.play();
      return true;
    } catch {
      toast("カメラを使えないため、全天マップで表示します。");
      return false;
    }
  }

  function watchLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error("位置情報が使えません"));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          state.observer = {
            lat: pos.coords.latitude,
            lon: pos.coords.longitude,
            altKm: (pos.coords.altitude || 0) / 1000,
          };
          resolve(state.observer);
          navigator.geolocation.watchPosition(
            (p) => {
              state.observer = {
                lat: p.coords.latitude,
                lon: p.coords.longitude,
                altKm: (p.coords.altitude || 0) / 1000,
              };
            },
            () => {},
            { enableHighAccuracy: true, maximumAge: 10000 }
          );
        },
        () => reject(new Error("位置情報の許可が必要です")),
        { enableHighAccuracy: true, timeout: 15000 }
      );
    });
  }

  async function loadCatalog(group) {
    const key = `stellalive-gp-${group}`;
    try {
      const cached = JSON.parse(localStorage.getItem(key) || "null");
      if (cached && Date.now() - cached.at < CACHE_MS && cached.records?.length) {
        return cached.records;
      }
    } catch {
      /* ignore */
    }

    const url = `${CELESTRAK}?GROUP=${encodeURIComponent(group)}&FORMAT=JSON`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`CelesTrak 取得失敗 (${res.status})`);
    const records = await res.json();
    if (!Array.isArray(records) || !records.length) {
      throw new Error("CelesTrak から衛星データが返りませんでした");
    }
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), records }));
    return records;
  }

  function tleChecksum(line) {
    let sum = 0;
    for (let i = 0; i < 68; i++) {
      const c = line[i] || " ";
      if (c === "-") sum += 1;
      else if (c >= "0" && c <= "9") sum += Number(c);
    }
    return String(sum % 10);
  }

  function tleScientific(val) {
    if (!val) return " 00000-0";
    const sign = val < 0 ? "-" : " ";
    const av = Math.abs(val);
    let exp = Math.floor(Math.log10(av)) + 1;
    let digits = Math.round((av / 10 ** exp) * 1e5);
    if (digits === 100000) {
      digits = 10000;
      exp += 1;
    }
    const expSign = exp < 0 ? "-" : "+";
    return `${sign}${String(digits).padStart(5, "0")}${expSign}${Math.abs(exp)}`;
  }

  function intlDesignator(objectId) {
    if (!objectId || !/^\d{4}-\d{3}/.test(objectId)) return "        ";
    const year = objectId.slice(2, 4);
    const rest = objectId.slice(5).replace("-", "");
    return (year + rest).padEnd(8, " ");
  }

  function epochToTle(epoch) {
    const d = new Date(epoch.endsWith("Z") ? epoch : `${epoch}Z`);
    const year = d.getUTCFullYear();
    const start = Date.UTC(year, 0, 1, 0, 0, 0);
    const doy = (d.getTime() - start) / 86400000 + 1;
    const yy = String(year % 100).padStart(2, "0");
    const frac = doy.toFixed(8);
    const [whole, dec] = frac.split(".");
    return `${yy}${whole.padStart(3, "0")}.${dec}`;
  }

  function jsonToTle(rec) {
    const cat = String(rec.NORAD_CAT_ID ?? 0).padStart(5, "0").slice(-5);
    const cls = rec.CLASSIFICATION_TYPE || "U";
    const nDot = rec.MEAN_MOTION_DOT || 0;
    const nDotStr =
      (nDot < 0 ? "-" : " ") + Math.abs(nDot).toFixed(8).replace(/^0/, "").padEnd(9, "0").slice(0, 9);
    const l1body = [
      "1 ",
      cat,
      cls,
      " ",
      intlDesignator(rec.OBJECT_ID),
      " ",
      epochToTle(rec.EPOCH),
      " ",
      nDotStr,
      " ",
      tleScientific(rec.MEAN_MOTION_DDOT || 0),
      " ",
      tleScientific(rec.BSTAR || 0),
      " ",
      String(rec.EPHEMERIS_TYPE ?? 0),
      " ",
      String(rec.ELEMENT_SET_NO ?? 999).padStart(4, " "),
    ].join("");
    const line1 = l1body.padEnd(68, " ") + tleChecksum(l1body.padEnd(68, " "));

    const ecc = Math.abs(rec.ECCENTRICITY || 0)
      .toFixed(7)
      .replace(/^0\./, "")
      .slice(0, 7);
    const mm = (rec.MEAN_MOTION || 0).toFixed(8).padStart(11, " ");
    const rev = String(rec.REV_AT_EPOCH ?? 0).padStart(5, " ");
    const l2body = [
      "2 ",
      cat,
      " ",
      (rec.INCLINATION || 0).toFixed(4).padStart(8, " "),
      " ",
      (rec.RA_OF_ASC_NODE || 0).toFixed(4).padStart(8, " "),
      " ",
      ecc.padStart(7, "0"),
      " ",
      (rec.ARG_OF_PERICENTER || 0).toFixed(4).padStart(8, " "),
      " ",
      (rec.MEAN_ANOMALY || 0).toFixed(4).padStart(8, " "),
      " ",
      mm,
      rev,
    ].join("");
    const line2 = l2body.padEnd(68, " ") + tleChecksum(l2body.padEnd(68, " "));
    return { line1, line2 };
  }

  function recordsToSats(records) {
    if (typeof satellite === "undefined") {
      throw new Error("satellite.js が読み込めませんでした");
    }
    const sats = [];
    for (const rec of records) {
      try {
        let line1 = rec.TLE_LINE1;
        let line2 = rec.TLE_LINE2;
        if (!line1 || !line2) {
          const tle = jsonToTle(rec);
          line1 = tle.line1;
          line2 = tle.line2;
        }
        const satrec = satellite.twoline2satrec(line1, line2);
        if (satrec.error) continue;
        sats.push({
          name: rec.OBJECT_NAME || rec.NAME || "UNKNOWN",
          id: rec.NORAD_CAT_ID,
          satrec,
        });
      } catch {
        /* skip */
      }
    }
    return sats;
  }

  function computeVisible() {
    if (!state.observer || !state.sats.length || typeof satellite === "undefined") {
      state.visible = [];
      return;
    }
    const now = new Date();
    const gmst = satellite.gstime(now);
    const observerGd = {
      longitude: satellite.degreesToRadians(state.observer.lon),
      latitude: satellite.degreesToRadians(state.observer.lat),
      height: state.observer.altKm,
    };

    const visible = [];
    for (const sat of state.sats) {
      const pv = satellite.propagate(sat.satrec, now);
      if (!pv.position) continue;
      const ecf = satellite.eciToEcf(pv.position, gmst);
      const look = satellite.ecfToLookAngles(observerGd, ecf);
      const el = toDeg(look.elevation);
      if (el < 0) continue;
      visible.push({
        name: sat.name,
        id: sat.id,
        az: wrap360(toDeg(look.azimuth)),
        el,
        rangeKm: look.rangeSat,
      });
    }
    visible.sort((a, b) => b.el - a.el);
    state.visible = visible;
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    els.canvas.width = Math.floor(window.innerWidth * dpr);
    els.canvas.height = Math.floor(window.innerHeight * dpr);
    els.canvas.style.width = `${window.innerWidth}px`;
    els.canvas.style.height = `${window.innerHeight}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function isHot(name) {
    return /ISS|CSS|TIANGONG|ZARYA/i.test(name);
  }

  function drawPolar(w, h) {
    const cx = w / 2;
    const cy = h / 2;
    const radius = Math.min(w, h) * 0.36;

    ctx.strokeStyle = "rgba(125, 211, 252, 0.28)";
    ctx.fillStyle = "rgba(8, 12, 28, 0.35)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    for (const el of [30, 60]) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * ((90 - el) / 90), 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.stroke();

    ctx.fillStyle = "#eef6ff";
    ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("N", cx, cy - radius - 8);
    ctx.fillText("S", cx, cy + radius + 16);
    ctx.textAlign = "left";
    ctx.fillText("E", cx + radius + 8, cy + 4);
    ctx.textAlign = "right";
    ctx.fillText("W", cx - radius - 8, cy + 4);

    if (state.hasOrientation) {
      const cone = projectPolar(state.look.az, Math.max(state.look.el, 0), w, h);
      ctx.strokeStyle = "rgba(251, 191, 36, 0.8)";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cone.x, cone.y);
      ctx.stroke();
    }

    for (const sat of state.visible) {
      const p = projectPolar(sat.az, sat.el, w, h);
      ctx.beginPath();
      ctx.fillStyle = isHot(sat.name) ? "#fbbf24" : "#7dd3fc";
      ctx.arc(p.x, p.y, isHot(sat.name) ? 5 : 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "600 12px ui-sans-serif, system-ui, 'Hiragino Sans', sans-serif";
      ctx.textAlign = "left";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(5,8,22,0.75)";
      ctx.fillStyle = isHot(sat.name) ? "#fde68a" : "#eef6ff";
      ctx.strokeText(sat.name, p.x + 8, p.y - 6);
      ctx.fillText(sat.name, p.x + 8, p.y - 6);
    }
  }

  function drawAr(w, h) {
    ctx.strokeStyle = "rgba(125, 211, 252, 0.2)";
    ctx.beginPath();
    ctx.moveTo(w / 2, h * 0.1);
    ctx.lineTo(w / 2, h * 0.9);
    ctx.moveTo(w * 0.1, h / 2);
    ctx.lineTo(w * 0.9, h / 2);
    ctx.stroke();

    for (const sat of state.visible) {
      const p = projectAr(sat.az, sat.el, state.look, w, h);
      if (!p.onScreen) continue;
      ctx.beginPath();
      ctx.fillStyle = isHot(sat.name) ? "#fbbf24" : "#7dd3fc";
      ctx.arc(p.x, p.y, isHot(sat.name) ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "600 13px ui-sans-serif, system-ui, 'Hiragino Sans', sans-serif";
      ctx.textAlign = "left";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(5,8,22,0.75)";
      ctx.fillStyle = isHot(sat.name) ? "#fde68a" : "#eef6ff";
      const label = `${sat.name}  ${sat.el.toFixed(0)}°`;
      ctx.strokeText(label, p.x + 10, p.y - 8);
      ctx.fillText(label, p.x + 10, p.y - 8);
    }
  }

  function draw() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    ctx.clearRect(0, 0, w, h);
    if (state.hasOrientation && els.camera.srcObject) {
      drawAr(w, h);
    } else {
      drawPolar(w, h);
    }
  }

  function renderList() {
    els.visible.innerHTML = "";
    const top = state.visible.slice(0, 12);
    els.listEmpty.hidden = top.length > 0;
    for (const sat of top) {
      const li = document.createElement("li");
      li.innerHTML = `<span>${sat.name}</span><span>${sat.el.toFixed(0)}° / ${sat.rangeKm.toFixed(0)} km</span>`;
      els.visible.appendChild(li);
    }
  }

  function onOrientation(ev) {
    if (ev.alpha == null && typeof ev.webkitCompassHeading !== "number") return;
    state.hasOrientation = true;

    if (typeof ev.webkitCompassHeading === "number") {
      const look = lookFromOrientation(0, ev.beta, ev.gamma);
      state.look = {
        az: wrap360(ev.webkitCompassHeading),
        el: look.el,
        roll: ev.gamma || 0,
      };
    } else {
      const absolute = ev.absolute === true || ev.type === "deviceorientationabsolute";
      let alpha = ev.alpha;
      if (!absolute) alpha = wrap360(360 - alpha);
      state.look = lookFromOrientation(alpha, ev.beta, ev.gamma);
    }

    els.heading.textContent = `${state.look.az.toFixed(0)}°`;
    els.elev.textContent = `仰角 ${state.look.el.toFixed(0)}°`;
  }

  function bindOrientation() {
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
  }

  function loop() {
    if (!state.running) return;
    draw();
    requestAnimationFrame(loop);
  }

  async function refreshCatalog() {
    const group = els.catalog.value;
    setStatus("CelesTrak から軌道要素を取得中…");
    const records = await loadCatalog(group);
    state.sats = recordsToSats(records);
    computeVisible();
    renderList();
    updateStatusLine();
  }

  function updateStatusLine() {
    const loc = state.observer
      ? `${state.observer.lat.toFixed(2)}°, ${state.observer.lon.toFixed(2)}°`
      : "";
    setStatus(`${state.sats.length} 機 · 頭上 ${state.visible.length} · ${loc}`);
  }

  async function start() {
    els.start.disabled = true;
    els.gateError.hidden = true;
    try {
      if (typeof satellite === "undefined") {
        throw new Error("satellite.js の読み込みに失敗しました");
      }
      await requestMotionPermission();
      await watchLocation();
      const camOk = await startCamera();
      bindOrientation();
      await refreshCatalog();

      els.gate.hidden = true;
      els.hud.hidden = false;
      els.compass.hidden = false;
      els.list.hidden = false;
      state.running = true;
      resize();
      loop();

      setTimeout(() => {
        if (!state.hasOrientation) {
          toast("向きセンサーが無い端末では全天マップになります。スマホを屋外で使ってください。");
        } else if (!camOk) {
          toast("カメラなし。十字線の向きに衛星名を重ねます。");
        }
      }, 1500);

      setInterval(() => {
        computeVisible();
        renderList();
        updateStatusLine();
      }, 1000);
    } catch (err) {
      els.gateError.hidden = false;
      els.gateError.textContent = err.message || String(err);
      els.start.disabled = false;
    }
  }

  els.start.addEventListener("click", start);
  els.catalog.addEventListener("change", () => {
    refreshCatalog().catch((err) => toast(err.message || String(err)));
  });
  window.addEventListener("resize", resize);
})();
