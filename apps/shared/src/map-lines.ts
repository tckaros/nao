import { formatCompactNumber } from './chart-values';
import {
	bubbleLegendValues,
	isPlottableCoordinate,
	type MapBounds,
	type MapGeometry,
	numericDomain,
	parseGeoJson,
	parseNumericValue,
} from './map';
import type * as displayMap from './tools/display-map';

export type LngLat = [number, number];

export interface MapLine {
	paths: LngLat[][];
	weight: number | null;
	width: number;
	arrows: LineArrow[];
	row: Record<string, unknown>;
}

/** Arrow halfway along a path. Its angle is in degrees clockwise from east on a north-up Web Mercator map, and its size is its length in pixels. */
export interface LineArrow {
	position: LngLat;
	angle: number;
	size: number;
}

export type LineDropReason = 'same_origin_destination' | 'invalid_coordinates' | 'invalid_geometry';

export type LineDropCounts = Partial<Record<LineDropReason, number>>;

export interface LineWidthLegendItem {
	label: string;
	width: number;
}

export interface ArrowImage {
	width: number;
	height: number;
	data: Uint8Array;
}

export const MAX_MAP_LINES = 1000;
export const LINE_MIN_WIDTH = 1;
export const LINE_MAX_WIDTH = 8;
export const DEFAULT_LINE_WIDTH = 2;
export const LINE_OPACITY = 0.8;
export const LINE_ARROW_MIN_SIZE = 8;
export const LINE_ARROW_IMAGE_PIXEL_RATIO = 2;
/** Length in pixels of the triangle drawn by {@link lineArrowImage}, once divided by its pixel ratio. */
export const LINE_ARROW_IMAGE_LENGTH = 11;

const ARC_SEGMENTS = 32;
const ARC_BEND = 0.2;
const ARROW_WIDTH_RATIO = 2.2;
const ARROW_IMAGE_SIZE = 32;
const ARROW_IMAGE_TRIANGLE: LngLat[] = [
	[28, 16],
	[6, 27],
	[6, 5],
];
const SDF_RADIUS = 4;
const SDF_EDGE = 0.75;

type LineSourceConfig = Pick<
	displayMap.Input,
	| 'origin_latitude_key'
	| 'origin_longitude_key'
	| 'destination_latitude_key'
	| 'destination_longitude_key'
	| 'geometry_key'
	| 'width_key'
	| 'curved'
	| 'arrows'
>;

type PathsReader = (row: Record<string, unknown>) => LngLat[][] | LineDropReason;

/** Builds one line per usable row, lightest first so that renderers draw the heaviest lines on top. */
export function buildMapLines(rows: Record<string, unknown>[], config: LineSourceConfig): MapLine[] {
	const readPaths = linePathsReader(config);
	const drafts = rows.flatMap((row) => {
		const paths = readPaths(row);
		return typeof paths === 'string' ? [] : [{ paths, weight: readWeight(row, config.width_key), row }];
	});
	const maxWeight = numericDomain(drafts.map((draft) => draft.weight))?.max ?? null;
	const withArrows = showsLineArrows(config);
	return drafts
		.map((draft) => {
			const width = config.width_key ? scaleLineWidth(draft.weight, maxWeight) : DEFAULT_LINE_WIDTH;
			const arrows = withArrows ? draft.paths.flatMap((path) => pathArrow(path, width)) : [];
			return { ...draft, width, arrows };
		})
		.sort(compareWeights);
}

/** Counts the rows {@link buildMapLines} drops, by reason, leaving out the reasons that dropped nothing. */
export function countDroppedLineRows(rows: Record<string, unknown>[], config: LineSourceConfig): LineDropCounts {
	const readPaths = linePathsReader(config);
	const counts: LineDropCounts = {};
	for (const row of rows) {
		const paths = readPaths(row);
		if (typeof paths === 'string') {
			counts[paths] = (counts[paths] ?? 0) + 1;
		}
	}
	return counts;
}

/** Arcs show their direction by default, straight lines do not. */
export function showsLineArrows(config: Pick<displayMap.Input, 'arrows' | 'curved'>): boolean {
	return config.arrows ?? !!config.curved;
}

/** Keeps the {@link MAX_MAP_LINES} heaviest lines, still in drawing order. */
export function visibleMapLines(lines: MapLine[]): MapLine[] {
	return lines.length > MAX_MAP_LINES ? lines.slice(-MAX_MAP_LINES) : lines;
}

