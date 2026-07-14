// thermal-sim.test.js
// Physics acceptance criteria for the Temperature Sim core. Run with:
//   node --test
// No browser, no dependencies. These tests ARE the definition of "the physics
// is correct" from the build brief, section 5/6.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThermalSim, C } from './thermal-sim.js';

// Advance a sim by `seconds`, calling step in coarse chunks (the core
// sub-steps internally, so chunk size does not affect the result).
function run(sim, seconds, chunk = 1) {
  for (let t = 0; t < seconds; t += chunk) sim.step(Math.min(chunk, seconds - t));
}

test('200 g water on 500 W heats to boiling in ~2 minutes', () => {
  const sim = new ThermalSim();
  const water = sim.add({ type: 'beaker', water_kg: 0.2, T: 20 });
  const plate = sim.add({ type: 'hotplate', watts: 500, on: true });
  sim.link(plate, water);

  // Q = m c dT = 0.2 * 4186 * 80 = 66976 J ; / 500 W = 133.95 s.
  run(sim, 134);
  assert.equal(sim.get(water).temp >= 100, true, 'should have reached boiling');

  // Check the time to first reach 100 C is close to the analytic 134 s.
  const sim2 = new ThermalSim();
  const w2 = sim2.add({ type: 'beaker', water_kg: 0.2, T: 20 });
  const p2 = sim2.add({ type: 'hotplate', watts: 500, on: true });
  sim2.link(p2, w2);
  let tBoil = 0;
  while (sim2.get(w2).temp < 100 && tBoil < 600) { sim2.step(1); tBoil = sim2.time; }
  assert.ok(Math.abs(tBoil - 134) < 5, `time to boil ${tBoil.toFixed(1)}s should be ~134s`);
});

test('water plateaus at exactly 100 C while boiling (the whole point)', () => {
  const sim = new ThermalSim();
  const water = sim.add({ type: 'beaker', water_kg: 0.2, T: 20 });
  const plate = sim.add({ type: 'hotplate', watts: 500, on: true });
  sim.link(plate, water);

  run(sim, 134);          // reach boiling
  const before = sim.get(water).mass;
  run(sim, 120);          // keep heating for two more minutes
  const body = sim.get(water);

  assert.ok(body && body.mass > 0, 'water should not have fully boiled yet');
  assert.ok(Math.abs(body.temp - 100) < 0.001, `temp should be pinned at 100 C, was ${body.temp}`);
  assert.ok(body.mass < before, 'water mass should be dropping as it boils off');
});

test('boiling 200 g fully away takes ~15 minutes (7x the heat-up time)', () => {
  const sim = new ThermalSim();
  const water = sim.add({ type: 'beaker', water_kg: 0.2, T: 20 });
  const plate = sim.add({ type: 'hotplate', watts: 500, on: true });
  sim.link(plate, water);

  // Heat-up: 66976 J. Boil-away: 0.2 * 2_260_000 = 452000 J. Total 518976 J.
  // At 500 W that is 1037.95 s = 17.3 min total; boil-away alone 904 s = 15.06 min.
  let tGone = 0;
  while (sim.mainWater() && tGone < 3000) { sim.step(1); tGone = sim.time; }
  const boilAwayMinutes = (tGone - 134) / 60;
  assert.ok(Math.abs(boilAwayMinutes - 15.06) < 0.5, `boil-away took ${boilAwayMinutes.toFixed(2)} min, expect ~15`);
});

test('boil-away is ~7x longer than heat-up', () => {
  const sim = new ThermalSim();
  const water = sim.add({ type: 'beaker', water_kg: 0.2, T: 20 });
  const plate = sim.add({ type: 'hotplate', watts: 500, on: true });
  sim.link(plate, water);
  let tBoilStart = 0;
  while (sim.get(water).temp < 100) { sim.step(1); tBoilStart = sim.time; }
  let tGone = tBoilStart;
  while (sim.mainWater()) { sim.step(1); tGone = sim.time; }
  const ratio = (tGone - tBoilStart) / tBoilStart;
  assert.ok(ratio > 6 && ratio < 8, `boil:heat ratio ${ratio.toFixed(2)} should be ~7`);
});

