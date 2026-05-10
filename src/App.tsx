import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Drawer } from 'vaul'
import {
  Bike,
  Bookmark,
  BookmarkCheck,
  ChevronLeft,
  Copy,
  ExternalLink,
  Gauge,
  History,
  List,
  Loader2,
  LocateFixed,
  MapPin,
  Mountain,
  Navigation,
  Pencil,
  Route,
  Search,
  ShieldCheck,
  Sparkles,
  Trees,
  X,
} from 'lucide-react'
import { cn } from './lib/utils'

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

type CitySuggestionState =
  | { status: 'idle'; items: CityResult[] }
  | { status: 'loading'; items: CityResult[] }
  | { status: 'ready'; items: CityResult[] }
  | { status: 'error'; items: CityResult[] }

type NominatimResult = {
  display_name: string
  lat: string
  lon: string
  boundingbox?: string[]
}

type ReverseGeocodeResult = {
  display_name?: string
  lat?: string
  lon?: string
  boundingbox?: string[]
  address?: Record<string, string | undefined>
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
  | { status: 'success'; city: CityResult; routes: TerrainRoute[]; source?: 'cache' | 'live'; cachedAt?: number }
  | { status: 'error'; message: string }

type DrawerMode = 'search' | 'results' | 'details' | null
type LocationState = 'idle' | 'locating' | 'ready' | 'blocked' | 'error'

type RecentPlace = CityResult & {
  id: string
  usedAt: number
}

type SavedRoute = {
  id: string
  savedAt: number
  city: CityResult
  activity: ActivityMode
  terrainStyle: TerrainStyle
  route: TerrainRoute
}

type CachedRoutes = {
  key: string
  createdAt: number
  city: CityResult
  routes: TerrainRoute[]
}

const DEFAULT_CITY = ''
const LOCATION_STORAGE_KEY = 'terrain-location-enabled'
const SAVED_ROUTES_KEY = 'terrain-saved-routes'
const RECENT_PLACES_KEY = 'terrain-recent-places'
const ROUTE_CACHE_KEY = 'terrain-route-cache'
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
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

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value))
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

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )

  useEffect(() => {
    const matcher = window.matchMedia(query)
    const update = () => setMatches(matcher.matches)
    update()
    matcher.addEventListener('change', update)
    return () => matcher.removeEventListener('change', update)
  }, [query])

  return matches
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

function normalizeCityResult(result: NominatimResult): CityResult {
  const lat = Number(result.lat)
  const lon = Number(result.lon)
  const rawBox = result.boundingbox?.map(Number)
  const boundingBox =
    rawBox && rawBox.length === 4
      ? (rawBox as [number, number, number, number])
      : ([lat, lat, lon, lon] as [number, number, number, number])

  return {
    displayName: result.display_name,
    lat,
    lon,
    boundingBox,
  }
}

function compactPlaceName(place: CityResult) {
  return place.displayName.split(',').slice(0, 3).join(', ')
}

function placeId(place: CityResult) {
  return `${place.lat.toFixed(4)},${place.lon.toFixed(4)}`
}

function routeSaveId(route: TerrainRoute) {
  const start = routeStart(route)
  return `${route.id}-${start?.[0].toFixed(5) ?? 'x'}-${start?.[1].toFixed(5) ?? 'x'}-${route.distance_km.toFixed(1)}`
}

function cacheKeyFor(
  city: CityResult,
  activity: ActivityMode,
  style: TerrainStyle,
  difficulty: Difficulty,
  distance: number,
  useDistance: boolean,
  nearOrigin: LatLngTuple | null,
) {
  const origin = nearOrigin ? `${nearOrigin[0].toFixed(3)},${nearOrigin[1].toFixed(3)}` : 'city'
  return [
    placeId(city),
    activity,
    style,
    difficulty,
    useDistance ? distance : 'any',
    origin,
  ].join('|')
}

function saveRecentPlace(place: CityResult) {
  const recent = readJson<RecentPlace[]>(RECENT_PLACES_KEY, [])
  const next = [
    { ...place, id: placeId(place), usedAt: Date.now() },
    ...recent.filter((item) => item.id !== placeId(place)),
  ].slice(0, 5)
  writeJson(RECENT_PLACES_KEY, next)
  return next
}

function readRouteCache(key: string) {
  const cache = readJson<Record<string, CachedRoutes>>(ROUTE_CACHE_KEY, {})
  const cached = cache[key]
  if (!cached || Date.now() - cached.createdAt > CACHE_TTL_MS) return null
  return cached
}

function writeRouteCache(entry: CachedRoutes) {
  const cache = readJson<Record<string, CachedRoutes>>(ROUTE_CACHE_KEY, {})
  const next = Object.fromEntries(
    Object.entries({ ...cache, [entry.key]: entry })
      .sort((a, b) => b[1].createdAt - a[1].createdAt)
      .slice(0, 20),
  )
  writeJson(ROUTE_CACHE_KEY, next)
}

async function geocodeCities(
  city: string,
  limit = 5,
  signal?: AbortSignal,
): Promise<CityResult[]> {
  const params = new URLSearchParams({
    q: city,
    format: 'jsonv2',
    limit: String(limit),
    addressdetails: '1',
    dedupe: '1',
    'accept-language': 'en',
  })
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    signal,
  })
  if (!response.ok) throw new Error('City search failed.')
  const results = (await response.json()) as NominatimResult[]
  return results.map(normalizeCityResult)
}