/** Width proportional to the value, so that a line twice as heavy looks about twice as wide. */
export function scaleLineWidth(value: number | null, maxValue: number | null): number {
	if (value === null || maxValue === null || value <= 0 || maxValue <= 0) {
		return LINE_MIN_WIDTH;
	}
	return LINE_MIN_WIDTH + (LINE_MAX_WIDTH - LINE_MIN_WIDTH) * Math.min(1, value / maxValue);
}

/** Grows with the line width, with a floor that keeps the arrow readable on the thinnest lines. */
export function lineArrowSize(width: number): number {
	return Math.max(LINE_ARROW_MIN_SIZE, width * ARROW_WIDTH_RATIO);
}

/** White east-pointing triangle encoded as a signed distance field, so that MapLibre can tint it with `icon-color`. */
export function lineArrowImage(): ArrowImage {
	const data = new Uint8Array(ARROW_IMAGE_SIZE * ARROW_IMAGE_SIZE * 4);
	for (let y = 0; y < ARROW_IMAGE_SIZE; y++) {
		for (let x = 0; x < ARROW_IMAGE_SIZE; x++) {
			const offset = (y * ARROW_IMAGE_SIZE + x) * 4;
			const outside = distanceOutsidePolygon([x + 0.5, y + 0.5], ARROW_IMAGE_TRIANGLE);
			data.fill(255, offset, offset + 3);
			data[offset + 3] = Math.round(255 * Math.min(1, Math.max(0, SDF_EDGE - outside / SDF_RADIUS)));
		}
	}
	return { width: ARROW_IMAGE_SIZE, height: ARROW_IMAGE_SIZE, data };
}

export function lineWidthLegend(lines: MapLine[]): LineWidthLegendItem[] {
	const domain = numericDomain(lines.map((line) => line.weight));
	if (!domain || domain.max <= 0) {
		return [];
	}
	return bubbleLegendValues(domain).map((value) => ({
		label: formatCompactNumber(value),
		width: scaleLineWidth(value, domain.max),
	}));
}

/** Quadratic curve that bends to the right of the travel direction, so A→B and B→A arcs never overlap. */
export function arcPath(origin: LngLat, destination: LngLat): LngLat[] {
	const [originLng, originLat] = origin;
	const [destinationLng, destinationLat] = destination;
	const controlLng = (originLng + destinationLng) / 2 + ARC_BEND * (destinationLat - originLat);
	const controlLat = (originLat + destinationLat) / 2 - ARC_BEND * (destinationLng - originLng);
	return Array.from({ length: ARC_SEGMENTS + 1 }, (_, index) => {
		const t = index / ARC_SEGMENTS;
		const originWeight = (1 - t) ** 2;
		const controlWeight = 2 * (1 - t) * t;
		const destinationWeight = t ** 2;
		return [
			originWeight * originLng + controlWeight * controlLng + destinationWeight * destinationLng,
			originWeight * originLat + controlWeight * controlLat + destinationWeight * destinationLat,
		];
	});
}

/**
 * Plain min/max of every position. Lines keep their longitudes as given, so no line ever leaves the frame, even when the lines
 * span more than half the globe. The trade-off: a line between Asia and America crosses the map instead of the Pacific.
 */
export function mapLinesBounds(lines: MapLine[]): MapBounds | null {
	const positions = lines.flatMap((line) => line.paths.flat());
	if (positions.length === 0) {
		return null;
	}
	const longitudes = positions.map(([longitude]) => longitude);
	const latitudes = positions.map(([, latitude]) => latitude);
	return {
		west: Math.min(...longitudes),
		south: Math.min(...latitudes),
		east: Math.max(...longitudes),
		north: Math.max(...latitudes),
	};
}

/** Tooltip columns for a lines map: the configured tooltip columns minus the label column, plus the width column. */
export function lineTooltipKeys(config: displayMap.Input): string[] {
	const keys = (config.tooltip_keys ?? []).filter((key) => key && key !== config.label_key);
	if (config.width_key && config.width_key !== config.label_key && !keys.includes(config.width_key)) {
		keys.push(config.width_key);
	}
	return keys;
}

function linePathsReader(config: LineSourceConfig): PathsReader {
	return config.geometry_key ? geometryPathsReader(config.geometry_key) : segmentPathsReader(config);
}

function segmentPathsReader(config: LineSourceConfig): PathsReader {
	return (row) => {
		const origin = readCoordinate(row, config.origin_latitude_key, config.origin_longitude_key);
		const destination = readCoordinate(row, config.destination_latitude_key, config.destination_longitude_key);
		if (!origin || !destination) {
			return 'invalid_coordinates';
		}
		if (isSameCoordinate(origin, destination)) {
			return 'same_origin_destination';
		}
		return [config.curved ? arcPath(origin, destination) : [origin, destination]];
	};
}

