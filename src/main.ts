import './style.css'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import GUI from 'lil-gui'
import Peer from 'peerjs'
import { createNoise3D } from 'simplex-noise'

// ---------- Types ----------
interface Planet {
  name: string
  radius: number
  color: number
  orbitalRadius: number
  orbitalSpeed: number // radians per second
  axialTilt: number
  rotationSpeed: number // radians per second
  gravityStrength: number // relative G for critters
  mesh: THREE.Mesh
  pivot: THREE.Object3D // used for orbit path
}

interface Critter {
  name: string
  body: THREE.SkinnedMesh
  skeleton: THREE.Skeleton
  bones: THREE.Bone[]
  mixer: THREE.AnimationMixer
  bodyType: 'worm' | 'insect' | 'biped' | 'quadruped'
  legs: THREE.Group[]
  state: 'grounded' | 'leaping' | 'space'
  targetPlanet: Planet | null
  homePlanet: Planet
  velocity: THREE.Vector3
  surfaceOffset: number
  wanderPhase: number
  gaitPhase: number
  sizeScale: number
  excitement: number
  socialTarget: Critter | null
  nextSocialTime: number
}

// ---------- Scene Setup ----------
const container = document.getElementById('app') as HTMLDivElement
const scene = new THREE.Scene()
scene.fog = null

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', alpha: true })
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
renderer.setSize(container.clientWidth, container.clientHeight)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
container.appendChild(renderer.domElement)

const camera = new THREE.PerspectiveCamera(60, container.clientWidth / container.clientHeight, 0.1, 2000)
camera.position.set(0, 30, 80)

const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.minDistance = 10
controls.maxDistance = 400
controls.target.set(0, 0, 0)

// Lights
const ambient = new THREE.AmbientLight(0xd9ecff, 0.6)
const hemi = new THREE.HemisphereLight(0xcfe9ff, 0x253040, 0.35)
scene.add(hemi)
scene.add(ambient)
const sunLight = new THREE.PointLight(0xfff0cc, 10.0, 0, 2)
sunLight.position.set(0, 0, 0)
sunLight.castShadow = true
sunLight.shadow.mapSize.set(2048, 2048)
sunLight.shadow.bias = -0.0005
scene.add(sunLight)

// Stars background (Boltzmann-like temperature distribution + blackbody colors)
function kelvinToRGB(tempK: number): THREE.Color {
  // Approximate blackbody color (1000K - 40000K) per Tanner Helland / simplified
  const t = tempK / 100
  let r: number, g: number, b: number
  // Red
  if (t <= 66) r = 255
  else r = 329.698727446 * Math.pow(t - 60, -0.1332047592)
  // Green
  if (t <= 66) g = 99.4708025861 * Math.log(t) - 161.1195681661
  else g = 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  // Blue
  if (t >= 66) b = 255
  else if (t <= 19) b = 0
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307
  const clamp = (x: number) => Math.max(0, Math.min(255, x))
  const color = new THREE.Color(clamp(r) / 255, clamp(g) / 255, clamp(b) / 255)
  return color
}

// Procedural nebula texture
function makeNebulaTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x / size) * 4 - 2
      const ny = (y / size) * 4 - 2
      const n = 0.6 * noise3D(nx * 0.5, ny * 0.5, 0.0) + 0.4 * noise3D(nx * 1.1 + 10, ny * 1.1 + 10, 0.0)
      const h = 0.65 + 0.1 * n
      const s = 0.7 + 0.25 * n
      const l = 0.05 + Math.max(0, n) * 0.35
      const c = new THREE.Color().setHSL(h, s, l)
      const i = (y * size + x) * 4
      img.data[i + 0] = Math.floor(255 * c.r)
      img.data[i + 1] = Math.floor(255 * c.g)
      img.data[i + 2] = Math.floor(255 * c.b)
      img.data[i + 3] = Math.floor(255 * (0.4 + 0.6 * Math.max(0, n)))
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function sampleStarTemperature(): number {
  // Sample 2500K..12000K with bias toward ~5500K (sunlike), loosely Boltzmann-like
  const Tmin = 2500
  const Tmax = 12000
  const u = Math.random()
  const v = Math.random()
  // Log-bias mixture for variety
  const bias = Math.pow(u, 0.6) * 0.6 + Math.pow(v, 2.0) * 0.4
  return Tmin * Math.pow(Tmax / Tmin, bias)
}

const starGeo = new THREE.BufferGeometry()
const starCount = 15000
const starPositions = new Float32Array(starCount * 3)
const starColors = new Float32Array(starCount * 3)
for (let i = 0; i < starCount; i++) {
  const r = THREE.MathUtils.randFloat(200, 900)
  const theta = Math.random() * Math.PI * 2
  const phi = Math.acos(THREE.MathUtils.randFloatSpread(2))
  starPositions[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta)
  starPositions[i * 3 + 1] = r * Math.cos(phi)
  starPositions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta)

  // Temperature -> blackbody RGB with brightness scaling
  const T = sampleStarTemperature()
  const bb = kelvinToRGB(T)
  const brightness = THREE.MathUtils.clamp(Math.pow(T / 6000, 4) * 0.85, 0.25, 2.2)
  bb.multiplyScalar(brightness)
  starColors[i * 3 + 0] = bb.r
  starColors[i * 3 + 1] = bb.g
  starColors[i * 3 + 2] = bb.b
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3))
starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3))
const stars = new THREE.Points(
  starGeo,
  new THREE.PointsMaterial({ vertexColors: true, size: 1.8, sizeAttenuation: true, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false })
)
scene.add(stars)

