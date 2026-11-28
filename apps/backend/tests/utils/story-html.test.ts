import { DEFAULT_COLORS, LINE_MAX_WIDTH, scaleLineWidth } from '@nao/shared';
import { DEFAULT_DARK_STORY_THEME, DEFAULT_STORY_THEME, type StoryThemePair } from '@nao/shared/story-theme';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/safe-fetch', () => ({
	safeFetch: vi.fn(async () => {
		throw new Error('no network in tests');
	}),
	parseAndValidateGeoJson: vi.fn(),
}));

import { generateStoryEmailHtml, generateStoryHtml, MAPLIBRE_CSS_URL } from '../../src/utils/story-html';

const CHART_ONE =
	'<chart query_id="q1" chart_type="line" x_axis_key="month" series=\'[{"data_key":"revenue"}]\' title="Revenue" />';
const CHART_TWO =
	'<chart query_id="q2" chart_type="bar" x_axis_key="month" series=\'[{"data_key":"orders"}]\' title="Orders" />';

describe('generateStoryHtml incomplete maps', () => {
	it('renders a placeholder naming the missing coordinate columns', async () => {
		const html = await generateStoryHtml(
			{ title: 'Story', code: '<map query_id="q1" map_type="scatter_bubble" title="Stores" />' },
			null,
		);

		expect(html).toContain('Stores');
		expect(html).toContain('missing latitude_key, longitude_key (query: q1)');
		expect(html).not.toContain('Data unavailable');
	});

	it('names the missing line columns of a lines map', async () => {
		const html = await generateStoryHtml(
			{ title: 'Story', code: '<map query_id="q1" map_type="lines" origin_latitude_key="a" title="Flows" />' },
			null,
		);

		expect(html).toContain(
			'missing origin_longitude_key, destination_latitude_key, destination_longitude_key (query: q1)',
		);
	});

	it('loads no map library when every map is a placeholder', async () => {
		const html = await generateStoryHtml(
			{ title: 'Story', code: '<map query_id="q1" map_type="points" title="Stores" />' },
			null,
		);

		expect(html).not.toContain(MAPLIBRE_CSS_URL);
	});
});