async function geocodeCity(city: string): Promise<CityResult> {
  const [result] = await geocodeCities(city, 1)
  if (!result) throw new Error(`No city match found for "${city}".`)
  return result
}

async function reverseGeocodeLocation(lat: number, lon: number): Promise<CityResult> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lon),
    format: 'jsonv2',
    addressdetails: '1',
    zoom: '12',
    'accept-language': 'en',
  })
  const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`)
  if (!response.ok) throw new Error('Location lookup failed.')
  const result = (await response.json()) as ReverseGeocodeResult
  const address = result.address ?? {}
  const placeName =
    [address.city, address.town, address.village, address.state, address.country].filter(Boolean).join(', ') ||
    result.display_name ||
    `Current location (${lat.toFixed(4)}, ${lon.toFixed(4)})`
  const rawBox = result.boundingbox?.map(Number)
  const boundingBox =
    rawBox && rawBox.length === 4
      ? (rawBox as [number, number, number, number])
      : ([lat, lat, lon, lon] as [number, number, number, number])

  return {
    displayName: placeName,
    lat: Number(result.lat ?? lat),
    lon: Number(result.lon ?? lon),
    boundingBox,
  }
}

function getBrowserPosition(): Promise<GeolocationPosition> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('GPS is not available in this browser.'))
      return
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      maximumAge: 5 * 60 * 1000,
      timeout: 12000,
    })
  })
}

async function shouldAutoUseLocation() {
  if (!navigator.geolocation) return false
  if (window.localStorage.getItem(LOCATION_STORAGE_KEY) === '1') return true

  try {
    const permission = await navigator.permissions?.query({ name: 'geolocation' as PermissionName })
    return permission?.state === 'granted'
  } catch {
    return false
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
  nearOrigin: LatLngTuple | null,
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
      const nearUser =
        nearOrigin && haversineKm(center, nearOrigin) < 30
          ? Math.max(0.35, 1 - haversineKm(nearOrigin, way.geometry[0]) / 16)
          : 1
      return { way, value: distance * unpavedBoost * targetFit * nearCity * nearUser }
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
    .map((route, index) => ({ ...route, name: `${index + 1}. ${routeDisplayName(route, city, index)}` }))
}

function wayLabel(way: OsmWay, index: number) {
  if (way.tags.name) return way.tags.name
  return `Path ${index + 1}`
}

function routeDisplayName(route: TerrainRoute, city: CityResult, index: number) {
  if (!/^Path \d+$/.test(route.name)) return route.name
  const routeCenter = centroid(route.geometry)
  const northSouth = routeCenter[0] >= city.lat ? 'North' : 'South'
  const eastWest = routeCenter[1] >= city.lon ? 'east' : 'west'
  const surface =
    route.facts.unpavedRatio > 0.75
      ? 'dirt track'
      : route.facts.unpavedRatio > 0.35
        ? 'mixed track'
        : 'easy link'
  const terrain =
    route.elevation_gain_m / Math.max(1, route.distance_km) > 28
      ? 'climb'
      : route.facts.greenExposure > 0.35
        ? 'green route'
        : 'route'
  return `${northSouth}-${eastWest} ${surface} ${terrain} ${index + 1}`
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
    <div className="grid grid-cols-[96px_1fr_28px] items-center gap-3 text-xs font-semibold text-muted">
      <span>{label}</span>
      <div className="h-1 overflow-hidden rounded-full bg-white/15">
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${value}%` }} />
      </div>
      <strong className="text-right text-ink">{value}</strong>
    </div>
  )
}

function Metric({ icon: Icon, label, value }: { icon: typeof Route; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-2xl border border-line bg-white/[0.045] p-3">
      <Icon className="text-accent" size={17} aria-hidden="true" />
      <span className="mt-2 block text-[0.65rem] font-bold uppercase tracking-[0.08em] text-muted">{label}</span>
      <strong className="mt-0.5 block break-words text-base font-semibold capitalize text-ink">{value}</strong>
    </div>
  )
}

function routeStart(route: TerrainRoute | undefined) {
  return route?.geometry[0]
}

function routeEnd(route: TerrainRoute | undefined) {
  return route?.geometry.at(-1)
}

function formatCoords(point: LatLngTuple | undefined) {
  if (!point) return ''
  return `${point[0].toFixed(6)}, ${point[1].toFixed(6)}`
}

function googleMapsUrl(point: LatLngTuple | undefined) {
  if (!point) return '#'
  return `https://www.google.com/maps/search/?api=1&query=${point[0]},${point[1]}`
}

function googleMapsRouteUrl(start: LatLngTuple | undefined, end: LatLngTuple | undefined) {
  if (!start || !end) return '#'
  const origin = `${start[0]},${start[1]}`
  const destination = `${end[0]},${end[1]}`
  return `https://www.google.com/maps/dir/?api=1&origin=${origin}&destination=${destination}&travelmode=bicycling`
}