// Sun
const sunRadius = 6
const sun = new THREE.Mesh(
  new THREE.SphereGeometry(sunRadius, 48, 48),
  new THREE.MeshBasicMaterial({ color: 0xffe08a })
)
scene.add(sun)

// Sun glow halo (sprite)
function makeGlowTexture(size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  g.addColorStop(0, 'rgba(255,245,200,0.85)')
  g.addColorStop(0.4, 'rgba(255,190,120,0.35)')
  g.addColorStop(1, 'rgba(255,170,100,0.0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, size, size)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
  map: makeGlowTexture(256),
  color: 0xffffff,
  blending: THREE.AdditiveBlending,
  transparent: true,
  depthWrite: false,
}))
sunGlow.scale.setScalar(sunRadius * 6)
sunGlow.renderOrder = 0
sun.add(sunGlow)

// Sunglasses for the sun
const sunglasses = new THREE.Group()
const lensRadius = 1.6
const lensGeo = new THREE.CircleGeometry(lensRadius, 32)
const lensMat = new THREE.MeshBasicMaterial({ color: 0x111111, side: THREE.DoubleSide })
const leftLens = new THREE.Mesh(lensGeo, lensMat)
const rightLens = new THREE.Mesh(lensGeo, lensMat)
leftLens.position.set(-lensRadius - 0.4, 0.4, 0)
rightLens.position.set(lensRadius + 0.4, 0.4, 0)
const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.25, 0.2), lensMat)
bridge.position.set(0, 0.4, 0)
sunglasses.add(leftLens, rightLens, bridge)
sunglasses.renderOrder = 2
scene.add(sunglasses)

// Sun mood and brightness state
let sunSmileActive = false
let sunSmileTime = 0
let sunSmileCooldown = 2 + Math.random() * 5
const sunLightBaseIntensity = 10.0
let sunLightTargetIntensity = sunLightBaseIntensity
let sunGlowTargetScale = sunRadius * 6

// Smile mouth (hidden by default)
const smileMouth = new THREE.Mesh(
  new THREE.TorusGeometry(1.8, 0.12, 12, 64, Math.PI),
  new THREE.MeshBasicMaterial({ color: 0x7a2b2b })
)
smileMouth.rotation.x = Math.PI / 2
smileMouth.rotation.z = Math.PI
smileMouth.position.set(0, -0.6, 0.02)
smileMouth.visible = false
sunglasses.add(smileMouth)

// Raycaster for planet selection
const raycaster = new THREE.Raycaster()
const mouse = new THREE.Vector2()
let followPlanet: Planet | null = null
let followOffset: THREE.Vector3 | null = null
window.addEventListener('pointerdown', (e) => {
  const rect = renderer.domElement.getBoundingClientRect()
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
  mouse.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1)
  raycaster.setFromCamera(mouse, camera)
  const planetMeshes = planets.map(p => p.mesh)
  const intersects = raycaster.intersectObjects(planetMeshes, false)
  if (intersects.length > 0) {
    const picked = intersects[0].object as THREE.Mesh
    followPlanet = planets.find(p => p.mesh === picked) || null
    if (followPlanet) {
      // Smoothly retarget orbit controls to this planet
      const target = new THREE.Vector3(); followPlanet.mesh.getWorldPosition(target)
      controls.target.copy(target)
      // Preserve current distance/orbit offset relative to new target
      followOffset = new THREE.Vector3().subVectors(camera.position, target)
    }
  }
})

// When user rotates/zooms while following, update offset to keep that new relative framing
controls.addEventListener('change', () => {
  if (followPlanet) {
    followOffset = new THREE.Vector3().subVectors(camera.position, controls.target)
  }
})

// Procedural tree texture (fractal-like branching)
function makeTreeTexture(size = 128): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  ctx.strokeStyle = 'rgba(40,60,35,0.95)'
  ctx.lineCap = 'round'
  function branch(x: number, y: number, len: number, angle: number, width: number) {
    if (len < 4) return
    ctx.lineWidth = width
    const x2 = x + Math.cos(angle) * len
    const y2 = y - Math.sin(angle) * len
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke()
    const n = 2 + Math.floor(Math.random() * 2)
    for (let i = 0; i < n; i++) {
      const a = angle + (Math.random() * 0.8 - 0.4)
      branch(x2, y2, len * (0.55 + Math.random() * 0.15), a, Math.max(1, width * 0.7))
    }
  }
  branch(size * 0.5, size * 0.05, size * 0.36, Math.PI / 2, 4)
  // Leaves cloud
  const leaf = ctx.createRadialGradient(size * 0.5, size * 0.7, 2, size * 0.5, size * 0.7, size * 0.35)
  leaf.addColorStop(0, 'rgba(120,180,120,0.9)')
  leaf.addColorStop(1, 'rgba(120,180,120,0.0)')
  ctx.fillStyle = leaf
  ctx.beginPath(); ctx.arc(size * 0.5, size * 0.7, size * 0.35, 0, Math.PI * 2); ctx.fill()
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.generateMipmaps = true
  return tex
}

