import 'maplibre-gl/dist/maplibre-gl.css';

import {
	BUBBLE_MAX_RADIUS,
	bubbleLegendValues,
	buildChoroplethEntries,
	buildChoroplethLegend,
	buildChoroplethScale,
	buildMapLines,
	CHOROPLETH_MIN_OPACITY,
	choroplethOpacity,
	choroplethOpacityExpression,
	choroplethTooltipKeys,
	computeMapBounds,
	DEFAULT_MARKER_COLOR,
	DEFAULT_MARKER_RADIUS,
	formatCompactNumber,
	indexBoundaries,
	labelize,
	LINE_ARROW_IMAGE_LENGTH,
	LINE_ARROW_IMAGE_PIXEL_RATIO,
	LINE_OPACITY,
	lineArrowImage,
	lineTooltipKeys,
	lineWidthLegend,
	mapLinesBounds,
	MAX_MAP_LINES,
	numericDomain,
	parseNumericValue,
	pointTooltipKeys,
	resolveBoundary,
	scaleBubbleRadius,
	visibleMapLines,
	withOpacity,
} from '@nao/shared';
import { useQuery } from '@tanstack/react-query';
import { formatRgb } from 'culori';
import { memo, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type {
	ChoroplethEntry,
	ChoroplethLegendClass,
	ChoroplethLegendModel,
	ChoroplethLegendTick,
	ChoroplethScale,
	CustomBoundarySet,
	LineWidthLegendItem,
	MapBounds,
	MapFeatureCollection as FeatureCollection,
	MapGeometry,
	MapLine,
	MapPoint,
	NumericDomain,
} from '@nao/shared';
import type { displayMap } from '@nao/shared/tools';
import type { DataDrivenPropertyValueSpecification } from 'maplibre-gl';
import type { Ref } from 'react';

import { Skeleton } from '@/components/ui/skeleton';
import { useMapSlot } from '@/hooks/use-map-slot';
import { getMapStyle, isMapStyleDark, MAP_STYLE_LIGHT, resolveStyleUrl, useMapStyle } from '@/hooks/use-map-style';
import { getActiveProjectId } from '@/lib/active-project';
import { resolveCssVariableColor } from '@/lib/css-color';
import { maplibregl } from '@/lib/maplibre';
import { trpc } from '@/main';

const POINTS_SOURCE_ID = 'query-points';
const POINTS_LAYER_ID = 'query-points-circles';
const REGIONS_SOURCE_ID = 'query-regions';
const REGIONS_FILL_ID = 'query-regions-fill';
const REGIONS_LINE_ID = 'query-regions-line';
const LINES_SOURCE_ID = 'query-lines';
const LINES_LAYER_ID = 'query-lines-line';
const LINES_HIT_LAYER_ID = 'query-lines-hit';
const LINE_HIT_PADDING = 8;
const LINE_ARROWS_SOURCE_ID = 'query-line-arrows';
const LINE_ARROWS_LAYER_ID = 'query-line-arrows';
const LINE_ARROW_IMAGE_ID = 'nao-line-arrow';
const POINT_STROKE_WIDTH = 1;
const NO_BOUNDARIES: CustomBoundarySet[] = [];

export interface MapViewHandle {
	captureImage: (type?: string) => Promise<string | null>;
	resize: () => void;
}

interface MapViewProps {
	points: MapPoint[];
	rows: Record<string, unknown>[];
	config: displayMap.Input;
	ref?: Ref<MapViewHandle>;
	/** Boundary sets injected by unauthenticated hosts (e.g. public embeds) instead of the protected project query. */
	customBoundaries?: CustomBoundarySet[];
	boundaryProjectId?: string | null;
}

type MapCamera = Required<Pick<maplibregl.CameraOptions, 'center' | 'zoom' | 'bearing' | 'pitch'>>;

export default memo(function MapView({
	points,
	config,
	rows,
	ref,
	customBoundaries: injectedBoundaries,
	boundaryProjectId,
}: MapViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const mapRef = useRef<maplibregl.Map | null>(null);
	const configRef = useRef(config);
	const pointsRef = useRef(points);
	const colorRef = useRef(DEFAULT_MARKER_COLOR);
	const themeRef = useRef<MapSurfaceTheme | undefined>(undefined);
	const styleUrlRef = useRef('');
	const savedCameraRef = useRef<MapCamera | null>(null);
	const [slotElement, setSlotElement] = useState<HTMLDivElement | null>(null);
	const { isLive, isPaused, pause, resume } = useMapSlot(slotElement);
	const [initFailed, setInitFailed] = useState(false);
	const [color, setColor] = useState(DEFAULT_MARKER_COLOR);
	const [surfaceTheme, setSurfaceTheme] = useState<MapSurfaceTheme>(() => resolveMapSurfaceTheme(null));
	const isDark = useIsDark();
	const [styleId] = useMapStyle();

	const isChoropleth = config.map_type === 'choropleth';
	const isBubble = config.map_type === 'scatter_bubble';
	const isLines = config.map_type === 'lines';

	const { data: fetchedBoundaries = NO_BOUNDARIES } = useQuery({
		...trpc.project.getMapBoundaries.queryOptions(),
		enabled: injectedBoundaries === undefined,
	});
	const customBoundaries = injectedBoundaries ?? fetchedBoundaries;
	const resolvedBoundary = useMemo(() => {
		if (!isChoropleth) {
			return null;
		}
		if (config.boundaries_url) {
			const proxied = `/api/map-boundaries/proxy?url=${encodeURIComponent(config.boundaries_url)}`;
			const joinProps = config.boundaries_join_property ? [config.boundaries_join_property] : undefined;
			return { url: proxied, joinProps };
		}
		if (!config.region_boundaries) {
			return null;
		}
		const key = config.region_boundaries;
		const custom = customBoundaries.find((s) => s.key === key);
		if (custom) {
			const projectId = boundaryProjectId ?? getActiveProjectId();
			const url = projectId ? `/api/map-boundaries/${projectId}/${key}` : custom.url;
			return { url, joinProps: [custom.joinProperty] };
		}
		const builtins = resolveBoundary(key);
		if (builtins) {
			const url =
				key === 'world_countries'
					? import.meta.env.VITE_MAP_BOUNDARIES_WORLD_URL || builtins.url
					: import.meta.env.VITE_MAP_BOUNDARIES_FRANCE_URL || builtins.url;
			return { url, joinProps: builtins.joinProps };
		}
		return null;
	}, [
		isChoropleth,
		config.boundaries_url,
		config.boundaries_join_property,
		config.region_boundaries,
		customBoundaries,
		boundaryProjectId,
	]);
	const boundaries = useBoundaries(resolvedBoundary?.url);
	const choroplethEntries = useMemo(
		() => (isChoropleth ? buildChoroplethEntries(rows, config) : []),
		[isChoropleth, rows, config],
	);
	const choroplethScale = useMemo(
		() => buildChoroplethScale(choroplethEntries, config.color_scale),
		[choroplethEntries, config.color_scale],
	);
	const regions = useMemo<FeatureCollection>(
		() =>
			isChoropleth
				? buildRegionFeatures(
						choroplethEntries,
						config,
						boundaries,
						choroplethScale,
						resolvedBoundary?.joinProps,
					)
				: emptyCollection(),
		[isChoropleth, choroplethEntries, config, boundaries, choroplethScale, resolvedBoundary],
	);
	const sizeDomain = useMemo(
		() =>
			isBubble ? numericDomain(points.map((point) => parseNumericValue(point.row[config.size_key ?? '']))) : null,
		[isBubble, points, config.size_key],
	);
	const allLines = useMemo(() => (isLines ? buildMapLines(rows, config) : []), [isLines, rows, config]);
	const visibleLines = useMemo(() => visibleMapLines(allLines), [allLines]);
	const lineFeatures = useMemo(() => buildLineFeatures(visibleLines, config), [visibleLines, config]);
	const lineArrowFeatures = useMemo(() => buildLineArrowFeatures(visibleLines), [visibleLines]);
	const lineLegend = useMemo(() => lineWidthLegend(visibleLines), [visibleLines]);
	const lineBounds = useMemo(() => mapLinesBounds(visibleLines), [visibleLines]);

	const regionsRef = useRef(regions);
	const choroplethScaleRef = useRef(choroplethScale);
	const sizeDomainRef = useRef(sizeDomain);
	const lineFeaturesRef = useRef(lineFeatures);
	const lineArrowFeaturesRef = useRef(lineArrowFeatures);
	const lineLegendRef = useRef(lineLegend);
	const lineBoundsRef = useRef(lineBounds);
	configRef.current = config;
	pointsRef.current = points;
	regionsRef.current = regions;
	choroplethScaleRef.current = choroplethScale;
	sizeDomainRef.current = sizeDomain;
	lineFeaturesRef.current = lineFeatures;
	lineArrowFeaturesRef.current = lineArrowFeatures;
	lineLegendRef.current = lineLegend;
	lineBoundsRef.current = lineBounds;

	useImperativeHandle(
		ref,
		() => ({
			captureImage: async (type = 'image/png') => {
				const map = mapRef.current;
				if (!map) {
					return null;
				}
				const currentConfig = configRef.current;
				const domains = {
					choropleth: choroplethScaleRef.current,
					size: sizeDomainRef.current,
					lines: lineLegendRef.current,
				};
				if (styleUrlRef.current === MAP_STYLE_LIGHT) {
					map.redraw();
					return composeLegendUrl(map.getCanvas(), currentConfig, domains, colorRef.current, type);
				}
				return captureLightSnapshot({
					live: map,
					config: currentConfig,
					domains,
					points: pointsRef.current,
					regions: regionsRef.current,
					lines: lineFeaturesRef.current,
					lineArrows: lineArrowFeaturesRef.current,
					type,
				});
			},
			resize: () => {
				mapRef.current?.resize();
			},
		}),
		[],
	);

	useEffect(() => {
		if (!isLive || !containerRef.current) {
			return;
		}

		const styleUrl = resolveStyleUrl(getMapStyle(), document.documentElement.classList.contains('dark'));
		styleUrlRef.current = styleUrl;

		let map: maplibregl.Map;
		try {
			map = new maplibregl.Map({
				container: containerRef.current,
				style: styleUrl,
				cooperativeGestures: true,
				attributionControl: { compact: true },
				canvasContextAttributes: { preserveDrawingBuffer: true },
			});
		} catch {
			setInitFailed(true);
			return;
		}
		mapRef.current = map;
		let hasLoadedStyle = false;
		map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
		map.on('resize', () => clampMinZoom(map));
		map.on('webglcontextlost', pause);

		map.on('style.load', () => {
			hasLoadedStyle = true;
			clampMinZoom(map);
			const savedCamera = savedCameraRef.current;
			savedCameraRef.current = null;
			withMapStyleTheme(() => {
				const resolved = resolveMarkerColor(configRef.current.color, containerRef.current);
				colorRef.current = resolved;
				setColor(resolved);
				if (configRef.current.map_type === 'choropleth') {
					setupRegionLayers(
						map,
						resolved,
						containerRef.current,
						choroplethScaleRef.current,
						regionsRef.current,
					);
				} else if (configRef.current.map_type === 'lines') {
					setupLineLayers(map, resolved, lineFeaturesRef.current, lineArrowFeaturesRef.current);
				} else {
					const data = toGeoJsonPoints(pointsRef.current, configRef.current, sizeDomainRef.current);
					setupPointLayers(map, resolved, containerRef.current, configRef.current, data);
				}
			});
			if (savedCamera) {
				map.jumpTo(savedCamera);
			} else if (configRef.current.map_type === 'choropleth') {
				fitToCollection(map, regionsRef.current);
			} else if (configRef.current.map_type === 'lines') {
				fitToBounds(map, lineBoundsRef.current);
			} else {
				fitToPoints(map, pointsRef.current);
			}
		});

		setupTooltip(map, () => configRef.current, {
			getPoint: (index) => pointsRef.current[index],
			getColor: () => colorRef.current,
			getTheme: () => themeRef.current ?? resolveMapSurfaceTheme(map.getContainer()),
		});

		return () => {
			if (hasLoadedStyle) {
				savedCameraRef.current = readCamera(map);
			}
			mapRef.current = null;
			map.remove();
		};
	}, [isLive, pause]);

	useEffect(() => {
		const map = mapRef.current;
		const styleUrl = resolveStyleUrl(styleId, isDark);
		if (!map || styleUrl === styleUrlRef.current) {
			return;
		}
		styleUrlRef.current = styleUrl;
		map.setStyle(styleUrl);
	}, [isDark, styleId]);

	useEffect(() => {
		const element = containerRef.current;
		if (!element) {
			return;
		}
		const theme = resolveMapSurfaceTheme(element);
		themeRef.current = theme;
		setSurfaceTheme(theme);
		applyControlTheme(element, theme);
	}, [isDark, styleId]);

	useEffect(() => {
		savedCameraRef.current = null;
		const map = mapRef.current;
		if (!map) {
			return;
		}
		if (isChoropleth) {
			const source = map.getSource(REGIONS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
			if (!source) {
				return;
			}
			source.setData(regions);
			applyChoroplethPaint(map, choroplethScale);
			fitToCollection(map, regions);
			return;
		}
		if (isLines) {
			const source = map.getSource(LINES_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
			if (!source) {
				return;
			}
			source.setData(lineFeatures);
			syncLineArrowLayer(map, colorRef.current, lineArrowFeatures);
			fitToBounds(map, lineBounds);
			return;
		}
		const source = map.getSource(POINTS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
		if (!source) {
			return;
		}
		source.setData(toGeoJsonPoints(points, config, sizeDomain));
		fitToPoints(map, points);
	}, [
		points,
		regions,
		isChoropleth,
		isLines,
		lineFeatures,
		lineArrowFeatures,
		lineBounds,
		choroplethScale,
		sizeDomain,
		config,
	]);

	const { color: configColor, radius: configRadius } = config;
	useEffect(() => {
		const map = mapRef.current;
		if (!map) {
			return;
		}
		withMapStyleTheme(() => {
			const resolved = resolveMarkerColor(configColor, containerRef.current);
			colorRef.current = resolved;
			setColor(resolved);
			if (isChoropleth && map.getLayer(REGIONS_FILL_ID)) {
				map.setPaintProperty(REGIONS_FILL_ID, 'fill-color', resolved);
				map.setPaintProperty(
					REGIONS_LINE_ID,
					'line-color',
					resolveCssColor('--border', resolved, containerRef.current),
				);
				return;
			}
			if (isLines && map.getLayer(LINES_LAYER_ID)) {
				map.setPaintProperty(LINES_LAYER_ID, 'line-color', resolved);
				if (map.getLayer(LINE_ARROWS_LAYER_ID)) {
					map.setPaintProperty(LINE_ARROWS_LAYER_ID, 'icon-color', resolved);
				}
				return;
			}
			if (!isChoropleth && map.getLayer(POINTS_LAYER_ID)) {
				map.setPaintProperty(POINTS_LAYER_ID, 'circle-color', resolved);
				map.setPaintProperty(POINTS_LAYER_ID, 'circle-radius', pointRadiusExpression(config));
				map.setPaintProperty(
					POINTS_LAYER_ID,
					'circle-stroke-color',
					resolveCssColor('--background', '#ffffff', containerRef.current),
				);
			}
		});
	}, [configColor, configRadius, isDark, styleId, isChoropleth, isLines, config]);

	if (initFailed) {
		return (
			<div className='my-2 text-foreground/50 text-sm'>
				Interactive maps are not supported in this browser (WebGL unavailable).
			</div>
		);
	}

	return (
		<div ref={setSlotElement} className='relative'>
			<div ref={containerRef} className='w-full aspect-3/2 rounded-lg overflow-hidden' />
			{!isLive && <MapPlaceholder isPaused={isPaused} onReload={resume} />}
			{isChoropleth && choroplethScale && (
				<ChoroplethLegend color={color} scale={choroplethScale} theme={surfaceTheme} />
			)}
			{isBubble && sizeDomain && (
				<BubbleLegend
					color={color}
					domain={sizeDomain}
					maxRadius={config.radius ?? BUBBLE_MAX_RADIUS}
					theme={surfaceTheme}
				/>
			)}
			{isLines && lineLegend.length > 0 && (
				<LineWidthLegend color={color} items={lineLegend} theme={surfaceTheme} />
			)}
			{allLines.length > MAX_MAP_LINES && (
				<span className='absolute top-2 left-2 rounded-md bg-background/90 px-2 py-1 text-xs text-foreground/60 shadow-sm'>
					Showing the {MAX_MAP_LINES.toLocaleString()} largest of {allLines.length.toLocaleString()} lines.
				</span>
			)}
		</div>
	);
});

function MapPlaceholder({ isPaused, onReload }: { isPaused: boolean; onReload: () => void }) {
	if (!isPaused) {
		return <Skeleton className='absolute inset-0' />;
	}
	return (
		<button
			type='button'
			onClick={onReload}
			className='absolute inset-0 flex items-center justify-center rounded-lg bg-accent text-sm text-foreground/60 hover:text-foreground'
		>
			Map paused, click to reload
		</button>
	);
}

function readCamera(map: maplibregl.Map): MapCamera {
	return { center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
}

function setupPointLayers(
	map: maplibregl.Map,
	color: string,
	element: HTMLElement | null,
	config: displayMap.Input,
	data: FeatureCollection,
) {
	map.addSource(POINTS_SOURCE_ID, { type: 'geojson', data });
	map.addLayer({
		id: POINTS_LAYER_ID,
		type: 'circle',
		source: POINTS_SOURCE_ID,
		paint: {
			'circle-radius': pointRadiusExpression(config),
			'circle-color': color,
			'circle-opacity': 0.9,
			'circle-stroke-width': POINT_STROKE_WIDTH,
			'circle-stroke-color': resolveCssColor('--background', '#ffffff', element),
		},
	});
}

/** A transparent, wider copy of the lines receives the hover events, since a 1px line is hard to point at. */
function setupLineLayers(map: maplibregl.Map, color: string, data: FeatureCollection, arrows: FeatureCollection) {
	map.addSource(LINES_SOURCE_ID, { type: 'geojson', data });
	map.addLayer({
		id: LINES_LAYER_ID,
		type: 'line',
		source: LINES_SOURCE_ID,
		layout: { 'line-cap': 'round', 'line-join': 'round', 'line-sort-key': ['get', 'index'] },
		paint: { 'line-color': color, 'line-width': ['get', 'width'], 'line-opacity': LINE_OPACITY },
	});
	map.addLayer({
		id: LINES_HIT_LAYER_ID,
		type: 'line',
		source: LINES_SOURCE_ID,
		paint: { 'line-color': color, 'line-width': ['+', ['get', 'width'], LINE_HIT_PADDING], 'line-opacity': 0 },
	});
	syncLineArrowLayer(map, color, arrows);
}

/** Adds the arrow layer under the hover layer the first time a line has an arrow, and updates it afterwards. */
function syncLineArrowLayer(map: maplibregl.Map, color: string, arrows: FeatureCollection) {
	const source = map.getSource(LINE_ARROWS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
	if (source) {
		source.setData(arrows);
		return;
	}
	if (arrows.features.length === 0) {
		return;
	}
	if (!map.hasImage(LINE_ARROW_IMAGE_ID)) {
		map.addImage(LINE_ARROW_IMAGE_ID, lineArrowImage(), { sdf: true, pixelRatio: LINE_ARROW_IMAGE_PIXEL_RATIO });
	}
	map.addSource(LINE_ARROWS_SOURCE_ID, { type: 'geojson', data: arrows });
	map.addLayer(
		{
			id: LINE_ARROWS_LAYER_ID,
			type: 'symbol',
			source: LINE_ARROWS_SOURCE_ID,
			layout: {
				'icon-image': LINE_ARROW_IMAGE_ID,
				'icon-size': ['/', ['get', 'size'], LINE_ARROW_IMAGE_LENGTH],
				'icon-rotate': ['get', 'angle'],
				'icon-rotation-alignment': 'map',
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				'symbol-sort-key': ['get', 'index'],
			},
			paint: { 'icon-color': color },
		},
		map.getLayer(LINES_HIT_LAYER_ID) ? LINES_HIT_LAYER_ID : undefined,
	);
}

function setupRegionLayers(
	map: maplibregl.Map,
	color: string,
	element: HTMLElement | null,
	scale: ChoroplethScale | null,
	data: FeatureCollection,
) {
	map.addSource(REGIONS_SOURCE_ID, { type: 'geojson', data });
	map.addLayer({
		id: REGIONS_FILL_ID,
		type: 'fill',
		source: REGIONS_SOURCE_ID,
		paint: {
			'fill-color': color,
			'fill-opacity': choroplethOpacityExpression(scale) as DataDrivenPropertyValueSpecification<number>,
		},
	});
	map.addLayer({
		id: REGIONS_LINE_ID,
		type: 'line',
		source: REGIONS_SOURCE_ID,
		paint: {
			'line-color': resolveCssColor('--border', color, element),
			'line-width': 0.75,
			'line-opacity': 0.6,
		},
	});
}

function applyChoroplethPaint(map: maplibregl.Map, scale: ChoroplethScale | null) {
	if (!map.getLayer(REGIONS_FILL_ID)) {
		return;
	}
	map.setPaintProperty(
		REGIONS_FILL_ID,
		'fill-opacity',
		choroplethOpacityExpression(scale) as DataDrivenPropertyValueSpecification<number>,
	);
}

function pointRadiusExpression(config: displayMap.Input): DataDrivenPropertyValueSpecification<number> {
	if (config.map_type === 'scatter_bubble') {
		return ['get', 'radius'];
	}
	return config.radius ?? DEFAULT_MARKER_RADIUS;
}

const boundaryCache = new Map<string, Promise<FeatureCollection | null>>();

function useBoundaries(url: string | undefined): FeatureCollection | null {
	const [boundaries, setBoundaries] = useState<FeatureCollection | null>(null);
	useEffect(() => {
		if (!url) {
			setBoundaries(null);
			return;
		}
		let active = true;
		loadBoundaries(url).then((collection) => {
			if (active) {
				setBoundaries(collection);
			}
		});
		return () => {
			active = false;
		};
	}, [url]);
	return boundaries;
}

function loadBoundaries(url: string): Promise<FeatureCollection | null> {
	let promise = boundaryCache.get(url);
	if (!promise) {
		promise = fetch(url)
			.then((response) => (response.ok ? (response.json() as Promise<FeatureCollection>) : null))
			.catch(() => null);
		boundaryCache.set(url, promise);
	}
	return promise;
}

function buildRegionFeatures(
	entries: ChoroplethEntry[],
	config: displayMap.Input,
	boundaries: FeatureCollection | null,
	scale: ChoroplethScale | null,
	joinProps?: string[],
): FeatureCollection {
	const features: FeatureCollection['features'] = [];
	if (config.geometry_key) {
		for (const entry of entries) {
			if (entry.geometry && entry.value !== null) {
				features.push(regionFeature(entry.geometry, entry, config, scale));
			}
		}
		return { type: 'FeatureCollection', features };
	}
	if ((config.boundaries_url || config.region_boundaries) && boundaries) {
		const index = indexBoundaries(boundaries, joinProps);
		for (const entry of entries) {
			if (entry.region === null || entry.value === null) {
				continue;
			}
			const geometry = index.get(entry.region);
			if (geometry) {
				features.push(regionFeature(geometry, entry, config, scale));
			}
		}
	}
	return { type: 'FeatureCollection', features };
}

function regionFeature(
	geometry: MapGeometry,
	entry: ChoroplethEntry,
	config: displayMap.Input,
	scale: ChoroplethScale | null,
) {
	return {
		type: 'Feature' as const,
		geometry,
		properties: { value: entry.value, tip: JSON.stringify(choroplethTooltipModel(entry, config, scale)) },
	};
}

interface TooltipModel {
	label?: string;
	rows: { label: string; value: string }[];
	swatchOpacity?: number;
}

function choroplethTooltipModel(
	entry: ChoroplethEntry,
	config: displayMap.Input,
	scale: ChoroplethScale | null,
): TooltipModel {
	const rows: { label: string; value: string }[] = [];
	for (const key of choroplethTooltipKeys(config)) {
		if (entry.row[key] == null) {
			continue;
		}
		rows.push({ label: labelize(key), value: String(entry.row[key]) });
	}
	const label = config.label_key ? entry.row[config.label_key] : entry.region;
	return {
		label: label != null ? String(label) : undefined,
		rows,
		swatchOpacity: choroplethOpacity(entry.value, scale),
	};
}

function pointTooltipModel(point: MapPoint, config: displayMap.Input): TooltipModel {
	const rows: { label: string; value: string }[] = [];
	for (const key of pointTooltipKeys(config)) {
		if (point.row[key] == null) {
			continue;
		}
		rows.push({ label: labelize(key), value: String(point.row[key]) });
	}
	const label = config.label_key ? point.row[config.label_key] : undefined;
	return { label: label != null ? String(label) : undefined, rows };
}

function lineTooltipModel(line: MapLine, config: displayMap.Input): TooltipModel {
	const rows = lineTooltipKeys(config)
		.filter((key) => line.row[key] != null)
		.map((key) => ({ label: labelize(key), value: String(line.row[key]) }));
	const label = config.label_key ? line.row[config.label_key] : undefined;
	return { label: label != null ? String(label) : undefined, rows };
}

function buildLineFeatures(lines: MapLine[], config: displayMap.Input): FeatureCollection {
	return {
		type: 'FeatureCollection',
		features: lines.map((line, index) => ({
			type: 'Feature',
			geometry: { type: 'MultiLineString', coordinates: line.paths },
			properties: { index, width: line.width, tip: JSON.stringify(lineTooltipModel(line, config)) },
		})),
	};
}

function buildLineArrowFeatures(lines: MapLine[]): FeatureCollection {
	return {
		type: 'FeatureCollection',
		features: lines.flatMap((line, index) =>
			line.arrows.map((arrow) => ({
				type: 'Feature' as const,
				geometry: { type: 'Point' as const, coordinates: arrow.position },
				properties: { index, angle: arrow.angle, size: arrow.size },
			})),
		),
	};
}

function setupTooltip(
	map: maplibregl.Map,
	getConfig: () => displayMap.Input,
	handlers: {
		getPoint: (index: number) => MapPoint | undefined;
		getColor: () => string;
		getTheme: () => MapSurfaceTheme;
	},
) {
	const tooltip = new maplibregl.Popup({
		closeButton: false,
		closeOnClick: false,
		className: 'map-tooltip',
		maxWidth: '280px',
		offset: 12,
	});

	map.on('mousemove', POINTS_LAYER_ID, (event) => {
		const index = event.features?.[0]?.properties?.index;
		const point = typeof index === 'number' ? handlers.getPoint(index) : undefined;
		const model = point ? pointTooltipModel(point, getConfig()) : null;
		const content = model && buildTooltipElement(model, handlers.getColor(), handlers.getTheme());
		if (!point || !content) {
			tooltip.remove();
			map.getCanvas().style.cursor = '';
			return;
		}
		map.getCanvas().style.cursor = 'pointer';
		tooltip.setLngLat([point.longitude, point.latitude]).setDOMContent(content).addTo(map);
	});
	map.on('mouseleave', POINTS_LAYER_ID, () => {
		map.getCanvas().style.cursor = '';
		tooltip.remove();
	});

	for (const layerId of [REGIONS_FILL_ID, LINES_HIT_LAYER_ID]) {
		map.on('mousemove', layerId, (event) => {
			const raw = event.features?.[0]?.properties?.tip;
			const model = typeof raw === 'string' ? (safeParse(raw) as TooltipModel | null) : null;
			const content = model && buildTooltipElement(model, handlers.getColor(), handlers.getTheme());
			if (!content) {
				tooltip.remove();
				map.getCanvas().style.cursor = '';
				return;
			}
			map.getCanvas().style.cursor = 'pointer';
			tooltip.setLngLat(event.lngLat).setDOMContent(content).addTo(map);
		});
		map.on('mouseleave', layerId, () => {
			map.getCanvas().style.cursor = '';
			tooltip.remove();
		});
	}
}

function buildTooltipElement(model: TooltipModel, color: string, theme: MapSurfaceTheme): HTMLElement | null {
	const rows: HTMLElement[] = [];

	if (model.label) {
		const title = document.createElement('div');
		title.className = 'flex items-center gap-2 font-medium';
		title.style.color = theme.foreground;
		const dot = document.createElement('span');
		dot.className = 'h-2.5 w-2.5 shrink-0 rounded-[2px]';
		dot.style.backgroundColor = model.swatchOpacity != null ? withOpacity(color, model.swatchOpacity) : color;
		const text = document.createElement('span');
		text.textContent = model.label;
		title.append(dot, text);
		rows.push(title);
	}

	for (const entry of model.rows) {
		const row = document.createElement('div');
		row.className = 'flex items-start justify-between gap-4 leading-tight';
		const label = document.createElement('span');
		label.style.color = theme.mutedForeground;
		label.textContent = entry.label;
		const value = document.createElement('span');
		value.className = 'font-mono font-medium tabular-nums text-right';
		value.style.color = theme.foreground;
		value.textContent = entry.value;
		row.append(label, value);
		rows.push(row);
	}

	if (rows.length === 0) {
		return null;
	}

	const container = document.createElement('div');
	container.style.borderColor = withOpacity(theme.border, 0.1);
	container.className =
		'grid min-w-32 items-start gap-1.5 rounded-lg border border-[1px] px-2.5 py-1.5 text-xs shadow-xl font-sans';
	container.style.backgroundColor = theme.background;
	container.append(...rows);
	return container;
}

type LegendModel =
	| { kind: 'choropleth'; color: string; scale: ChoroplethLegendModel }
	| { kind: 'bubble'; color: string; domain: NumericDomain; maxRadius: number }
	| { kind: 'lines'; color: string; items: LineWidthLegendItem[] };

interface LegendDomains {
	choropleth: ChoroplethScale | null;
	size: NumericDomain | null;
	lines: LineWidthLegendItem[];
}

function legendModel(config: displayMap.Input, color: string, domains: LegendDomains): LegendModel | null {
	if (config.map_type === 'choropleth' && domains.choropleth) {
		return { kind: 'choropleth', color, scale: buildChoroplethLegend(domains.choropleth) };
	}
	if (config.map_type === 'scatter_bubble' && domains.size) {
		return { kind: 'bubble', color, domain: domains.size, maxRadius: config.radius ?? BUBBLE_MAX_RADIUS };
	}
	if (config.map_type === 'lines' && domains.lines.length > 0) {
		return { kind: 'lines', color, items: domains.lines };
	}
	return null;
}

const LEGEND_FONT = '10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const LEGEND_MARGIN = 8;
const LEGEND_PADDING_X = 8;
const LEGEND_PADDING_Y = 6;
const LEGEND_TEXT_COLOR = '#6b7280';
const LEGEND_TEXT_HEIGHT = 12;

function composeLegendUrl(
	canvas: HTMLCanvasElement,
	config: displayMap.Input,
	domains: LegendDomains,
	color: string,
	type: string,
): string {
	const legend = legendModel(config, color, domains);
	const composed = legend ? drawLegendOnCanvas(canvas, legend) : null;
	return (composed ?? canvas).toDataURL(type);
}

interface LightSnapshotOptions {
	live: maplibregl.Map;
	config: displayMap.Input;
	domains: LegendDomains;
	points: MapPoint[];
	regions: FeatureCollection;
	lines: FeatureCollection;
	lineArrows: FeatureCollection;
	type: string;
}

const LIGHT_SNAPSHOT_TIMEOUT = 8000;

/** Renders the current map view into a throwaway light-themed map so the exported PNG never carries dark tiles. */
function captureLightSnapshot({
	live,
	config,
	domains,
	points,
	regions,
	lines,
	lineArrows,
	type,
}: LightSnapshotOptions): Promise<string | null> {
	return new Promise((resolve) => {
		const liveCanvas = live.getCanvas();
		const width = liveCanvas.clientWidth;
		const height = liveCanvas.clientHeight;
		if (!width || !height) {
			resolve(null);
			return;
		}

		const colors = resolveLightMapColors(config);
		const container = document.createElement('div');
		container.style.cssText = `position:absolute;left:-99999px;top:0;width:${width}px;height:${height}px`;
		document.body.appendChild(container);

		let map: maplibregl.Map;
		try {
			map = new maplibregl.Map({
				container,
				style: MAP_STYLE_LIGHT,
				interactive: false,
				attributionControl: { compact: true },
				canvasContextAttributes: { preserveDrawingBuffer: true },
				center: live.getCenter(),
				zoom: live.getZoom(),
				bearing: live.getBearing(),
				pitch: live.getPitch(),
			});
		} catch {
			container.remove();
			resolve(null);
			return;
		}

		let settled = false;
		const finish = (url: string | null) => {
			if (settled) {
				return;
			}
			settled = true;
			map.remove();
			container.remove();
			resolve(url);
		};

		const timeout = window.setTimeout(() => finish(null), LIGHT_SNAPSHOT_TIMEOUT);
		map.on('error', () => {
			window.clearTimeout(timeout);
			finish(null);
		});
		map.on('style.load', () => {
			if (config.map_type === 'choropleth') {
				setupRegionLayers(map, colors.fill, container, domains.choropleth, regions);
				map.setPaintProperty(REGIONS_LINE_ID, 'line-color', colors.line);
			} else if (config.map_type === 'lines') {
				setupLineLayers(map, colors.fill, lines, lineArrows);
			} else {
				setupPointLayers(map, colors.fill, container, config, toGeoJsonPoints(points, config, domains.size));
				map.setPaintProperty(POINTS_LAYER_ID, 'circle-stroke-color', colors.stroke);
			}
			map.once('idle', () => {
				window.clearTimeout(timeout);
				finish(composeLegendUrl(map.getCanvas(), config, domains, colors.fill, type));
			});
		});
	});
}

function resolveLightMapColors(config: displayMap.Input): { fill: string; stroke: string; line: string } {
	const root = document.documentElement;
	const wasDark = root.classList.contains('dark');
	if (wasDark) {
		root.classList.remove('dark');
	}
	try {
		const fill = resolveMarkerColor(config.color, root);
		return {
			fill,
			stroke: resolveCssColor('--background', '#ffffff', root),
			line: resolveCssColor('--border', fill, root),
		};
	} finally {
		if (wasDark) {
			root.classList.add('dark');
		}
	}
}

function drawLegendOnCanvas(source: HTMLCanvasElement, legend: LegendModel): HTMLCanvasElement | null {
	const canvas = document.createElement('canvas');
	canvas.width = source.width;
	canvas.height = source.height;
	const context = canvas.getContext('2d');
	if (!context) {
		return null;
	}
	context.drawImage(source, 0, 0);
	const scale = source.clientWidth ? source.width / source.clientWidth : window.devicePixelRatio || 1;
	const cssHeight = source.height / scale;
	context.save();
	context.scale(scale, scale);
	context.font = LEGEND_FONT;
	if (legend.kind === 'choropleth') {
		drawChoroplethLegend(context, cssHeight, legend);
	} else if (legend.kind === 'lines') {
		drawLineWidthLegend(context, cssHeight, legend);
	} else {
		drawBubbleLegend(context, cssHeight, legend);
	}
	context.restore();
	return canvas;
}

function drawLegendBox(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number) {
	context.beginPath();
	context.roundRect(x, y, width, height, 6);
	context.fillStyle = 'rgba(255, 255, 255, 0.9)';
	context.fill();
	context.lineWidth = 1;
	context.strokeStyle = 'rgba(0, 0, 0, 0.08)';
	context.stroke();
}

function drawChoroplethLegend(
	context: CanvasRenderingContext2D,
	cssHeight: number,
	legend: Extract<LegendModel, { kind: 'choropleth' }>,
) {
	if (legend.scale.kind === 'classes') {
		drawChoroplethClassesLegend(context, cssHeight, legend.color, legend.scale.classes);
		return;
	}
	drawChoroplethGradientLegend(context, cssHeight, legend.color, legend.scale.ticks);
}

const CANVAS_TEXT_ALIGN: Record<ChoroplethLegendTick['align'], CanvasTextAlign> = {
	start: 'left',
	center: 'center',
	end: 'right',
};

function drawChoroplethGradientLegend(
	context: CanvasRenderingContext2D,
	cssHeight: number,
	color: string,
	ticks: ChoroplethLegendTick[],
) {
	const barWidth = 96;
	const barHeight = 8;
	const gap = 4;
	const boxWidth = LEGEND_PADDING_X * 2 + barWidth;
	const boxHeight = LEGEND_PADDING_Y * 2 + barHeight + gap + LEGEND_TEXT_HEIGHT;
	const boxX = LEGEND_MARGIN;
	const boxY = cssHeight - LEGEND_MARGIN - boxHeight;
	drawLegendBox(context, boxX, boxY, boxWidth, boxHeight);

	const barX = boxX + LEGEND_PADDING_X;
	const barY = boxY + LEGEND_PADDING_Y;
	const gradient = context.createLinearGradient(barX, 0, barX + barWidth, 0);
	gradient.addColorStop(0, withOpacity(color, CHOROPLETH_MIN_OPACITY));
	gradient.addColorStop(1, color);
	context.beginPath();
	context.roundRect(barX, barY, barWidth, barHeight, barHeight / 2);
	context.fillStyle = gradient;
	context.fill();

	const textY = barY + barHeight + gap + LEGEND_TEXT_HEIGHT / 2;
	context.fillStyle = LEGEND_TEXT_COLOR;
	context.textBaseline = 'middle';
	for (const tick of ticks) {
		context.textAlign = CANVAS_TEXT_ALIGN[tick.align];
		context.fillText(tick.label, barX + tick.position * barWidth, textY);
	}
}

function drawChoroplethClassesLegend(
	context: CanvasRenderingContext2D,
	cssHeight: number,
	color: string,
	classes: ChoroplethLegendClass[],
) {
	const swatchSize = 10;
	const swatchGap = 6;
	const rowGap = 2;
	const labelWidth = Math.max(...classes.map((item) => context.measureText(item.label).width));
	const boxWidth = LEGEND_PADDING_X * 2 + swatchSize + swatchGap + labelWidth;
	const boxHeight = LEGEND_PADDING_Y * 2 + classes.length * LEGEND_TEXT_HEIGHT + (classes.length - 1) * rowGap;
	const boxX = LEGEND_MARGIN;
	const boxY = cssHeight - LEGEND_MARGIN - boxHeight;
	drawLegendBox(context, boxX, boxY, boxWidth, boxHeight);

	context.textBaseline = 'middle';
	context.textAlign = 'left';
	classes.forEach((item, index) => {
		const rowY = boxY + LEGEND_PADDING_Y + index * (LEGEND_TEXT_HEIGHT + rowGap);
		const swatchX = boxX + LEGEND_PADDING_X;
		context.beginPath();
		context.roundRect(swatchX, rowY + (LEGEND_TEXT_HEIGHT - swatchSize) / 2, swatchSize, swatchSize, 2);
		context.fillStyle = withOpacity(color, item.opacity);
		context.fill();
		context.fillStyle = LEGEND_TEXT_COLOR;
		context.fillText(item.label, swatchX + swatchSize + swatchGap, rowY + LEGEND_TEXT_HEIGHT / 2);
	});
}

function drawBubbleLegend(
	context: CanvasRenderingContext2D,
	cssHeight: number,
	legend: Extract<LegendModel, { kind: 'bubble' }>,
) {
	const values = bubbleLegendValues(legend.domain);
	const gap = 8;
	const labelGap = 4;
	const slotHeight = legend.maxRadius * 2;
	const items = values.map((value) => {
		const radius = scaleBubbleRadius(value, legend.domain, legend.maxRadius);
		const text = formatCompactNumber(value);
		return { radius, text, width: Math.max(radius * 2, context.measureText(text).width) };
	});
	const contentWidth = items.reduce((sum, item) => sum + item.width, 0) + gap * (items.length - 1);
	const boxWidth = LEGEND_PADDING_X * 2 + contentWidth;
	const boxHeight = LEGEND_PADDING_Y * 2 + slotHeight + labelGap + LEGEND_TEXT_HEIGHT;
	const boxX = LEGEND_MARGIN;
	const boxY = cssHeight - LEGEND_MARGIN - boxHeight;
	drawLegendBox(context, boxX, boxY, boxWidth, boxHeight);

	const circleBottom = boxY + LEGEND_PADDING_Y + slotHeight;
	const labelY = circleBottom + labelGap + LEGEND_TEXT_HEIGHT / 2;
	let cursorX = boxX + LEGEND_PADDING_X;
	for (const item of items) {
		const centerX = cursorX + item.width / 2;
		context.beginPath();
		context.arc(centerX, circleBottom - item.radius, item.radius, 0, Math.PI * 2);
		context.fillStyle = withOpacity(legend.color, 0.9);
		context.fill();
		context.fillStyle = LEGEND_TEXT_COLOR;
		context.textAlign = 'center';
		context.textBaseline = 'middle';
		context.fillText(item.text, centerX, labelY);
		cursorX += item.width + gap;
	}
}

const LINE_LEGEND_SAMPLE_LENGTH = 24;
const LINE_LEGEND_ROW_GAP = 4;

function drawLineWidthLegend(
	context: CanvasRenderingContext2D,
	cssHeight: number,
	legend: Extract<LegendModel, { kind: 'lines' }>,
) {
	const labelGap = 6;
	const rowHeight = Math.max(LEGEND_TEXT_HEIGHT, ...legend.items.map((item) => item.width));
	const labelWidth = Math.max(...legend.items.map((item) => context.measureText(item.label).width));
	const boxWidth = LEGEND_PADDING_X * 2 + LINE_LEGEND_SAMPLE_LENGTH + labelGap + labelWidth;
	const boxHeight =
		LEGEND_PADDING_Y * 2 + legend.items.length * rowHeight + (legend.items.length - 1) * LINE_LEGEND_ROW_GAP;
	const boxX = LEGEND_MARGIN;
	const boxY = cssHeight - LEGEND_MARGIN - boxHeight;
	drawLegendBox(context, boxX, boxY, boxWidth, boxHeight);

	context.textBaseline = 'middle';
	context.textAlign = 'left';
	context.lineCap = 'round';
	legend.items.forEach((item, index) => {
		const centerY = boxY + LEGEND_PADDING_Y + index * (rowHeight + LINE_LEGEND_ROW_GAP) + rowHeight / 2;
		const sampleX = boxX + LEGEND_PADDING_X;
		context.beginPath();
		context.moveTo(sampleX, centerY);
		context.lineTo(sampleX + LINE_LEGEND_SAMPLE_LENGTH, centerY);
		context.lineWidth = item.width;
		context.strokeStyle = withOpacity(legend.color, LINE_OPACITY);
		context.stroke();
		context.fillStyle = LEGEND_TEXT_COLOR;
		context.fillText(item.label, sampleX + LINE_LEGEND_SAMPLE_LENGTH + labelGap, centerY);
	});
}

function ChoroplethLegend({ color, scale, theme }: { color: string; scale: ChoroplethScale; theme: MapSurfaceTheme }) {
	const legend = buildChoroplethLegend(scale);
	return (
		<div
			className='absolute bottom-2 left-2 rounded-md border border-[1px] px-2 py-1.5 text-[10px] shadow-sm backdrop-blur'
			style={{ borderColor: withOpacity(theme.border, 0.1), backgroundColor: withOpacity(theme.background, 0.9) }}
		>
			{legend.kind === 'classes' ? (
				<ChoroplethClassesLegend color={color} classes={legend.classes} theme={theme} />
			) : (
				<ChoroplethGradientLegend color={color} ticks={legend.ticks} theme={theme} />
			)}
		</div>
	);
}

function ChoroplethGradientLegend({
	color,
	ticks,
	theme,
}: {
	color: string;
	ticks: ChoroplethLegendTick[];
	theme: MapSurfaceTheme;
}) {
	return (
		<>
			<div
				className='h-2 w-24 rounded-full'
				style={{
					background: `linear-gradient(to right, ${withOpacity(color, CHOROPLETH_MIN_OPACITY)}, ${color})`,
				}}
			/>
			<div
				className='relative mt-1 flex justify-between font-mono tabular-nums'
				style={{ color: theme.mutedForeground }}
			>
				{ticks.map((tick) =>
					tick.align === 'center' ? (
						<span
							key={tick.position}
							className='absolute -translate-x-1/2'
							style={{ left: `${tick.position * 100}%` }}
						>
							{tick.label}
						</span>
					) : (
						<span key={tick.position}>{tick.label}</span>
					),
				)}
			</div>
		</>
	);
}

function ChoroplethClassesLegend({
	color,
	classes,
	theme,
}: {
	color: string;
	classes: ChoroplethLegendClass[];
	theme: MapSurfaceTheme;
}) {
	return (
		<div className='grid gap-0.5 font-mono tabular-nums' style={{ color: theme.mutedForeground }}>
			{classes.map((item) => (
				<div key={item.label} className='flex items-center gap-1.5'>
					<span
						className='size-2.5 shrink-0 rounded-[2px]'
						style={{ backgroundColor: withOpacity(color, item.opacity) }}
					/>
					<span>{item.label}</span>
				</div>
			))}
		</div>
	);
}

function BubbleLegend({
	color,
	domain,
	maxRadius,
	theme,
}: {
	color: string;
	domain: NumericDomain;
	maxRadius: number;
	theme: MapSurfaceTheme;
}) {
	const size = maxRadius * 2;
	const values = bubbleLegendValues(domain);
	return (
		<div
			className='absolute bottom-2 left-2 flex items-end gap-2 rounded-md border border-[1px] px-2 py-1.5 text-[10px] shadow-sm backdrop-blur'
			style={{ borderColor: withOpacity(theme.border, 0.1), backgroundColor: withOpacity(theme.background, 0.9) }}
		>
			{values.map((value, index) => {
				const radius = scaleBubbleRadius(value, domain, maxRadius);
				return (
					<div key={index} className='flex flex-col items-center gap-1'>
						<div style={{ height: size, display: 'flex', alignItems: 'flex-end' }}>
							<span
								className='rounded-full'
								style={{
									width: radius * 2,
									height: radius * 2,
									backgroundColor: withOpacity(color, 0.9),
								}}
							/>
						</div>
						<span className='font-mono tabular-nums' style={{ color: theme.mutedForeground }}>
							{formatCompactNumber(value)}
						</span>
					</div>
				);
			})}
		</div>
	);
}

function LineWidthLegend({
	color,
	items,
	theme,
}: {
	color: string;
	items: LineWidthLegendItem[];
	theme: MapSurfaceTheme;
}) {
	return (
		<div
			className='absolute bottom-2 left-2 grid gap-1 rounded-md border border-[1px] px-2 py-1.5 text-[10px] shadow-sm backdrop-blur'
			style={{ borderColor: withOpacity(theme.border, 0.1), backgroundColor: withOpacity(theme.background, 0.9) }}
		>
			{items.map((item) => (
				<div key={item.label} className='flex items-center gap-1.5'>
					<span
						className='rounded-full'
						style={{
							width: LINE_LEGEND_SAMPLE_LENGTH,
							height: item.width,
							backgroundColor: withOpacity(color, LINE_OPACITY),
						}}
					/>
					<span className='font-mono tabular-nums' style={{ color: theme.mutedForeground }}>
						{item.label}
					</span>
				</div>
			))}
		</div>
	);
}

function useIsDark() {
	const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

	useEffect(() => {
		const root = document.documentElement;
		const observer = new MutationObserver(() => setIsDark(root.classList.contains('dark')));
		observer.observe(root, { attributes: true, attributeFilter: ['class'] });
		return () => observer.disconnect();
	}, []);

	return isDark;
}

function clampMinZoom(map: maplibregl.Map) {
	const width = map.getContainer().clientWidth;
	if (!width) {
		return;
	}
	const minZoom = Math.max(0, Math.log2(width / 512) + 0.02);
	if (Math.abs(map.getMinZoom() - minZoom) > 0.001) {
		map.setMinZoom(minZoom);
	}
}

function emptyCollection(): FeatureCollection {
	return { type: 'FeatureCollection', features: [] };
}

function toGeoJsonPoints(
	points: MapPoint[],
	config: displayMap.Input,
	sizeDomain: NumericDomain | null,
): FeatureCollection {
	const isBubble = config.map_type === 'scatter_bubble';
	const maxRadius = config.radius ?? BUBBLE_MAX_RADIUS;
	return {
		type: 'FeatureCollection',
		features: points.map((point, index) => ({
			type: 'Feature' as const,
			geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
			properties: {
				index,
				...(isBubble && {
					radius: scaleBubbleRadius(
						parseNumericValue(point.row[config.size_key ?? '']),
						sizeDomain,
						maxRadius,
					),
				}),
			},
		})),
	};
}

function fitToPoints(map: maplibregl.Map, points: MapPoint[]) {
	fitToBounds(map, computeMapBounds(points));
}

/** Uses the shared bounds, which take the short way across the antimeridian like the shared line paths. */
function fitToBounds(map: maplibregl.Map, bounds: MapBounds | null) {
	if (!bounds) {
		return;
	}
	map.fitBounds(
		[
			[bounds.west, bounds.south],
			[bounds.east, bounds.north],
		],
		{ padding: 48, maxZoom: 14, duration: 0 },
	);
}

function fitToCollection(map: maplibregl.Map, collection: FeatureCollection) {
	const bounds = collectionBounds(collection);
	if (!bounds) {
		return;
	}
	map.fitBounds(bounds, { padding: 32, maxZoom: 12, duration: 0 });
}

function collectionBounds(collection: FeatureCollection): [[number, number], [number, number]] | null {
	let west = Infinity;
	let south = Infinity;
	let east = -Infinity;
	let north = -Infinity;
	const visit = (coords: unknown) => {
		if (!Array.isArray(coords)) {
			return;
		}
		if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
			const lng = coords[0];
			const lat = coords[1];
			west = Math.min(west, lng);
			east = Math.max(east, lng);
			south = Math.min(south, lat);
			north = Math.max(north, lat);
			return;
		}
		coords.forEach(visit);
	};
	for (const feature of collection.features) {
		visit((feature.geometry as { coordinates?: unknown }).coordinates);
	}
	return Number.isFinite(west)
		? [
				[west, south],
				[east, north],
			]
		: null;
}

function resolveMarkerColor(markerColor: string | undefined, element?: HTMLElement | null): string {
	return markerColor?.trim() || resolveCssColor('--primary', DEFAULT_MARKER_COLOR, element);
}

interface MapSurfaceTheme {
	background: string;
	foreground: string;
	border: string;
	mutedForeground: string;
	accent: string;
	isDark: boolean;
}

/** Resolves the theme colors of the map surface (tooltips, controls) from the selected map style, not the app theme. */
function resolveMapSurfaceTheme(element: HTMLElement | null): MapSurfaceTheme {
	return withMapStyleTheme(() => ({
		background: resolveCssColor('--background', '#ffffff', element),
		foreground: resolveCssColor('--foreground', '#111827', element),
		border: resolveCssColor('--border', 'rgba(0, 0, 0, 0.1)', element),
		mutedForeground: resolveCssColor('--muted-foreground', '#6b7280', element),
		accent: resolveCssColor('--accent', 'rgba(0, 0, 0, 0.05)', element),
		isDark: isMapStyleDark(getMapStyle(), document.documentElement.classList.contains('dark')),
	}));
}

function applyControlTheme(element: HTMLElement, theme: MapSurfaceTheme) {
	element.style.setProperty('--map-ctrl-bg', theme.background);
	element.style.setProperty('--map-ctrl-fg', theme.foreground);
	element.style.setProperty('--map-ctrl-border', theme.border);
	element.style.setProperty('--map-ctrl-hover', theme.accent);
	element.style.setProperty('--map-ctrl-icon-filter', theme.isDark ? 'invert(1)' : 'none');
}

function withMapStyleTheme<T>(run: () => T): T {
	const root = document.documentElement;
	const wasDark = root.classList.contains('dark');
	const styleIsDark = isMapStyleDark(getMapStyle(), wasDark);
	if (styleIsDark === wasDark) {
		return run();
	}
	root.classList.toggle('dark', styleIsDark);
	try {
		return run();
	} finally {
		root.classList.toggle('dark', wasDark);
	}
}

function resolveCssColor(variableName: string, fallback: string, element?: HTMLElement | null): string {
	const color = resolveCssVariableColor(variableName, element);
	return color ? formatRgb(color) : fallback;
}

function safeParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}
