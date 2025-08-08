# Solar Critters

A playful Three.js solar system where adorable procedural animals (Scrappybara, Blanca, Diagaur, and friends) roam orbiting worlds, leap between planets under gravity, and light up a dreamy cosmos.

- Planets on stable orbits with atmospheres, rings, moons, and vertex-color biomes
- Blackbody-colored stars and a procedural nebula backdrop
- Skinned critters with multiple body types (worm, insect, biped, quadruped), animated gaits, and simple social AI
- Camera follow by clicking a planet (target-only! preserves your zoom/orientation)
- Bloom postprocessing, fireflies, and little heart bursts when critters land
- Start screen with presets and free P2P multiplayer via PeerJS

## Quick start

```bash
npm install
npm run dev
```

Open the URL printed by the dev server. Use the start screen to pick a preset and optionally host/join a multiplayer room.

## Build

```bash
npm run build
```

Static files will be in `dist/`. The site deploys via GitHub Pages.

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).

- Good first issues: UI polish, new critter species, biomes, music/SFX, accessibility
- Advanced: host-authoritative multiplayer state, interpolation, netcode, photo mode

## License

MIT © Contributors
