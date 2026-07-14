// thermal-sim.js
// Headless thermal-physics core for the LABKickstart Temperature Sim.
//
// No DOM, no rendering, no timers. A pure model you advance with step(dt).
// The rendering layer (index.html) and the unit tests (thermal-sim.test.js)
// both drive this same object. Keeping it headless is what lets the physics
// be unit-tested with no browser, and what lets the sim drop into a dashboard
// later without untangling physics from <canvas> calls.
//
// Units are SI throughout: kilograms, seconds, joules, watts, kelvin for
// differences, degrees Celsius for absolute temperatures (because that is what
// the real probe hardware reports, on a channel it calls `temp_c`).

// --- Material constants (from the build brief, section 2) -------------------

export const C = {
  WATER: 4186,     // specific heat of liquid water, J/(kg K)
  ICE: 2090,       // specific heat of ice,          J/(kg K)
  STEAM: 2010,     // specific heat of steam,         J/(kg K)
  GLASS: 840,      // specific heat of glass,         J/(kg K)  (available, unused in v1)
  L_FUSION: 334000,    // latent heat of fusion (melt/freeze),  J/kg
  L_VAPOR: 2260000,    // latent heat of vaporisation (boil),   J/kg
  MELT_C: 0,       // melting point,  degrees C
  BOIL_C: 100,     // boiling point,  degrees C
  AMBIENT_C: 22,   // room temperature, degrees C
};

const specificHeat = (phase) =>
  phase === 'solid' ? C.ICE : phase === 'gas' ? C.STEAM : C.WATER;

let _nextId = 1;
const newId = () => _nextId++;

// --- Bodies -----------------------------------------------------------------
//
// A thermal body is a lumped mass at a single uniform temperature. Water, ice
// and steam are all the same substance (H2O) in different phases; a body knows
// its phase and picks the right specific heat. Phase change moves *mass*
// between bodies (ice melts into the water it sits in, water boils off into
// steam) while temperature stays pinned at the transition point. That mass
// transfer, held at a constant temperature, is what draws the flat plateaus.

class Body {
  constructor(spec) {
    this.id = spec.id ?? newId();
    this.type = spec.type;              // 'water' | 'ice' | 'steam' | 'hotplate' | 'beaker'
    this.mass = spec.mass ?? 0;         // kg
    this.temp = spec.T ?? C.AMBIENT_C;  // degrees C
    this.phase = spec.phase ?? phaseForType(spec.type); // 'solid'|'liquid'|'gas'|null
    this.hA = spec.hA ?? 0;             // Newton-cooling coefficient h*A, W/K (0 = insulated)
    this.watts = spec.watts ?? 0;       // hotplate power, W
    this.on = spec.on ?? true;          // hotplate on/off
    // Rendering/UI metadata; the physics never reads these.
    this.contained = spec.contained ?? (spec.type === 'beaker' || spec.type === 'water');
    this.label = spec.label ?? spec.type;
  }

  get isThermal() {
    return this.type === 'water' || this.type === 'ice' || this.type === 'steam';
  }

  get c() {
    return specificHeat(this.phase);
  }

  // Total heat capacity, J/K. Zero-mass bodies are inert (no divide-by-zero).
  get heatCapacity() {
    return this.mass * this.c;
  }
}

function phaseForType(type) {
  if (type === 'ice') return 'solid';
  if (type === 'steam') return 'gas';
  if (type === 'water' || type === 'beaker') return 'liquid';
  return null; // hotplate
}

// --- Probe ------------------------------------------------------------------
//
// A real thermistor does not read the true temperature instantly; it has its
// own thermal mass and lags by a few seconds. We model that as a first-order
// lag toward whatever the probe is currently immersed in. This is honest: the
// instrument is part of the experiment, and a student using the real hardware
// sees the same lag.

class Probe {
  constructor(spec, ambientC) {
    this.id = spec.id ?? newId();
    this.tau = spec.tau ?? 3;                 // time constant, seconds
    this.target = spec.target ?? null;        // body id, or null => ambient
    this.temp = spec.T ?? ambientC;           // current reading, degrees C
  }

  // The channel name and unit the real hardware uses. Do not rename.
  get temp_c() {
    return this.temp;
  }
}

// --- Simulation -------------------------------------------------------------

export class ThermalSim {
  constructor(opts = {}) {
    this.ambientC = opts.ambient_c ?? C.AMBIENT_C;
    this.maxSubStep = opts.max_substep ?? 0.05; // s; internal integration step for stability
    this.time = 0;                              // simulated seconds elapsed
    this.bodies = [];
    this.probes = [];
    this.contacts = [];                         // { a, b, G }  conductance G in W/K
  }

