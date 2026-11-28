import { describe, expect, it } from 'vitest';

import {
	arcPath,
	buildMapLines,
	countDroppedLineRows,
	DEFAULT_LINE_WIDTH,
	LINE_ARROW_MIN_SIZE,
	LINE_MAX_WIDTH,
	LINE_MIN_WIDTH,
	lineArrowImage,
	lineArrowSize,
	lineTooltipKeys,
	lineWidthLegend,
	mapLinesBounds,
	MAX_MAP_LINES,
	scaleLineWidth,
	visibleMapLines,
} from '../src/map-lines';
import type { displayMap } from '../src/tools';

const segmentKeys = {
	origin_latitude_key: 'from_lat',
	origin_longitude_key: 'from_lng',
	destination_latitude_key: 'to_lat',
	destination_longitude_key: 'to_lng',
};

const flow = (overrides: Record<string, unknown> = {}) => ({
	from_lat: 45.76,
	from_lng: 4.84,
	to_lat: 45.19,
	to_lng: 5.72,
	trips: 10,
	...overrides,
});

describe('buildMapLines from origin and destination columns', () => {
	it('draws one straight segment per row in [longitude, latitude] order', () => {
		const lines = buildMapLines([flow()], segmentKeys);

		expect(lines.map((line) => line.paths)).toEqual([
			[
				[
					[4.84, 45.76],
					[5.72, 45.19],
				],
			],
		]);
	});

	it.each([
		{ variant: 'a non-numeric origin latitude', row: flow({ from_lat: 'north' }), reason: 'invalid_coordinates' },
		{
			variant: 'a latitude beyond the Web Mercator limit',
			row: flow({ to_lat: 89 }),
			reason: 'invalid_coordinates',
		},
		{ variant: 'a longitude beyond 180°', row: flow({ to_lng: 190 }), reason: 'invalid_coordinates' },
		{ variant: 'a missing destination', row: flow({ to_lat: null }), reason: 'invalid_coordinates' },
		{
			variant: 'the same origin and destination',
			row: flow({ to_lat: 45.76, to_lng: 4.84 }),
			reason: 'same_origin_destination',
		},
	])('drops a row with $variant and counts it as $reason', ({ row, reason }) => {
		expect(buildMapLines([row], segmentKeys)).toEqual([]);
		expect(countDroppedLineRows([row, flow()], segmentKeys)).toEqual({ [reason]: 1 });
	});

	it('replaces the segment with an arc when curved', () => {
		const [line] = buildMapLines([flow()], { ...segmentKeys, curved: true });

		expect(line.paths).toEqual([arcPath([4.84, 45.76], [5.72, 45.19])]);
	});
});

describe('buildMapLines from a geometry column', () => {
	const lineString = {
		type: 'LineString',
		coordinates: [
			[2.35, 48.85],
			[3.06, 50.63],
			[4.35, 50.85],
		],
	};

	it.each([
		{ variant: 'a LineString string', geometry: JSON.stringify(lineString), paths: [lineString.coordinates] },
		{
			variant: 'a MultiLineString object',
			geometry: { type: 'MultiLineString', coordinates: [lineString.coordinates, lineString.coordinates] },
			paths: [lineString.coordinates, lineString.coordinates],
		},
		{
			variant: 'a Feature wrapping a LineString',
			geometry: { type: 'Feature', geometry: lineString },
			paths: [lineString.coordinates],
		},
	])('reads $variant', ({ geometry, paths }) => {
		const [line] = buildMapLines([{ route: geometry }], { geometry_key: 'route' });

		expect(line.paths).toEqual(paths);
	});

	it.each([
		{ variant: 'a Point', geometry: { type: 'Point', coordinates: [2.35, 48.85] } },
		{ variant: 'a Polygon', geometry: { type: 'Polygon', coordinates: [lineString.coordinates] } },
		{
			variant: 'a line with a single valid position',
			geometry: {
				type: 'LineString',
				coordinates: [
					[2.35, 48.85],
					[2.35, 99],
				],
			},
		},
		{ variant: 'text that is not GeoJSON', geometry: 'Paris to Lille' },
	])('drops $variant', ({ geometry }) => {
		expect(buildMapLines([{ route: geometry }], { geometry_key: 'route' })).toEqual([]);
		expect(countDroppedLineRows([{ route: geometry }], { geometry_key: 'route' })).toEqual({ invalid_geometry: 1 });
	});

	it('ignores curved, since the geometry already gives the path', () => {
		const [line] = buildMapLines([{ route: lineString }], { geometry_key: 'route', curved: true });

		expect(line.paths).toEqual([lineString.coordinates]);
	});
});

