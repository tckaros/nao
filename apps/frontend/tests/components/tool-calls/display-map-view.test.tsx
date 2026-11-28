// @vitest-environment jsdom

import { LINE_MAX_WIDTH, scaleLineWidth } from '@nao/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { displayMap } from '@nao/shared/tools';
import type { MapPoint } from '@nao/shared';

import MapView from '@/components/tool-calls/display-map-view';

const { FakeMap, createdMaps } = vi.hoisted(() => {
	const maps: InstanceType<typeof FakeMapClass>[] = [];

	class FakeMapClass {
		camera = { center: { lng: 0, lat: 0 }, zoom: 0, bearing: 0, pitch: 0 };
		handlers = new Map<string, (() => void)[]>();
		jumpTo = vi.fn((camera: Partial<FakeMapClass['camera']>) => Object.assign(this.camera, camera));
		fitBounds = vi.fn();

		constructor() {
			maps.push(this);
		}

		on(event: string, layerOrHandler: string | (() => void), handler?: () => void) {
			const listener = typeof layerOrHandler === 'function' ? layerOrHandler : handler;
			if (listener) {
				this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
			}
		}

		emit(event: string) {
			this.handlers.get(event)?.forEach((listener) => listener());
		}

		getCenter() {
			return this.camera.center;
		}
		getZoom() {
			return this.camera.zoom;
		}
		getBearing() {
			return this.camera.bearing;
		}
		getPitch() {
			return this.camera.pitch;
		}
		getContainer() {
			return document.createElement('div');
		}
		getSource() {
			return undefined;
		}
		getLayer() {
			return undefined;
		}
		addControl() {}
		hasImage() {
			return false;
		}
		addImage = vi.fn();
		addSource = vi.fn();
		addLayer = vi.fn();
		remove() {}
	}

	return { FakeMap: FakeMapClass, createdMaps: maps };
});

vi.mock('@/lib/maplibre', () => ({
	maplibregl: { Map: FakeMap, NavigationControl: class {}, Popup: class {} },
}));

vi.mock('@/main', () => ({
	trpc: {
		project: {
			getMapBoundaries: {
				queryOptions: () => ({ queryKey: ['map-boundaries'], queryFn: () => new Promise(() => {}) }),
			},
		},
	},
}));

const CONFIG: displayMap.Input = {
	query_id: 'query',
	title: 'Stores',
	map_type: 'points',
	latitude_key: 'lat',
	longitude_key: 'lng',
};
const CHOROPLETH_CONFIG: displayMap.Input = {
	query_id: 'query',
	title: 'Regions',
	map_type: 'choropleth',
	region_boundaries: 'world_countries',
	region_key: 'country',
	value_key: 'sales',
};
const PARIS: MapPoint[] = [{ latitude: 48.85, longitude: 2.35, row: {} }];
const TOKYO: MapPoint[] = [{ latitude: 35.68, longitude: 139.69, row: {} }];

let setNearViewport: (isIntersecting: boolean) => void = () => {};

beforeEach(() => {
	vi.stubGlobal(
		'IntersectionObserver',
		class {
			constructor(callback: (entries: Partial<IntersectionObserverEntry>[]) => void) {
				setNearViewport = (isIntersecting) => act(() => callback([{ isIntersecting }]));
			}
			observe() {}
			disconnect() {}
		},
	);
});

afterEach(() => {
	cleanup();
	createdMaps.length = 0;
	vi.unstubAllGlobals();
});

