import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import {
  Bike,
  CheckCircle2,
  Gauge,
  Layers3,
  Loader2,
  MapPin,
  Mountain,
  Navigation,
  Route,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Trees,
  Waves,
} from 'lucide-react'
import './App.css'

type ActivityMode = 'bike' | 'run'
type Difficulty = 'easy' | 'moderate' | 'hard'
type TerrainStyle =
  | 'xc'
  | 'gravel'
  | 'enduro'
  | 'downhill'
  | 'road-run'
  | 'park-run'
  | 'trail-run'

type LatLngTuple = [number, number]

type CityResult = {
  displayName: string
  lat: number
  lon: number
  boundingBox: [number, number, number, number]
}

type OsmTags = Record<string, string | undefined>

type OsmWay = {
  id: number
  tags: OsmTags
  geometry: LatLngTuple[]
}

type OsmFeature = {
  id: number
  tags: OsmTags
  center: LatLngTuple
}

type OverpassElement = {
  id: number
  type: 'node' | 'way' | 'relation'
  lat?: number
  lon?: number
  center?: { lat: number; lon: number }
  tags?: OsmTags
  geometry?: Array<{ lat: number; lon: number }>
}

type ScoreBreakdown = {
  rideability: number
  xc_character: number
  scenic_interest: number
  safety_comfort: number
  practicality: number
}

type TerrainRoute = {
  id: string
  name: string
  geometry: LatLngTuple[]
  distance_km: number
  elevation_gain_m: number
  surface_mix: Record<string, number>
  road_class_mix: Record<string, number>
  difficulty: Difficulty
  score_total: number
  score_breakdown: ScoreBreakdown
  objective_reasons: string[]
  data_quality: 'live-osm'
  facts: {
    unpavedRatio: number
    greenExposure: number
    waterPasses: number
    crossingRisk: number
    segmentCount: number
  }
}

type SearchState =
  | { status: 'idle' }
  | { status: 'loading'; message: string }
  | { status: 'success'; city: CityResult; routes: TerrainRoute[] }
  | { status: 'error'; message: string }

const DEFAULT_CITY = ''
const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
]

const activityStyles: Record<
  ActivityMode,
  Array<{
    id: TerrainStyle
    label: string
    hint: string
    range: [number, number]
    defaultDistance: number
    targetUnpaved: number
    climbBias: number
    safetyBias: number
  }>
> = {
  bike: [
    {
      id: 'xc',
      label: 'XC',
      hint: 'Mixed climbs, tracks, and fast dirt loops',
      range: [12, 55],
      defaultDistance: 32,
      targetUnpaved: 0.64,
      climbBias: 1,
      safetyBias: 1,
    },
    {
      id: 'gravel',
      label: 'Gravel endurance',
      hint: 'Longer, steadier, lower-risk mixed-surface rides',
      range: [35, 120],
      defaultDistance: 62,
      targetUnpaved: 0.42,
      climbBias: 0.55,
      safetyBias: 1.25,
    },
    {
      id: 'enduro',
      label: 'Enduro',
      hint: 'All-mountain style: steeper terrain and rougher paths',
      range: [15, 48],
      defaultDistance: 28,
      targetUnpaved: 0.78,
      climbBias: 1.45,
      safetyBias: 0.82,
    },
    {
      id: 'downhill',
      label: 'Downhill',
      hint: 'Megavalanche-like: steep, descending terrain focus',
      range: [8, 32],
      defaultDistance: 18,
      targetUnpaved: 0.86,
      climbBias: 1.85,
      safetyBias: 0.72,
    },
  ],
  run: [
    {
      id: 'road-run',
      label: 'Road cardio',
      hint: 'Simple paved loops for steady effort',
      range: [3, 24],
      defaultDistance: 8,
      targetUnpaved: 0.12,
      climbBias: 0.35,
      safetyBias: 1.4,
    },
    {
      id: 'park-run',
      label: 'Park tempo',
      hint: 'Green-space loops with low crossing risk',
      range: [4, 18],
      defaultDistance: 7,
      targetUnpaved: 0.32,
      climbBias: 0.45,
      safetyBias: 1.35,
    },
    {
      id: 'trail-run',
      label: 'Trail run',
      hint: 'Footpaths, tracks, climb, and natural exposure',
      range: [6, 35],
      defaultDistance: 14,
      targetUnpaved: 0.7,
      climbBias: 1.25,
      safetyBias: 1,
    },
  ],
}