function geometryPathsReader(geometryKey: string): PathsReader {
	return (row) => {
		const geometry = parseGeoJson(row[geometryKey]);
		const paths = geometry
			? linePaths(geometry)
					.map(toPlottablePath)
					.filter((path) => path.length >= 2)
			: [];
		return paths.length > 0 ? paths : 'invalid_geometry';
	};
}

function linePaths(geometry: MapGeometry): unknown[][] {
	if (geometry.type === 'LineString') {
		return [geometry.coordinates];
	}
	if (geometry.type === 'MultiLineString') {
		return geometry.coordinates;
	}
	return [];
}

function toPlottablePath(positions: unknown[]): LngLat[] {
	return positions.flatMap((position) => {
		if (!Array.isArray(position)) {
			return [];
		}
		const longitude = parseNumericValue(position[0]);
		const latitude = parseNumericValue(position[1]);
		return longitude !== null && latitude !== null && isPlottableCoordinate(latitude, longitude)
			? [[longitude, latitude] as LngLat]
			: [];
	});
}

/** Places the arrow halfway along the path as drawn on a Web Mercator map, pointing along the segment it falls on. */
function pathArrow(path: LngLat[], width: number): LineArrow[] {
	const projected = path.map(projectMercator);
	const lengths = projected.slice(1).map((point, index) => distance(projected[index], point));
	let remaining = lengths.reduce((total, length) => total + length, 0) / 2;
	const segment = lengths.findIndex((length) => {
		if (length > 0 && remaining <= length) {
			return true;
		}
		remaining -= length;
		return false;
	});
	if (segment < 0) {
		return [];
	}
	const [startX, startY] = projected[segment];
	const [endX, endY] = projected[segment + 1];
	const ratio = remaining / lengths[segment];
	const longitude = path[segment][0] + (path[segment + 1][0] - path[segment][0]) * ratio;
	const latitude = mercatorLatitude(startY + (endY - startY) * ratio);
	return [
		{
			position: [longitude, latitude],
			angle: (Math.atan2(endY - startY, endX - startX) * 180) / Math.PI,
			size: lineArrowSize(width),
		},
	];
}

/** Web Mercator with y growing southwards, like screen pixels, on the same scale as x. */
function projectMercator([longitude, latitude]: LngLat): LngLat {
	const sin = Math.sin((latitude * Math.PI) / 180);
	return [longitude / 360, -Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)];
}

function mercatorLatitude(y: number): number {
	return (Math.atan(Math.sinh(-y * 2 * Math.PI)) * 180) / Math.PI;
}

function distance([firstX, firstY]: LngLat, [secondX, secondY]: LngLat): number {
	return Math.hypot(secondX - firstX, secondY - firstY);
}

/** Signed distance to a convex polygon listed clockwise in screen space: negative inside, exact outside except near corners. */
function distanceOutsidePolygon(point: LngLat, corners: LngLat[]): number {
	return Math.max(
		...corners.map((corner, index) => {
			const next = corners[(index + 1) % corners.length];
			const length = distance(corner, next);
			const normalX = (next[1] - corner[1]) / length;
			const normalY = (corner[0] - next[0]) / length;
			return normalX * (point[0] - corner[0]) + normalY * (point[1] - corner[1]);
		}),
	);
}

function readCoordinate(
	row: Record<string, unknown>,
	latitudeKey: string | undefined,
	longitudeKey: string | undefined,
): LngLat | null {
	const latitude = parseNumericValue(row[latitudeKey ?? '']);
	const longitude = parseNumericValue(row[longitudeKey ?? '']);
	if (latitude === null || longitude === null || !isPlottableCoordinate(latitude, longitude)) {
		return null;
	}
	return [longitude, latitude];
}

function readWeight(row: Record<string, unknown>, widthKey: string | undefined): number | null {
	return widthKey ? parseNumericValue(row[widthKey]) : null;
}

function isSameCoordinate([firstLng, firstLat]: LngLat, [secondLng, secondLat]: LngLat): boolean {
	return firstLng === secondLng && firstLat === secondLat;
}

function compareWeights(first: MapLine, second: MapLine): number {
	const firstRank = first.weight ?? Number.NEGATIVE_INFINITY;
	const secondRank = second.weight ?? Number.NEGATIVE_INFINITY;
	if (firstRank === secondRank) {
		return 0;
	}
	return firstRank < secondRank ? -1 : 1;
}