// ---------- Planet System ----------
const planets: Planet[] = []
const noise3D = createNoise3D()

function createPlanet(params: Omit<Planet, 'mesh' | 'pivot'>): Planet {
  const geometry = new THREE.SphereGeometry(params.radius, 64, 64)

  // Slight surface variation for visual flair
  const positions = geometry.attributes.position as THREE.BufferAttribute
  const temp = new THREE.Vector3()
  const colors: number[] = []
  const base = new THREE.Color(params.color)
  const hsl = { h: 0, s: 0, l: 0 }
  base.getHSL(hsl)
  for (let i = 0; i < positions.count; i++) {
    temp.fromBufferAttribute(positions, i).normalize()
    const n = noise3D(temp.x * 1.5, temp.y * 1.5, temp.z * 1.5)
    const scale = 1 + n * 0.05
    positions.setXYZ(i, temp.x * params.radius * scale, temp.y * params.radius * scale, temp.z * params.radius * scale)
    const altitude = (n + 1) * 0.5
    const c = new THREE.Color().setHSL(
      (hsl.h + THREE.MathUtils.mapLinear(altitude, 0, 1, -0.02, 0.02) + 1) % 1,
      THREE.MathUtils.clamp(hsl.s + THREE.MathUtils.mapLinear(altitude, 0, 1, 0.1, -0.05), 0, 1),
      THREE.MathUtils.clamp(hsl.l + THREE.MathUtils.mapLinear(altitude, 0, 1, -0.1, 0.18), 0, 1)
    )
    colors.push(c.r, c.g, c.b)
  }
  positions.needsUpdate = true
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
  geometry.computeVertexNormals()

  const material = new THREE.MeshStandardMaterial({
    color: params.color,
    roughness: 0.6,
    metalness: 0.08,
    vertexColors: true,
    envMapIntensity: 0.7,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.castShadow = true
  mesh.receiveShadow = true

  const pivot = new THREE.Object3D()
  pivot.position.set(0, 0, 0)
  pivot.add(mesh)
  scene.add(pivot)

  mesh.position.set(params.orbitalRadius, 0, 0)
  mesh.rotation.x = params.axialTilt

  const planet: Planet = { ...params, mesh, pivot }
  planets.push(planet)

  // Atmosphere shell
  const atmosphere = new THREE.Mesh(
    new THREE.SphereGeometry(params.radius * 1.06, 48, 48),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(params.color).multiplyScalar(1.1), transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, side: THREE.BackSide })
  )
  mesh.add(atmosphere)

  // A few billboards as simple "trees" using fractal-like branching texture
  const treeCount = Math.floor(THREE.MathUtils.mapLinear(params.radius, 3, 6, 24, 64))
  const treeMat = new THREE.SpriteMaterial({ map: makeTreeTexture(), transparent: true, depthWrite: false })
  for (let i = 0; i < treeCount; i++) {
    const sprite = new THREE.Sprite(treeMat)
    const lat = THREE.MathUtils.mapLinear(Math.random(), 0, 1, -Math.PI / 2, Math.PI / 2)
    const lon = Math.random() * Math.PI * 2
    const n = noise3D(Math.cos(lon) * 2, Math.sin(lat) * 2, Math.sin(lon) * 2)
    const scale = THREE.MathUtils.lerp(0.8, 1.6, (n + 1) / 2)
    sprite.scale.setScalar(scale)
    const pos = new THREE.Vector3(
      Math.cos(lat) * Math.cos(lon),
      Math.sin(lat),
      Math.cos(lat) * Math.sin(lon)
    ).multiplyScalar(params.radius * 1.01)
    sprite.position.copy(pos)
    sprite.lookAt(new THREE.Vector3(0, 0, 0))
    mesh.add(sprite)
  }
  return planet
}

// A few colorful planets with different gravity strengths
const cobalt = createPlanet({ name: 'Cobalt', radius: 6, color: 0x6ea8ff, orbitalRadius: 40, orbitalSpeed: 0.25, axialTilt: THREE.MathUtils.degToRad(18), rotationSpeed: 0.3, gravityStrength: 22 })
const saffron = createPlanet({ name: 'Saffron', radius: 4.5, color: 0xffb347, orbitalRadius: 66, orbitalSpeed: 0.18, axialTilt: THREE.MathUtils.degToRad(8), rotationSpeed: 0.45, gravityStrength: 16 })
const viridian = createPlanet({ name: 'Viridian', radius: 3.8, color: 0x95e78f, orbitalRadius: 90, orbitalSpeed: 0.14, axialTilt: THREE.MathUtils.degToRad(25), rotationSpeed: 0.35, gravityStrength: 12 })
createPlanet({ name: 'Rose', radius: 3.2, color: 0xff7aa2, orbitalRadius: 115, orbitalSpeed: 0.11, axialTilt: THREE.MathUtils.degToRad(5), rotationSpeed: 0.55, gravityStrength: 10 })