describe('line widths and drawing order', () => {
	it.each([
		{ value: 10, max: 10, width: LINE_MAX_WIDTH },
		{ value: 5, max: 10, width: LINE_MIN_WIDTH + (LINE_MAX_WIDTH - LINE_MIN_WIDTH) / 2 },
		{ value: 0, max: 10, width: LINE_MIN_WIDTH },
		{ value: -3, max: 10, width: LINE_MIN_WIDTH },
		{ value: null, max: 10, width: LINE_MIN_WIDTH },
		{ value: 4, max: null, width: LINE_MIN_WIDTH },
	])('scales $value out of a $max maximum to $width px', ({ value, max, width }) => {
		expect(scaleLineWidth(value, max)).toBe(width);
	});

	it('sizes each line from width_key relative to the heaviest line', () => {
		const lines = buildMapLines([flow({ trips: 2 }), flow({ trips: 8 })], { ...segmentKeys, width_key: 'trips' });

		expect(lines.map((line) => line.width)).toEqual([scaleLineWidth(2, 8), LINE_MAX_WIDTH]);
	});

	it('gives every line the default width without width_key', () => {
		const lines = buildMapLines([flow({ trips: 2 }), flow({ trips: 8 })], segmentKeys);

		expect(lines.map((line) => line.width)).toEqual([DEFAULT_LINE_WIDTH, DEFAULT_LINE_WIDTH]);
	});

	it('orders lines from the lightest to the heaviest, rows without a weight first', () => {
		const rows = [flow({ trips: 5 }), flow({ trips: null }), flow({ trips: 12 }), flow({ trips: 1 })];

		const lines = buildMapLines(rows, { ...segmentKeys, width_key: 'trips' });

		expect(lines.map((line) => line.weight)).toEqual([null, 1, 5, 12]);
	});

	it('keeps the heaviest lines beyond the cap', () => {
		const rows = Array.from({ length: MAX_MAP_LINES + 5 }, (_, index) => flow({ trips: index }));

		const visible = visibleMapLines(buildMapLines(rows, { ...segmentKeys, width_key: 'trips' }));

		expect(visible).toHaveLength(MAX_MAP_LINES);
		expect(visible[0].weight).toBe(5);
		expect(visible.at(-1)?.weight).toBe(MAX_MAP_LINES + 4);
	});
});

describe('arcPath', () => {
	it('starts at the origin and ends at the destination', () => {
		const path = arcPath([0, 0], [10, 0]);

		expect(path[0]).toEqual([0, 0]);
		expect(path.at(-1)).toEqual([10, 0]);
	});

	it.each([
		{ direction: 'eastward', origin: [0, 0], destination: [10, 0], middle: [5, -1] },
		{ direction: 'westward', origin: [10, 0], destination: [0, 0], middle: [5, 1] },
	] as const)('bends a $direction line to its right', ({ origin, destination, middle }) => {
		const path = arcPath([...origin], [...destination]);

		expect(path[(path.length - 1) / 2]).toEqual(middle);
	});
});

describe('line arrows', () => {
	const segment = (origin: [number, number], destination: [number, number]) => ({
		from_lng: origin[0],
		from_lat: origin[1],
		to_lng: destination[0],
		to_lat: destination[1],
	});

	it.each<{ variant: string; options: Partial<displayMap.Input>; arrowCount: number }>([
		{ variant: 'straight lines have none by default', options: {}, arrowCount: 0 },
		{ variant: 'arcs have one by default', options: { curved: true }, arrowCount: 1 },
		{ variant: 'arrows=false removes them from arcs', options: { curved: true, arrows: false }, arrowCount: 0 },
		{ variant: 'arrows=true adds them to straight lines', options: { arrows: true }, arrowCount: 1 },
	])('$variant', ({ options, arrowCount }) => {
		const [line] = buildMapLines([flow()], { ...segmentKeys, ...options });

		expect(line.arrows).toHaveLength(arrowCount);
	});

	it.each([
		{ direction: 'east', origin: [0, 0], destination: [10, 0], position: [5, 0], angle: 0 },
		{ direction: 'west', origin: [10, 0], destination: [0, 0], position: [5, 0], angle: 180 },
		{ direction: 'north', origin: [0, 0], destination: [0, 10], angle: -90 },
		{ direction: 'south', origin: [0, 10], destination: [0, 0], angle: 90 },
	] as const)('points a straight line going $direction from its middle', ({ origin, destination, ...expected }) => {
		const [line] = buildMapLines([segment([...origin], [...destination])], { ...segmentKeys, arrows: true });
		const [arrow] = line.arrows;

		expect(arrow.angle).toBeCloseTo(expected.angle);
		if ('position' in expected) {
			expect(arrow.position[0]).toBeCloseTo(expected.position[0]);
			expect(arrow.position[1]).toBeCloseTo(expected.position[1]);
		}
	});

	it('places the middle of a north-south line halfway on the Mercator map, not halfway in latitude', () => {
		const [line] = buildMapLines([segment([0, 0], [0, 80])], { ...segmentKeys, arrows: true });

		expect(line.arrows[0].position[1]).toBeGreaterThan(50);
	});

	it.each([
		{ direction: 'outbound', origin: [0, 0], destination: [10, 0], position: [5, -1], angle: 0 },
		{ direction: 'return', origin: [10, 0], destination: [0, 0], position: [5, 1], angle: 180 },
	] as const)('puts the $direction arrow at the top of its own arc', ({ origin, destination, position, angle }) => {
		const [line] = buildMapLines([segment([...origin], [...destination])], { ...segmentKeys, curved: true });
		const [arrow] = line.arrows;

		expect(arrow.position[0]).toBeCloseTo(position[0]);
		expect(arrow.position[1]).toBeCloseTo(position[1], 1);
		expect(Math.abs(Math.abs(arrow.angle) - angle)).toBeLessThan(3);
	});

	it('draws one arrow per path of a MultiLineString, in the direction of its positions', () => {
		const route = {
			type: 'MultiLineString',
			coordinates: [
				[
					[0, 0],
					[10, 0],
				],
				[
					[20, 10],
					[20, 0],
				],
			],
		};

		const [line] = buildMapLines([{ route }], { geometry_key: 'route', arrows: true });

		expect(line.arrows.map((arrow) => Math.round(arrow.angle))).toEqual([0, 90]);
	});

	it.each([
		{ width: 1, size: LINE_ARROW_MIN_SIZE },
		{ width: 8, size: 17.6 },
	])('sizes the arrow of a $width px line to $size px', ({ width, size }) => {
		expect(lineArrowSize(width)).toBeCloseTo(size);
	});

	it.each([
		{ variant: 'inside the wide base', x: 8, y: 7, inside: true },
		{ variant: 'inside the tip', x: 26, y: 16, inside: true },
		{ variant: 'beside the tip', x: 25, y: 7, inside: false },
		{ variant: 'behind the base', x: 1, y: 16, inside: false },
	])('draws the arrow image pointing east: $variant', ({ x, y, inside }) => {
		const image = lineArrowImage();
		const alpha = image.data[(y * image.width + x) * 4 + 3];

		expect(alpha >= 192).toBe(inside);
	});
});