test('mixing converges to the calorimetry answer (mcDeltaT)', () => {
  // 0.3 kg at 80 C mixed with 0.1 kg at 20 C. No phase change, insulated.
  // T_final = (0.3*80 + 0.1*20) / 0.4 = 65 C.
  const sim = new ThermalSim();
  const hot = sim.add({ type: 'water', kg: 0.3, T: 80 });
  const cold = sim.add({ type: 'water', kg: 0.1, T: 20 });
  sim.link(hot, cold, 50);
  run(sim, 600);
  const expected = (0.3 * 80 + 0.1 * 20) / 0.4;
  assert.ok(Math.abs(sim.get(hot).temp - expected) < 0.5, `hot at ${sim.get(hot).temp.toFixed(2)}, expect ${expected}`);
  assert.ok(Math.abs(sim.get(cold).temp - expected) < 0.5, `cold at ${sim.get(cold).temp.toFixed(2)}, expect ${expected}`);
});

test('ice holds at 0 C while it melts, then the mixture warms', () => {
  // 50 g ice at 0 C into 200 g water at 40 C, insulated.
  // Melt cost: 0.05 * 334000 = 16700 J.
  // After melt: 0.2 kg @40 and 0.05 kg @0, minus 16700 J already removed.
  // Final: energy = 0.2*4186*40 - 16700, over 0.25 kg -> ~24.0 C.
  const sim = new ThermalSim();
  const water = sim.add({ type: 'water', kg: 0.2, T: 40 });
  const ice = sim.add({ type: 'ice', kg: 0.05, T: 0 });
  sim.link(water, ice, 40);

  // Sample the ice temperature partway through melting: it must stay at 0.
  let sawMeltingPlateau = false;
  for (let t = 0; t < 5; t += 0.5) {
    sim.step(0.5);
    const iceBody = sim.get(ice);
    if (iceBody && iceBody.mass > 0.001 && iceBody.mass < 0.049) {
      assert.ok(Math.abs(iceBody.temp - 0) < 0.001, `ice should hold at 0 C while melting, was ${iceBody.temp}`);
      sawMeltingPlateau = true;
    }
  }
  assert.ok(sawMeltingPlateau, 'should observe the melting plateau');

  run(sim, 600);
  const q0 = 0.2 * C.WATER * 40 - 0.05 * C.L_FUSION;
  const expected = q0 / (0.25 * C.WATER);
  const finalTemp = sim.mainWater().temp;
  assert.ok(Math.abs(finalTemp - expected) < 1.0, `final mix ${finalTemp.toFixed(2)} C, expect ~${expected.toFixed(2)} C`);
});

test('not all the ice melts when the water cannot supply enough heat', () => {
  // 300 g ice at 0 C into 100 g water at 10 C. Water can give up at most
  // 0.1*4186*10 = 4186 J; that melts only 4186/334000 = 12.5 g. Equilibrium
  // is 0 C with most of the ice still solid.
  const sim = new ThermalSim();
  const water = sim.add({ type: 'water', kg: 0.1, T: 10 });
  const ice = sim.add({ type: 'ice', kg: 0.3, T: 0 });
  sim.link(water, ice, 40);
  run(sim, 1200);
  assert.ok(Math.abs(sim.mainWater().temp - 0) < 0.5, 'mixture should settle at 0 C');
  const remaining = sim.get(ice);
  assert.ok(remaining && remaining.mass > 0.28, `most ice should remain, ${(remaining?.mass ?? 0).toFixed(3)} kg left`);
});

test('sub-zero ice first warms to 0 C before it melts', () => {
  const sim = new ThermalSim();
  const water = sim.add({ type: 'water', kg: 0.5, T: 30 });
  const ice = sim.add({ type: 'ice', kg: 0.02, T: -15 });
  sim.link(water, ice, 30);
  // Early on, the ice should be warming through the sub-zero range.
  sim.step(0.2);
  const iceBody = sim.get(ice);
  assert.ok(iceBody.temp > -15 && iceBody.temp <= 0, `ice should be warming from -15, at ${iceBody.temp.toFixed(2)}`);
});