// Planet rings for Saffron
function makeRingTexture(size = 256): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const center = size / 2
  const img = ctx.createImageData(size, size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center
      const dy = y - center
      const r = Math.sqrt(dx * dx + dy * dy) / center
      const alpha = THREE.MathUtils.smoothstep(r, 0.55, 0.98) - THREE.MathUtils.smoothstep(r, 0.58, 0.99)
      const i = (y * size + x) * 4
      img.data[i + 0] = 255
      img.data[i + 1] = 220
      img.data[i + 2] = 150
      img.data[i + 3] = Math.floor(255 * Math.max(0, alpha))
    }
  }
  ctx.putImageData(img, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

const ring = new THREE.Mesh(
  new THREE.RingGeometry(saffron.radius * 1.5, saffron.radius * 2.4, 64),
  new THREE.MeshBasicMaterial({ map: makeRingTexture(512), color: 0xffffff, transparent: true, side: THREE.DoubleSide, opacity: 0.85 })
)
ring.rotation.x = THREE.MathUtils.degToRad(75)
saffron.mesh.add(ring)

// A couple of moons
const moons: { planet: Planet; mesh: THREE.Mesh; radius: number; orbitRadius: number; speed: number; angle: number; tilt: number }[] = []
function addMoon(planet: Planet, radius: number, orbitRadius: number, speed: number, tiltDeg: number) {
  const moonMesh = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 24),
    new THREE.MeshStandardMaterial({ color: 0xbac5d6, roughness: 0.95 })
  )
  scene.add(moonMesh)
  moons.push({ planet, mesh: moonMesh, radius, orbitRadius, speed, angle: Math.random() * Math.PI * 2, tilt: THREE.MathUtils.degToRad(tiltDeg) })
}
addMoon(cobalt, 1.1, cobalt.radius + 7, 1.6, 25)
addMoon(viridian, 0.9, viridian.radius + 5.5, 1.2, -15)

// ---------- Critter Factory (Skinned, smooth body) ----------
const critterNames = ['Scrappybara', 'Blanca', 'Diagaur', 'Mochi', 'Pip', 'Nori', 'Boba', 'Zuzu', 'Mimi', 'Peanut', 'Luna', 'Kiki']
const critters: Critter[] = []

function makeSmoothCritterMaterial(baseColor: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.25, metalness: 0.05 })
}

function makeLeg(material: THREE.Material, length: number, thickness: number): THREE.Group {
  const g = new THREE.Group()
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(thickness, thickness, length * 0.55, 8), material)
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(thickness * 0.8, thickness * 0.8, length * 0.55, 8), material)
  upper.position.y = -length * 0.275
  lower.position.y = -length * 0.825
  g.add(upper, lower)
  return g
}

function createCritter(name: string, homePlanet: Planet, hueShift: number): Critter {
  // Build a simple bone chain and a smooth blob geometry skinned to it
  const segments = 4
  const bones: THREE.Bone[] = []
  let prev: THREE.Bone | null = null
  for (let i = 0; i < segments; i++) {
    const bone = new THREE.Bone()
    bone.position.y = i === 0 ? 0 : 1.2
    if (prev) prev.add(bone)
    bones.push(bone)
    prev = bone
  }

  const skeleton = new THREE.Skeleton(bones)

  // Smooth capsule-like body
  const baseScale = THREE.MathUtils.lerp(0.8, 1.4, Math.random())
  const bodyGeo = new THREE.SphereGeometry(1.2 * baseScale, 32, 32)
  // Skinning attributes
  const skinIndices = [] as number[]
  const skinWeights = [] as number[]
  const vertex = new THREE.Vector3()

  for (let i = 0; i < bodyGeo.attributes.position.count; i++) {
    vertex.fromBufferAttribute(bodyGeo.attributes.position as THREE.BufferAttribute, i)
    const y = THREE.MathUtils.clamp((vertex.y + 1.2) / 2.4, 0, 1)
    // Blend across bones smoothly from bottom to top
    const boneIndex = Math.floor(y * (segments - 1))
    const nextIndex = Math.min(boneIndex + 1, segments - 1)
    const t = (y * (segments - 1)) % 1

    skinIndices.push(boneIndex, nextIndex, 0, 0)
    skinWeights.push(1 - t, t, 0, 0)
  }

  bodyGeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4))
  bodyGeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4))

  const color = new THREE.Color().setHSL(hueShift, 0.55, 0.65).getHex()
  const material = makeSmoothCritterMaterial(color)

  const rootBone = bones[0]
  const mesh = new THREE.SkinnedMesh(bodyGeo, material)
  const skeletonHelper = new THREE.SkeletonHelper(rootBone)
  skeletonHelper.visible = false
  scene.add(skeletonHelper)

  mesh.add(rootBone)
  mesh.bind(skeleton)
  mesh.castShadow = true
  mesh.receiveShadow = true

  // Add tiny ears for cuteness
  const earGeo = new THREE.SphereGeometry(0.35, 16, 16)
  const earL = new THREE.Mesh(earGeo, material)
  const earR = new THREE.Mesh(earGeo, material)
  earL.position.set(-0.6, 1.2, 0.35)
  earR.position.set(0.6, 1.2, 0.35)
  mesh.add(earL, earR)

  const mixer = new THREE.AnimationMixer(mesh)
  const types: Critter['bodyType'][] = ['worm', 'insect', 'biped', 'quadruped']
  const bodyType = types[Math.floor(Math.random() * types.length)]

  const legs: THREE.Group[] = []
  if (bodyType === 'insect') {
    for (let i = -1; i <= 1; i++) {
      const legL = makeLeg(material, 1.2 * baseScale, 0.12 * baseScale)
      const legR = makeLeg(material, 1.2 * baseScale, 0.12 * baseScale)
      legL.position.set(-0.9 * baseScale, 0.2 * baseScale, i * 0.6 * baseScale)
      legR.position.set(0.9 * baseScale, 0.2 * baseScale, i * 0.6 * baseScale)
      mesh.add(legL, legR)
      legs.push(legL, legR)
    }
  } else if (bodyType === 'biped') {
    const legL = makeLeg(material, 1.4 * baseScale, 0.16 * baseScale)
    const legR = makeLeg(material, 1.4 * baseScale, 0.16 * baseScale)
    legL.position.set(-0.45 * baseScale, -0.2 * baseScale, 0.2 * baseScale)
    legR.position.set(0.45 * baseScale, -0.2 * baseScale, 0.2 * baseScale)
    mesh.add(legL, legR)
    legs.push(legL, legR)
  } else if (bodyType === 'quadruped') {
    const offsets = [
      [-0.6, -0.1, 0.5],
      [0.6, -0.1, 0.5],
      [-0.6, -0.1, -0.5],
      [0.6, -0.1, -0.5],
    ]
    for (const [x, y, z] of offsets) {
      const leg = makeLeg(material, 1.3 * baseScale, 0.14 * baseScale)
      leg.position.set(x * baseScale, y * baseScale, z * baseScale)
      mesh.add(leg)
      legs.push(leg)
    }
  } // worms have no extra legs

  const critter: Critter = {
    name,
    body: mesh,
    skeleton,
    bones,
    mixer,
    bodyType,
    legs,
    state: 'grounded',
    targetPlanet: null,
    homePlanet,
    velocity: new THREE.Vector3(),
    surfaceOffset: 1.4 * baseScale, // hover a bit above ground for smoothness
    wanderPhase: Math.random() * Math.PI * 2,
    gaitPhase: Math.random() * Math.PI * 2,
    sizeScale: baseScale,
    excitement: Math.random() * 0.6 + 0.2,
    socialTarget: null,
    nextSocialTime: 1 + Math.random() * 3,
  }

  // Place on home planet surface at random longitude
  const a = Math.random() * Math.PI * 2

  const planetWorldPos = new THREE.Vector3()
  homePlanet.mesh.getWorldPosition(planetWorldPos)
  const normal = new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).normalize()
  critter.body.position.copy(planetWorldPos).add(normal.multiplyScalar(homePlanet.radius + critter.surfaceOffset))

  scene.add(critter.body)
  critters.push(critter)
  return critter
}