  // Add a body. Returns its id.
  //   { type:'beaker', water_kg, T, hA }   -> a liquid water body (the contents)
  //   { type:'ice',    kg, T, hA }         -> an ice body
  //   { type:'hotplate', watts, on }       -> a heat source
  //   { type:'steam',  kg, T }             -> steam (usually created by boiling)
  add(spec) {
    let body;
    if (spec.type === 'beaker') {
      body = new Body({ ...spec, type: 'water', mass: spec.water_kg ?? spec.kg ?? 0, contained: true, label: 'water' });
    } else if (spec.type === 'ice' || spec.type === 'water' || spec.type === 'steam') {
      body = new Body({ ...spec, mass: spec.kg ?? spec.mass ?? 0, T: spec.T ?? (spec.type === 'ice' ? 0 : this.ambientC) });
    } else if (spec.type === 'hotplate') {
      body = new Body({ ...spec });
    } else {
      throw new Error(`unknown body type: ${spec.type}`);
    }
    this.bodies.push(body);
    return body.id;
  }

  get(id) {
    return this.bodies.find((b) => b.id === id) ?? null;
  }

  remove(id) {
    this.bodies = this.bodies.filter((b) => b.id !== id);
    this.contacts = this.contacts.filter((k) => k.a !== id && k.b !== id);
  }

  // Declare that two bodies are touching, with a thermal conductance G (W/K).
  // A hotplate-to-water contact delivers the plate's wattage; any other pair
  // exchanges heat by conduction toward equilibrium. In the UI these are
  // recomputed every frame from object positions; in tests they are explicit.
  link(a, b, G = 25) {
    this.contacts.push({ a, b, G });
  }

  // Replace all contacts at once (what the UI does each frame after hit-testing).
  setContacts(list) {
    this.contacts = list.map((k) => ({ a: k.a, b: k.b, G: k.G ?? 25 }));
  }

  // Probes ------------------------------------------------------------------
  addProbe(spec = {}) {
    const p = new Probe(spec, this.ambientC);
    this.probes.push(p);
    return this.probes.length - 1;
  }

  probe(i) {
    return this.probes[i];
  }

  // Point probe i at a body id, or null for ambient air.
  setProbeTarget(i, target) {
    if (this.probes[i]) this.probes[i].target = target;
  }

  // Advance the physics by `dt` seconds of *simulated* time. Callers pass
  // real-frame-dt * speed; we sub-step internally so time acceleration never
  // destabilises the integration.
  step(dt) {
    let remaining = dt;
    while (remaining > 1e-9) {
      const h = Math.min(this.maxSubStep, remaining);
      this._substep(h);
      remaining -= h;
    }
    return this;
  }

  _substep(dt) {
    // 1. Accumulate the net heat into each thermal body over this sub-step.
    const heat = new Map(); // body id -> joules this sub-step
    const add = (id, q) => heat.set(id, (heat.get(id) ?? 0) + q);

    // Contacts: hotplate power, or conduction between thermal bodies.
    for (const { a, b, G } of this.contacts) {
      const ba = this.get(a);
      const bb = this.get(b);
      if (!ba || !bb) continue;

      const plate = ba.type === 'hotplate' ? ba : bb.type === 'hotplate' ? bb : null;
      const sink = plate === ba ? bb : ba;
      if (plate) {
        if (plate.on && sink.isThermal) add(sink.id, plate.watts * dt);
        continue;
      }
      if (ba.isThermal && bb.isThermal) {
        // Conductive flow from hotter to colder; converges to the mcΔT mix.
        const q = G * (ba.temp - bb.temp) * dt;
        add(ba.id, -q);
        add(bb.id, q);
      }
    }

    // Ambient loss (Newton's cooling) for every exposed thermal body.
    for (const body of this.bodies) {
      if (!body.isThermal || body.hA <= 0) continue;
      add(body.id, -body.hA * (body.temp - this.ambientC) * dt);
    }

    // 2. Apply the heat, letting each body handle its own phase transitions.
    //    Snapshot the list because melting/boiling can spawn new bodies.
    const snapshot = [...this.bodies];
    for (const body of snapshot) {
      if (!body.isThermal) continue;
      const q = heat.get(body.id) ?? 0;
      this._applyHeat(body, q);
    }

    // 3. Drop any bodies that have fully changed phase away to nothing.
    this.bodies = this.bodies.filter((b) => !(b.isThermal && b.mass <= 1e-9));

    // 4. Update probe readings with first-order lag.
    for (const p of this.probes) {
      const targetTemp = p.target == null ? this.ambientC : (this.get(p.target)?.temp ?? this.ambientC);
      p.temp += ((targetTemp - p.temp) / p.tau) * dt;
    }

    this.time += dt;
  }