describe('lines spanning more than half the globe', () => {
	const city = {
		london: [51.51, -0.13],
		tokyo: [35.68, 139.69],
		sydney: [-33.87, 151.21],
		losAngeles: [34.05, -118.24],
	};
	const route = (from: number[], to: number[]) => ({
		from_lat: from[0],
		from_lng: from[1],
		to_lat: to[0],
		to_lng: to[1],
	});

	it('frames every line of a hub whose destinations cover more than 180° of longitude', () => {
		const lines = buildMapLines(
			[route(city.london, city.tokyo), route(city.london, city.sydney), route(city.london, city.losAngeles)],
			segmentKeys,
		);

		expect(mapLinesBounds(lines)).toEqual({ west: -118.24, south: -33.87, east: 151.21, north: 51.51 });
	});

	it('keeps the longitudes of a Tokyo → Los Angeles line, with its arrow halfway and pointing west', () => {
		const [line] = buildMapLines([route(city.tokyo, city.losAngeles)], { ...segmentKeys, arrows: true });
		const [arrow] = line.arrows;

		expect(line.paths[0].map(([longitude]) => longitude)).toEqual([139.69, -118.24]);
		expect(arrow.position[0]).toBeCloseTo((139.69 - 118.24) / 2);
		expect(Math.abs(arrow.angle)).toBeGreaterThan(90);
	});
});

describe('lineWidthLegend', () => {
	it('shows the lightest and heaviest values at their drawn widths', () => {
		const lines = buildMapLines([flow({ trips: 2 }), flow({ trips: 10 })], { ...segmentKeys, width_key: 'trips' });

		expect(lineWidthLegend(lines)).toEqual([
			{ label: '2', width: scaleLineWidth(2, 10) },
			{ label: '10', width: LINE_MAX_WIDTH },
		]);
	});

	it('is empty when the lines have no weight', () => {
		expect(lineWidthLegend(buildMapLines([flow()], segmentKeys))).toEqual([]);
	});
});

describe('mapLinesBounds', () => {
	it('covers every position of every line', () => {
		const lines = buildMapLines(
			[flow(), flow({ from_lat: 43.3, from_lng: 5.37, to_lat: 48.85, to_lng: 2.35 })],
			segmentKeys,
		);

		expect(mapLinesBounds(lines)).toEqual({ west: 2.35, south: 43.3, east: 5.72, north: 48.85 });
	});
});

describe('lineTooltipKeys', () => {
	it.each<{ variant: string; config: Partial<displayMap.Input>; keys: string[] }>([
		{
			variant: 'adds the width column',
			config: { tooltip_keys: ['mode'], width_key: 'trips' },
			keys: ['mode', 'trips'],
		},
		{
			variant: 'does not repeat the width column',
			config: { tooltip_keys: ['trips'], width_key: 'trips' },
			keys: ['trips'],
		},
		{
			variant: 'leaves out the label column',
			config: { tooltip_keys: ['route', 'mode'], label_key: 'route' },
			keys: ['mode'],
		},
	])('$variant', ({ config, keys }) => {
		expect(lineTooltipKeys({ query_id: 'q1', title: 'Flows', map_type: 'lines', ...config })).toEqual(keys);
	});
});