// Spawn critters across planets
planets.forEach((p, i) => {
  const perPlanet = 2
  for (let k = 0; k < perPlanet; k++) {
    const name = critterNames[(i * 3 + k) % critterNames.length]
    createCritter(name, p, ((i * 3 + k) % critterNames.length) / critterNames.length)
  }
})

// ---------- Physics-like parameters ----------
const params = {
  timeScale: 1.0,
  gravityGlobal: 70, // base strength of inter-planet gravity for critters
  leapImpulse: 24, // initial jump impulse
  spaceDrag: 0.02, // slow critters in space so they arc nicely
  stickiness: 16, // how quickly critters align to surfaces
  wanderSpeed: 0.8, // how fast grounded critters meander
  orbitEccentricity: 0.12, // eccentricity factor for path fun
}

const gui = new GUI({ title: 'Solar Critters' })
const f1 = gui.addFolder('Dynamics')
f1.add(params, 'timeScale', 0.2, 2.0, 0.01)
f1.add(params, 'gravityGlobal', 10, 200, 1)
f1.add(params, 'leapImpulse', 6, 60, 1)
f1.add(params, 'spaceDrag', 0, 0.2, 0.001)
f1.add(params, 'stickiness', 4, 40, 1)
f1.add(params, 'wanderSpeed', 0, 3, 0.01)
f1.add(params, 'orbitEccentricity', 0, 0.6, 0.01)

// ---------- Config + Multiplayer Wiring ----------
type GameConfigKey = 'eden' | 'wander' | 'carnival'
function applyConfig(key: GameConfigKey) {
  switch (key) {
    case 'eden':
      params.gravityGlobal = 70; params.leapImpulse = 24; params.spaceDrag = 0.02; params.wanderSpeed = 0.8; params.orbitEccentricity = 0.12
      break
    case 'wander':
      params.gravityGlobal = 55; params.leapImpulse = 20; params.spaceDrag = 0.03; params.wanderSpeed = 1.1; params.orbitEccentricity = 0.08
      break
    case 'carnival':
      params.gravityGlobal = 90; params.leapImpulse = 36; params.spaceDrag = 0.01; params.wanderSpeed = 1.6; params.orbitEccentricity = 0.2
      break
  }
}

// Minimal state sync (future use)
type Role = 'host' | 'client' | null
let peer: Peer | null = null
let connections: any[] = []
let myName = 'Guest'
const remoteCursors: { name: string; mesh: THREE.Sprite }[] = []
function initMultiplayer(role: Role, roomId?: string) {
  if (!role && !roomId) return
  peer = new Peer({ debug: 1 })
  peer.on('open', () => {
    if (role === 'host') {
      // Host uses its own id (or hash) and accepts connections
      peer!.on('connection', (conn: any) => {
        connections.push(conn)
        conn.on('data', (data: any) => handleRemote(data))
      })
    } else if (roomId) {
      const conn = peer!.connect(roomId)
      connections.push(conn)
      conn.on('open', () => {})
      conn.on('data', (data: any) => handleRemote(data))
    }
  })
  peer.on('error', err => { console.warn('Peer error', err) })
}