describe('generateStoryHtml lines maps', () => {
	const LINES_BLOCK =
		'<map query_id="q1" map_type="lines" origin_latitude_key="from_lat" origin_longitude_key="from_lng" destination_latitude_key="to_lat" destination_longitude_key="to_lng" width_key="trips" label_key="route" title="Flows" />';
	const flowData = {
		q1: {
			columns: ['route', 'from_lat', 'from_lng', 'to_lat', 'to_lng', 'trips'],
			data: [
				{ route: 'Lyon → Grenoble', from_lat: 45.76, from_lng: 4.84, to_lat: 45.19, to_lng: 5.72, trips: 8 },
				{ route: 'Lyon → Annecy', from_lat: 45.76, from_lng: 4.84, to_lat: 45.9, to_lng: 6.13, trips: 4 },
			],
		},
	};

	it('hands the MapLibre script the lines, lightest first, with their widths and popups', async () => {
		const html = await generateStoryHtml({ title: 'Story', code: LINES_BLOCK }, flowData);

		const payload = JSON.parse(decodeAttribute(html.match(/data-map="([^"]*)"/)![1]));
		expect(payload.type).toBe('lines');
		expect(payload.lines.map((line: { width: number; label: string }) => [line.label, line.width])).toEqual([
			['Lyon → Annecy', scaleLineWidth(4, 8)],
			['Lyon → Grenoble', LINE_MAX_WIDTH],
		]);
	});

	it('draws one stroked path per line in the static SVG', async () => {
		const html = await generateStoryHtml({ title: 'Story', code: LINES_BLOCK }, flowData, null, [], {
			staticMaps: true,
		});

		const strokeWidths = [...html.matchAll(/<path d="[^"]+" fill="none" stroke="[^"]+" stroke-width="([\d.]+)"/g)];
		expect(strokeWidths.map((match) => Number(match[1]))).toEqual([scaleLineWidth(4, 8), LINE_MAX_WIDTH]);
		expect(html).toContain('data-leaflet=');
	});

	it.each([
		{ variant: 'straight lines', attributes: '', arrowCount: 0 },
		{ variant: 'curved lines', attributes: ' curved="true"', arrowCount: 2 },
		{ variant: 'straight lines with arrows', attributes: ' arrows="true"', arrowCount: 2 },
	])(
		'draws an arrow on each line of $variant in both the MapLibre payload and the static SVG',
		async ({ attributes, arrowCount }) => {
			const code = LINES_BLOCK.replace(' title="Flows"', `${attributes} title="Flows"`);

			const live = await generateStoryHtml({ title: 'Story', code }, flowData);
			const payload = JSON.parse(decodeAttribute(live.match(/data-map="([^"]*)"/)![1]));
			const staticHtml = await generateStoryHtml({ title: 'Story', code }, flowData, null, [], {
				staticMaps: true,
			});

			expect(payload.lines.flatMap((line: { arrows: unknown[] }) => line.arrows)).toHaveLength(arrowCount);
			expect(staticHtml.match(/<path d="M[^"]+ Z" fill="[^"]+"/g) ?? []).toHaveLength(arrowCount);
		},
	);
});

describe('generateStoryHtml lines spanning more than half the globe', () => {
	it('keeps every line and arrow of a London hub inside the static SVG', async () => {
		const code =
			'<map query_id="q1" map_type="lines" origin_latitude_key="from_lat" origin_longitude_key="from_lng" destination_latitude_key="to_lat" destination_longitude_key="to_lng" arrows="true" title="Hub" />';
		const london = { from_lat: 51.51, from_lng: -0.13 };
		const data = {
			q1: {
				columns: ['from_lat', 'from_lng', 'to_lat', 'to_lng'],
				data: [
					{ ...london, to_lat: 35.68, to_lng: 139.69 },
					{ ...london, to_lat: -33.87, to_lng: 151.21 },
					{ ...london, to_lat: 34.05, to_lng: -118.24 },
				],
			},
		};

		const html = await generateStoryHtml({ title: 'Story', code }, data, null, [], { staticMaps: true });

		const [, width] = html.match(/viewBox="0 0 ([\d.]+) [\d.]+"/)!.map(Number);
		const shapes = [...html.matchAll(/<path d="(M[^"]+)" fill="(?:none|[^"]+)"/g)].map((match) => match[1]);
		const xs = shapes.flatMap((d) => [...d.matchAll(/[ML]([-\d.]+),/g)].map((match) => Number(match[1])));
		expect(shapes).toHaveLength(6);
		expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
		expect(Math.max(...xs)).toBeLessThanOrEqual(width);
	});
});

function decodeAttribute(value: string): string {
	return value
		.replace(/&quot;/g, '"')
		.replace(/&#x27;/g, "'")
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&');
}

describe('generateStoryHtml grid flattening', () => {
	it.each([
		{ variant: 'with widths', attributes: 'widths="3,1"' },
		{ variant: 'without widths', attributes: 'cols="2"' },
	])('flattens grids $variant', async ({ attributes }) => {
		const html = await generateStoryHtml(
			{ title: 'Story', code: `<grid ${attributes}>${CHART_ONE}${CHART_TWO}</grid>` },
			null,
		);

		expect(html).not.toContain('grid-template-columns');
		expect(html).toContain('Revenue');
		expect(html).toContain('Orders');
	});
});

const THEME: StoryThemePair = {
	light: {
		...DEFAULT_STORY_THEME,
		surfaces: { page: '#fbf7ef', sunken: '#f1e9da' },
		text: { ...DEFAULT_STORY_THEME.text, headingColor: '#0b1f3a', bodyColor: '#2d3a4f', bodyFont: 'Lora, serif' },
		table: { ...DEFAULT_STORY_THEME.table, headerBackground: '#e8dcc4' },
		charts: { ...DEFAULT_STORY_THEME.charts, series: ['#c2410c', '#0f766e', '#7c3aed'] },
	},
	dark: DEFAULT_DARK_STORY_THEME,
};

const THEMED_STORY = {
	title: 'Story',
	code: `# Revenue\n\n${CHART_TWO}\n\n<table query_id="q2" title="Orders" />`,
};
const QUERY_DATA = { q2: { columns: ['month', 'orders'], data: [{ month: 'Jan', orders: 3 }] } };

describe('generateStoryHtml theme', () => {
	it('keeps the default look when the story has no theme', async () => {
		const html = await generateStoryHtml(THEMED_STORY, QUERY_DATA);

		expect(html).toContain('color:#111827');
		expect(html).toContain(`fill="${DEFAULT_COLORS[0]}"`);
		expect(html).not.toContain('#fbf7ef');
	});

	it('paints the document, tables and chart series with the light theme', async () => {
		const html = await generateStoryHtml(THEMED_STORY, QUERY_DATA, null, undefined, { theme: THEME });

		expect(html).toContain('background:#fbf7ef');
		expect(html).toContain('@page{background:#fbf7ef}');
		expect(html).toContain('color:#0b1f3a');
		expect(html).toContain('font-family:Lora, serif');
		expect(html).toContain('background:#e8dcc4');
		expect(html).toContain('fill="#c2410c"');
		expect(html).toContain('--background:#fbf7ef');
		expect(html).not.toContain(DEFAULT_DARK_STORY_THEME.surfaces.page);
	});

	it('inlines the theme into emailed stories, where stylesheets are stripped', async () => {
		const { html } = await generateStoryEmailHtml(THEMED_STORY, QUERY_DATA, null, undefined, THEME);

		expect(html).toContain('color:#0b1f3a');
		expect(html).toContain('background:#e8dcc4');
	});
});

describe('generateStoryHtml tabs', () => {
	it('renders each tab as a titled section with its content', async () => {
		const html = await generateStoryHtml(
			{
				title: 'Tabbed story',
				code: `<tab title="Overview">
## Summary
Hello overview
</tab>
<tab title="Details">
Some details text
</tab>`,
			},
			null,
		);

		expect(html).toContain('Overview');
		expect(html).toContain('Details');
		expect(html).toContain('Hello overview');
		expect(html).toContain('Some details text');
	});

	it('formats KPI values with the series value format', async () => {
		const html = await generateStoryHtml(
			{
				title: 'Revenue story',
				code: `<chart query_id="q1" chart_type="kpi_card" x_axis_key="month" series='[{"data_key":"revenue","color":"#2563eb","value_format":{"d3_format":",.2f","prefix":"$","suffix":" USD"}}]' />`,
			},
			{ q1: { data: [{ month: 'July', revenue: 1234.5 }], columns: ['month', 'revenue'] } },
		);

		expect(html).toContain('$1,234.50 USD');
	});
});

const LEGEND_MARKER = 'gap:16px;padding-top:12px';

describe('generateStoryHtml chart legend visibility', () => {
	const chartStory = (chartType: string, attr = '') => ({
		title: 'Story',
		code: `<chart query_id="q2" chart_type="${chartType}" x_axis_key="month" series='[{"data_key":"orders"}]' title="Orders"${attr} />`,
	});

	it('shows the legend of a single-series bar chart by default', async () => {
		expect(await generateStoryHtml(chartStory('bar'), QUERY_DATA)).toContain(LEGEND_MARKER);
	});

	it('hides the legend when show_legend is false', async () => {
		const html = await generateStoryHtml(chartStory('bar', ' show_legend="false"'), QUERY_DATA);

		expect(html).not.toContain(LEGEND_MARKER);
	});

	it('shows the legend of a single-series horizontal bar chart when show_legend is true', async () => {
		expect(await generateStoryHtml(chartStory('horizontal_bar'), QUERY_DATA)).not.toContain(LEGEND_MARKER);
		expect(await generateStoryHtml(chartStory('horizontal_bar', ' show_legend="true"'), QUERY_DATA)).toContain(
			LEGEND_MARKER,
		);
	});

	it('hides the legend of emailed charts when show_legend is false', async () => {
		const shown = await generateStoryEmailHtml(chartStory('bar'), QUERY_DATA);
		const hidden = await generateStoryEmailHtml(chartStory('bar', ' show_legend="false"'), QUERY_DATA);

		expect(shown.html).toContain(LEGEND_MARKER);
		expect(hidden.html).not.toContain(LEGEND_MARKER);
	});
});