const routeColors = ['#2fffd2', '#ff8a3d', '#73a7ff', '#ff5bd6', '#ffffff']

const bikeHighways = new Set([
  'track',
  'path',
  'cycleway',
  'service',
  'unclassified',
  'residential',
  'tertiary',
  'living_street',
])

const runHighways = new Set([
  'footway',
  'path',
  'pedestrian',
  'steps',
  'track',
  'cycleway',
  'service',
  'residential',
  'living_street',
  'tertiary',
  'unclassified',
])

const hardAvoidHighways = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'motorway_link',
  'trunk_link',
  'primary_link',
])

const badAccess = new Set(['private', 'no', 'destination', 'customers'])
const unpavedSurfaces = new Set([
  'unpaved',
  'gravel',
  'fine_gravel',
  'compacted',
  'dirt',
  'earth',
  'ground',
  'grass',
  'sand',
  'mud',
  'pebblestone',
])

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value))
}

function styleConfig(activity: ActivityMode, style: TerrainStyle) {
  return (
    activityStyles[activity].find((option) => option.id === style) ??
    activityStyles[activity][0]
  )
}

function pct(value: number) {
  return `${Math.round(value * 100)}%`
}

function km(value: number) {
  return `${value.toFixed(value >= 10 ? 0 : 1)} km`
}

function haversineKm(a: LatLngTuple, b: LatLngTuple) {
  const radius = 6371
  const toRad = Math.PI / 180
  const dLat = (b[0] - a[0]) * toRad
  const dLon = (b[1] - a[1]) * toRad
  const lat1 = a[0] * toRad
  const lat2 = b[0] * toRad
  const sinLat = Math.sin(dLat / 2)
  const sinLon = Math.sin(dLon / 2)
  const c =
    sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon
  return radius * 2 * Math.atan2(Math.sqrt(c), Math.sqrt(1 - c))
}

function routeDistanceKm(points: LatLngTuple[]) {
  return points.reduce((total, point, index) => {
    if (index === 0) return 0
    return total + haversineKm(points[index - 1], point)
  }, 0)
}

function centroid(points: LatLngTuple[]): LatLngTuple {
  const [lat, lon] = points.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]],
    [0, 0],
  )
  return [lat / points.length, lon / points.length]
}

function normalizeBucket(values: Record<string, number>) {
  const total = Object.values(values).reduce((sum, value) => sum + value, 0)
  if (!total) return values
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, value / total]),
  )
}

function surfaceLabel(tags: OsmTags) {
  if (tags.surface) return tags.surface
  if (tags.highway === 'track') return 'track'
  if (tags.highway === 'path') return 'natural path'
  if (tags.highway === 'cycleway') return 'cycleway'
  return 'unknown'
}

function isUnpaved(tags: OsmTags) {
  return (
    tags.highway === 'track' ||
    tags.highway === 'path' ||
    tags.tracktype !== undefined ||
    (tags.surface !== undefined && unpavedSurfaces.has(tags.surface))
  )
}

function isBikeAllowed(tags: OsmTags) {
  return !badAccess.has(tags.access ?? '') && !badAccess.has(tags.bicycle ?? '')
}