// Expose a start function for the start screen
;(window as any).startGame = (cfg: GameConfigKey, role: Role, roomId?: string, name?: string) => {
  applyConfig(cfg)
  myName = name || 'Guest'
  initMultiplayer(role, roomId)
}

// ---------- Simple state sync ----------
type Msg =
  | { t: 'camera'; name: string; p: { x: number, y: number, z: number }; g: { x: number, y: number, z: number } }
  | { t: 'seed'; s: number }

function broadcast(msg: Msg) {
  for (const c of connections) {
    if (c.open) c.send(msg)
  }
}

function handleRemote(msg: Msg) {
  switch (msg.t) {
    case 'camera':
      // Show/update a remote presence sprite at their target
      const key = msg.name
      let cur = remoteCursors.find(c => c.name === key)
      if (!cur) {
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x9cc3ff, opacity: 0.9 }))
        spr.scale.set(2, 2, 1)
        scene.add(spr)
        cur = { name: key, mesh: spr }
        remoteCursors.push(cur)
      }
      cur.mesh.position.set(msg.g.x, msg.g.y, msg.g.z)
      break
    case 'seed':
      // Could reinit noise/positions based on shared seed (not applied retroactively here)
      break
  }
}

// Periodically send local camera to peers for presence
setInterval(() => {
  if (!peer || connections.length === 0) return
  const p = camera.position
  const g = controls.target
  broadcast({ t: 'camera', name: myName, p: { x: p.x, y: p.y, z: p.z }, g: { x: g.x, y: g.y, z: g.z } })
}, 200)

// ---------- Helpers ----------
function getCombinedGravityAtPoint(point: THREE.Vector3): THREE.Vector3 {
  const g = new THREE.Vector3()
  for (const p of planets) {
    const pw = new THREE.Vector3()
    p.mesh.getWorldPosition(pw)
    const toPlanet = new THREE.Vector3().subVectors(pw, point)
    const d2 = Math.max(toPlanet.lengthSq(), 1e-2)
    const strength = (params.gravityGlobal * p.gravityStrength) / d2
    g.add(toPlanet.normalize().multiplyScalar(strength))
  }
  return g
}

function findNearestPlanet(point: THREE.Vector3): { planet: Planet; dist: number; normal: THREE.Vector3 } {
  let best: Planet = planets[0]
  let bestDist = Infinity
  const normal = new THREE.Vector3()

  for (const p of planets) {
    const pw = new THREE.Vector3()
    p.mesh.getWorldPosition(pw)
    const d = point.distanceTo(pw) - p.radius
    if (d < bestDist) {
      best = p
      bestDist = d
      normal.copy(new THREE.Vector3().subVectors(point, pw).normalize())
    }
  }
  return { planet: best, dist: bestDist, normal }
}

function stickToPlanetSurface(critter: Critter, planet: Planet, delta: number) {
  const pw = new THREE.Vector3()
  planet.mesh.getWorldPosition(pw)
  const toCenter = new THREE.Vector3().subVectors(critter.body.position, pw)
  const surfacePoint = new THREE.Vector3().copy(toCenter).setLength(planet.radius + critter.surfaceOffset)
  const desired = new THREE.Vector3().addVectors(pw, surfacePoint)
  critter.body.position.lerp(desired, Math.min(1, params.stickiness * delta))

  // Align up-axis smoothly
  const up = surfacePoint.normalize()
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(critter.body.quaternion)
  const right = new THREE.Vector3().crossVectors(forward, up).normalize()
  forward.copy(new THREE.Vector3().crossVectors(up, right).normalize())

  const targetQuat = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(right, up, forward)
  )
  critter.body.quaternion.slerp(targetQuat, 4 * delta)
}

function wanderOnSurface(critter: Critter, planet: Planet, delta: number) {
  critter.wanderPhase += delta * params.wanderSpeed
  critter.gaitPhase += delta * (1.5 + 2.0 * critter.excitement)
  const pw = new THREE.Vector3()
  planet.mesh.getWorldPosition(pw)
  const up = new THREE.Vector3().subVectors(critter.body.position, pw).normalize()
  const tangent = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0))
  if (tangent.lengthSq() < 1e-5) tangent.set(1, 0, 0)
  tangent.normalize()
  const bitangent = new THREE.Vector3().crossVectors(up, tangent)
  const wander = new THREE.Vector3().addVectors(
    tangent.clone().multiplyScalar(Math.cos(critter.wanderPhase)),
    bitangent.clone().multiplyScalar(Math.sin(critter.wanderPhase * 0.7))
  )
  const sunDir = new THREE.Vector3().subVectors(sun.position, pw).normalize()
  const sunTangent = new THREE.Vector3().subVectors(sunDir, up.clone().multiplyScalar(sunDir.dot(up)))
  const separation = new THREE.Vector3()
  for (const other of critters) {
    if (other === critter) continue
    const nearest = findNearestPlanet(other.body.position)
    if (nearest.planet !== planet) continue
    const d = critter.body.position.distanceTo(other.body.position)
    if (d < 3 && d > 1e-3) {
      const away = new THREE.Vector3().subVectors(critter.body.position, other.body.position).normalize()
      const awayTangent = new THREE.Vector3().subVectors(away, up.clone().multiplyScalar(away.dot(up)))
      separation.addScaledVector(awayTangent, (3 - d) / 3)
    }
  }

  const dir = new THREE.Vector3()
    .addScaledVector(wander.normalize(), 1.0)
    .addScaledVector(sunTangent.normalize(), 0.4 + 0.6 * critter.excitement)
    .addScaledVector(separation.normalize(), 0.8 + 0.8 * critter.excitement)
    .normalize()

  const speed = 2.0 + 2.2 * critter.excitement
  const move = dir.multiplyScalar(speed * delta)
  critter.body.position.add(move)

  // Animate procedural legs
  const legLift = 0.18 * critter.sizeScale
  for (let i = 0; i < critter.legs.length; i++) {
    const leg = critter.legs[i]
    const phase = critter.gaitPhase + (i % 2 === 0 ? 0 : Math.PI)
    leg.rotation.z = Math.sin(phase) * 0.5
    leg.position.y += Math.sin(phase) * legLift * delta
  }
}