  // Apply q joules to a single body, respecting phase-change plateaus.
  // Temperature never crosses a transition point in one step: the crossing
  // energy is redirected into melting or boiling instead.
  _applyHeat(body, q) {
    if (body.heatCapacity <= 0) return;

    if (body.phase === 'solid') this._applyToIce(body, q);
    else if (body.phase === 'liquid') this._applyToWater(body, q);
    else this._applyToSteam(body, q);
  }

  _applyToIce(body, q) {
    // Warm the ice toward 0 C. Any energy beyond that melts it (at a fixed 0 C).
    if (q <= 0 || body.temp < C.MELT_C) {
      const toMelt = body.mass * C.ICE * (C.MELT_C - body.temp); // J to reach 0 C
      if (q <= toMelt) {
        body.temp += q / (body.mass * C.ICE);
        return;
      }
      body.temp = C.MELT_C;
      q -= toMelt;
    }
    // At 0 C, remaining energy melts ice into water (mass transfer, temp pinned).
    const dm = Math.min(body.mass, q / C.L_FUSION);
    body.mass -= dm;
    this._depositMeltwater(body, dm);
    // Leftover after melting everything superheats the resulting water.
    if (body.mass <= 1e-9) {
      const leftover = q - dm * C.L_FUSION;
      const water = this._meltTarget(body);
      if (water && leftover > 0 && water.mass > 0) {
        water.temp += leftover / (water.mass * C.WATER);
      }
    }
  }

  _applyToWater(body, q) {
    const cap = body.mass * C.WATER;
    if (q >= 0 && body.temp >= C.BOIL_C) {
      this._boil(body, q);
      return;
    }
    if (q < 0 && body.temp <= C.MELT_C) {
      // Colder than freezing has no source in v1; equilibrium floors at 0 C.
      body.temp = C.MELT_C;
      return;
    }
    if (q > 0) {
      const toBoil = cap * (C.BOIL_C - body.temp); // J to reach 100 C
      if (q <= toBoil) {
        body.temp += q / cap;
        return;
      }
      body.temp = C.BOIL_C;
      this._boil(body, q - toBoil);
    } else {
      const toFreeze = cap * (body.temp - C.MELT_C); // J to reach 0 C (q is negative)
      if (-q <= toFreeze) {
        body.temp += q / cap;
      } else {
        body.temp = C.MELT_C; // floor; no active freezing in v1
      }
    }
  }

  // Boil q joules worth of water into steam at 100 C (mass transfer, temp pinned).
  _boil(body, q) {
    if (q <= 0) return;
    const dm = Math.min(body.mass, q / C.L_VAPOR);
    body.mass -= dm;
    const steam = this._steamNode(body);
    steam.mass += dm;
    steam.temp = C.BOIL_C;
    if (body.mass <= 1e-9) {
      const leftover = q - dm * C.L_VAPOR;
      if (leftover > 0 && steam.mass > 0) steam.temp += leftover / (steam.mass * C.STEAM);
    }
  }

  _applyToSteam(body, q) {
    body.temp += q / (body.mass * C.STEAM);
    if (body.temp < C.BOIL_C) body.temp = C.BOIL_C; // v1 vents rather than re-condensing
  }

  // Where melting ice sends its water: a liquid body it is in contact with,
  // else a fresh water body created in its place.
  _meltTarget(iceBody) {
    if (iceBody._meltTarget) return this.get(iceBody._meltTarget);
    for (const { a, b } of this.contacts) {
      const other = a === iceBody.id ? this.get(b) : b === iceBody.id ? this.get(a) : null;
      if (other && other.type === 'water' && other.phase === 'liquid') {
        iceBody._meltTarget = other.id;
        return other;
      }
    }
    return null;
  }

  _depositMeltwater(iceBody, dm) {
    if (dm <= 0) return;
    let water = this._meltTarget(iceBody);
    if (!water) {
      // No host water: the ice becomes its own puddle at 0 C.
      const id = this.add({ type: 'water', kg: 0, T: C.MELT_C, hA: iceBody.hA });
      water = this.get(id);
      iceBody._meltTarget = id;
    }
    // Blend dm of 0 C meltwater into the host (energy-conserving mix).
    const totalCap = water.mass + dm;
    water.temp = totalCap > 0 ? (water.mass * water.temp + dm * C.MELT_C) / totalCap : C.MELT_C;
    water.mass = totalCap;
  }

  _steamNode(waterBody) {
    if (waterBody._steam && this.get(waterBody._steam)) return this.get(waterBody._steam);
    const id = this.add({ type: 'steam', kg: 0, T: C.BOIL_C });
    const node = this.get(id);
    node._risenFrom = waterBody.id;
    waterBody._steam = id;
    return node;
  }

  // Convenience for reading the primary liquid body (used by the UI and the
  // brief's illustrative snippet).
  mainWater() {
    return this.bodies.find((b) => b.type === 'water' && b.phase === 'liquid') ?? null;
  }
}

export default ThermalSim;
