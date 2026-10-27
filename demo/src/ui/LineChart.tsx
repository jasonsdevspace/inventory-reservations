import { useId, useState } from 'react';

export interface Series {
    readonly name: string;
    /** A CSS color, from the validated series tokens. */
    readonly color: string;
    readonly values: readonly number[];
}

interface Props {
    readonly title: string;
    readonly unit: string;
    /** The x positions, evenly spaced, such as buyer counts that double. */
    readonly categories: readonly number[];
    readonly categoryLabel: string;
    readonly series: readonly Series[];
}

const WIDTH = 360;
const HEIGHT = 200;
const PAD = { top: 12, right: 92, bottom: 30, left: 44 };

/** A round upper bound and tick step for an axis that starts at zero. */
const niceScale = (max: number): { top: number; step: number } => {
    const raw = Math.max(max, 1) / 4;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? raw;
    return { top: Math.ceil(max / step) * step, step };
};

const format = (value: number) =>
    value >= 1000 ? value.toLocaleString('en-US') : String(Math.round(value));

/**
 * One measure against one axis, with a hover readout for every point.
 *
 * Lines end in a direct label as well as appearing in the legend, so no
 * series is identified by color alone.
 */
export const LineChart = ({ title, unit, categories, categoryLabel, series }: Props) => {
    const id = useId();
    const [hover, setHover] = useState<number | undefined>(undefined);
    const { top, step } = niceScale(Math.max(...series.flatMap((s) => s.values)));
    const plotW = WIDTH - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (i: number) =>
        PAD.left + (categories.length === 1 ? 0 : (i / (categories.length - 1)) * plotW);
    const y = (v: number) => PAD.top + plotH - (v / top) * plotH;
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);

    return (
        <figure className="chart" aria-labelledby={`${id}-title`}>
            <figcaption id={`${id}-title`}>
                <span className="chart-title">{title}</span>
                <span className="legend">
                    {series.map((s) => (
                        <span key={s.name}>
                            <i style={{ background: s.color }} aria-hidden="true" />
                            {s.name}
                        </span>
                    ))}
                </span>
            </figcaption>
            <div className="chart-plot">
                <svg
                    viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
                    role="img"
                    aria-label={`${title}. ${series
                        .map((s) => `${s.name}: ${s.values.map(format).join(', ')} ${unit}`)
                        .join('. ')}`}
                    onMouseLeave={() => setHover(undefined)}
                >
                    {ticks.map((tick) => (
                        <g key={tick}>
                            <line
                                className="grid"
                                x1={PAD.left}
                                x2={PAD.left + plotW}
                                y1={y(tick)}
                                y2={y(tick)}
                            />
                            <text
                                className="axis"
                                x={PAD.left - 6}
                                y={y(tick) + 4}
                                textAnchor="end"
                            >
                                {format(tick)}
                            </text>
                        </g>
                    ))}
                    {categories.map((category, i) => (
                        <text
                            key={category}
                            className="axis"
                            x={x(i)}
                            y={HEIGHT - PAD.bottom + 16}
                            textAnchor="middle"
                        >
                            {category}
                        </text>
                    ))}
                    <text
                        className="axis"
                        x={PAD.left + plotW / 2}
                        y={HEIGHT - 2}
                        textAnchor="middle"
                    >
                        {categoryLabel}
                    </text>

                    {hover !== undefined && (
                        <line
                            className="crosshair"
                            x1={x(hover)}
                            x2={x(hover)}
                            y1={PAD.top}
                            y2={PAD.top + plotH}
                        />
                    )}

                    {series.map((s) => (
                        <g key={s.name}>
                            <polyline
                                fill="none"
                                stroke={s.color}
                                strokeWidth={2}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                                points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')}
                            />
                            {s.values.map((v, i) => (
                                <circle
                                    key={i}
                                    className="marker"
                                    cx={x(i)}
                                    cy={y(v)}
                                    r={hover === i ? 5 : 4}
                                    fill={s.color}
                                />
                            ))}
                            <text
                                className="end-label"
                                x={x(s.values.length - 1) + 8}
                                y={y(s.values.at(-1) ?? 0) + 4}
                            >
                                {s.name}
                            </text>
                        </g>
                    ))}

                    {categories.map((category, i) => (
                        <rect
                            key={category}
                            className="hit"
                            x={x(i) - plotW / (2 * Math.max(categories.length - 1, 1))}
                            y={PAD.top}
                            width={plotW / Math.max(categories.length - 1, 1)}
                            height={plotH}
                            onMouseEnter={() => setHover(i)}
                            onFocus={() => setHover(i)}
                        />
                    ))}
                </svg>
                {hover !== undefined && (
                    <div
                        className="tooltip"
                        style={{ left: `${(x(hover) / WIDTH) * 100}%` }}
                        role="status"
                    >
                        <b>
                            {categories[hover]} {categoryLabel.toLowerCase()}
                        </b>
                        {series.map((s) => (
                            <span key={s.name}>
                                <i style={{ background: s.color }} aria-hidden="true" />
                                {s.name}: {format(s.values[hover] ?? 0)} {unit}
                            </span>
                        ))}
                    </div>
                )}
            </div>
        </figure>
    );
};