function maybeLeapBetweenPlanets(critter: Critter) {
  // Small probability to leap if another planet is attractively near along tangent
  if (critter.state !== 'grounded') return
  const baseChance = 0.012 + 0.03 * critter.excitement
  if (Math.random() > baseChance) return

  const here = critter.body.position.clone()
  const { planet } = findNearestPlanet(here)
  let best: Planet | null = null
  let bestScore = 0

  for (const p of planets) {
    if (p === planet) continue
    const pw = new THREE.Vector3()
    p.mesh.getWorldPosition(pw)
    const dist = here.distanceTo(pw)
    const dirTo = new THREE.Vector3().subVectors(pw, here).normalize()

    // Score based on closeness and alignment with the local tangent plane (encourage lateral jumps)
    const up = new THREE.Vector3().subVectors(here, new THREE.Vector3().copy(planet.mesh.getWorldPosition(new THREE.Vector3()))).normalize()
    const tangentScore = 1 - Math.abs(dirTo.dot(up))
    const score = (tangentScore * 20) / dist

    if (score > bestScore) { bestScore = score; best = p }
  }

  if (best && bestScore > 0.01) {
    const target = new THREE.Vector3(); best.mesh.getWorldPosition(target)
    const dir = new THREE.Vector3().subVectors(target, here).normalize()
    const tangentDir = dir.add(new THREE.Vector3().randomDirection().multiplyScalar(0.3)).normalize()

    critter.velocity.copy(tangentDir).multiplyScalar(params.leapImpulse)
    critter.state = 'leaping'
    critter.targetPlanet = best
  }
}

// ---------- Animation Loop ----------
const clock = new THREE.Clock()
let tOrbit = 0

