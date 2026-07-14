# Temperature Sim

A thermal physics sandbox in the browser: drag objects onto a bench, heat them,
cool them, mix them, and watch a temperature-versus-time graph draw itself live.
The software twin of the LABKickstart temperature probe module.

The output that matters is the graph. The 2D scene is the interface; the chart
is the physics.

## Run it

Because `index.html` loads the physics core as an ES module, it needs to be
served over HTTP (opening the file directly will trip module CORS rules):

```sh
cd temperature-sim
python3 -m http.server 8080      # or: npx serve .
# open http://localhost:8080
```

Or use the zero-server single file, which inlines the core:

```sh
node build.js
open dist/standalone.html        # runs straight from file://
```

## Test the physics

The physics core is headless (no DOM) so it can be unit-tested with no browser.
These tests are the acceptance criteria for the physics.

```sh
node --test
```

They assert the numbers from the brief: 200 g of water on 500 W reaches boiling
in ~2 minutes, plateaus at exactly 100 °C, takes ~15 minutes to boil away (~7×
the heat-up time), that mixing converges to the calorimetry answer, that ice
holds at 0 °C while it melts, and that the probe reads with a first-order lag.

## Files

| File | What it is |
|---|---|
| `thermal-sim.js` | Headless physics core. Pure `step(dt)` model, no DOM. |
| `thermal-sim.test.js` | Physics acceptance tests (`node --test`). |
| `index.html` | The sandbox UI: 2D canvas scene + live chart. Imports the core. |
| `build.js` | Inlines the core into `dist/standalone.html`. |

## Using the core headlessly

```js
import { ThermalSim } from './thermal-sim.js';

const sim = new ThermalSim();
const water = sim.add({ type: 'beaker', water_kg: 0.2, T: 20 });
const plate = sim.add({ type: 'hotplate', watts: 500 });
sim.link(plate, water);          // beaker sits on the plate
sim.addProbe({ target: water }); // probe immersed in the water
sim.step(dt);                    // advance the physics
sim.probe(0).temp_c;             // -> reading in °C
```

Each probe exposes `temp_c` in degrees Celsius — the channel name and unit the
real probe hardware reports, so this drops into the dashboard chart unchanged.

## The physics

Every object is a lumped mass at a uniform temperature. Each tick:

```
Q_in  = hot-plate power (if in contact)
Q_out = hA * (T - T_ambient)              Newton's cooling
T    += (Q_in - Q_out) * dt / (m * c)
```

Phase change is modelled as an energy accumulator: at a transition temperature
the body stops changing temperature and routes incoming energy into melting or
boiling (moving *mass* between ice / water / steam) until the transition is
complete. Those flat plateaus are the whole pedagogical point.

Time acceleration (1× / 10× / 60×) lets a student watch the full boil-away in
under a minute. The core sub-steps internally, so acceleration never
destabilises the integration.

## Not in v1

Sealed vessels and gas laws (PV = nRT), non-water liquids, stirring, conduction
through the beaker walls as a separate body, and radiation. See the brief.