test('probe reads with first-order lag, not instantly', () => {
  const sim = new ThermalSim();
  const water = sim.add({ type: 'water', kg: 1.0, T: 90 });
  const pi = sim.addProbe({ target: water, tau: 3, T: 22 });
  // After one time-constant (~3 s) a first-order lag reaches ~63% of the step.
  run(sim, 3, 0.1);
  const reading = sim.probe(pi).temp_c;
  const expected = 22 + (90 - 22) * (1 - Math.exp(-1)); // ~64.9 C
  assert.ok(Math.abs(reading - expected) < 3, `probe at ${reading.toFixed(1)} C, expect ~${expected.toFixed(1)} C`);
  // Given long enough it converges on the true temperature.
  run(sim, 60, 0.5);
  assert.ok(Math.abs(sim.probe(pi).temp_c - 90) < 0.5, 'probe should converge to 90 C');
});

test('probe in the air reads ambient; steam above a boil reads 100 C', () => {
  const sim = new ThermalSim({ ambient_c: 22 });
  const water = sim.add({ type: 'beaker', water_kg: 0.2, T: 20 });
  const plate = sim.add({ type: 'hotplate', watts: 800, on: true });
  sim.link(plate, water);
  const air = sim.addProbe({ target: null, T: 22 });   // room air
  run(sim, 30);
  assert.ok(Math.abs(sim.probe(air).temp_c - 22) < 0.5, 'air probe should read ambient');

  // Once boiling, point a probe at the steam: it should read 100 C.
  run(sim, 200);
  const steam = sim.bodies.find((b) => b.type === 'steam');
  assert.ok(steam, 'steam should exist once boiling');
  const steamProbe = sim.addProbe({ target: steam.id, T: 22 });
  run(sim, 30);
  assert.ok(Math.abs(sim.probe(steamProbe).temp_c - 100) < 1.0, `steam probe reads ${sim.probe(steamProbe).temp_c.toFixed(1)}, expect ~100`);
});

test('hotplate off delivers no power', () => {
  const sim = new ThermalSim();
  const water = sim.add({ type: 'water', kg: 0.2, T: 20 });
  const plate = sim.add({ type: 'hotplate', watts: 500, on: false });
  sim.link(plate, water);
  run(sim, 120);
  assert.ok(Math.abs(sim.get(water).temp - 20) < 0.001, 'water should not warm with the plate off');
});

test('Newton cooling relaxes a hot body toward ambient', () => {
  const sim = new ThermalSim({ ambient_c: 22 });
  const water = sim.add({ type: 'water', kg: 0.2, T: 80, hA: 2.0 });
  run(sim, 2000);
  assert.ok(sim.get(water).temp < 30, `should cool toward ambient, at ${sim.get(water).temp.toFixed(1)}`);
  assert.ok(sim.get(water).temp >= 22, 'should not overshoot below ambient');
});

test('energy is conserved through a melt (no heat created or destroyed)', () => {
  const sim = new ThermalSim();
  const water = sim.add({ type: 'water', kg: 0.2, T: 50 });
  const ice = sim.add({ type: 'ice', kg: 0.04, T: 0 });
  sim.link(water, ice, 40);
  const energy = () => sim.bodies.reduce((e, b) => {
    if (b.type === 'water') return e + b.mass * C.WATER * b.temp;
    if (b.type === 'ice') return e + b.mass * C.ICE * b.temp - b.mass * C.L_FUSION; // ice carries -latent
    return e;
  }, 0);
  const e0 = energy();
  run(sim, 600);
  const e1 = energy();
  assert.ok(Math.abs(e1 - e0) < 50, `energy drift ${(e1 - e0).toFixed(1)} J should be ~0`);
});