function animate() {
  requestAnimationFrame(animate)
  const deltaReal = clock.getDelta()
  const delta = deltaReal * params.timeScale
  tOrbit += delta

  // Move planets along simple elliptical programmed orbits for stability
  planets.forEach((p, i) => {
    const e = params.orbitEccentricity
    const a = p.orbitalRadius
    const b = a * (1 - e)
    const angle = tOrbit * p.orbitalSpeed + i * 0.6
    const x = a * Math.cos(angle)
    const z = b * Math.sin(angle)
    p.mesh.position.set(x, 0, z)

    p.pivot.rotation.y += 0.0 // pivot reserved
    p.mesh.rotation.y += p.rotationSpeed * delta
  })

  // If following a planet, only lock the controls target to it; preserve user distance/orientation/scale
  if (followPlanet) {
    const target = new THREE.Vector3(); followPlanet.mesh.getWorldPosition(target)
    controls.target.lerp(target, 0.25)
    if (followOffset) {
      const desiredPos = target.clone().add(followOffset)
      camera.position.lerp(desiredPos, 0.15)
    }
  }

  // Critter physics
  for (const c of critters) {
    const nearest = findNearestPlanet(c.body.position)

    if (c.state === 'grounded') {
      stickToPlanetSurface(c, nearest.planet, delta)
      wanderOnSurface(c, nearest.planet, delta)
      maybeLeapBetweenPlanets(c)
    } else {
      // Leaping / space flight under combined gravity
      const g = getCombinedGravityAtPoint(c.body.position)
      c.velocity.addScaledVector(g, delta)
      // Add space drag so they arc and settle
      c.velocity.multiplyScalar(1 - params.spaceDrag)
      c.body.position.addScaledVector(c.velocity, delta)

      // Ground collision detection with nearest planet
      const pw = new THREE.Vector3(); nearest.planet.mesh.getWorldPosition(pw)
      const distToSurface = c.body.position.distanceTo(pw) - (nearest.planet.radius + c.surfaceOffset * 0.6)
      if (distToSurface <= 0 && c.velocity.dot(new THREE.Vector3().subVectors(c.body.position, pw)) > 0) {
        c.state = 'grounded'
        c.homePlanet = nearest.planet
        c.targetPlanet = null
        c.velocity.set(0, 0, 0)
        stickToPlanetSurface(c, nearest.planet, delta)
        spawnHearts(c.body.position.clone())
      }
    }
  }

  // Subtle star twinkle and slow rotation
  stars.rotation.y += 0.005 * delta
  ;(stars.material as THREE.PointsMaterial).opacity = 0.9 + 0.1 * Math.sin(tOrbit * 0.7)

  // Keep sunglasses on the sun, easing toward facing the camera
  const toCamera = new THREE.Vector3().subVectors(camera.position, sun.position).normalize()
  const sunFront = new THREE.Vector3().copy(sun.position).addScaledVector(toCamera, sunRadius + 0.15)
  sunglasses.position.copy(sunFront)
  // Slerp orientation rather than snapping
  const desiredQuat = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(sunglasses.position, camera.position, new THREE.Vector3(0,1,0)))
  sunglasses.quaternion.slerp(desiredQuat, Math.min(1, 2.0 * delta))

  // Sun random smile logic and brightness pulse
  sunSmileCooldown -= delta
  if (!sunSmileActive && sunSmileCooldown <= 0 && Math.random() < 0.02) {
    sunSmileActive = true
    sunSmileTime = 0
    sunSmileCooldown = 3 + Math.random() * 6
  }
  if (sunSmileActive) {
    sunSmileTime += delta
    const pulse = 1.0 + 0.6 * Math.sin(sunSmileTime * 8) * Math.exp(-sunSmileTime * 1.2)
    sunLightTargetIntensity = sunLightBaseIntensity * 1.8 * pulse
    sunGlowTargetScale = sunRadius * (6 + 1.5 * Math.sin(sunSmileTime * 6) * Math.exp(-sunSmileTime * 1.3))
    smileMouth.visible = true
    if (sunSmileTime > 1.8) {
      sunSmileActive = false
      smileMouth.visible = false
      sunLightTargetIntensity = sunLightBaseIntensity
      sunGlowTargetScale = sunRadius * 6
    }
  }
  // Ease light intensity and glow scale toward targets
  sunLight.intensity += (sunLightTargetIntensity - sunLight.intensity) * Math.min(1, 3.0 * delta)
  sunGlow.scale.lerp(new THREE.Vector3(1,1,1).multiplyScalar(sunGlowTargetScale), Math.min(1, 3.0 * delta))

  // Animate moons in local orbits
  for (const m of moons) {
    m.angle += (m.speed * delta) / 6
    const pw = new THREE.Vector3(); m.planet.mesh.getWorldPosition(pw)
    const x = m.orbitRadius * Math.cos(m.angle)
    const z = m.orbitRadius * Math.sin(m.angle)
    const pos = new THREE.Vector3(x, 0, z)
    // tilt around X
    pos.applyAxisAngle(new THREE.Vector3(1, 0, 0), m.tilt)
    m.mesh.position.copy(pw).add(pos)
  }

  controls.update()
  composer.render()
}

animate()

// ---------- Resize ----------
// Postprocessing: bloom
const composer = new EffectComposer(renderer)
const renderPass = new RenderPass(scene, camera)
composer.addPass(renderPass)
const bloomPass = new UnrealBloomPass(new THREE.Vector2(container.clientWidth, container.clientHeight), 0.9, 0.4, 0.85)
composer.addPass(bloomPass)

// Nebula background (large gradient plane far behind)
;(() => {
  const geo = new THREE.PlaneGeometry(4000, 4000)
  const tex = makeNebulaTexture(1024)
  const mat = new THREE.MeshBasicMaterial({ map: tex, depthWrite: false, depthTest: false, transparent: true, opacity: 0.8 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.set(0, 0, -1500)
  scene.add(mesh)
  return mesh
})()

// Fireflies around planets
const fireflyGroup = new THREE.Group()
scene.add(fireflyGroup)
function spawnFireflies(count = 300) {
  const geom = new THREE.BufferGeometry()
  const positions = new Float32Array(count * 3)
  const colors = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const p = planets[Math.floor(Math.random() * planets.length)]
    const base = p.mesh.position.clone()
    const dir = new THREE.Vector3().randomDirection()
    const r = THREE.MathUtils.randFloat(p.radius + 2, p.radius + 10)
    const pos = base.addScaledVector(dir, r)
    positions.set([pos.x, pos.y, pos.z], i * 3)
    const c = new THREE.Color().setHSL(Math.random(), 0.8, 0.6)
    colors.set([c.r, c.g, c.b], i * 3)
  }
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  const pts = new THREE.Points(geom, new THREE.PointsMaterial({ size: 0.9, transparent: true, opacity: 0.9, vertexColors: true, blending: THREE.AdditiveBlending, depthWrite: false }))
  fireflyGroup.add(pts)
}
spawnFireflies(600)

// Heart burst when critter lands after a leap
function spawnHearts(at: THREE.Vector3) {
  const count = 10
  const geom = new THREE.BufferGeometry()
  const positions = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    const dir = new THREE.Vector3().randomDirection()
    const pos = at.clone().add(dir.multiplyScalar(Math.random() * 1.5))
    positions.set([pos.x, pos.y, pos.z], i * 3)
  }
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  const mat = new THREE.PointsMaterial({ size: 1.6, color: 0xff7aa2, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
  const pts = new THREE.Points(geom, mat)
  scene.add(pts)
  setTimeout(() => scene.remove(pts), 800)
}

window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight
  camera.updateProjectionMatrix()
  renderer.setSize(container.clientWidth, container.clientHeight)
  composer.setSize(container.clientWidth, container.clientHeight)
  bloomPass.setSize(container.clientWidth, container.clientHeight)
})