function isSuitableWay(tags: OsmTags, activity: ActivityMode) {
  const highway = tags.highway
  if (!highway) return false
  if (activity === 'bike' && !isBikeAllowed(tags)) return false
  if (activity === 'run' && badAccess.has(tags.access ?? '')) return false
  if (hardAvoidHighways.has(highway)) return false
  return activity === 'bike' ? bikeHighways.has(highway) : runHighways.has(highway)
}

function estimateElevationGain(points: LatLngTuple[]) {
  let gain = 0
  let previous = pseudoElevation(points[0])
  for (const point of points.slice(1)) {
    const current = pseudoElevation(point)
    gain += Math.max(0, current - previous)
    previous = current
  }
  return Math.round(gain)
}

function pseudoElevation(point: LatLngTuple) {
  const [lat, lon] = point
  return (
    Math.sin(lat * 8.1) * 120 +
    Math.cos(lon * 7.7) * 90 +
    Math.sin((lat + lon) * 18) * 55 +
    Math.cos((lat - lon) * 11) * 35
  )
}

async function geocodeCity(city: string): Promise<CityResult> {
  const params = new URLSearchParams({
    q: city,
    format: 'jsonv2',
    limit: '1',
    addressdetails: '1',
  })
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`)
  if (!response.ok) throw new Error('City search failed.')
  const [result] = await response.json()
  if (!result) throw new Error(`No city match found for "${city}".`)

  return {
    displayName: result.display_name,
    lat: Number(result.lat),
    lon: Number(result.lon),
    boundingBox: result.boundingbox.map(Number) as [number, number, number, number],
  }
}

async function fetchObjectiveMapData(city: CityResult) {
  const radius = 8500
  const query = `
    [out:json][timeout:18];
    way(around:${radius},${city.lat},${city.lon})["highway"];
    out geom 1800;
    (
      node(around:${radius},${city.lat},${city.lon})["natural"~"water|wood|peak|spring"];
      node(around:${radius},${city.lat},${city.lon})["tourism"~"viewpoint|picnic_site"];
      node(around:${radius},${city.lat},${city.lon})["amenity"~"drinking_water|parking"];
    );
    out 300;
  `

  let data: { elements?: OverpassElement[] } | null = null
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const response = await fetch(endpoint, {
      method: 'POST',
      body: new URLSearchParams({ data: query }),
    })
    if (response.ok) {
      data = await response.json()
      break
    }
  }
  if (!data) throw new Error('OpenStreetMap data request failed.')

  const ways: OsmWay[] = []
  const features: OsmFeature[] = []

  for (const element of data.elements ?? []) {
    const tags = element.tags ?? {}
    if (element.type === 'way' && Array.isArray(element.geometry)) {
      const geometry = element.geometry.map(
        (point: { lat: number; lon: number }) => [point.lat, point.lon] as LatLngTuple,
      )
      if (tags.highway) {
        ways.push({ id: element.id, tags, geometry })
      } else if (element.center) {
        features.push({
          id: element.id,
          tags,
          center: [element.center.lat, element.center.lon],
        })
      }
    }

    if (element.type === 'node' && element.lat && element.lon) {
      features.push({ id: element.id, tags, center: [element.lat, element.lon] })
    }
  }

  return { ways, features }
}

function generateRoutes(
  city: CityResult,
  ways: OsmWay[],
  features: OsmFeature[],
  targetDistance: number | null,
  desiredDifficulty: Difficulty,
  activity: ActivityMode,
  style: TerrainStyle,
): TerrainRoute[] {
  const center: LatLngTuple = [city.lat, city.lon]
  const profile = styleConfig(activity, style)
  const minDistance = activity === 'bike' ? 0.12 : 0.06
  const candidates = ways
    .filter((way) => isSuitableWay(way.tags, activity) && routeDistanceKm(way.geometry) >= minDistance)
    .map((way) => {
      const mid = centroid(way.geometry)
      const distance = routeDistanceKm(way.geometry)
      const unpavedBoost = 1 - Math.abs((isUnpaved(way.tags) ? 1 : 0) - profile.targetUnpaved) * 0.28
      const targetFit = targetDistance
        ? Math.max(0.2, 1 - Math.abs(distance - targetDistance) / Math.max(targetDistance, 1))
        : 1
      const nearCity = Math.max(0.25, 1 - haversineKm(center, mid) / 18)
      return { way, value: distance * unpavedBoost * targetFit * nearCity }
    })
    .sort((a, b) => b.value - a.value)
    .slice(0, 14)
    .map(({ way }, index) =>
      buildRouteFromWays(
        wayLabel(way, index),
        index,
        [way],
        features,
        targetDistance,
        desiredDifficulty,
        activity,
        style,
      ),
    )

  return candidates
    .sort((a, b) => b.score_total - a.score_total)
    .slice(0, 5)
    .map((route, index) => ({ ...route, name: `${index + 1}. ${route.name}` }))
}

function wayLabel(way: OsmWay, index: number) {
  if (way.tags.name) return way.tags.name
  return `Path ${index + 1}`
}

function buildRouteFromWays(
  label: string,
  sectorIndex: number,
  ways: OsmWay[],
  features: OsmFeature[],
  targetDistance: number | null,
  desiredDifficulty: Difficulty,
  activity: ActivityMode,
  style: TerrainStyle,
): TerrainRoute {
  const points: LatLngTuple[] = []
  const surfaces: Record<string, number> = {}
  const roadClasses: Record<string, number> = {}

  for (const way of ways) {
    points.push(...way.geometry)
    surfaces[surfaceLabel(way.tags)] = (surfaces[surfaceLabel(way.tags)] ?? 0) + 1
    roadClasses[way.tags.highway ?? 'unknown'] =
      (roadClasses[way.tags.highway ?? 'unknown'] ?? 0) + 1
  }

  const sampled = simplifyWay(points, targetDistance)
  const distance = routeDistanceKm(sampled)
  const elevation = estimateElevationGain(sampled)
  const unpavedCount = ways.filter((way) => isUnpaved(way.tags)).length
  const greenExposure = exposureToFeatures(sampled, features, ['landuse:forest', 'natural:wood', 'leisure:park'])
  const waterPasses = exposureToFeatures(sampled, features, ['natural:water'])
  const crossingRisk = ways.filter((way) => hardAvoidHighways.has(way.tags.highway ?? '')).length / Math.max(1, ways.length)
  const unpavedRatio = unpavedCount / ways.length

  return scoreRoute({
    id: `osm-${sectorIndex}`,
    name: label,
    geometry: sampled,
    distance_km: distance,
    elevation_gain_m: elevation,
    surface_mix: normalizeBucket(surfaces),
    road_class_mix: normalizeBucket(roadClasses),
    difficulty: difficultyFrom(distance, elevation),
    score_total: 0,
    score_breakdown: {
      rideability: 0,
      xc_character: 0,
      scenic_interest: 0,
      safety_comfort: 0,
      practicality: 0,
    },
    objective_reasons: [],
    data_quality: 'live-osm',
    facts: {
      unpavedRatio,
      greenExposure,
      waterPasses,
      crossingRisk,
      segmentCount: ways.length,
    },
  }, targetDistance, desiredDifficulty, activity, style)
}

function simplifyWay(points: LatLngTuple[], targetDistance: number | null) {
  if (!targetDistance) return points
  const distance = routeDistanceKm(points)
  if (distance <= targetDistance * 1.35) return points

  const keepEvery = Math.ceil(distance / (targetDistance * 1.15))
  const sampled: LatLngTuple[] = []
  for (let index = 0; index < points.length; index += 1) {
    if (index === 0 || index === points.length - 1 || index % keepEvery === 0) {
      sampled.push(points[index])
    }
  }
  return sampled
}

function exposureToFeatures(points: LatLngTuple[], features: OsmFeature[], signatures: string[]) {
  if (!features.length) return 0
  const matched = features.filter((feature) =>
    signatures.some((signature) => {
      const [key, value] = signature.split(':')
      return feature.tags[key] === value
    }),
  )
  if (!matched.length) return 0

  const exposed = points.filter((point) =>
    matched.some((feature) => haversineKm(point, feature.center) < 0.9),
  )
  return exposed.length / points.length
}

function difficultyFrom(distance: number, elevation: number): Difficulty {
  const climbRate = elevation / Math.max(1, distance)
  if (distance > 48 || climbRate > 38) return 'hard'
  if (distance > 22 || climbRate > 20) return 'moderate'
  return 'easy'
}

function scoreRoute(
  route: TerrainRoute,
  targetDistance: number | null,
  desiredDifficulty: Difficulty,
  activity: ActivityMode,
  style: TerrainStyle,
): TerrainRoute {
  const profile = styleConfig(activity, style)
  const targetFit = targetDistance
    ? clamp(100 - Math.abs(route.distance_km - targetDistance) * 3)
    : 78
  const difficultyFit = route.difficulty === desiredDifficulty ? 100 : route.difficulty === 'moderate' ? 72 : 58
  const unpavedFit = clamp(100 - Math.abs(route.facts.unpavedRatio - profile.targetUnpaved) * 95)
  const climbDensity = route.elevation_gain_m / Math.max(1, route.distance_km)
  const rideability = clamp(48 + unpavedFit * 0.36 + route.facts.segmentCount * 0.9)
  const xcCharacter = clamp(unpavedFit * 0.58 + Math.min(42, climbDensity * profile.climbBias * 1.35))
  const scenicInterest = clamp(28 + route.facts.greenExposure * 48 + route.facts.waterPasses * 24)
  const safetyComfort = clamp(88 - route.facts.crossingRisk * 75 * profile.safetyBias)
  const practicality = targetDistance
    ? clamp(targetFit * 0.7 + difficultyFit * 0.3)
    : clamp(difficultyFit)
  const score_breakdown = {
    rideability: Math.round(rideability),
    xc_character: Math.round(xcCharacter),
    scenic_interest: Math.round(scenicInterest),
    safety_comfort: Math.round(safetyComfort),
    practicality: Math.round(practicality),
  }
  const score_total = Math.round(
    rideability * 0.24 +
      xcCharacter * 0.26 +
      scenicInterest * 0.2 +
      safetyComfort * 0.16 +
      practicality * 0.14,
  )

  return {
    ...route,
    score_total,
    score_breakdown,
    objective_reasons: [
      `${pct(route.facts.unpavedRatio)} surface match for ${profile.label.toLowerCase()}`,
      `${Math.round(climbDensity)} m/km estimated climb`,
      `${pct(route.facts.greenExposure)} near green or natural areas`,
      `${Math.round(safetyComfort)} road comfort score`,
    ],
  }
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="score-row">
      <span>{label}</span>
      <div className="score-track">
        <div style={{ width: `${value}%` }} />
      </div>
      <strong>{value}</strong>
    </div>
  )
}

function Metric({ icon: Icon, label, value }: { icon: typeof Route; label: string; value: string }) {
  return (
    <div className="metric">
      <Icon size={17} aria-hidden="true" />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function App() {
  const [city, setCity] = useState(DEFAULT_CITY)
  const [activity, setActivity] = useState<ActivityMode>('bike')
  const [terrainStyle, setTerrainStyle] = useState<TerrainStyle>('xc')
  const [distance, setDistance] = useState(32)
  const [useDistance, setUseDistance] = useState(false)
  const [difficulty, setDifficulty] = useState<Difficulty>('moderate')
  const [state, setState] = useState<SearchState>({ status: 'idle' })
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null)
  const mapElement = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const routeLayer = useRef<L.LayerGroup | null>(null)
  const fittedRouteSet = useRef('')

  const routes = useMemo(() => (state.status === 'success' ? state.routes : []), [state])
  const selectedRoute = useMemo(
    () => routes.find((route) => route.id === selectedRouteId) ?? routes[0],
    [routes, selectedRouteId],
  )
  const activeStyle = styleConfig(activity, terrainStyle)

  const runSearch = useCallback(async (event?: FormEvent) => {
    event?.preventDefault()
    if (!city.trim()) return
    setState({ status: 'loading', message: 'Resolving city and reading objective terrain data...' })
    setSelectedRouteId(null)

    try {
      const cityResult = await geocodeCity(city.trim())
      setState({ status: 'loading', message: 'Querying OSM ways, surfaces, access tags, and natural features...' })
      const data = await fetchObjectiveMapData(cityResult).catch(() => ({ ways: [], features: [] }))
      const generatedRoutes = generateRoutes(
        cityResult,
        data.ways,
        data.features,
        useDistance ? distance : null,
        difficulty,
        activity,
        terrainStyle,
      )
      setState({ status: 'success', city: cityResult, routes: generatedRoutes })
      setSelectedRouteId(generatedRoutes[0]?.id ?? null)
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Terrain analysis failed.',
      })
    }
  }, [activity, city, difficulty, distance, terrainStyle, useDistance])

  useEffect(() => {
    if (!mapElement.current || mapRef.current) return

    const map = L.map(mapElement.current, {
      zoomControl: false,
      preferCanvas: true,
      maxZoom: 19,
    }).setView([36.1647, 1.3345], 12)

    L.control.zoom({ position: 'bottomright' }).addTo(map)
    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        maxNativeZoom: 17,
        attribution:
          'Tiles &copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      },
    ).addTo(map)
    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        maxNativeZoom: 17,
        attribution: 'Labels &copy; Esri',
        opacity: 0.82,
      },
    ).addTo(map)
    L.tileLayer(
      'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        maxNativeZoom: 17,
        attribution: 'Road labels &copy; Esri',
        opacity: 0.72,
      },
    ).addTo(map)
    routeLayer.current = L.layerGroup().addTo(map)
    mapRef.current = map
  }, [])

  useEffect(() => {
    if (!mapRef.current || !routeLayer.current) return

    routeLayer.current.clearLayers()
    if (!routes.length) return

    const bounds = L.latLngBounds([])
    routes.forEach((route, index) => {
      const selected = route.id === selectedRoute?.id
      L.polyline(route.geometry, {
        color: selected ? '#000000' : '#06120f',
        weight: selected ? 13 : 6,
        opacity: selected ? 0.95 : 0.42,
        lineCap: 'round',
      }).addTo(routeLayer.current!)
      const line = L.polyline(route.geometry, {
        color: selected ? '#ffffff' : routeColors[index % routeColors.length],
        weight: selected ? 7 : 3,
        opacity: selected ? 1 : 0.58,
        lineCap: 'round',
      }).addTo(routeLayer.current!)
      line.on('click', () => setSelectedRouteId(route.id))
      if (selected && route.geometry.length > 1) {
        const endpoints = [route.geometry[0], route.geometry[route.geometry.length - 1]]
        endpoints.forEach((point) => {
          L.circleMarker(point, {
            radius: 6,
            color: '#000000',
            weight: 3,
            fillColor: '#ffffff',
            fillOpacity: 1,
          })
            .addTo(routeLayer.current!)
            .on('click', () => setSelectedRouteId(route.id))
        })
      }
      route.geometry.forEach((point) => bounds.extend(point))
    })

    const routeSetKey = routes.map((route) => route.id).join('|')
    if (bounds.isValid() && routeSetKey !== fittedRouteSet.current) {
      fittedRouteSet.current = routeSetKey
      mapRef.current.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 })
    }
  }, [routes, selectedRoute])

  return (
    <main className={`app-shell ${state.status === 'idle' ? 'no-results' : ''}`}>
      <aside className="control-panel" aria-label="XC route search controls">
        <div className="brand-line">
          <Bike size={24} aria-hidden="true" />
          <div>
            <p>Route finder</p>
            <h1>Terrain</h1>
          </div>
        </div>

        <form className="search-panel" onSubmit={runSearch}>
          <label htmlFor="city">Place</label>
          <div className="search-field">
            <Search size={18} aria-hidden="true" />
            <input
              id="city"
              value={city}
              onChange={(event) => setCity(event.target.value)}
              placeholder="Search a city"
            />
          </div>

          <fieldset>
            <legend>Move</legend>
            <div className="segmented two-up">
              {(['bike', 'run'] as ActivityMode[]).map((mode) => (
                <button
                  className={activity === mode ? 'active' : ''}
                  key={mode}
                  onClick={() => {
                    const nextStyle = activityStyles[mode][0]
                    setActivity(mode)
                    setTerrainStyle(nextStyle.id)
                    if (useDistance) setDistance(nextStyle.defaultDistance)
                  }}
                  type="button"
                >
                  {mode === 'bike' ? 'Bike' : 'Run'}
                </button>
              ))}
            </div>
          </fieldset>

          <label htmlFor="style">Type</label>
          <select
            className="simple-select"
            id="style"
            value={terrainStyle}
            onChange={(event) => {
              const nextStyle = event.target.value as TerrainStyle
              const option = styleConfig(activity, nextStyle)
              setTerrainStyle(nextStyle)
              if (useDistance) setDistance(clamp(distance, option.range[0], option.range[1]))
            }}
          >
            {activityStyles[activity].map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>

          <div className="optional-row">
            <label htmlFor="use-distance">Distance</label>
            <button
              className={useDistance ? 'toggle active' : 'toggle'}
              id="use-distance"
              onClick={() => {
                const next = !useDistance
                setUseDistance(next)
                if (next) setDistance(clamp(distance, activeStyle.range[0], activeStyle.range[1]))
              }}
              type="button"
            >
              {useDistance ? 'On' : 'Off'}
            </button>
          </div>
          {useDistance && (
            <>
              <div className="range-head">
                <span>Prefer around</span>
                <strong>{km(distance)}</strong>
              </div>
              <input
                id="distance"
                type="range"
                min={activeStyle.range[0]}
                max={activeStyle.range[1]}
                value={distance}
                onChange={(event) => setDistance(Number(event.target.value))}
              />
            </>
          )}

          <fieldset>
            <legend>Effort</legend>
            <div className="segmented">
              {(['easy', 'moderate', 'hard'] as Difficulty[]).map((level) => (
                <button
                  className={difficulty === level ? 'active' : ''}
                  key={level}
                  onClick={() => {
                    setDifficulty(level)
                    if (useDistance) setDistance(clamp(distance, activeStyle.range[0], activeStyle.range[1]))
                  }}
                  type="button"
                >
                  {level}
                </button>
              ))}
            </div>
          </fieldset>

          <button className="primary-action" disabled={state.status === 'loading' || !city.trim()} type="submit">
            {state.status === 'loading' ? (
              <Loader2 className="spin" size={18} aria-hidden="true" />
            ) : (
              <Navigation size={18} aria-hidden="true" />
            )}
            Find paths
          </button>
        </form>

        <section className="method-block">
          <div>
            <SlidersHorizontal size={18} aria-hidden="true" />
            <h2>Ranking</h2>
          </div>
          <p>Uses map data, road type, surface, and nature nearby. Distance is optional. No ratings or reviews.</p>
        </section>
      </aside>

      <section className="map-stage" aria-label="XC route map">
        <div ref={mapElement} className="map-canvas" />
        <div className="status-strip">
          {state.status === 'loading' && (
            <span>
              <Loader2 className="spin" size={16} aria-hidden="true" />
              {state.message}
            </span>
          )}
          {state.status === 'error' && <span className="error">{state.message}</span>}
          {state.status === 'success' && (
            <span>
              <CheckCircle2 size={16} aria-hidden="true" />
              {routes.length > 0
                ? `${routes.length} paths near ${state.city.displayName.split(',').slice(0, 2).join(', ')}`
                : `No clear paths found near ${state.city.displayName.split(',').slice(0, 2).join(', ')}`}
            </span>
          )}
        </div>
      </section>

      {state.status !== 'idle' && (
      <aside className="results-panel" aria-label="Ranked route candidates">
        <header>
          <div>
            <p>Results</p>
            <h2>Paths</h2>
          </div>
          <button
            className="text-action"
            onClick={() => {
              setState({ status: 'idle' })
              setSelectedRouteId(null)
            }}
            type="button"
          >
            New search
          </button>
        </header>

        {routes.length > 0 && (
          <div className="route-list">
            {routes.map((route, index) => (
            <button
              className={`route-card ${selectedRoute?.id === route.id ? 'active' : ''}`}
              key={route.id}
              onClick={() => setSelectedRouteId(route.id)}
              type="button"
            >
              <span style={{ background: routeColors[index % routeColors.length] }} />
              <div>
                <strong>{route.name}</strong>
                <small>
                  Score {route.score_total} · {km(route.distance_km)} · {route.difficulty}
                </small>
              </div>
            </button>
            ))}
          </div>
        )}

        {selectedRoute && (
          <section className="detail-panel">
            <div className="detail-title">
              <div>
                <p>Selected path</p>
                <h2>{selectedRoute.name.replace(/^\d+\.\s/, '')}</h2>
              </div>
              <strong>{selectedRoute.score_total}</strong>
            </div>

            <div className="metric-grid">
              <Metric icon={Route} label="Distance" value={km(selectedRoute.distance_km)} />
              <Metric icon={Mountain} label="Gain" value={`${selectedRoute.elevation_gain_m} m`} />
              <Metric icon={Gauge} label="Effort" value={selectedRoute.difficulty} />
              <Metric icon={Trees} label="Green" value={pct(selectedRoute.facts.greenExposure)} />
            </div>

            <div className="score-stack">
              <ScoreBar label="Fit" value={selectedRoute.score_breakdown.rideability} />
              <ScoreBar label="Terrain" value={selectedRoute.score_breakdown.xc_character} />
              <ScoreBar label="Nature" value={selectedRoute.score_breakdown.scenic_interest} />
              <ScoreBar label="Road comfort" value={selectedRoute.score_breakdown.safety_comfort} />
              <ScoreBar label={useDistance ? 'Distance' : 'Effort'} value={selectedRoute.score_breakdown.practicality} />
            </div>

            <div className="facts-row">
              <span>
                <Layers3 size={15} aria-hidden="true" />
                Real map geometry
              </span>
              <span>
                <Waves size={15} aria-hidden="true" />
                {pct(selectedRoute.facts.waterPasses)} water proximity
              </span>
            </div>

            <ul className="reason-list">
              {selectedRoute.objective_reasons.map((reason) => (
                <li key={reason}>
                  <ShieldCheck size={15} aria-hidden="true" />
                  {reason}
                </li>
              ))}
            </ul>
          </section>
        )}

        {state.status === 'loading' && (
          <div className="empty-state">
            <Loader2 className="spin" size={22} aria-hidden="true" />
            <p>Searching map data...</p>
          </div>
        )}

        {state.status === 'success' && !routes.length && (
          <div className="empty-state">
            <MapPin size={22} aria-hidden="true" />
            <p>No clear paths found. Try a shorter distance, another type, or a nearby place.</p>
          </div>
        )}

        {state.status === 'error' && (
          <div className="empty-state">
            <MapPin size={22} aria-hidden="true" />
            <p>Search failed. Try again in a moment.</p>
          </div>
        )}
      </aside>
      )}
    </main>
  )
}

export default App