describe('MapView camera across viewport releases', () => {
	it('restores the camera the user left when the map comes back', () => {
		renderMap(PARIS);
		setNearViewport(true);
		const firstMap = lastMap();
		act(() => firstMap.emit('style.load'));
		firstMap.camera = { center: { lng: 5, lat: 45 }, zoom: 9, bearing: 10, pitch: 20 };

		setNearViewport(false);
		setNearViewport(true);
		act(() => lastMap().emit('style.load'));

		expect(lastMap()).not.toBe(firstMap);
		expect(lastMap().jumpTo).toHaveBeenCalledWith(firstMap.camera);
		expect(lastMap().fitBounds).not.toHaveBeenCalled();
	});

	it('does not save the default camera of a map released before its style loaded', () => {
		renderMap(PARIS);
		setNearViewport(true);

		setNearViewport(false);
		setNearViewport(true);
		act(() => lastMap().emit('style.load'));

		expect(lastMap().jumpTo).not.toHaveBeenCalled();
		expect(lastMap().fitBounds).toHaveBeenCalledOnce();
	});

	it('fits the new data instead of restoring the camera when data changed off-screen', () => {
		const { rerender } = renderMap(PARIS);
		setNearViewport(true);
		act(() => lastMap().emit('style.load'));
		setNearViewport(false);

		rerender(<MapView points={TOKYO} rows={[]} config={CONFIG} customBoundaries={[]} />);
		setNearViewport(true);
		act(() => lastMap().emit('style.load'));

		expect(lastMap().jumpTo).not.toHaveBeenCalled();
		expect(lastMap().fitBounds).toHaveBeenCalledOnce();
	});

	it('restores the camera of a choropleth while its boundary sets are still loading', () => {
		renderWithQueryClient(<MapView points={[]} rows={[]} config={CHOROPLETH_CONFIG} />);
		setNearViewport(true);
		const firstMap = lastMap();
		act(() => firstMap.emit('style.load'));
		firstMap.camera = { center: { lng: 5, lat: 45 }, zoom: 9, bearing: 10, pitch: 20 };

		setNearViewport(false);
		setNearViewport(true);
		act(() => lastMap().emit('style.load'));

		expect(lastMap().jumpTo).toHaveBeenCalledWith(firstMap.camera);
	});
});

describe('MapView lines', () => {
	const LINES_CONFIG: displayMap.Input = {
		query_id: 'query',
		title: 'Flows',
		map_type: 'lines',
		origin_latitude_key: 'from_lat',
		origin_longitude_key: 'from_lng',
		destination_latitude_key: 'to_lat',
		destination_longitude_key: 'to_lng',
		width_key: 'trips',
	};
	const FLOWS = [
		{ from_lat: 45.76, from_lng: 4.84, to_lat: 45.19, to_lng: 5.72, trips: 8 },
		{ from_lat: 45.76, from_lng: 4.84, to_lat: 45.9, to_lng: 6.13, trips: 4 },
	];

	it('draws the lines with their widths under a wider hover layer, and fits them', () => {
		renderWithQueryClient(<MapView points={[]} rows={FLOWS} config={LINES_CONFIG} customBoundaries={[]} />);
		setNearViewport(true);
		act(() => lastMap().emit('style.load'));

		const [sourceId, source] = lastMap().addSource.mock.calls[0];
		expect(sourceId).toBe('query-lines');
		expect(
			source.data.features.map((feature: { properties: { width: number } }) => feature.properties.width),
		).toEqual([scaleLineWidth(4, 8), LINE_MAX_WIDTH]);
		expect(lastMap().addLayer.mock.calls.map(([layer]) => [layer.id, layer.paint['line-width']])).toEqual([
			['query-lines-line', ['get', 'width']],
			['query-lines-hit', ['+', ['get', 'width'], 8]],
		]);
		expect(lastMap().fitBounds).toHaveBeenCalledWith(
			[
				[4.84, 45.19],
				[6.13, 45.9],
			],
			expect.anything(),
		);
	});

	it('adds an arrow layer turned along each curved line', () => {
		renderWithQueryClient(
			<MapView points={[]} rows={FLOWS} config={{ ...LINES_CONFIG, curved: true }} customBoundaries={[]} />,
		);
		setNearViewport(true);
		act(() => lastMap().emit('style.load'));

		const [, arrowSource] = lastMap().addSource.mock.calls[1];
		const [arrowLayer] = lastMap().addLayer.mock.calls[2];
		expect(arrowSource.data.features).toHaveLength(FLOWS.length);
		expect(arrowLayer.layout['icon-rotate']).toEqual(['get', 'angle']);
		expect(lastMap().addImage).toHaveBeenCalledOnce();
	});

	it.each([
		{ variant: 'shows the width legend with width_key', config: LINES_CONFIG, labels: ['4', '8'] },
		{ variant: 'shows no legend without width_key', config: { ...LINES_CONFIG, width_key: undefined }, labels: [] },
	])('$variant', ({ config, labels }) => {
		const { container } = renderWithQueryClient(
			<MapView points={[]} rows={FLOWS} config={config} customBoundaries={[]} />,
		);

		expect([...container.querySelectorAll('.font-mono')].map((label) => label.textContent)).toEqual(labels);
	});
});

function renderMap(points: MapPoint[]) {
	return renderWithQueryClient(<MapView points={points} rows={[]} config={CONFIG} customBoundaries={[]} />);
}

function renderWithQueryClient(element: ReactNode) {
	const queryClient = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	return render(element, { wrapper });
}

function lastMap() {
	return createdMaps[createdMaps.length - 1];
}