function App() {
  const [city, setCity] = useState(DEFAULT_CITY)
  const [selectedCity, setSelectedCity] = useState<CityResult | null>(null)
  const [cityFocused, setCityFocused] = useState(false)
  const [citySuggestionState, setCitySuggestionState] = useState<CitySuggestionState>({
    status: 'idle',
    items: [],
  })
  const [activity, setActivity] = useState<ActivityMode>('bike')
  const [terrainStyle, setTerrainStyle] = useState<TerrainStyle>('xc')
  const [distance, setDistance] = useState(32)
  const [useDistance, setUseDistance] = useState(false)
  const [difficulty, setDifficulty] = useState<Difficulty>('moderate')
  const [state, setState] = useState<SearchState>({ status: 'idle' })
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null)
  const [drawerMode, setDrawerMode] = useState<DrawerMode>('search')
  const [locationState, setLocationState] = useState<LocationState>('idle')
  const [copiedCoords, setCopiedCoords] = useState(false)
  const [currentLocation, setCurrentLocation] = useState<LatLngTuple | null>(null)
  const [preferNearMe, setPreferNearMe] = useState(true)
  const [recentPlaces, setRecentPlaces] = useState<RecentPlace[]>(() =>
    readJson<RecentPlace[]>(RECENT_PLACES_KEY, []),
  )
  const [savedRoutes, setSavedRoutes] = useState<SavedRoute[]>(() =>
    readJson<SavedRoute[]>(SAVED_ROUTES_KEY, []),
  )
  const mapElement = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const routeLayer = useRef<L.LayerGroup | null>(null)
  const fittedRouteSet = useRef('')
  const drawerBodyRef = useRef<HTMLDivElement | null>(null)
  const locationBootRef = useRef(false)
  const isMobile = useMediaQuery('(max-width: 900px)')

  const routes = useMemo(() => (state.status === 'success' ? state.routes : []), [state])
  const selectedRoute = useMemo(
    () => routes.find((route) => route.id === selectedRouteId) ?? routes[0],
    [routes, selectedRouteId],
  )
  const activeStyle = styleConfig(activity, terrainStyle)
  const selectedStart = routeStart(selectedRoute)
  const selectedEnd = routeEnd(selectedRoute)
  const selectedSaved = selectedRoute
    ? savedRoutes.some((item) => routeSaveId(item.route) === routeSaveId(selectedRoute))
    : false
  const savedRouteIds = useMemo(
    () => new Set(savedRoutes.map((item) => routeSaveId(item.route))),
    [savedRoutes],
  )

  useEffect(() => {
    drawerBodyRef.current?.scrollTo({ top: 0 })
  }, [drawerMode])

  const focusRouteOnMap = useCallback((route: TerrainRoute) => {
    if (!mapRef.current || route.geometry.length < 2) return
    const bounds = L.latLngBounds(route.geometry)
    if (bounds.isValid()) {
      mapRef.current.fitBounds(bounds, {
        paddingTopLeft: [36, 96],
        paddingBottomRight: [36, 170],
        maxZoom: 15,
      })
    }
  }, [])

  const selectRoute = useCallback((route: TerrainRoute, revealMap = true) => {
    setSelectedRouteId(route.id)
    setCopiedCoords(false)
    focusRouteOnMap(route)
    if (revealMap && isMobile) setDrawerMode(null)
  }, [focusRouteOnMap, isMobile])

  const copySelectedCoords = useCallback(async () => {
    const coords = formatCoords(selectedStart)
    if (!coords) return
    try {
      await navigator.clipboard.writeText(coords)
      setCopiedCoords(true)
      window.setTimeout(() => setCopiedCoords(false), 1600)
    } catch {
      setCopiedCoords(false)
    }
  }, [selectedStart])

  const openSavedRoute = useCallback((saved: SavedRoute) => {
    setState({ status: 'success', city: saved.city, routes: [saved.route], source: 'cache', cachedAt: saved.savedAt })
    setSelectedCity(saved.city)
    setCity(compactPlaceName(saved.city))
    setActivity(saved.activity)
    setTerrainStyle(saved.terrainStyle)
    setSelectedRouteId(saved.route.id)
    setDrawerMode(isMobile ? null : 'details')
    focusRouteOnMap(saved.route)
  }, [focusRouteOnMap, isMobile])

  const toggleSavedRoute = useCallback(() => {
    if (!selectedRoute || state.status !== 'success') return
    const savedId = routeSaveId(selectedRoute)
    setSavedRoutes((current) => {
      const exists = current.some((item) => routeSaveId(item.route) === savedId)
      const next = exists
        ? current.filter((item) => routeSaveId(item.route) !== savedId)
        : [
            {
              id: savedId,
              savedAt: Date.now(),
              city: state.city,
              activity,
              terrainStyle,
              route: selectedRoute,
            },
            ...current,
          ].slice(0, 30)
      writeJson(SAVED_ROUTES_KEY, next)
      return next
    })
  }, [activity, selectedRoute, state, terrainStyle])

  useEffect(() => {
    if (!cityFocused || selectedCity || city.trim().length < 2) {
      return
    }

    const controller = new AbortController()
    const timeout = window.setTimeout(() => {
      setCitySuggestionState((current) => ({ status: 'loading', items: current.items }))
      geocodeCities(city.trim(), 5, controller.signal)
        .then((items) => setCitySuggestionState({ status: 'ready', items }))
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === 'AbortError') return
          setCitySuggestionState({ status: 'error', items: [] })
        })
    }, 260)

    return () => {
      window.clearTimeout(timeout)
      controller.abort()
    }
  }, [city, cityFocused, selectedCity])

  const searchFromCity = useCallback(async (cityResult: CityResult) => {
    setDrawerMode('results')
    setCityFocused(false)
    setCitySuggestionState({ status: 'idle', items: [] })
    setSelectedRouteId(null)
    const recent = saveRecentPlace(cityResult)
    setRecentPlaces(recent)
    const nearOrigin =
      preferNearMe && currentLocation && haversineKm([cityResult.lat, cityResult.lon], currentLocation) < 30
        ? currentLocation
        : null
    const cacheKey = cacheKeyFor(
      cityResult,
      activity,
      terrainStyle,
      difficulty,
      distance,
      useDistance,
      nearOrigin,
    )
    const cached = readRouteCache(cacheKey)

    if (cached) {
      setState({
        status: 'success',
        city: cached.city,
        routes: cached.routes,
        source: 'cache',
        cachedAt: cached.createdAt,
      })
      setSelectedRouteId(cached.routes[0]?.id ?? null)
      setDrawerMode('results')
      if (!navigator.onLine) return
    } else {
      setState({ status: 'loading', message: 'Reading map and terrain data...' })
    }

    try {
      if (!cached) {
        setState({ status: 'loading', message: 'Checking paths, surfaces, access, and natural areas...' })
      }
      const data = await fetchObjectiveMapData(cityResult).catch(() => ({ ways: [], features: [] }))
      const generatedRoutes = generateRoutes(
        cityResult,
        data.ways,
        data.features,
        useDistance ? distance : null,
        difficulty,
        activity,
        terrainStyle,
        nearOrigin,
      )
      writeRouteCache({
        key: cacheKey,
        createdAt: Date.now(),
        city: cityResult,
        routes: generatedRoutes,
      })
      setState({ status: 'success', city: cityResult, routes: generatedRoutes, source: 'live' })
      setSelectedRouteId(generatedRoutes[0]?.id ?? null)
      setDrawerMode('results')
    } catch (error) {
      if (cached) return
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Terrain analysis failed.',
      })
      setDrawerMode('results')
    }
  }, [activity, currentLocation, difficulty, distance, preferNearMe, terrainStyle, useDistance])

  const runSearch = useCallback(async (event?: FormEvent) => {
    event?.preventDefault()
    if (!city.trim()) return

    try {
      const cityResult = selectedCity ?? (await geocodeCity(city.trim()))
      setSelectedCity(cityResult)
      setCity(compactPlaceName(cityResult))
      await searchFromCity(cityResult)
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : 'Place lookup failed.',
      })
      setDrawerMode('results')
    }
  }, [city, searchFromCity, selectedCity])

  const requestCurrentLocation = useCallback(async () => {
    setLocationState('locating')

    try {
      const position = await getBrowserPosition()
      const lat = position.coords.latitude
      const lon = position.coords.longitude
      setCurrentLocation([lat, lon])
      const cityResult = await reverseGeocodeLocation(lat, lon).catch(() => ({
        displayName: `Current location (${lat.toFixed(4)}, ${lon.toFixed(4)})`,
        lat,
        lon,
        boundingBox: [lat, lat, lon, lon] as [number, number, number, number],
      }))
      window.localStorage.setItem(LOCATION_STORAGE_KEY, '1')
      setLocationState('ready')
      setSelectedCity(cityResult)
      setCity(compactPlaceName(cityResult))
      mapRef.current?.setView([cityResult.lat, cityResult.lon], 13, { animate: true })
      await searchFromCity(cityResult)
    } catch (error) {
      window.localStorage.removeItem(LOCATION_STORAGE_KEY)
      const denied = typeof error === 'object' && error !== null && 'code' in error && error.code === 1
      setLocationState(denied ? 'blocked' : 'error')
    }
  }, [searchFromCity])

  useEffect(() => {
    if (locationBootRef.current || city.trim()) return
    locationBootRef.current = true

    shouldAutoUseLocation().then((useLocation) => {
      if (useLocation) void requestCurrentLocation()
    })
  }, [city, requestCurrentLocation])

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
      line.on('click', () => selectRoute(route, true))
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
            .on('click', () => selectRoute(route, true))
        })
      }
      route.geometry.forEach((point) => bounds.extend(point))
    })

    const routeSetKey = routes.map((route) => route.id).join('|')
    if (bounds.isValid() && routeSetKey !== fittedRouteSet.current) {
      fittedRouteSet.current = routeSetKey
      mapRef.current.fitBounds(bounds, { padding: [30, 30], maxZoom: 13 })
    }
  }, [routes, selectedRoute, selectRoute])

  const citySuggestionsVisible =
    cityFocused &&
    !selectedCity &&
    city.trim().length >= 2 &&
    (citySuggestionState.status === 'loading' || citySuggestionState.items.length > 0)

  const labelClass = 'text-[0.68rem] font-bold uppercase tracking-[0.1em] text-muted'
  const fieldClass =
    'h-12 w-full rounded-2xl border border-line bg-field px-4 text-ink transition focus-within:border-accent/70 focus-within:bg-field-strong'
  const iconButtonClass =
    'inline-grid h-9 w-9 place-items-center rounded-full border border-line bg-white/[0.06] text-muted transition hover:bg-white/[0.1] hover:text-ink'
  const primaryButtonClass =
    'inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-accent px-4 font-bold text-[#07100c] shadow-[0_14px_30px_rgba(168,236,151,0.22)] transition disabled:cursor-not-allowed disabled:opacity-45 disabled:shadow-none'
  const locationButtonText =
    locationState === 'locating'
      ? 'Finding location'
      : locationState === 'ready'
        ? 'Use current location'
        : 'Use current location'
  const locationHint =
    locationState === 'blocked'
      ? 'Location is blocked. You can still search a city.'
      : locationState === 'error'
        ? 'Could not get location. Try a city search.'
        : ''

  const searchContent = (
    <div className="flex min-h-0 flex-col gap-5">
      <div className="flex items-center gap-3">
        <Bike className="text-accent" size={24} aria-hidden="true" />
        <h1 className="text-lg font-bold uppercase tracking-[0.18em] text-ink">Terrain</h1>
      </div>

      <form className="grid gap-4" onSubmit={runSearch}>
        <div className="relative grid gap-2">
          <label className={labelClass} htmlFor="city">Place</label>
          <button
            className="flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-accent/30 bg-accent/12 px-4 text-sm font-bold text-accent transition hover:bg-accent/18 disabled:cursor-not-allowed disabled:opacity-55"
            disabled={locationState === 'locating' || state.status === 'loading'}
            onClick={requestCurrentLocation}
            type="button"
          >
            {locationState === 'locating' ? (
              <Loader2 className="animate-spin" size={18} aria-hidden="true" />
            ) : (
              <LocateFixed size={18} aria-hidden="true" />
            )}
            {locationButtonText}
          </button>
          {locationHint && <p className="m-0 text-xs font-medium text-muted">{locationHint}</p>}
          <div className={cn(fieldClass, 'grid grid-cols-[20px_1fr] items-center gap-3 px-4')}>
            <Search className="text-muted" size={18} aria-hidden="true" />
            <input
              autoComplete="off"
              className="min-w-0 border-0 bg-transparent text-ink outline-none placeholder:text-white/55"
              id="city"
              value={city}
              onBlur={() => window.setTimeout(() => setCityFocused(false), 120)}
              onChange={(event) => {
                const nextCity = event.target.value
                setCity(nextCity)
                setSelectedCity(null)
                if (nextCity.trim().length < 2) setCitySuggestionState({ status: 'idle', items: [] })
              }}
              onFocus={() => setCityFocused(true)}
              placeholder="Search a city"
            />
          </div>
          {citySuggestionsVisible && (
            <div className="grid gap-1 rounded-2xl border border-line bg-black/25 p-1.5" role="listbox">
              {citySuggestionState.items.map((place) => (
                <button
                  className="grid gap-0.5 rounded-xl px-3 py-2.5 text-left text-ink transition hover:bg-accent/10"
                  key={`${place.lat}-${place.lon}-${place.displayName}`}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setSelectedCity(place)
                    setCity(compactPlaceName(place))
                    setCitySuggestionState({ status: 'idle', items: [] })
                    setCityFocused(false)
                  }}
                  type="button"
                >
                  <strong className="text-sm font-semibold">{place.displayName.split(',')[0]}</strong>
                  <span className="text-xs font-medium text-muted">{place.displayName.split(',').slice(1, 4).join(', ')}</span>
                </button>
              ))}
              {citySuggestionState.status === 'loading' && (
                <div className="px-3 py-2 text-xs font-medium text-muted">Searching...</div>
              )}
            </div>
          )}
          {currentLocation && (
            <button
              className={cn(
                'flex h-10 items-center justify-between rounded-2xl border border-line bg-white/[0.04] px-3 text-sm font-semibold text-muted transition hover:bg-white/[0.08]',
                preferNearMe && 'border-accent/35 bg-accent/10 text-accent',
              )}
              onClick={() => setPreferNearMe((value) => !value)}
              type="button"
            >
              <span className="inline-flex items-center gap-2">
                <Sparkles size={15} aria-hidden="true" />
                Start near me
              </span>
              <span>{preferNearMe ? 'On' : 'Off'}</span>
            </button>
          )}
          {(recentPlaces.length > 0 || savedRoutes.length > 0) && (
            <div className="grid gap-2 pt-1">
              {recentPlaces.length > 0 && (
                <div className="grid gap-1.5">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-muted">
                    <History size={14} aria-hidden="true" />
                    Recent
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {recentPlaces.map((place) => (
                      <button
                        className="shrink-0 rounded-full border border-line bg-white/[0.05] px-3 py-2 text-xs font-semibold text-ink"
                        key={place.id}
                        onClick={() => {
                          setSelectedCity(place)
                          setCity(compactPlaceName(place))
                          void searchFromCity(place)
                        }}
                        type="button"
                      >
                        {place.displayName.split(',')[0]}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {savedRoutes.length > 0 && (
                <div className="grid gap-1.5">
                  <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.08em] text-muted">
                    <BookmarkCheck size={14} aria-hidden="true" />
                    Saved
                  </div>
                  <div className="grid gap-1">
                    {savedRoutes.slice(0, 3).map((saved) => (
                      <button
                        className="flex min-w-0 items-center justify-between gap-3 rounded-2xl border border-line bg-white/[0.04] px-3 py-2.5 text-left"
                        key={saved.id}
                        onClick={() => openSavedRoute(saved)}
                        type="button"
                      >
                        <span className="min-w-0">
                          <strong className="block truncate text-sm font-semibold text-ink">
                            {saved.route.name.replace(/^\d+\.\s/, '')}
                          </strong>
                          <span className="block truncate text-xs font-medium text-muted">
                            {km(saved.route.distance_km)} / {compactPlaceName(saved.city)}
                          </span>
                        </span>
                        <Navigation className="shrink-0 text-muted" size={16} aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <fieldset className="grid gap-2">
          <legend className={labelClass}>Move</legend>
          <div className="grid h-11 grid-cols-2 overflow-hidden rounded-2xl border border-line bg-white/[0.035]">
            {(['bike', 'run'] as ActivityMode[]).map((mode) => (
              <button
                className={cn('font-semibold text-muted transition', activity === mode && 'bg-accent text-[#07100c]')}
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

        <div className="grid gap-2">
          <label className={labelClass} htmlFor="style">Type</label>
          <select
            className={fieldClass}
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
              <option className="text-slate-950" key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <label className={labelClass} htmlFor="use-distance">Distance</label>
            <button
              className={cn(
                'h-9 min-w-16 rounded-full border border-line px-4 text-sm font-bold text-muted',
                useDistance && 'border-transparent bg-accent text-[#07100c]',
              )}
              id="use-distance"
              onClick={() => {
                const next = !useDistance
                setUseDistance(next)
                if (next) setDistance(clamp(distance, activeStyle.range[0], activeStyle.range[1]))
              }}
              type="button"
            >
              {useDistance ? km(distance) : 'Off'}
            </button>
          </div>
          {useDistance && (
            <input
              className="w-full accent-accent"
              id="distance"
              type="range"
              min={activeStyle.range[0]}
              max={activeStyle.range[1]}
              value={distance}
              onChange={(event) => setDistance(Number(event.target.value))}
            />
          )}
        </div>

        <fieldset className="grid gap-2">
          <legend className={labelClass}>Effort</legend>
          <div className="grid h-11 grid-cols-3 overflow-hidden rounded-2xl border border-line bg-white/[0.035]">
            {(['easy', 'moderate', 'hard'] as Difficulty[]).map((level) => (
              <button
                className={cn('font-semibold capitalize text-muted transition', difficulty === level && 'bg-accent text-[#07100c]')}
                key={level}
                onClick={() => setDifficulty(level)}
                type="button"
              >
                {level}
              </button>
            ))}
          </div>
        </fieldset>

        <button className={primaryButtonClass} disabled={state.status === 'loading' || !city.trim()} type="submit">
          {state.status === 'loading' ? (
            <Loader2 className="animate-spin" size={18} aria-hidden="true" />
          ) : (
            <Navigation size={18} aria-hidden="true" />
          )}
          Find paths
        </button>
      </form>
    </div>
  )

  const emptyContent = (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-white/[0.04] p-4 text-muted">
      {state.status === 'loading' ? <Loader2 className="animate-spin text-accent" size={22} /> : <MapPin className="text-accent" size={22} />}
      <p className="m-0 text-sm font-medium">
        {state.status === 'loading'
          ? state.message
          : state.status === 'error'
            ? 'Search failed. Try again in a moment.'
            : 'No clear paths found. Try another type or nearby place.'}
      </p>
    </div>
  )

  const routeList = (
    <div className="grid gap-2">
      {routes.map((route, index) => (
        <div
          className={cn(
            'grid grid-cols-[4px_1fr_auto] items-center gap-3 rounded-2xl border border-line bg-white/[0.04] p-3 text-ink transition hover:border-accent/45 hover:bg-accent/10',
            selectedRoute?.id === route.id && 'border-accent/65 bg-accent/12',
          )}
          key={route.id}
        >
          <span className="h-11 rounded-full" style={{ background: routeColors[index % routeColors.length] }} />
          <button className="min-w-0 text-left" onClick={() => selectRoute(route)} type="button">
            <strong className="block truncate text-sm font-semibold">{route.name.replace(/^\d+\.\s/, '')}</strong>
            <span className="mt-1 block text-xs font-medium capitalize text-muted">
              {route.score_total} score / {km(route.distance_km)} / {route.difficulty}
            </span>
          </button>
          <button
            className={cn(
              'inline-grid h-9 w-9 place-items-center rounded-full border border-line bg-white/[0.05] text-muted transition hover:bg-white/[0.1]',
              savedRouteIds.has(routeSaveId(route)) && 'border-accent/45 bg-accent/12 text-accent',
            )}
            onClick={() => {
              const savedId = routeSaveId(route)
              setSavedRoutes((current) => {
                const exists = current.some((item) => routeSaveId(item.route) === savedId)
                const next = exists
                  ? current.filter((item) => routeSaveId(item.route) !== savedId)
                  : state.status === 'success'
                    ? [
                        {
                          id: savedId,
                          savedAt: Date.now(),
                          city: state.city,
                          activity,
                          terrainStyle,
                          route,
                        },
                        ...current,
                      ].slice(0, 30)
                    : current
                writeJson(SAVED_ROUTES_KEY, next)
                return next
              })
            }}
            type="button"
            aria-label={savedRouteIds.has(routeSaveId(route)) ? 'Remove saved path' : 'Save path'}
          >
            {savedRouteIds.has(routeSaveId(route)) ? (
              <BookmarkCheck size={17} aria-hidden="true" />
            ) : (
              <Bookmark size={17} aria-hidden="true" />
            )}
          </button>
        </div>
      ))}
    </div>
  )

  const resultsContent = (
    <div className="flex min-h-0 flex-col gap-4">
      <header className="flex items-center justify-between gap-3">
        <button className={iconButtonClass} onClick={() => setDrawerMode('search')} type="button" aria-label="Edit search">
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold text-ink">Paths</h2>
          {state.status === 'success' && (
            <p className="truncate text-xs font-medium text-muted">
              {compactPlaceName(state.city)}
              {state.source === 'cache' ? ' / saved earlier' : ''}
            </p>
          )}
        </div>
      </header>

      {routes.length > 0 ? routeList : emptyContent}
    </div>
  )

  const actionButtonClass =
    'inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-2xl border border-line bg-white/[0.06] px-2 text-sm font-semibold text-ink transition hover:bg-white/[0.1]'

  const detailsContent = selectedRoute && (
    <div className="flex min-h-0 flex-col gap-4">
      <header className="flex items-start gap-3 pr-12">
        <button className={iconButtonClass} onClick={() => setDrawerMode('results')} type="button" aria-label="Back to paths">
          <ChevronLeft size={18} aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-lg font-bold text-ink">{selectedRoute.name.replace(/^\d+\.\s/, '')}</h2>
            <strong className="shrink-0 rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-sm font-bold leading-none text-accent">
              {selectedRoute.score_total}
            </strong>
          </div>
          <p className="mt-1 truncate text-xs font-medium text-muted">{formatCoords(selectedStart)}</p>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-2">
        <Metric icon={Route} label="Distance" value={km(selectedRoute.distance_km)} />
        <Metric icon={Mountain} label="Gain" value={`${selectedRoute.elevation_gain_m} m`} />
        <Metric icon={Gauge} label="Effort" value={selectedRoute.difficulty} />
        <Metric icon={Trees} label="Green" value={pct(selectedRoute.facts.greenExposure)} />
      </div>

      <div className="grid grid-cols-4 gap-2">
        <button
          className={cn(actionButtonClass, selectedSaved && 'border-accent/45 bg-accent/12 text-accent')}
          onClick={toggleSavedRoute}
          type="button"
        >
          {selectedSaved ? <BookmarkCheck size={17} aria-hidden="true" /> : <Bookmark size={17} aria-hidden="true" />}
          {selectedSaved ? 'Saved' : 'Save'}
        </button>
        <button className={actionButtonClass} onClick={copySelectedCoords} type="button">
          <Copy size={17} aria-hidden="true" />
          {copiedCoords ? 'Copied' : 'GPS'}
        </button>
        <a className={actionButtonClass} href={googleMapsUrl(selectedStart)} target="_blank" rel="noreferrer">
          <ExternalLink size={17} aria-hidden="true" />
          Start
        </a>
        <a className="inline-flex h-11 min-w-0 items-center justify-center gap-1.5 rounded-2xl bg-accent px-2 text-sm font-bold text-[#07100c]" href={googleMapsRouteUrl(selectedStart, selectedEnd)} target="_blank" rel="noreferrer">
          <Navigation size={17} aria-hidden="true" />
          Route
        </a>
      </div>

      <div className="grid gap-3">
        <ScoreBar label="Fit" value={selectedRoute.score_breakdown.rideability} />
        <ScoreBar label="Terrain" value={selectedRoute.score_breakdown.xc_character} />
        <ScoreBar label="Nature" value={selectedRoute.score_breakdown.scenic_interest} />
        <ScoreBar label="Roads" value={selectedRoute.score_breakdown.safety_comfort} />
      </div>

      <ul className="grid gap-2 border-t border-line pt-3 text-sm font-medium text-ink">
        {selectedRoute.objective_reasons.slice(0, 3).map((reason) => (
          <li className="flex items-center gap-2" key={reason}>
            <ShieldCheck className="shrink-0 text-accent" size={15} aria-hidden="true" />
            {reason}
          </li>
        ))}
      </ul>
    </div>
  )

  const mobileDrawer = (
    <Drawer.Root
      direction="bottom"
      dismissible
      fixed
      modal={false}
      open={drawerMode !== null}
      repositionInputs={false}
      shouldScaleBackground={false}
      onOpenChange={(open) => {
        if (!open) setDrawerMode(null)
      }}
    >
      <Drawer.Portal>
        <Drawer.Content key={drawerMode} className="drawer-panel glass-panel" aria-label="Terrain drawer">
          <div className="flex shrink-0 items-center justify-center px-4 pt-2">
            <Drawer.Handle className="h-1.5 w-14 rounded-full bg-white/35" />
          </div>
          <Drawer.Title className="sr-only">Terrain</Drawer.Title>
          <Drawer.Description className="sr-only">Search, browse paths, and inspect route details.</Drawer.Description>
          <button
            className="absolute right-4 top-4 inline-grid h-9 w-9 place-items-center rounded-full border border-line bg-white/[0.06] text-muted transition hover:bg-white/[0.1] hover:text-ink"
            onClick={() => setDrawerMode(null)}
            type="button"
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
          <div ref={drawerBodyRef} className="min-h-0 overflow-y-auto overscroll-contain px-4 pt-3 safe-bottom">
            {drawerMode === 'search' && searchContent}
            {drawerMode === 'results' && resultsContent}
            {drawerMode === 'details' && detailsContent}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  )

  return (
    <main className="relative h-dvh min-h-svh overflow-hidden bg-[#07100c] text-ink">
      <section className="absolute inset-0 overflow-hidden" aria-label="Route map">
        <div ref={mapElement} className="absolute inset-0" />
      </section>

      {!isMobile && (
        <>
          <aside className="glass-panel absolute left-5 top-5 z-[460] flex max-h-[calc(100dvh-40px)] w-[360px] flex-col overflow-y-auto rounded-[28px] p-5" aria-label="Route search">
            {searchContent}
          </aside>
          {state.status !== 'idle' && (
            <aside className="glass-panel absolute right-5 top-5 z-[460] flex max-h-[calc(100dvh-40px)] w-[380px] flex-col overflow-y-auto rounded-[28px] p-5" aria-label="Paths">
              {resultsContent}
              {selectedRoute && <div className="mt-5 border-t border-line pt-5">{detailsContent}</div>}
            </aside>
          )}
        </>
      )}

      {state.status === 'loading' && (
        <div className="pointer-events-none absolute left-3 right-3 top-[max(14px,env(safe-area-inset-top))] z-[455] flex justify-center">
          <span className="glass-panel inline-flex max-w-full items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold text-muted">
            <Loader2 className="animate-spin text-accent" size={16} aria-hidden="true" />
            <span className="truncate">{state.message}</span>
          </span>
        </div>
      )}

      {isMobile && mobileDrawer}

      {isMobile && drawerMode === null && selectedRoute && state.status === 'success' && (
        <div className="glass-panel fixed inset-x-3 z-[1200] rounded-[24px] p-3 bottom-[max(8px,env(safe-area-inset-bottom))]">
          <div className="flex items-center gap-3">
            <button className="min-w-0 flex-1 text-left" onClick={() => setDrawerMode('details')} type="button">
              <strong className="block truncate text-sm font-semibold text-ink">{selectedRoute.name.replace(/^\d+\.\s/, '')}</strong>
              <span className="text-xs font-medium text-muted">{km(selectedRoute.distance_km)} / {selectedRoute.difficulty} / {formatCoords(selectedStart)}</span>
            </button>
            <button className={iconButtonClass} onClick={() => setDrawerMode('results')} type="button" aria-label="Paths">
              <List size={18} aria-hidden="true" />
            </button>
            <button className={cn(iconButtonClass, selectedSaved && 'border-accent/45 bg-accent/12 text-accent')} onClick={toggleSavedRoute} type="button" aria-label={selectedSaved ? 'Remove saved path' : 'Save path'}>
              {selectedSaved ? <BookmarkCheck size={18} aria-hidden="true" /> : <Bookmark size={18} aria-hidden="true" />}
            </button>
            <a className={iconButtonClass} href={googleMapsUrl(selectedStart)} target="_blank" rel="noreferrer" aria-label="Open start in Google Maps">
              <ExternalLink size={18} aria-hidden="true" />
            </a>
            <a className={iconButtonClass} href={googleMapsRouteUrl(selectedStart, selectedEnd)} target="_blank" rel="noreferrer" aria-label="Open route in Google Maps">
              <Navigation size={18} aria-hidden="true" />
            </a>
          </div>
        </div>
      )}

      {isMobile && drawerMode === null && state.status === 'idle' && (
        <button className="fixed left-1/2 z-[1200] inline-flex h-12 min-w-32 -translate-x-1/2 items-center justify-center gap-2 rounded-full bg-accent px-5 font-bold text-[#07100c] shadow-panel bottom-[max(12px,calc(env(safe-area-inset-bottom)+8px))]" onClick={() => setDrawerMode('search')} type="button">
          <Search size={17} aria-hidden="true" />
          Search
        </button>
      )}

      {isMobile && drawerMode === null && state.status !== 'idle' && !selectedRoute && (
        <button className="fixed left-1/2 z-[1200] inline-flex h-12 min-w-32 -translate-x-1/2 items-center justify-center gap-2 rounded-full bg-accent px-5 font-bold text-[#07100c] shadow-panel bottom-[max(12px,calc(env(safe-area-inset-bottom)+8px))]" onClick={() => setDrawerMode('results')} type="button">
          <Route size={17} aria-hidden="true" />
          Paths
        </button>
      )}

      {isMobile && drawerMode === null && state.status !== 'idle' && (
        <button className="fixed left-3 top-[max(14px,env(safe-area-inset-top))] z-[1200] inline-flex h-10 items-center gap-2 rounded-full border border-line bg-black/35 px-3 text-sm font-semibold text-ink backdrop-blur-xl" onClick={() => setDrawerMode('search')} type="button">
          <Pencil size={15} aria-hidden="true" />
          Edit
        </button>
      )}
    </main>
  )
}

export default App
